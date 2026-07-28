import type {
  CrawlRequest,
  CrawlResponse,
  GraphDataset,
  GraphEdge,
  GraphNode,
  GraphPage,
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
