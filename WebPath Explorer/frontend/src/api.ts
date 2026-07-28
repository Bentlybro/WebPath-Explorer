import type {
  CrawlJob,
  CrawlJobList,
  CrawlJobStatus,
  CrawlJobSubmission,
  CrawlRequest,
  CrawlResponse,
  GraphDataset,
  GraphEdge,
  GraphManifest,
  GraphNode,
  GraphPage,
  GraphPageEnvelope,
  GraphQuery,
  GraphStats,
  SearchRecord,
} from "./types";

const DEFAULT_NODE_LIMIT = "all";
const DEFAULT_EDGE_LIMIT = "all";

interface BackendStats {
  nodes?: number;
  edges?: number;
  domains?: number;
  searches?: number;
  agents?: number;
  last_updated_at?: string;
}

interface BackendGraphMeta {
  returned?: { nodes?: number; edges?: number };
  total?: { nodes?: number; edges?: number };
  truncated?: boolean;
}

interface BackendGraphPage extends GraphPage {
  meta?: BackendGraphMeta;
  page?: {
    has_more?: boolean;
    next_after_id?: number | null;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const detail =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : response.statusText;
    throw new ApiError(detail || `Request failed (${response.status})`, response.status, body);
  }
  return body as T;
}

function paramsFor(query: GraphQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  if (query.domain) params.set("domain", query.domain);
  if (query.kind) params.set("kind", query.kind);
  if (query.session) params.set("session", query.session);
  if (query.search !== undefined) params.set("search", String(query.search));
  if (query.root !== undefined) params.set("root", String(query.root));
  if (query.cursor) params.set("after_id", query.cursor);
  params.set("node_limit", String(query.limit ?? DEFAULT_NODE_LIMIT));
  params.set("edge_limit", String(query.edgeLimit ?? DEFAULT_EDGE_LIMIT));
  return params;
}

