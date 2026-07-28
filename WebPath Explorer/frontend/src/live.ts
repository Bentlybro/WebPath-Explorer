import type { GraphEdge, GraphNode, NodeId } from "./types";

export type LiveConnectionState = "connecting" | "open" | "closed" | "reconnecting";

export interface CrawlIdentity {
  crawlId?: NodeId;
  jobId?: NodeId;
  searchId?: NodeId;
  url?: string;
}

export type LiveGraphEvent =
  | ({ type: "crawl-start" } & CrawlIdentity)
  | ({
      type: "crawl-progress";
      crawled?: number;
      queued?: number;
      nodes?: number;
      edges?: number;
      message?: string;
    } & CrawlIdentity)
  | ({ type: "node"; node: GraphNode } & CrawlIdentity)
  | ({ type: "edge"; edge: GraphEdge } & CrawlIdentity)
  | ({
      type: "graph-delta";
      nodes: GraphNode[];
      edges: GraphEdge[];
      pagesVisited?: number;
      edgesObserved?: number;
      depth?: number;
      currentUrl?: string;
    } & CrawlIdentity)
  | { type: "graph-changed"; reason?: string }
  | ({ type: "crawl-complete"; message?: string } & CrawlIdentity)
  | ({ type: "crawl-error"; message: string } & CrawlIdentity)
  | { type: "hello" }
  | { type: "unknown"; raw: unknown };

