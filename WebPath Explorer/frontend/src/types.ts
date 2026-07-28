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
  source: "graph" | "legacy";
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
