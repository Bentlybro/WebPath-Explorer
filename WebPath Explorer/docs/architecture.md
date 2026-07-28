# Architecture and scaling

WebPath Explorer separates ingestion, storage and query, live delivery, CPU-side graph modeling, and GPU rendering. This separation is deliberate because drawing millions of primitives cheaply does not make an unbounded JSON response, a full CPU model rebuild, or an unindexed database operation cheap.

## Data flow

```text
Manual crawl ----\
                  +--> validation and canonicalization --> SQLite research graph
AI agent batch --/                                         |
                  |                                        +--> /api/graph/v2 progressive snapshot
                  |                                        +--> /api/graph legacy snapshot
                  +---------------------------------------->+--> /ws graph deltas
                                                           |
                                                           v
                                             GraphModel typed arrays
                                                           |
                                                           v
                                             Shallot compute graph
                                                           |
                                                           v
                                                        WebGPU
```

## Storage boundary

`webpath/graph_store.py` initializes and additively migrates SQLite. The original node, edge, and search data remains compatible, while the expanded schema records stable agent identities, research sessions, search provenance and lifecycle, and append-only observations.

URLs are conservatively canonicalized. Nodes and relationships are upserted, while observations preserve which agent saw an item, in which session, and at what time. A stable `event_id` makes agent delivery idempotent.

SQLite runs in WAL mode so readers can continue while crawls write. Each `GraphStore` also uses a re-entrant write lock and `BEGIN IMMEDIATE` transactions to serialize writes from concurrent Flask crawler threads, prevent intermittent `database is locked` failures, preserve nested ingestion operations, and roll back a failed batch as one unit. The process must be restarted after this code changes so an already running server loads the new transaction behavior.

SQLite is a practical local-first store for the current milestone. At much larger sustained ingestion rates, the `GraphStore` boundary is the correct place to introduce a dedicated writer queue, batched commits, or another graph or columnar backend without coupling storage to the renderer.

## Crawl boundary

`POST /api/crawls` validates the starting URL, creates a durable crawl-job record, and returns HTTP 202 immediately with a `Location` header. A bounded pool of worker threads (`WEBPATH_CRAWL_JOB_WORKERS`, default two) claims queued jobs atomically and runs each bounded breadth-first crawl with one asynchronous HTTP session and a semaphore-controlled request pool. Durable progress is coalesced to roughly four writes per second, and `GET /api/crawls` and `GET /api/crawls/<job_id>` expose queued, running, and terminal states so the browser can rebuild its crawl monitor after a refresh.

`DELETE /api/crawls/<job_id>` cancels idempotently: a queued job becomes `cancelled`, a running job becomes `cancel_requested`, and the crawler cooperatively abandons its in-flight fetch wave before publishing `crawl_cancelled`. Interrupted `running` jobs are requeued when a process starts, interrupted `cancel_requested` jobs become cancelled, and their associated search rows are marked failed, so a restart never loses or duplicates work.

`POST /api/search` remains available as the synchronous compatibility path, and the browser falls back to it automatically when the job API is absent.

`tools/batch_crawl.py` orchestrates many API requests with a second, cross-crawl concurrency limit. It applies a finite request timeout, caps connection establishment time, retries only connector failures and transient HTTP responses, releases its semaphore before retry backoff, and never automatically retries a timed-out POST because the server may still be processing that crawl.

Cross-crawl concurrency multiplies the HTTP concurrency inside each crawl. This is useful for throughput, but responsible configurations must account for local SQLite write capacity, available bandwidth, and the load placed on remote sites.

## Query boundary

`GET /api/graph/v2/manifest` creates an opaque snapshot token that captures node, edge, and observation high-water marks in one short read transaction, binds query, domain, kind, session, search, and root-neighborhood filters to the token, and records the live-event sequence current at manifest time. `GET /api/graph/v2/nodes` and `GET /api/graph/v2/edges` then page the snapshot with independent keyset cursors: the client finishes the node phase before starting the edge phase, which preserves edges whose endpoints land in different node chunks. Pages never hold a long SQLite read transaction, so paging cannot block WAL checkpoints, and records appended after the manifest are excluded by the high-water marks. Expired or unknown tokens return HTTP 409, unknown roots return HTTP 404, and invalid cursors or limits return HTTP 400.

The browser loads the complete graph in one request because Shallot renders the full buffer set immediately, and stages live deltas that arrive during the load so they are appended to the new model as soon as it becomes current. The v2 snapshot API remains available for constrained clients and future very large graphs. `GET /api/graph` remains unchanged as the legacy fallback and still returns the complete graph by default with optional limits, filters, neighborhoods, and keyset pagination.

Renderer capacity and transfer capacity are separate concerns. Snapshot paging removes the single enormous JSON response, and a future million-item view should additionally stream binary or columnar pages that map directly into typed arrays.

## Live event boundary

`/ws` uses the `webpath.events.v1` protocol. Every crawl publishes lifecycle events and renderer-compatible `graph_delta` batches containing newly observed nodes and connections. The browser coalesces bursts, preserves the current camera, updates its crawl monitor, and performs a final HTTP snapshot reconciliation after the active crawl group drains.

Agent ingestion publishes `graph_changed`, which causes connected viewers to resynchronize without polling. Events carry monotonic sequence numbers, reconnecting browsers request events after the last sequence they applied, and bounded subscriber queues and replay history prevent a slow tab from blocking ingestion.

Live deltas now append into the incremental `GraphModel` instead of rebuilding it. The model deduplicates nodes and edges, queues edges whose endpoints have not arrived yet, and reports dirty index ranges, so a coalesced burst uploads only the changed typed-array ranges to the GPU rather than replacing every buffer.

