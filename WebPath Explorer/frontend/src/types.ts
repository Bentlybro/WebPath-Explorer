export type NodeId = string | number;

export type NodeKind = "page" | "domain" | "search" | "claim" | "agent" | "artifact" | string;

export interface GraphNode {
  id: NodeId;
  url: string;
  label?: string;
  domain?: string;
  kind?: NodeKind;
  x?: number;
  y?: number;
  z?: number;
  depth?: number;
  visits?: number;
  visit_count?: number;
  is_original?: boolean;
  isOriginalSearch?: boolean;
  first_seen?: string;
  last_seen?: string;
  title?: string;
  status?: number;
  tags?: string[];
  agent_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id?: NodeId;
  source: NodeId | GraphNode;
  target: NodeId | GraphNode;
  kind?: string;
  weight?: number;
  first_seen?: string;
  last_seen?: string;
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  total_domains?: number;
  total_searches?: number;
  total_agents?: number;
  visible_nodes?: number;
  visible_edges?: number;
  updated_at?: string;
}

export interface GraphPage {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats?: GraphStats;
  cursor?: string | null;
  has_more?: boolean;
  truncated?: boolean;
  bounds?: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
  };
}

export interface GraphQuery {
  query?: string;
  domain?: string;
  kind?: string;
  session?: string;
  search?: number | string;
  root?: number | string;
  limit?: number;
  edgeLimit?: number;
  cursor?: string;
}

export interface GraphManifest {
  protocol: string;
  snapshot: string;
  node_high_water: number;
  edge_high_water: number;
  event_sequence: number;
  counts: { nodes: number; edges: number };
  recommended_limits: { nodes: number; edges: number };
  ttl_seconds: number;
}

export interface GraphPageEnvelope<T> {
  protocol: string;
  snapshot: string;
  type: "nodes" | "edges";
  items: T[];
  page: {
    after: number;
    next_after: number | null;
    done: boolean;
    limit: number;
    returned: number;
  };
}

export type CrawlJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled";

export interface CrawlJob {
  id: string;
  status: CrawlJobStatus;
  starting_url: string;
  max_depth: number;
  search_id: number | null;
  pages_visited: number;
  edges_observed: number;
  current_depth: number;
  current_url: string | null;
  error: string | null;
  created_at?: string;
  started_at?: string | null;
  updated_at?: string;
  finished_at?: string | null;
}

export interface CrawlJobList {
  jobs: CrawlJob[];
  count: number;
}

export interface CrawlJobSubmission {
  job: CrawlJob;
  location: string;
}

export interface CrawlRequest {
  starting_url: string;
  max_depth: number;
}

export interface CrawlResponse {
  message: string;
  original_search_id?: number | string;
  search_id?: number | string;
  job_id?: number | string;
  status?: string;
}

export interface SearchRecord {
  url: string;
  max_depth?: number;
  created_at?: string;
}

export interface GraphDataset {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
  truncated: boolean;
  source: "graph" | "graph-v2" | "legacy";
  /** WebSocket sequence captured by the snapshot manifest, when known. */
  eventSequence?: number;
}

export interface NodeView {
  node: GraphNode;
  index: number;
  x: number;
  y: number;
  radius: number;
  color: readonly [number, number, number, number];
  visible: boolean;
  degree: number;
}