export interface LiveGraphSocketOptions {
  endpoints?: string[];
  onEvent(event: LiveGraphEvent): void;
  onState?(state: LiveConnectionState): void;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function first(source: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function identity(source: JsonRecord): CrawlIdentity {
  const crawlId = first(source, "crawl_id", "crawlId");
  const jobId = first(source, "job_id", "jobId");
  const searchId = first(source, "search_id", "searchId", "original_search_id");
  return {
    crawlId: typeof crawlId === "string" || typeof crawlId === "number" ? crawlId : undefined,
    jobId: typeof jobId === "string" || typeof jobId === "number" ? jobId : undefined,
    searchId:
      typeof searchId === "string" || typeof searchId === "number" ? searchId : undefined,
    url: stringValue(first(source, "url", "starting_url", "startingUrl")),
  };
}

function normalizeNode(value: unknown): GraphNode | null {
  const source = record(value);
  if (!source) return null;
  const id = first(source, "id", "node_id", "nodeId");
  const url = first(source, "url", "canonical_url", "canonicalUrl");
  if ((typeof id !== "string" && typeof id !== "number") || typeof url !== "string") {
    return null;
  }
  return {
    ...(source as unknown as GraphNode),
    id,
    url,
    label: stringValue(first(source, "label", "title", "domain")),
    kind: stringValue(first(source, "kind", "node_type", "nodeType")) ?? "page",
    is_original: Boolean(first(source, "is_original", "isOriginal")),
    visit_count: numberValue(first(source, "visit_count", "visitCount", "visits")),
    first_seen: stringValue(first(source, "first_seen", "first_seen_at", "firstSeen")),
    last_seen: stringValue(first(source, "last_seen", "last_seen_at", "lastSeen")),
  };
}

function normalizeEndpoint(endpoint: string): string {
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${protocol}//${window.location.host}${path}`;
}

function normalizeEdge(value: unknown): GraphEdge | null {
  const source = record(value);
  if (!source) return null;
  const from = first(source, "source", "source_id", "sourceId", "from");
  const to = first(source, "target", "target_id", "targetId", "to");
  const validFrom = typeof from === "string" || typeof from === "number" || record(from);
  const validTo = typeof to === "string" || typeof to === "number" || record(to);
  if (!validFrom || !validTo) return null;
  return {
    ...(source as unknown as GraphEdge),
    source: from as GraphEdge["source"],
    target: to as GraphEdge["target"],
    kind: stringValue(first(source, "kind", "relation", "edge_type")) ?? "links_to",
    weight: numberValue(first(source, "weight")),
  };
}

export function normalizeLiveEvent(raw: unknown): LiveGraphEvent {
  const envelope = record(raw);
  if (!envelope) return { type: "unknown", raw };
  const nested =
    record(envelope.payload) ?? record(envelope.data) ?? record(envelope.event) ?? envelope;
  const merged = { ...envelope, ...nested };
  const rawType = String(
    first(envelope, "type", "event_type", "eventType", "event") ??
      first(nested, "type", "event_type", "eventType") ??
      "",
  )
    .toLowerCase()
    .replace(/[.\s_]+/g, "-");
  const id = identity(merged);

  if (["hello", "connected", "ready", "subscribed"].includes(rawType)) return { type: "hello" };
  if (["crawl-start", "crawl-started", "start", "started"].includes(rawType)) {
    return { type: "crawl-start", ...id };
  }
  if (["crawl-progress", "progress", "crawl-update"].includes(rawType)) {
    return {
      type: "crawl-progress",
      ...id,
      crawled: numberValue(
        first(merged, "crawled", "visited", "pages", "pages_crawled", "pages_visited"),
      ),
      queued: numberValue(first(merged, "queued", "pending", "queue_size", "queued_pages")),
      nodes: numberValue(first(merged, "nodes", "node_count")),
      edges: numberValue(first(merged, "edges", "edge_count", "edges_observed")),
      message: stringValue(first(merged, "message", "status_message")),
    };
  }
  if (["node", "node-added", "graph-node", "crawl-node"].includes(rawType)) {
    const node = normalizeNode(first(merged, "node") ?? merged);
    return node ? { type: "node", node, ...id } : { type: "unknown", raw };
  }
  if (["edge", "edge-added", "graph-edge", "crawl-edge"].includes(rawType)) {
    const edge = normalizeEdge(first(merged, "edge") ?? merged);
    return edge ? { type: "edge", edge, ...id } : { type: "unknown", raw };
  }
  if (["graph-delta", "delta"].includes(rawType)) {
    const nodes = Array.isArray(merged.nodes)
      ? merged.nodes.map(normalizeNode).filter((node): node is GraphNode => node !== null)
      : [];
    const edges = Array.isArray(merged.edges)
      ? merged.edges.map(normalizeEdge).filter((edge): edge is GraphEdge => edge !== null)
      : [];
    return {
      type: "graph-delta",
      ...id,
      nodes,
      edges,
      pagesVisited: numberValue(first(merged, "pages_visited", "pagesVisited")),
      edgesObserved: numberValue(first(merged, "edges_observed", "edgesObserved")),
      depth: numberValue(first(merged, "depth")),
      currentUrl: stringValue(first(merged, "current_url", "currentUrl")),
    };
  }
  if (["graph-changed", "agent-ingested", "ingest-complete"].includes(rawType)) {
    return {
      type: "graph-changed",
      reason: stringValue(first(merged, "reason", "message")),
    };
  }
  if (["crawl-complete", "crawl-completed", "complete", "completed", "done"].includes(rawType)) {
    return {
      type: "crawl-complete",
      ...id,
      message: stringValue(first(merged, "message")),
    };
  }
  if (["crawl-error", "crawl-failed", "error", "failed"].includes(rawType)) {
    return {
      type: "crawl-error",
      ...id,
      message: stringValue(first(merged, "message", "error", "detail")) ?? "Crawl failed",
    };
  }
  return { type: "unknown", raw };
}

export class LiveGraphSocket {
  private readonly endpoints: string[];
  private socket: WebSocket | null = null;
  private endpointIndex = 0;
  private reconnectAttempt = 0;
  private reconnectTimer = 0;
  private stopped = false;
  private openedAt = 0;
  private lastSequence = 0;

  constructor(private readonly options: LiveGraphSocketOptions) {
    this.endpoints = (options.endpoints ?? ["/ws", "/api/events"]).map(normalizeEndpoint);
  }

  connect(): void {
    if (this.stopped || this.socket?.readyState === WebSocket.OPEN) return;
    window.clearTimeout(this.reconnectTimer);
    this.options.onState?.(this.reconnectAttempt ? "reconnecting" : "connecting");
    const baseEndpoint = this.endpoints[this.endpointIndex] ?? this.endpoints[0]!;
    const endpoint = new URL(baseEndpoint);
    if (this.lastSequence > 0) endpoint.searchParams.set("after", String(this.lastSequence));
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.openedAt = performance.now();
      this.reconnectAttempt = 0;
      this.options.onState?.("open");
    });
    socket.addEventListener("message", (message) => {
      void this.handleMessage(message.data);
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.options.onState?.("closed");
      if (this.stopped) return;
      if (!this.openedAt || performance.now() - this.openedAt < 2_000) {
        this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
      }
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  close(): void {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "page closing");
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = Math.min(15_000, 500 * 2 ** Math.min(this.reconnectAttempt, 5));
    const jitter = Math.random() * Math.min(1_000, base * 0.25);
    this.reconnectAttempt++;
    this.options.onState?.("reconnecting");
    this.reconnectTimer = window.setTimeout(() => this.connect(), base + jitter);
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const text = data instanceof Blob ? await data.text() : String(data);
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          this.captureSequence(item);
          this.options.onEvent(normalizeLiveEvent(item));
        }
      } else {
        this.captureSequence(parsed);
        this.options.onEvent(normalizeLiveEvent(parsed));
      }
    } catch {
      this.options.onEvent({ type: "unknown", raw: data });
    }
  }

  private captureSequence(value: unknown): void {
    const source = record(value);
    const sequence = numberValue(source?.sequence);
    if (sequence !== undefined) this.lastSequence = Math.max(this.lastSequence, sequence);
  }
}
