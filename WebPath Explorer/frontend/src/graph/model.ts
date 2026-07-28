import { domainOf } from "../api";
import type { GraphDataset, GraphEdge, GraphNode, NodeId } from "../types";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const UNKNOWN_COLOR: readonly [number, number, number, number] = [0.36, 0.76, 0.68, 1];
const KIND_COLORS: Record<string, readonly [number, number, number, number]> = {
  page: [0.28, 0.82, 0.72, 1],
  domain: [0.37, 0.62, 1, 1],
  search: [1, 0.72, 0.25, 1],
  claim: [0.96, 0.42, 0.55, 1],
  agent: [0.72, 0.48, 1, 1],
  artifact: [0.43, 0.86, 0.97, 1],
};

export interface FilterState {
  text: string;
  domain: string;
  kind: string;
  originalsOnly: boolean;
  hideIsolated: boolean;
}

export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  volume: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
}

export interface SelectionDetails {
  node: GraphNode;
  index: number;
  incoming: GraphNode[];
  outgoing: GraphNode[];
  degree: number;
}

function idKey(id: NodeId | GraphNode): string {
  if (typeof id === "object") return String(id.id);
  return String(id);
}

function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashUnit(value: string, salt: number): number {
  let h = hash32(value) ^ salt;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function domainColor(domain: string, kind: string): readonly [number, number, number, number] {
  const known = KIND_COLORS[kind];
  if (kind !== "page" && known) return known;
  if (!domain || domain === "unknown") return UNKNOWN_COLOR;
  const hue = hashUnit(domain, 0xa5312);
  const s = 0.58 + hashUnit(domain, 0x19df) * 0.24;
  const l = 0.49 + hashUnit(domain, 0x23ab) * 0.14;
  return hsl(hue, s, l);
}

function hsl(hue: number, saturation: number, lightness: number): [number, number, number, number] {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = lightness - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 1 / 6) {
    r = c;
    g = x;
  } else if (hue < 2 / 6) {
    r = x;
    g = c;
  } else if (hue < 3 / 6) {
    g = c;
    b = x;
  } else if (hue < 4 / 6) {
    g = x;
    b = c;
  } else if (hue < 5 / 6) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [r + m, g + m, b + m, 1];
}

function isOriginal(node: GraphNode): boolean {
  return Boolean(node.is_original ?? node.isOriginalSearch);
}

type Vec3 = readonly [number, number, number];

function directionFor(value: string, salt: number): Vec3 {
  const z = hashUnit(value, salt) * 2 - 1;
  const angle = hashUnit(value, salt ^ 0x9e3779b9) * Math.PI * 2;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return [Math.cos(angle) * radial, Math.sin(angle) * radial, z];
}

function domainCenter(domain: string): Vec3 {
  const direction = directionFor(domain, 0x51f15e);
  // Cube-root radial distribution fills the volume rather than a spherical shell.
  const radius = 360 + Math.cbrt(hashUnit(domain, 0xa19d3)) * 3_000;
  return [direction[0] * radius, direction[1] * radius, direction[2] * radius];
}

function siteForDomain(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const suffix = labels.at(-1) ?? "";
  const secondLevel = labels.at(-2) ?? "";
  const countrySecondLevels = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);
  const take = suffix.length === 2 && countrySecondLevels.has(secondLevel) ? 3 : 2;
  return labels.slice(-take).join(".");
}

function hierarchyTokens(url: string, domain: string): string[] {
  try {
    const parsed = new URL(url);
    const labels = parsed.hostname.toLowerCase().split(".").filter(Boolean);
    const siteLabelCount = domain.split(".").filter(Boolean).length;
    const subdomains =
      labels.length > siteLabelCount ? labels.slice(0, -siteLabelCount).reverse() : [];
    const path = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part).slice(0, 80);
        } catch {
          return part.slice(0, 80);
        }
      });
    return [...subdomains.map((part) => `host:${part}`), ...path.map((part) => `path:${part}`)];
  } catch {
    return [`url:${url || domain}`];
  }
}

export class GraphModel {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly positions: Float32Array;
  readonly positions3D: Float32Array;
  readonly colors: Float32Array;
  readonly meta: Float32Array;
  readonly edgeIndices: Uint32Array;
  readonly degree: Uint32Array;
  readonly domains: string[];
  readonly kinds: string[];
  readonly nodeIndex = new Map<string, number>();
  readonly bounds: GraphBounds;