function normalizeStats(
  raw: GraphStats | undefined,
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphStats {
  return {
    total_nodes: raw?.total_nodes ?? nodes.length,
    total_edges: raw?.total_edges ?? edges.length,
    total_domains: raw?.total_domains,
    total_searches: raw?.total_searches,
    total_agents: raw?.total_agents,
    visible_nodes: nodes.length,
    visible_edges: edges.length,
    updated_at: raw?.updated_at,
  };
}

function normalizePage(raw: BackendGraphPage, backendStats?: BackendStats): GraphDataset {
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edges = Array.isArray(raw.edges) ? raw.edges : [];
  const totals = raw.meta?.total;
  const mappedStats: GraphStats = {
    total_nodes: backendStats?.nodes ?? totals?.nodes ?? nodes.length,
    total_edges: backendStats?.edges ?? totals?.edges ?? edges.length,
    total_domains: backendStats?.domains,
    total_searches: backendStats?.searches,
    total_agents: backendStats?.agents,
    visible_nodes: raw.meta?.returned?.nodes ?? nodes.length,
    visible_edges: raw.meta?.returned?.edges ?? edges.length,
    updated_at: backendStats?.last_updated_at,
  };
  return {
    nodes,
    edges,
    stats: normalizeStats(raw.stats ?? mappedStats, nodes, edges),
    truncated: Boolean(
      raw.truncated || raw.has_more || raw.page?.has_more || raw.meta?.truncated,
    ),
    source: "graph",
  };
}

async function fetchLegacy(signal?: AbortSignal): Promise<GraphDataset> {
  const [nodes, edges, searches] = await Promise.all([
    fetch("/api/nodes", { signal }).then((r) => readJson<GraphNode[]>(r)),
    fetch("/api/edges", { signal }).then((r) => readJson<GraphEdge[]>(r)),
    fetch("/api/original_search_ids", { signal })
      .then((r) => readJson<SearchRecord[]>(r))
      .catch(() => []),
  ]);
  const originals = new Set(searches.map((item) => item.url));
  for (const node of nodes) {
    if (originals.has(node.url)) node.is_original = true;
  }
  return {
    nodes,
    edges,
    stats: {
      total_nodes: nodes.length,
      total_edges: edges.length,
      total_searches: searches.length,
      total_domains: new Set(nodes.map((node) => domainOf(node.url))).size,
      visible_nodes: nodes.length,
      visible_edges: edges.length,
    },
    truncated: false,
    source: "legacy",
  };
}

export async function fetchGraph(
  query: GraphQuery = {},
  signal?: AbortSignal,
): Promise<GraphDataset> {
  const response = await fetch(`/api/graph?${paramsFor(query)}`, { signal });
  if (response.status === 404) return fetchLegacy(signal);
  const [page, backendStats] = await Promise.all([
    readJson<BackendGraphPage>(response),
    fetch("/api/stats", { signal })
      .then((statsResponse) => readJson<BackendStats>(statsResponse))
      .catch(() => undefined),
  ]);
  return normalizePage(page, backendStats);
}

function manifestParamsFor(query: GraphQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  if (query.domain) params.set("domain", query.domain);
  if (query.kind) params.set("kind", query.kind);
  if (query.session) params.set("session", query.session);
  if (query.search !== undefined) params.set("search", String(query.search));
  if (query.root !== undefined) params.set("root", String(query.root));
  return params;
}

export async function fetchBackendStats(signal?: AbortSignal): Promise<BackendStats | null> {
  try {
    const response = await fetch("/api/stats", { signal });
    return await readJson<BackendStats>(response);
  } catch {
    return null;
  }
}

export async function fetchGraphManifest(
  query: GraphQuery = {},
  signal?: AbortSignal,
): Promise<GraphManifest | null> {
  const response = await fetch(`/api/graph/v2/manifest?${manifestParamsFor(query)}`, {
    signal,
  });
  // Older servers without the v2 routes fall back to the legacy graph API.
  if (response.status === 404) return null;
  return readJson<GraphManifest>(response);
}

export async function fetchGraphNodePage(
  snapshot: string,
  after: number,
  limit: number,
  signal?: AbortSignal,
): Promise<GraphPageEnvelope<GraphNode>> {
  const params = new URLSearchParams({
    snapshot,
    after: String(after),
    limit: String(limit),
  });
  return readJson<GraphPageEnvelope<GraphNode>>(
    await fetch(`/api/graph/v2/nodes?${params}`, { signal }),
  );
}

export async function fetchGraphEdgePage(
  snapshot: string,
  after: number,
  limit: number,
  signal?: AbortSignal,
): Promise<GraphPageEnvelope<GraphEdge>> {
  const params = new URLSearchParams({
    snapshot,
    after: String(after),
    limit: String(limit),
  });
  return readJson<GraphPageEnvelope<GraphEdge>>(
    await fetch(`/api/graph/v2/edges?${params}`, { signal }),
  );
}

export interface CrawlLaunchResult {
  kind: "job" | "legacy";
  job?: CrawlJob;
  legacy?: CrawlResponse;
}

export async function launchCrawl(request: CrawlRequest): Promise<CrawlLaunchResult> {
  const response = await fetch("/api/crawls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  // Servers without the durable job API fall back to the synchronous crawl.
  if (response.status === 404 || response.status === 405) {
    return { kind: "legacy", legacy: await startCrawl(request) };
  }
  const submission = await readJson<CrawlJobSubmission>(response);
  return { kind: "job", job: submission.job };
}

export async function fetchCrawlJobs(
  options: { status?: CrawlJobStatus; limit?: number } = {},
): Promise<CrawlJob[]> {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const suffix = params.size ? `?${params}` : "";
  const response = await fetch(`/api/crawls${suffix}`);
  if (response.status === 404) return [];
  const list = await readJson<CrawlJobList>(response);
  return Array.isArray(list.jobs) ? list.jobs : [];
}

export interface CrawlWorkerStatus {
  workers: number;
  threads: number;
  active_jobs: number;
  max_workers: number;
}

export async function fetchCrawlWorkers(): Promise<CrawlWorkerStatus> {
  return readJson<CrawlWorkerStatus>(await fetch("/api/crawls/workers"));
}

export async function setCrawlWorkers(workers: number): Promise<CrawlWorkerStatus> {
  return readJson<CrawlWorkerStatus>(
    await fetch("/api/crawls/workers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workers }),
    }),
  );
}

export async function cancelCrawlJob(jobId: string): Promise<CrawlJob | null> {
  const response = await fetch(`/api/crawls/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (response.status === 404) return null;
  const result = await readJson<{ job: CrawlJob }>(response);
  return result.job;
}

export async function startCrawl(request: CrawlRequest): Promise<CrawlResponse> {
  return readJson<CrawlResponse>(
    await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function clearGraph(adminToken: string): Promise<string> {
  const result = await readJson<{ message?: string }>(
    await fetch("/api/cleardb", {
      method: "POST",
      headers: { "X-Admin-Token": adminToken },
    }),
  );
  return result.message ?? "Graph cleared";
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export const GRAPH_CONTRACT = {
  endpoint: "/api/graph",
  query: ["q", "domain", "session", "search", "root", "node_limit", "edge_limit", "after_id"],
  maxSuggestedNodes: DEFAULT_NODE_LIMIT,
  maxSuggestedEdges: DEFAULT_EDGE_LIMIT,
} as const;
