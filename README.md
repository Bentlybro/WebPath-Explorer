# WebPath Explorer

WebPath Explorer is a local-first, persistent research graph for websites, crawls, searches, and AI-agent browsing history. Its frontend uses Shallot and WebGPU to upload graph data into typed GPU buffers and draw every visible connection and node in two instanced draw calls.

The current system provides the following capabilities:

- The Shallot/WebGPU viewer switches between a stable 2D overview and a genuinely volumetric 3D scene with independent XYZ positions, orbit controls, perspective projection, depth testing, filtering, neighborhood isolation, node details, and crawl actions.
- A same-origin WebSocket stream pushes crawl lifecycle events and batched node and connection deltas into the open graph in real time.
- The live status badge opens an accessible crawl monitor that shows every pending or running crawl, its starting URL, current URL, depth, visited pages, queued pages, observed edges, and recent completion or failure state.
- The renderer-oriented graph API returns the complete graph by default while retaining optional limits, filters, neighborhoods, and keyset pagination for constrained clients.
- Additive SQLite migrations preserve the original graph while adding durable agents, research sessions, searches, relationships, and idempotent observations.
- AI agents can append searches and sources through a transactional ingestion API or the dependency-free Python bridge.
- The crawler uses shared asynchronous HTTP sessions, bounded concurrency, timeouts, page and response limits, URL canonicalization, relative-link resolution, redirect validation, and private-network blocking.
- The reusable batch launcher can feed many starting sites into the running service with bounded cross-crawl concurrency, finite request timeouts, and safe transient retries.
- Administrative graph clearing requires a token, and agent ingestion can be protected with a separate optional token.

## Run the application

WebGPU requires a compatible browser and a secure context, which means either `localhost` during local development or HTTPS in a deployed environment. Recent versions of Chrome and Edge are the safest choices.

```powershell
cd "WebPath Explorer"
python -m pip install -r requirements.txt
python map.py
```

Open <http://127.0.0.1:5000>. The compiled frontend is committed under `WebPath Explorer/static/dist`, so running the Python application does not require Node.js.

## Crawl websites

Enter a complete HTTP or HTTPS URL in the sidebar, choose a depth, and select **Launch crawl**. The button remains available while other work is running, so multiple requests can crawl concurrently. Select the live crawl badge in the top bar to inspect current work, and press Escape or select outside the drawer to close it.

The crawler records every discovered link as a graph relationship, but it fetches at most the configured page limit for each search. Depth controls how many breadth-first waves are fetched rather than imposing a rendering limit.

To launch the maintained broad seed set from a terminal, keep the web application running and use:

```powershell
cd "WebPath Explorer"
python tools/batch_crawl.py --depth 4 --concurrency 3
```

Edit `tools/crawl_seeds.txt` to change the default starting sites. You can also pass URLs directly, select another file with `--seed-file`, or adjust request and retry behavior with `--request-timeout`, `--retries`, and `--retry-delay`. Cross-crawl concurrency multiplies the per-crawl HTTP concurrency, so increase it deliberately instead of launching an unbounded burst against SQLite or remote websites.

## Develop the frontend

The exact Shallot 0.4.0 snapshot used by the build is stored as `frontend/vendor/dylanebert-shallot-0.4.0.tgz`. The snapshot was packed from `C:\Users\Bently\Desktop\shallot`, which prevents later edits to that checkout from silently changing WebPath Explorer.

```powershell
cd "WebPath Explorer\frontend"
npm install
npm run build
```

For a live Vite frontend, run `npm run dev` alongside `python map.py`. The production build writes directly to `WebPath Explorer/static/dist`.

The renderer explicitly passes Shallot's supported `NoLoading` implementation. This prevents Shallot's default branded loading overlay from being created while leaving initialization errors visible through WebPath Explorer's non-blocking status and toast UI.

## Connect AI agents

Agents append research with `POST /api/agent/ingest`. Each transactional batch identifies an agent and research session and can contain one search, many sources, and relationships. Stable `event_id` values make retries idempotent.

An agent can also call the included bridge:

```powershell
python tools/agent_client.py research-batch.json
```

See [Agent ingestion](WebPath%20Explorer/docs/agent-ingestion.md) for the complete contract, idempotency rules, and integration example.

## Configure safety and limits

The server binds to `127.0.0.1` and runs without debug mode by default. The following environment variables control its behavior:

- `WEBPATH_DB_PATH` or `WEBPATH_DATABASE` selects the SQLite database path.
- `WEBPATH_ADMIN_TOKEN` is required as `X-Admin-Token` when clearing the graph.
- `WEBPATH_INGEST_TOKEN`, when configured, is required as `X-Ingest-Token` for agent ingestion.
- `WEBPATH_EVENTS_TOKEN` optionally protects the `/ws` live-event stream.
- `WEBPATH_EVENT_HISTORY_SIZE`, `WEBPATH_EVENT_QUEUE_SIZE`, `WEBPATH_EVENT_BATCH_SIZE`, and `WEBPATH_EVENT_HEARTBEAT_SECONDS` control live-event replay, subscriber buffering, delta batching, and heartbeats.
- `WEBPATH_CORS_ORIGINS` defines a comma-separated list of trusted API origins.
- `WEBPATH_MAX_CRAWL_DEPTH`, `WEBPATH_MAX_CRAWL_PAGES`, `WEBPATH_CRAWL_CONCURRENCY`, `WEBPATH_CRAWL_TIMEOUT`, and `WEBPATH_MAX_RESPONSE_BYTES` define crawler limits.
- `WEBPATH_HOST`, `WEBPATH_PORT`, and `WEBPATH_DEBUG` control the local server.

Application-level URL validation reduces server-side request forgery risk, but any internet-facing deployment should also place the crawler behind an egress firewall. Operators should respect remote-site terms, robots policies, and reasonable request rates.

## Verify the repository

Run the backend tests with:

```powershell
cd "WebPath Explorer"
python -m pip install -r requirements-dev.txt
python -m pytest -q --basetemp .pytest-tmp/full
```

Run the frontend type check and production build with:

```powershell
cd "WebPath Explorer\frontend"
npm run build
```

The current graph renders efficiently because drawing is batched on the GPU. End-to-end million-item operation will still require incremental binary graph transfer, append-only or capacity-grown GPU buffers, and batched background database writes so that JSON serialization, full CPU model reconstruction, and SQLite write throughput do not become the limiting stages.

See [Architecture and scaling](WebPath%20Explorer/docs/architecture.md) for the detailed system boundaries and roadmap.