  private readonly edgeDirections: Uint32Array;
  private readonly adjacencyOffsets: Uint32Array;
  private readonly adjacency: Uint32Array;
  private readonly spatial = new Map<number, number[]>();
  private readonly cellSize = 96;
  private selectedIndex = -1;
  visibleNodeCount = 0;
  visibleEdgeCount = 0;

  constructor(readonly dataset: GraphDataset) {
    this.nodes = dataset.nodes;
    this.edges = dataset.edges;
    const count = this.nodes.length;
    this.positions = new Float32Array(count * 2);
    this.positions3D = new Float32Array(count * 4);
    this.colors = new Float32Array(count * 4);
    this.meta = new Float32Array(count * 4);
    this.degree = new Uint32Array(count);
    this.domains = new Array<string>(count);
    this.kinds = new Array<string>(count);

    for (let i = 0; i < count; i++) {
      const node = this.nodes[i];
      if (!node) continue;
      this.nodeIndex.set(String(node.id), i);
    }

    const validEdges: number[] = [];
    const directions: number[] = [];
    for (const edge of this.edges) {
      const source = this.nodeIndex.get(idKey(edge.source));
      const target = this.nodeIndex.get(idKey(edge.target));
      if (source === undefined || target === undefined) continue;
      validEdges.push(source, target);
      directions.push(source, target);
      this.degree[source]++;
      this.degree[target]++;
    }
    this.edgeIndices = Uint32Array.from(validEdges);
    this.edgeDirections = Uint32Array.from(directions);

    this.adjacencyOffsets = new Uint32Array(count + 1);
    for (let i = 0; i < count; i++) {
      this.adjacencyOffsets[i + 1] = this.adjacencyOffsets[i]! + this.degree[i]!;
    }
    this.adjacency = new Uint32Array(this.adjacencyOffsets[count]);
    const writeHeads = this.adjacencyOffsets.slice(0, count);
    for (let i = 0; i < this.edgeIndices.length; i += 2) {
      const source = this.edgeIndices[i]!;
      const target = this.edgeIndices[i + 1]!;
      this.adjacency[writeHeads[source]!] = target;
      writeHeads[source]++;
      this.adjacency[writeHeads[target]!] = source;
      writeHeads[target]++;
    }

    this.bounds = this.createLayout();
    this.updateFilter({
      text: "",
      domain: "",
      kind: "",
      originalsOnly: false,
      hideIsolated: false,
    });
    this.createSpatialIndex();
  }