## CPU graph model

`GraphModel` converts API records into geometrically grown typed arrays for positions, colors, state flags, and edge endpoints. Nodes and edges are append-only: the initial dataset, progressive snapshot pages, and live deltas all flow through the same append path, which preserves filter and selection state, deduplicates by node identity and edge key, and queues edges whose endpoints have not arrived yet. Adjacency is maintained as per-node linked lists so inserting a connection is O(1), and the spatial grid used for low-latency hover and selection is extended incrementally with every appended node.

The 2D layout provides a stable overview. The 3D layout stores independent XYZ coordinates, places deterministic site centers throughout a volume, and branches pages according to domains, subdomains, URL paths, crawl depth, and entity kind. Small deterministic offsets prevent exact overlap without turning the graph into random visual noise.

Text filters and neighborhood isolation change visibility state rather than creating thousands of DOM elements. A naive all-pairs CPU force simulation must not be introduced because it would erase the performance advantage of the renderer.

## Shallot and WebGPU boundary

The frontend starts Shallot with its default plugin bundle disabled and enables only the compute plugin, viewport plugin, the WebPath render plugin, and the explicit `NoLoading` implementation. Passing `NoLoading` is required because Shallot registers its branded `shallotDark` loader separately from plugin defaults.

Graph records are not represented as one Shallot entity per node. The renderer instead uses contiguous storage buffers with the following architecture:

- One storage buffer contains aligned 2D positions, and another contains aligned XYZ positions packed as four floats per node.
- Additional storage buffers contain colors, visibility and interaction state, and pairs of node indices for edges.
- Buffers are sized to the model's typed-array capacity and grow geometrically; between growth steps the renderer calls `GPUQueue.writeBuffer` only for the dirty node and edge ranges the model reports, and bind groups are rebuilt only when a buffer is actually replaced.
- One instanced line draw renders every visible edge.
- One instanced billboard-quad draw renders every visible circular node.
- The 3D view uses an orbit camera, perspective projection, meaningful volumetric positions, camera-facing billboards, and a resize-aware depth texture.
- The 2D view remains available as a stable overview with direct pan and zoom controls.
- Filtering updates GPU-visible state without producing per-node DOM work.
- Pan, orbit, dolly, zoom, and styling changes update small uniform buffers rather than rebuilding scene objects.

This design keeps draw-call count effectively constant as the graph grows. The remaining large-scale costs are data transfer, JSON parsing, CPU model reconstruction, buffer replacement, GPU memory capacity, and picking strategy rather than the number of draw calls.

## User interface boundary

The application shell is visible immediately and does not display either WebPath Explorer's former full-page loading layer or Shallot's branded default loader. Initialization and renderer errors appear through non-blocking status text and toast notifications.

The top-bar live badge is an accessible button. Its drawer displays pending and running crawls with their starting and current locations, depth, visited pages, queued pages, and observed connections, followed by recent completions and failures. Escape and outside selection dismiss the drawer.

The sidebar contains crawl, graph overview, filtering, display, and database controls. Renderer branding and diagnostics no longer occupy a dedicated sidebar section, although concise GPU buffer information remains available in the status bar for performance awareness.

## Security boundary

- Crawls accept only absolute HTTP or HTTPS URLs without embedded credentials.
- Every starting URL, fetched URL, and redirect is checked against private, loopback, link-local, multicast, and reserved addresses.
- Crawl depth, page count, request concurrency, request duration, redirect count, and response bytes are bounded.
- Graph clearing requires `WEBPATH_ADMIN_TOKEN`.
- Agent ingestion can require `WEBPATH_INGEST_TOKEN`.
- CORS is disabled unless trusted origins are configured explicitly.
- The server is local-only and non-debug by default.

DNS rebinding cannot be eliminated entirely in application code. Production crawling requires network-level egress policy as a second boundary.

## Performance position and next milestones

The current renderer is optimized for a low draw-call count and performs comfortably at the current graph size. During the July 2026 release pass, the live development database produced an approximately 8.9 MB complete graph response in roughly 0.77 to 1.16 seconds during moderate write activity, while a later 9.05 MB response took 12.35 seconds under heavier crawl contention. Narrow Shallot imports reduced the production JavaScript bundle from approximately 470 KB to 104 KB, eliminated four unused generated runtime assets, and returned the new bundle locally in under a quarter of a second while the server was crawling. These numbers are environment-specific smoke measurements rather than universal benchmarks, and the contention result reinforces the need for streamed loading and batched writes.

The project should complete the following milestones before claiming end-to-end million-item performance:

1. Replace paged JSON transport with binary or columnar streaming that maps directly into typed arrays.
2. Batch crawler database writes per fetched page or wave, or route them through a dedicated writer queue, so per-link transactions stop limiting ingestion.
3. Add crawl-job retries, rate policies, and per-domain politeness windows on top of the durable job queue.
4. Add GPU timestamp and interaction benchmarks at 100,000, 1 million, and 3 million nodes and edges. The CPU model path already builds 100,000 nodes and edges in roughly two seconds and appends ten thousand more in tens of milliseconds in an environment-specific Node.js measurement.
5. Replace or augment CPU spatial picking when measured density makes it the interaction bottleneck.
6. Add server-side projections for domain, time, agent, claim, and semantic search.
7. Add snapshots, content hashes, citations, claims, contradiction links, change detection, freshness scoring, retention, export, and backup controls.
8. Publish a stable agent SDK and connectors for each supported agent runtime.
