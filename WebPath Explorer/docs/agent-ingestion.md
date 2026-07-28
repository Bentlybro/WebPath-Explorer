# Agent ingestion

WebPath Explorer can preserve web research from Codex and other AI agents so that every search becomes part of the same permanent graph as manual crawls. Agents append research through the following endpoint:

```text
POST /api/agent/ingest
Content-Type: application/json
X-Ingest-Token: <WEBPATH_INGEST_TOKEN, when configured>
```

The legacy alias `POST /api/ingest` remains supported.

## Batch contract

```json
{
  "agent": {
    "id": "codex",
    "name": "Codex",
    "metadata": {
      "model": "gpt-5"
    }
  },
  "session": {
    "id": "thread-123",
    "title": "Researching high-scale graph rendering",
    "started_at": "2026-07-28T12:00:00Z",
    "metadata": {}
  },
  "search": {
    "id": "search-call-1",
    "event_id": "thread-123:search:1",
    "query": "WebGPU graph rendering",
    "status": "completed",
    "started_at": "2026-07-28T12:01:00Z",
    "completed_at": "2026-07-28T12:01:04Z",
    "metadata": {}
  },
  "sources": [
    {
      "url": "https://example.com/research",
      "title": "Research result",
      "event_id": "thread-123:source:1",
      "observed_at": "2026-07-28T12:01:02Z",
      "node_type": "page",
      "metadata": {
        "rank": 1,
        "snippet": "Optional short extract"
      }
    }
  ],
  "edges": [
    {
      "source_url": "https://example.com/research",
      "target_url": "https://example.org/cited-work",
      "relation": "cites",
      "event_id": "thread-123:edge:1",
      "observed_at": "2026-07-28T12:01:03Z",
      "metadata": {}
    }
  ]
}
```

The only required identity fields are `agent.id` and `session.id`. The `sources` and `edges` collections default to empty arrays, and a batch may contain at most 5,000 sources and 20,000 edges.

Relationship names are intentionally free-form. Useful conventions include `links_to`, `cites`, `redirects_to`, `supports`, `contradicts`, `discovered_by`, and `derived_from`.

## Idempotency and transactions

Every search, source, and edge event should use a stable `event_id` derived from the originating agent call or tool event. Replaying an already delivered batch then records no duplicate observations, while reusing the same event identifier for a different event type is rejected.

Ingestion runs inside one serialized write transaction. Validation or storage failure rolls back the complete batch, and the per-store re-entrant lock keeps concurrent crawler and agent threads from interleaving write transactions.

An accepted response has the following shape:

```json
{
  "agent_id": "codex",
  "session_id": "thread-123",
  "search_id": 42,
  "nodes_touched": 2,
  "edges_touched": 1,
  "observations_inserted": 3,
  "observations_replayed": 0
}
```

## Python bridge

The repository includes `tools/agent_client.py`, which can be imported by an agent runtime or executed from a terminal:

```powershell
python tools/agent_client.py research-batch.json
Get-Content research-batch.json | python tools/agent_client.py -
```

An agent can call the client immediately after its web-search tool returns:

```python
from tools.agent_client import WebPathClient

result = WebPathClient().ingest(batch)
```

The bridge reads its server URL and optional token from configuration, sends the batch as JSON, and surfaces HTTP or validation failures to the caller.

Agent logging should be best-effort and must not break the original research task when the local WebPath service is offline. A connector should queue a failed batch locally and retry it later with the same event identifiers.

## Recommended agent workflow

1. Create one stable agent identifier for the runtime or assistant.
2. Create one stable session identifier for the research thread or task.
3. Record each search tool call with its query, timing, status, and stable event identifier.
4. Record each useful result as a source with its canonical URL, title, rank, and a short snippet or summary in metadata.
5. Record explicit citations or discovered links as edges instead of relying only on the crawler to rediscover them.
6. Retry failed delivery with the same event identifiers so the graph remains idempotent.
7. End or update the session when the surrounding research task completes.

This workflow lets later agents recover the provenance of a source, inspect which search produced it, follow relationships discovered by other tools, and avoid repeating research that already exists in the graph.

## Authentication and privacy

When `WEBPATH_INGEST_TOKEN` is set, every ingestion request must send the same value in `X-Ingest-Token`. The local server rejects a missing or incorrect token.

Connectors should default to explicit allow-listing. They must not ingest secrets, private URLs, authentication headers, personal search history, or full page content unless the user has intentionally enabled that data class. Short metadata, citations, and content hashes are safer defaults; page snapshots require separate retention and access controls.