  private createLayout(): GraphBounds {
    const domainIndices = new Map<string, number>();
    const domainCounts = new Map<string, number>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let min3DX = Infinity;
    let min3DY = Infinity;
    let min3DZ = Infinity;
    let max3DX = -Infinity;
    let max3DY = -Infinity;
    let max3DZ = -Infinity;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (!node) continue;
      const domain = node.domain || domainOf(node.url);
      const site = siteForDomain(domain);
      const kind = node.kind || "page";
      this.domains[i] = domain;
      this.kinds[i] = kind;

      let x = Number(node.x);
      let y = Number(node.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        let domainIndex = domainIndices.get(domain);
        if (domainIndex === undefined) {
          domainIndex = domainIndices.size;
          domainIndices.set(domain, domainIndex);
        }
        const localIndex = domainCounts.get(domain) ?? 0;
        domainCounts.set(domain, localIndex + 1);

        const clusterRadius = 420 * Math.sqrt(domainIndex + 0.25);
        const clusterAngle = domainIndex * GOLDEN_ANGLE;
        const clusterX = Math.cos(clusterAngle) * clusterRadius;
        const clusterY = Math.sin(clusterAngle) * clusterRadius;
        const localAngle = hashUnit(node.url || String(node.id), 0x7781) * Math.PI * 2;
        const localRadius =
          18 + Math.sqrt(localIndex) * 11 + hashUnit(node.url || String(node.id), 0x35cf) * 32;
        x = clusterX + Math.cos(localAngle) * localRadius;
        y = clusterY + Math.sin(localAngle) * localRadius;
      }

      this.positions[i * 2] = x;
      this.positions[i * 2 + 1] = y;
      const explicit3D = node.metadata?.position3d;
      let x3 = Array.isArray(explicit3D) ? Number(explicit3D[0]) : Number.NaN;
      let y3 = Array.isArray(explicit3D) ? Number(explicit3D[1]) : Number.NaN;
      let z3 = Array.isArray(explicit3D) ? Number(explicit3D[2]) : Number.NaN;
      if (!Number.isFinite(x3) || !Number.isFinite(y3) || !Number.isFinite(z3)) {
        const center = domainCenter(site);
        x3 = center[0];
        y3 = center[1];
        z3 = center[2];
        const tokens = kind === "domain" ? [] : hierarchyTokens(node.url, site);
        let prefix = `site:${site}`;
        for (let level = 0; level < tokens.length; level++) {
          prefix += `/${tokens[level]}`;
          const direction = directionFor(prefix, 0x71c49 + level * 131);
          const step = Math.max(28, 170 / (1 + level * 0.2));
          x3 += direction[0] * step;
          y3 += direction[1] * step;
          z3 += direction[2] * step;
        }
        if ((node.depth ?? 0) > 0) {
          const crawlDirection = directionFor(`${prefix}|crawl:${node.depth}`, 0xc2b2ae);
          const crawlStep = Math.min(180, (node.depth ?? 0) * 24);
          x3 += crawlDirection[0] * crawlStep;
          y3 += crawlDirection[1] * crawlStep;
          z3 += crawlDirection[2] * crawlStep;
        }
        if (kind !== "page" && kind !== "domain") {
          const kindDirection = directionFor(`kind:${kind}`, 0x27d4eb);
          x3 += kindDirection[0] * 110;
          y3 += kindDirection[1] * 110;
          z3 += kindDirection[2] * 110;
        }
        const jitter = directionFor(`${node.url}|${String(node.id)}`, 0x165667);
        const jitterScale = 4 + hashUnit(node.url, 0xd3a264) * 8;
        x3 += jitter[0] * jitterScale;
        y3 += jitter[1] * jitterScale;
        z3 += jitter[2] * jitterScale;
      }
      const position3DOffset = i * 4;
      this.positions3D[position3DOffset] = x3;
      this.positions3D[position3DOffset + 1] = y3;
      this.positions3D[position3DOffset + 2] = z3;
      this.positions3D[position3DOffset + 3] = 1;
      const color = domainColor(domain, kind);
      this.colors.set(color, i * 4);

      const radius = Math.min(16, 3.3 + Math.log2(this.degree[i]! + 1) * 1.15);
      this.meta[i * 4] = isOriginal(node) ? Math.max(7.5, radius) : radius;
      this.meta[i * 4 + 1] = 1;
      this.meta[i * 4 + 2] = 0;
      this.meta[i * 4 + 3] = isOriginal(node) ? 1 : 0;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      min3DX = Math.min(min3DX, x3);
      min3DY = Math.min(min3DY, y3);
      min3DZ = Math.min(min3DZ, z3);
      max3DX = Math.max(max3DX, x3);
      max3DY = Math.max(max3DY, y3);
      max3DZ = Math.max(max3DZ, z3);
    }
    if (!Number.isFinite(minX)) {
      return {
        minX: -1,
        minY: -1,
        maxX: 1,
        maxY: 1,
        volume: { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 },
      };
    }
    return {
      minX,
      minY,
      maxX,
      maxY,
      volume: {
        minX: min3DX,
        minY: min3DY,
        minZ: min3DZ,
        maxX: max3DX,
        maxY: max3DY,
        maxZ: max3DZ,
      },
    };
  }

  private createSpatialIndex(): void {
    for (let i = 0; i < this.nodes.length; i++) {
      const x = this.positions[i * 2]!;
      const y = this.positions[i * 2 + 1]!;
      const key = this.cellKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
      let bucket = this.spatial.get(key);
      if (!bucket) {
        bucket = [];
        this.spatial.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private cellKey(x: number, y: number): number {
    return ((x & 0xffff) << 16) ^ (y & 0xffff);
  }

  updateFilter(filter: FilterState): void {
    const text = filter.text.trim().toLowerCase();
    let visible = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (!node) continue;
      const domain = this.domains[i] ?? "unknown";
      const kind = this.kinds[i] ?? "page";
      const matchesText =
        !text ||
        node.url.toLowerCase().includes(text) ||
        (node.label ?? node.title ?? "").toLowerCase().includes(text) ||
        domain.includes(text);
      const show =
        matchesText &&
        (!filter.domain || domain === filter.domain) &&
        (!filter.kind || kind === filter.kind) &&
        (!filter.originalsOnly || isOriginal(node)) &&
        (!filter.hideIsolated || this.degree[i]! > 0);
      this.meta[i * 4 + 1] = show ? 1 : 0;
      if (show) visible++;
    }
    this.visibleNodeCount = visible;

    let visibleEdges = 0;
    for (let i = 0; i < this.edgeIndices.length; i += 2) {
      const source = this.edgeIndices[i]!;
      const target = this.edgeIndices[i + 1]!;
      if (this.meta[source * 4 + 1] && this.meta[target * 4 + 1]) visibleEdges++;
    }
    this.visibleEdgeCount = visibleEdges;
  }

  setSelected(index: number): void {
    if (this.selectedIndex >= 0) this.meta[this.selectedIndex * 4 + 2] = 0;
    this.selectedIndex = index >= 0 && index < this.nodes.length ? index : -1;
    if (this.selectedIndex >= 0) this.meta[this.selectedIndex * 4 + 2] = 1;
  }

  showNeighborhood(index: number): number {
    if (index < 0 || index >= this.nodes.length) return 0;
    this.meta.forEach((_value, metaIndex) => {
      if (metaIndex % 4 === 1) this.meta[metaIndex] = 0;
    });
    this.meta[index * 4 + 1] = 1;
    let visibleNodes = 1;
    const neighbors = this.neighborIndices(index);
    for (const neighbor of neighbors) {
      if (this.meta[neighbor * 4 + 1] < 0.5) {
        this.meta[neighbor * 4 + 1] = 1;
        visibleNodes++;
      }
    }
    this.visibleNodeCount = visibleNodes;
    let visibleEdges = 0;
    for (let i = 0; i < this.edgeIndices.length; i += 2) {
      const source = this.edgeIndices[i]!;
      const target = this.edgeIndices[i + 1]!;
      if (this.meta[source * 4 + 1] && this.meta[target * 4 + 1]) visibleEdges++;
    }
    this.visibleEdgeCount = visibleEdges;
    return this.visibleNodeCount;
  }

  getSelected(): number {
    return this.selectedIndex;
  }

  pick(
    worldX: number,
    worldY: number,
    worldRadius: number,
    radiusForIndex?: (index: number) => number,
  ): number {
    const minCellX = Math.floor((worldX - worldRadius) / this.cellSize);
    const maxCellX = Math.floor((worldX + worldRadius) / this.cellSize);
    const minCellY = Math.floor((worldY - worldRadius) / this.cellSize);
    const maxCellY = Math.floor((worldY + worldRadius) / this.cellSize);
    let closest = -1;
    let closestDistance = Infinity;
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
        const bucket = this.spatial.get(this.cellKey(cellX, cellY));
        if (!bucket) continue;
        for (const index of bucket) {
          if (!this.meta[index * 4 + 1]) continue;
          const dx = this.positions[index * 2]! - worldX;
          const dy = this.positions[index * 2 + 1]! - worldY;
          const distance = dx * dx + dy * dy;
          const candidateRadius = radiusForIndex?.(index) ?? worldRadius;
          if (
            distance < candidateRadius * candidateRadius &&
            distance < closestDistance
          ) {
            closest = index;
            closestDistance = distance;
          }
        }
      }
    }
    return closest;
  }

  selectionDetails(index: number, limit = 16): SelectionDetails | null {
    const node = this.nodes[index];
    if (!node) return null;
    const incoming: GraphNode[] = [];
    const outgoing: GraphNode[] = [];
    for (let i = 0; i < this.edgeDirections.length; i += 2) {
      const source = this.edgeDirections[i]!;
      const target = this.edgeDirections[i + 1]!;
      if (target === index && incoming.length < limit) {
        const candidate = this.nodes[source];
        if (candidate) incoming.push(candidate);
      }
      if (source === index && outgoing.length < limit) {
        const candidate = this.nodes[target];
        if (candidate) outgoing.push(candidate);
      }
      if (incoming.length >= limit && outgoing.length >= limit) break;
    }
    return { node, index, incoming, outgoing, degree: this.degree[index] ?? 0 };
  }

  neighborIndices(index: number): Uint32Array {
    if (index < 0 || index >= this.nodes.length) return new Uint32Array();
    const start = this.adjacencyOffsets[index]!;
    const end = this.adjacencyOffsets[index + 1]!;
    return this.adjacency.subarray(start, end);
  }

  findFirst(query: string): number {
    const needle = query.trim().toLowerCase();
    if (!needle) return -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (
        node &&
        (node.url.toLowerCase().includes(needle) ||
          (node.label ?? node.title ?? "").toLowerCase().includes(needle))
      ) {
        return i;
      }
    }
    return -1;
  }

  uniqueDomains(limit = 300): string[] {
    const counts = new Map<string, number>();
    for (const domain of this.domains) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([domain]) => domain);
  }

  uniqueKinds(): string[] {
    return [...new Set(this.kinds)].sort();
  }
}
