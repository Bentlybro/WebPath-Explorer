import "./styles.css";
import type { State } from "@dylanebert/shallot";
import {
  cancelCrawlJob,
  clearGraph,
  domainOf,
  fetchCrawlJobs,
  fetchCrawlWorkers,
  fetchGraph,
  launchCrawl,
  setCrawlWorkers,
} from "./api";
import { GraphModel, type FilterState, type SelectionDetails } from "./graph/model";
import { ShallotGraphRenderer, startShallotRenderer } from "./graph/renderer";
import { LiveGraphSocket, type LiveConnectionState, type LiveGraphEvent } from "./live";
import type { CrawlJob, GraphEdge, GraphNode, GraphQuery, NodeId } from "./types";
import { shell } from "./ui/shell";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app root");
app.innerHTML = shell();

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

const canvas = element<HTMLCanvasElement>("#graph-canvas");
const statusMessage = element<HTMLSpanElement>("#status-message");
const livePill = element<HTMLButtonElement>("#live-pill");
const liveText = element<HTMLSpanElement>("#live-text");
const liveCrawls = element<HTMLDivElement>(".live-crawls");
const crawlDrawer = element<HTMLElement>("#crawl-drawer");
const crawlConnection = element<HTMLSpanElement>("#crawl-connection");
const crawlRunningCount = element<HTMLSpanElement>("#crawl-running-count");
const crawlRunningList = element<HTMLDivElement>("#crawl-running-list");
const crawlRecentSection = element<HTMLElement>("#crawl-recent-section");
const crawlRecentList = element<HTMLDivElement>("#crawl-recent-list");
const crawlEmpty = element<HTMLParagraphElement>("#crawl-empty");
const graphSearch = element<HTMLInputElement>("#graph-search");
const graphSearchForm = element<HTMLFormElement>("#graph-search-form");
const domainFilter = element<HTMLSelectElement>("#domain-filter");
const kindFilter = element<HTMLSelectElement>("#kind-filter");
const originalsFilter = element<HTMLInputElement>("#originals-filter");
const isolatedFilter = element<HTMLInputElement>("#isolated-filter");
const nodeScale = element<HTMLInputElement>("#node-scale");
const nodeScaleValue = element<HTMLSpanElement>("#node-scale-value");
const edgeAlpha = element<HTMLInputElement>("#edge-alpha");
const edgeAlphaValue = element<HTMLSpanElement>("#edge-alpha-value");
const clusterSpread = element<HTMLInputElement>("#cluster-spread");
const clusterSpreadValue = element<HTMLSpanElement>("#cluster-spread-value");
const nodeSpread = element<HTMLInputElement>("#node-spread");
const nodeSpreadValue = element<HTMLSpanElement>("#node-spread-value");
const workerCount = element<HTMLInputElement>("#worker-count");
const crawlForm = element<HTMLFormElement>("#crawl-form");
const crawlUrl = element<HTMLInputElement>("#crawl-url");
const crawlDepth = element<HTMLInputElement>("#crawl-depth");
const fitButton = element<HTMLButtonElement>("#fit-button");
const reloadButton = element<HTMLButtonElement>("#reload-button");
const clearButton = element<HTMLButtonElement>("#clear-button");
const zoomStatus = element<HTMLSpanElement>("#zoom-status");
const gpuMemory = element<HTMLSpanElement>("#gpu-memory");
const detailsPanel = element<HTMLElement>("#details-panel");
const detailsClose = element<HTMLButtonElement>("#details-close");
const detailKind = element<HTMLSpanElement>("#detail-kind");
const detailTitle = element<HTMLHeadingElement>("#detail-title");
const detailUrl = element<HTMLSpanElement>("#detail-url");
const detailMeta = element<HTMLDListElement>("#detail-meta");
const detailOpen = element<HTMLButtonElement>("#detail-open");
const detailCopy = element<HTMLButtonElement>("#detail-copy");
const detailCrawl = element<HTMLButtonElement>("#detail-crawl");
const detailNeighbors = element<HTMLButtonElement>("#detail-neighbors");
const outgoingList = element<HTMLUListElement>("#outgoing-list");
const incomingList = element<HTMLUListElement>("#incoming-list");
const outgoingCount = element<HTMLSpanElement>("#outgoing-count");
const incomingCount = element<HTMLSpanElement>("#incoming-count");
const outgoingGroup = element<HTMLDivElement>("#outgoing-group");
const incomingGroup = element<HTMLDivElement>("#incoming-group");
const tooltip = element<HTMLDivElement>("#tooltip");
const tooltipTitle = element<HTMLElement>("#tooltip-title");
const tooltipMeta = element<HTMLSpanElement>("#tooltip-meta");
const contextMenu = element<HTMLElement>("#context-menu");
const toastStack = element<HTMLDivElement>("#toast-stack");
const viewModeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-view-mode]")];
const primaryGesture = element<HTMLSpanElement>("#primary-gesture");
const secondaryGesture = element<HTMLSpanElement>("#secondary-gesture");

const stats = {
  nodes: element<HTMLElement>("#stat-nodes"),
  edges: element<HTMLElement>("#stat-edges"),
  domains: element<HTMLElement>("#stat-domains"),
  searches: element<HTMLElement>("#stat-searches"),
  visibleNodes: element<HTMLElement>("#visible-nodes"),
  visibleEdges: element<HTMLElement>("#visible-edges"),
};

const formatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exactFormatter = new Intl.NumberFormat("en");
const renderer = new ShallotGraphRenderer();
let model: GraphModel | null = null;
let currentDetails: SelectionDetails | null = null;
let contextNodeIndex = -1;
let loadController: AbortController | null = null;
let searchTimer = 0;
let hoverFrame = 0;
let pointerX = 0;
let pointerY = 0;
let shallotState: State | null = null;
let liveConnection: LiveConnectionState = "connecting";
let operationBusy = false;
const activeCrawlIds = new Set<string>();
const pendingCrawlUrls = new Map<string, number>();
const recentCrawlCompletions = new Map<string, number>();
type CrawlActivityState =
  | "pending"
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";
interface CrawlActivity {
  id: string;
  startUrl: string;
  currentUrl: string;
  requestedDepth?: number;
  depth: number;
  pagesVisited: number;
  queuedPages: number;
  edgeCount: number;
  state: CrawlActivityState;
  message?: string;
  startedAt: number;
  finishedAt?: number;
}
const crawlActivities = new Map<string, CrawlActivity>();
const pendingActivityIds = new Map<string, string[]>();
let pendingActivitySerial = 0;
let crawlActivityFrame = 0;
let recentActivityTimer = 0;
const stagedLiveNodes: GraphNode[] = [];
const stagedLiveEdges: GraphEdge[] = [];
let liveFlushTimer = 0;
let liveDirtySince = 0;
let externalResyncTimer = 0;
let finalResyncRunning = false;
let queuedResync: { message?: string } | null = null;
let completionResyncNeeded = false;
let graphLoading = false;

function setBusy(busy: boolean, message?: string): void {
  operationBusy = busy;
  updateLiveIndicator();
  if (message) statusMessage.textContent = message;
}

function updateLiveIndicator(): void {
  const connecting = liveConnection !== "open";
  const crawlCount = currentCrawlCount();
  livePill.classList.toggle("is-busy", operationBusy || crawlCount > 0 || connecting);
  if (operationBusy) liveText.textContent = "Working";
  else if (crawlCount > 0) liveText.textContent = `${crawlCount} crawl${crawlCount === 1 ? "" : "s"}`;
  else if (liveConnection === "open") liveText.textContent = "Live graph";
  else if (liveConnection === "reconnecting") liveText.textContent = "Reconnecting";
  else liveText.textContent = "Connecting";
  scheduleCrawlActivityRender();
}

function crawlId(event: LiveGraphEvent): string | null {
  if ("jobId" in event && event.jobId !== undefined) return `job:${String(event.jobId)}`;
  if ("searchId" in event && event.searchId !== undefined) return `search:${String(event.searchId)}`;
  if ("crawlId" in event && event.crawlId !== undefined) return `crawl:${String(event.crawlId)}`;
  return null;
}

function requestUrlKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function beginCrawlActivity(url: string, requestedDepth: number): void {
  const id = `pending:${++pendingActivitySerial}`;
  const key = requestUrlKey(url);
  const ids = pendingActivityIds.get(key) ?? [];
  ids.push(id);
  pendingActivityIds.set(key, ids);
  crawlActivities.set(id, {
    id,
    startUrl: url,
    currentUrl: url,
    requestedDepth,
    depth: 0,
    pagesVisited: 0,
    queuedPages: 0,
    edgeCount: 0,
    state: "pending",
    startedAt: Date.now(),
  });
  scheduleCrawlActivityRender();
}

function removePendingActivityReference(id: string): void {
  for (const [url, ids] of pendingActivityIds) {
    const next = ids.filter((candidate) => candidate !== id);
    if (next.length) pendingActivityIds.set(url, next);
    else pendingActivityIds.delete(url);
  }
}

function claimPendingActivity(url: string | undefined, key: string | null): CrawlActivity | null {
  if (!url) return null;
  const urlKey = requestUrlKey(url);
  const ids = pendingActivityIds.get(urlKey);
  const pendingId = ids?.shift();
  if (!pendingId) return null;
  if (ids?.length) pendingActivityIds.set(urlKey, ids);
  else pendingActivityIds.delete(urlKey);
  const activity = crawlActivities.get(pendingId);
  if (!activity) return null;
  if (key && key !== pendingId) {
    crawlActivities.delete(pendingId);
    activity.id = key;
    crawlActivities.set(key, activity);
  }
  return activity;
}

function ensureCrawlActivity(event: LiveGraphEvent): CrawlActivity | null {
  const key = crawlId(event);
  const url = "url" in event ? event.url : undefined;
  if (key) {
    const existing = crawlActivities.get(key);
    if (existing) return existing;
    const claimed = claimPendingActivity(url, key);
    if (claimed) return claimed;
  } else if (url) {
    const ids = pendingActivityIds.get(requestUrlKey(url));
    const pending = ids?.[0] ? crawlActivities.get(ids[0]) : undefined;
    if (pending) return pending;
  }

  if (!key) return null;
  const currentUrl = event.type === "graph-delta" ? event.currentUrl : undefined;
  const startUrl = url ?? currentUrl ?? "Unknown starting URL";
  const activity: CrawlActivity = {
    id: key,
    startUrl,
    currentUrl: currentUrl ?? startUrl,
    depth: 0,
    pagesVisited: 0,
    queuedPages: 0,
    edgeCount: 0,
    state: "running",
    startedAt: Date.now(),
  };
  crawlActivities.set(key, activity);
  return activity;
}

function updateCrawlActivity(event: LiveGraphEvent): void {
  const activity = ensureCrawlActivity(event);
  if (!activity || isTerminalActivity(activity.state)) return;
  activity.state = event.type === "crawl-start" ? "running" : activity.state;
  if (event.type !== "crawl-start" && (activity.state === "pending" || activity.state === "queued")) {
    activity.state = "running";
  }
  if ("url" in event && event.url && activity.startUrl === "Unknown starting URL") {
    activity.startUrl = event.url;
  }
  switch (event.type) {
    case "crawl-progress":
      if (event.crawled !== undefined) activity.pagesVisited = Math.max(activity.pagesVisited, event.crawled);
      if (event.queued !== undefined) activity.queuedPages = Math.max(0, event.queued);
      if (event.edges !== undefined) activity.edgeCount = Math.max(activity.edgeCount, event.edges);
      if (event.message) activity.message = event.message;
      break;
    case "graph-delta":
      if (event.currentUrl) activity.currentUrl = event.currentUrl;
      if (event.depth !== undefined) activity.depth = Math.max(activity.depth, event.depth);
      if (event.pagesVisited !== undefined) {
        activity.pagesVisited = Math.max(activity.pagesVisited, event.pagesVisited);
      }
      if (event.edgesObserved !== undefined) {
        activity.edgeCount = Math.max(activity.edgeCount, event.edgesObserved);
      } else {
        activity.edgeCount += event.edges.length;
      }
      break;
    case "edge":
      activity.edgeCount++;
      break;
  }
  scheduleCrawlActivityRender();
}

function isTerminalActivity(state: CrawlActivityState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function completeCrawlActivity(
  key: string | null,
  url: string | undefined,
  message: string | undefined,
  outcome: "completed" | "failed" | "cancelled",
): void {
  let activity = key ? crawlActivities.get(key) : undefined;
  if (!activity) activity = claimPendingActivity(url, key) ?? undefined;
  if (!activity && key) {
    activity = {
      id: key,
      startUrl: url ?? "Unknown starting URL",
      currentUrl: url ?? "Unknown current URL",
      depth: 0,
      pagesVisited: 0,
      queuedPages: 0,
      edgeCount: 0,
      state: outcome,
      startedAt: Date.now(),
    };
    crawlActivities.set(key, activity);
  }
  if (!activity) return;
  removePendingActivityReference(activity.id);
  activity.state = outcome;
  activity.queuedPages = 0;
  activity.message = message;
  activity.finishedAt = Date.now();
  scheduleCrawlActivityRender();
}

function jobStateToActivityState(status: CrawlJob["status"]): CrawlActivityState {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "cancel_requested":
      return "cancelling";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function jobTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Merge a durable crawl job into the activity feed, keyed as job:<uuid>. */
function mergeJobActivity(job: CrawlJob): CrawlActivity {
  const key = `job:${job.id}`;
  let activity = crawlActivities.get(key);
  if (!activity) {
    const claimed = claimPendingActivity(job.starting_url, key);
    activity = claimed ?? undefined;
  }
  const state = jobStateToActivityState(job.status);
  if (!activity) {
    activity = {
      id: key,
      startUrl: job.starting_url,
      currentUrl: job.current_url ?? job.starting_url,
      requestedDepth: job.max_depth,
      depth: job.current_depth,
      pagesVisited: job.pages_visited,
      queuedPages: 0,
      edgeCount: job.edges_observed,
      state,
      startedAt: jobTimestamp(job.started_at) ?? jobTimestamp(job.created_at) ?? Date.now(),
    };
    crawlActivities.set(key, activity);
  }
  activity.requestedDepth = job.max_depth;
  activity.depth = Math.max(activity.depth, job.current_depth);
  activity.pagesVisited = Math.max(activity.pagesVisited, job.pages_visited);
  activity.edgeCount = Math.max(activity.edgeCount, job.edges_observed);
  if (job.current_url) activity.currentUrl = job.current_url;
  if (!isTerminalActivity(activity.state) || isTerminalActivity(state)) {
    activity.state = state;
  }
  if (job.error) activity.message = job.error;
  const finishedAt = jobTimestamp(job.finished_at);
  if (isTerminalActivity(state) && finishedAt !== undefined) {
    activity.finishedAt = finishedAt;
  }
  if (isTerminalActivity(activity.state)) activeCrawlIds.delete(key);
  else activeCrawlIds.add(key);
  return activity;
}

async function refreshCrawlJobs(): Promise<void> {
  try {
    const jobs = await fetchCrawlJobs({ limit: 50 });
    for (const job of jobs) mergeJobActivity(job);
    scheduleCrawlActivityRender();
    updateLiveIndicator();
  } catch {
    // Servers without the durable job API simply skip the merge.
  }
}

async function requestJobCancellation(activity: CrawlActivity): Promise<void> {
  if (!activity.id.startsWith("job:")) return;
  activity.state = "cancelling";
  scheduleCrawlActivityRender();
  try {
    const job = await cancelCrawlJob(activity.id.slice(4));
    if (job) mergeJobActivity(job);
    else toast("That crawl job is no longer available.", true);
  } catch (error) {
    activity.state = "running";
    toast(error instanceof Error ? error.message : String(error), true);
  }
  scheduleCrawlActivityRender();
  updateLiveIndicator();
}

function activityHost(url: string): string {
  const host = domainOf(url);
  return host === "unknown" ? "Research crawl" : host;
}

function activityStatusLabel(state: CrawlActivityState): string {
  switch (state) {
    case "pending":
      return "Launching";
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "cancelling":
      return "Cancelling";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function crawlMetric(label: string, value: string): HTMLDivElement {
  const metric = document.createElement("div");
  const number = document.createElement("strong");
  const caption = document.createElement("span");
  number.textContent = value;
  caption.textContent = label;
  metric.append(number, caption);
  return metric;
}

function crawlUrlLine(label: string, url: string): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "crawl-url-line";
  const caption = document.createElement("span");
  const value = document.createElement("span");
  caption.textContent = label;
  value.textContent = url;
  value.title = url;
  line.append(caption, value);
  return line;
}

function crawlActivityCard(activity: CrawlActivity): HTMLElement {
  const card = document.createElement("article");
  card.className = `crawl-activity is-${activity.state}`;

  const head = document.createElement("div");
  head.className = "crawl-activity-head";
  const identity = document.createElement("div");
  const host = document.createElement("strong");
  const startLabel = document.createElement("span");
  host.textContent = activityHost(activity.startUrl);
  startLabel.textContent = "Start host";
  identity.append(host, startLabel);
  const state = document.createElement("span");
  state.className = "crawl-state";
  state.textContent = activityStatusLabel(activity.state);
  head.append(identity, state);

  const route = document.createElement("div");
  route.className = "crawl-route";
  route.append(crawlUrlLine("Started", activity.startUrl));
  route.append(
    crawlUrlLine(
      "Current",
      `${activityHost(activity.currentUrl)} · ${activity.currentUrl}`,
    ),
  );

  const metrics = document.createElement("div");
  metrics.className = "crawl-metrics";
  const depth =
    activity.requestedDepth !== undefined
      ? `${exactFormatter.format(activity.depth)} / ${exactFormatter.format(activity.requestedDepth)}`
      : exactFormatter.format(activity.depth);
  metrics.append(
    crawlMetric("Depth", depth),
    crawlMetric("Pages", exactFormatter.format(activity.pagesVisited)),
    crawlMetric("Queued", exactFormatter.format(activity.queuedPages)),
    crawlMetric("Edges", exactFormatter.format(activity.edgeCount)),
  );
  card.append(head, route, metrics);
  if (
    activity.id.startsWith("job:") &&
    (activity.state === "queued" || activity.state === "running")
  ) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "crawl-cancel-button";
    cancel.textContent = "Cancel crawl";
    cancel.addEventListener("click", () => void requestJobCancellation(activity));
    card.append(cancel);
  }
  if (activity.message && isTerminalActivity(activity.state)) {
    const message = document.createElement("p");
    message.className = "crawl-activity-message";
    message.textContent = activity.message;
    card.append(message);
  }
  return card;
}

function renderCrawlActivities(): void {
  crawlActivityFrame = 0;
  const now = Date.now();
  const recentCutoff = now - 120_000;
  for (const [key, activity] of crawlActivities) {
    if (activity.finishedAt !== undefined && activity.finishedAt < recentCutoff) {
      crawlActivities.delete(key);
    }
  }

  const active = [...crawlActivities.values()]
    .filter((activity) => !isTerminalActivity(activity.state))
    .sort((left, right) => right.startedAt - left.startedAt);
  const recent = [...crawlActivities.values()]
    .filter((activity) => isTerminalActivity(activity.state))
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))
    .slice(0, 8);

  crawlRunningCount.textContent = exactFormatter.format(active.length);
  crawlEmpty.hidden = active.length > 0;
  crawlRunningList.replaceChildren(...active.map(crawlActivityCard));
  crawlRecentSection.hidden = recent.length === 0;
  crawlRecentList.replaceChildren(...recent.map(crawlActivityCard));
  crawlConnection.textContent =
    liveConnection === "open"
      ? "Connected"
      : liveConnection === "reconnecting"
        ? "Reconnecting"
        : liveConnection === "closed"
          ? "Offline"
          : "Connecting";
  crawlConnection.classList.toggle("is-online", liveConnection === "open");

  window.clearTimeout(recentActivityTimer);
  const oldestVisible = recent.at(-1)?.finishedAt;
  if (oldestVisible !== undefined) {
    recentActivityTimer = window.setTimeout(
      scheduleCrawlActivityRender,
      Math.max(1_000, oldestVisible + 120_000 - now),
    );
  }
}

function scheduleCrawlActivityRender(): void {
  if (crawlActivityFrame) return;
  crawlActivityFrame = requestAnimationFrame(renderCrawlActivities);
}

function setCrawlDrawerOpen(open: boolean): void {
  crawlDrawer.hidden = !open;
  livePill.setAttribute("aria-expanded", String(open));
  livePill.classList.toggle("is-open", open);
  if (open) scheduleCrawlActivityRender();
}

function pendingCrawlCount(): number {
  let count = 0;
  for (const value of pendingCrawlUrls.values()) count += value;
  return count;
}

function currentCrawlCount(): number {
  return activeCrawlIds.size + pendingCrawlCount();
}

function addPendingCrawl(url: string): void {
  const key = requestUrlKey(url);
  pendingCrawlUrls.set(key, (pendingCrawlUrls.get(key) ?? 0) + 1);
}

function consumePendingCrawl(url?: string): void {
  if (!url) return;
  const key = requestUrlKey(url);
  const count = pendingCrawlUrls.get(key) ?? 0;
  if (count <= 1) pendingCrawlUrls.delete(key);
  else pendingCrawlUrls.set(key, count - 1);
}

function trackLiveCrawl(event: LiveGraphEvent): void {
  const key = crawlId(event);
  if (key && recentCrawlCompletions.has(key)) return;
  updateCrawlActivity(event);
  if (key) activeCrawlIds.add(key);
  if ("url" in event) consumePendingCrawl(event.url);
  updateLiveIndicator();
}

function responseCrawlId(result: {
  search_id?: NodeId;
  original_search_id?: NodeId;
  job_id?: NodeId;
}): string | null {
  if (result.job_id !== undefined) return `job:${String(result.job_id)}`;
  const searchId = result.search_id ?? result.original_search_id;
  if (searchId !== undefined) return `search:${String(searchId)}`;
  return null;
}

function trimRecentCrawlCompletions(now: number): void {
  for (const [key, completedAt] of recentCrawlCompletions) {
    if (now - completedAt > 15_000) recentCrawlCompletions.delete(key);
  }
}

function finishTrackedCrawl(
  key: string | null,
  url?: string,
  message?: string,
  outcome: "completed" | "failed" | "cancelled" = "completed",
): void {
  const now = performance.now();
  trimRecentCrawlCompletions(now);
  consumePendingCrawl(url);
  completeCrawlActivity(key, url, message, outcome);

  if (key && recentCrawlCompletions.has(key)) {
    activeCrawlIds.delete(key);
    updateLiveIndicator();
    return;
  }
  if (key) {
    activeCrawlIds.delete(key);
    recentCrawlCompletions.set(key, now);
  }

  completionResyncNeeded = true;
  const remaining = currentCrawlCount();
  updateLiveIndicator();
  if (outcome === "failed" && message) toast(message, true);

  if (remaining === 0) {
    completionResyncNeeded = false;
    void finalGraphResync(outcome === "failed" ? undefined : message);
    return;
  }

  statusMessage.textContent = `${exactFormatter.format(remaining)} crawl${
    remaining === 1 ? "" : "s"
  } still running · graph streaming live`;
  if (outcome === "completed" && message) toast(message);
}

function toast(message: string, error = false): void {
  const item = document.createElement("div");
  item.className = `toast${error ? " is-error" : ""}`;
  item.textContent = message;
  toastStack.append(item);
  window.setTimeout(() => item.remove(), 4400);
}

function filterState(): FilterState {
  return {
    text: graphSearch.value,
    domain: domainFilter.value,
    kind: kindFilter.value,
    originalsOnly: originalsFilter.checked,
    hideIsolated: isolatedFilter.checked,
  };
}

function updateVisibleStats(): void {
  if (!model) return;
  stats.visibleNodes.textContent = exactFormatter.format(model.visibleNodeCount);
  stats.visibleEdges.textContent = exactFormatter.format(model.visibleEdgeCount);
}

function applyFilters(): void {
  if (!model) return;
  model.updateFilter(filterState());
  renderer.updateMeta();
  updateVisibleStats();
  statusMessage.textContent = `${formatter.format(model.visibleNodeCount)} nodes in the active view`;
}

function addOptions(select: HTMLSelectElement, values: string[]): void {
  while (select.options.length > 1) select.remove(1);
  const fragment = document.createDocumentFragment();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    fragment.append(option);
  }
  select.append(fragment);
}

function updateStats(): void {
  if (!model) return;
  const graphStats = model.dataset.stats;
  stats.nodes.textContent = formatter.format(graphStats.total_nodes);
  stats.edges.textContent = formatter.format(graphStats.total_edges);
  stats.domains.textContent = formatter.format(graphStats.total_domains ?? new Set(model.domains).size);
  stats.searches.textContent =
    graphStats.total_searches === undefined ? "—" : formatter.format(graphStats.total_searches);
  updateVisibleStats();
  const snapshot = renderer.snapshot();
  gpuMemory.textContent = `${(snapshot.gpuBytes / 1024 / 1024).toFixed(1)} MB GPU buffers`;
}

function fitGraph(): void {
  if (!model) return;
  renderer.fit(model.framingBounds(), canvas.clientWidth, canvas.clientHeight);
  updateCameraStatus();
}

function updateCameraStatus(): void {
  zoomStatus.textContent = renderer.is3D()
    ? `3D · ${formatter.format(renderer.camera.distance)} distance`
    : `${Math.round(renderer.camera.zoom * 100)}%`;
}

function setViewMode(mode: "2d" | "3d"): void {
  if ((mode === "3d") === renderer.is3D()) return;
  renderer.setViewMode(mode);
  if (mode === "3d") renderer.reset3DOrientation();
  for (const button of viewModeButtons) {
    const active = button.dataset.viewMode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  primaryGesture.textContent = mode === "3d" ? "Drag to orbit" : "Drag to pan";
  secondaryGesture.textContent =
    mode === "3d" ? "Shift/right/middle-drag to pan · Scroll to dolly" : "Scroll to zoom";
  canvas.setAttribute("aria-label", `${mode.toUpperCase()} interactive website relationship graph`);
  fitGraph();
  updateCameraStatus();
  toast(`${mode.toUpperCase()} graph mode`);
}

interface LoadGraphOptions {
  fit?: boolean;
}

/**
 * Load the complete graph in one request and build the typed model in a
 * single pass. Shallot renders the full buffer set immediately, so paging
 * the initial load would only add latency; incremental appends are reserved
 * for live deltas after the load.
 */
async function loadGraph(
  query: GraphQuery = {},
  options: LoadGraphOptions = { fit: true },
): Promise<void> {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  graphLoading = true;
  setBusy(true, "Loading the graph…");
  try {
    const dataset = await fetchGraph(query, controller.signal);
    if (controller.signal.aborted) return;
    statusMessage.textContent = "Building typed graph buffers…";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const nextModel = new GraphModel(dataset, currentLayoutOptions());
    if (controller.signal.aborted) return;
    nextModel.updateFilter(filterState());
    model = nextModel;
    renderer.setModel(nextModel);
    addOptions(domainFilter, nextModel.uniqueDomains());
    addOptions(kindFilter, nextModel.uniqueKinds());
    if (options.fit !== false) fitGraph();
    updateStats();
    updateVisibleStats();
    const sourceLabel = dataset.source === "graph" ? "graph API" : "legacy API bridge";
    statusMessage.textContent = `Loaded ${formatter.format(
      nextModel.nodes.length,
    )} nodes and ${formatter.format(nextModel.edgeCount)} links through ${sourceLabel}${
      dataset.truncated ? " · slice capped" : ""
    }`;
    if (dataset.truncated) {
      toast("This view is a bounded slice of the permanent graph. Refine search to explore more.");
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    statusMessage.textContent = `Graph load failed · ${message}`;
    toast(message, true);
  } finally {
    graphLoading = false;
    if (!controller.signal.aborted) {
      flushLiveGraph();
      setBusy(false);
    }
  }
}

function stageLiveNode(node: GraphNode): void {
  stagedLiveNodes.push(node);
  scheduleLiveFlush();
}

function stageLiveEdge(edge: GraphEdge): void {
  stagedLiveEdges.push(edge);
  scheduleLiveFlush();
}

function scheduleLiveFlush(): void {
  const now = performance.now();
  if (!liveDirtySince) liveDirtySince = now;
  window.clearTimeout(liveFlushTimer);
  const maxWaitRemaining = Math.max(0, 500 - (now - liveDirtySince));
  liveFlushTimer = window.setTimeout(flushLiveGraph, Math.min(100, maxWaitRemaining));
}

/**
 * Append staged live nodes and edges to the incremental model and upload
 * only the dirty ranges to the GPU. Staged data survives while no model is
 * loaded so deltas that arrive before the first snapshot are not lost.
 */
function flushLiveGraph(): void {
  window.clearTimeout(liveFlushTimer);
  liveFlushTimer = 0;
  liveDirtySince = 0;
  // While a full load is in flight, staged deltas keep accumulating and are
  // appended to the new model as soon as it becomes current.
  if (!model || graphLoading) return;
  if (stagedLiveNodes.length) model.appendNodes(stagedLiveNodes.splice(0));
  if (stagedLiveEdges.length) model.appendEdges(stagedLiveEdges.splice(0));
  renderer.syncModel();
  updateStats();
  updateVisibleStats();
  if (currentDetails) {
    const details = model.selectionDetails(currentDetails.index);
    if (details) showDetails(details);
  }
}

async function finalGraphResync(message?: string): Promise<void> {
  if (finalResyncRunning) {
    queuedResync = {
      message: message ?? queuedResync?.message,
    };
    return;
  }
  finalResyncRunning = true;
  flushLiveGraph();
  setBusy(true, "Verifying the completed graph…");
  try {
    await loadGraph({}, { fit: false });
    if (message) toast(message);
  } finally {
    finalResyncRunning = false;
    setBusy(false);
    const next = queuedResync;
    queuedResync = null;
    if (next) void finalGraphResync(next.message);
  }
}

function scheduleExternalResync(reason?: string): void {
  window.clearTimeout(externalResyncTimer);
  externalResyncTimer = window.setTimeout(() => {
    externalResyncTimer = 0;
    void finalGraphResync(reason ?? "Agent research synchronized");
  }, 180);
}

function progressLabel(event: Extract<LiveGraphEvent, { type: "crawl-progress" }>): string {
  if (event.message) return event.message;
  const parts: string[] = [];
  if (event.crawled !== undefined) parts.push(`${exactFormatter.format(event.crawled)} pages`);
  if (event.nodes !== undefined) parts.push(`${exactFormatter.format(event.nodes)} nodes`);
  if (event.edges !== undefined) parts.push(`${exactFormatter.format(event.edges)} links`);
  return parts.length ? `Crawling · ${parts.join(" · ")}` : "Crawl in progress…";
}

function handleLiveEvent(event: LiveGraphEvent): void {
  switch (event.type) {
    case "crawl-start":
      trackLiveCrawl(event);
      statusMessage.textContent = event.url
        ? `Crawling ${domainOf(event.url)} · ${exactFormatter.format(currentCrawlCount())} active`
        : `${exactFormatter.format(currentCrawlCount())} crawl${
            currentCrawlCount() === 1 ? "" : "s"
          } active`;
      break;
    case "crawl-progress":
      trackLiveCrawl(event);
      statusMessage.textContent = progressLabel(event);
      break;
    case "node":
      trackLiveCrawl(event);
      stageLiveNode(event.node);
      break;
    case "edge":
      trackLiveCrawl(event);
      stageLiveEdge(event.edge);
      break;
    case "graph-delta":
      trackLiveCrawl(event);
      for (const node of event.nodes) stagedLiveNodes.push(node);
      for (const edge of event.edges) stagedLiveEdges.push(edge);
      if (event.nodes.length || event.edges.length) scheduleLiveFlush();
      statusMessage.textContent = event.currentUrl
        ? `${exactFormatter.format(currentCrawlCount())} active · ${domainOf(
            event.currentUrl,
          )} · ${exactFormatter.format(event.pagesVisited ?? 0)} pages`
        : `Streaming ${exactFormatter.format(event.nodes.length)} nodes · ${exactFormatter.format(
            event.edges.length,
          )} links`;
      break;
    case "graph-changed":
      scheduleExternalResync(event.reason);
      break;
    case "crawl-complete":
      finishTrackedCrawl(
        crawlId(event),
        event.url,
        event.message ?? "Crawl complete · graph synchronized",
      );
      break;
    case "crawl-cancelled":
      finishTrackedCrawl(
        crawlId(event),
        event.url,
        event.message ?? "Crawl cancelled",
        "cancelled",
      );
      break;
    case "crawl-error":
      finishTrackedCrawl(crawlId(event), event.url, event.message, "failed");
      break;
    case "hello":
    case "unknown":
      break;
  }
}

const liveSocket = new LiveGraphSocket({
  endpoints: ["/ws"],
  onEvent: handleLiveEvent,
  onState(state) {
    liveConnection = state;
    updateLiveIndicator();
  },
});

livePill.addEventListener("click", () => {
  setCrawlDrawerOpen(crawlDrawer.hidden);
  if (!crawlDrawer.hidden) void refreshCrawlJobs();
});

document.addEventListener("pointerdown", (event) => {
  if (!crawlDrawer.hidden && !liveCrawls.contains(event.target as Node)) {
    setCrawlDrawerOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !crawlDrawer.hidden) {
    setCrawlDrawerOpen(false);
    livePill.focus();
  }
});

function appendMeta(label: string, value: string): void {
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = value;
  detailMeta.append(term, description);
}

function connectionButton(node: GraphNode): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = node.label || node.title || node.url;
  button.title = node.url;
  button.addEventListener("click", () => {
    if (!model) return;
    const index = model.nodeIndex.get(String(node.id));
    if (index === undefined) return;
    selectNode(index, true);
  });
  item.append(button);
  return item;
}

function showDetails(details: SelectionDetails): void {
  currentDetails = details;
  const node = details.node;
  detailKind.textContent = node.kind || "page";
  detailTitle.textContent = node.label || node.title || domainOf(node.url);
  detailUrl.textContent = node.url;
  detailMeta.replaceChildren();
  appendMeta("Domain", node.domain || domainOf(node.url));
  appendMeta("Connections", exactFormatter.format(details.degree));
  if (node.depth !== undefined) appendMeta("Crawl depth", String(node.depth));
  const visits = node.visit_count ?? node.visits;
  if (visits !== undefined) appendMeta("Observations", exactFormatter.format(visits));
  if (node.first_seen) appendMeta("First seen", new Date(node.first_seen).toLocaleString());
  if (node.last_seen) appendMeta("Last seen", new Date(node.last_seen).toLocaleString());
  if (node.agent_ids?.length) appendMeta("Agents", node.agent_ids.join(", "));
  if (node.tags?.length) appendMeta("Tags", node.tags.join(", "));

  outgoingList.replaceChildren(...details.outgoing.map(connectionButton));
  incomingList.replaceChildren(...details.incoming.map(connectionButton));
  outgoingCount.textContent = exactFormatter.format(details.outgoing.length);
  incomingCount.textContent = exactFormatter.format(details.incoming.length);
  outgoingGroup.hidden = details.outgoing.length === 0;
  incomingGroup.hidden = details.incoming.length === 0;
  detailsPanel.hidden = false;
}

function selectNode(index: number, focus = false): void {
  if (!model) return;
  model.setSelected(index);
  renderer.updateMeta();
  const details = model.selectionDetails(index);
  if (details) showDetails(details);
  if (focus) renderer.focusNode(index);
}

function closeDetails(): void {
  detailsPanel.hidden = true;
  currentDetails = null;
  model?.setSelected(-1);
  renderer.updateMeta();
}

function pickAt(clientX: number, clientY: number): number {
  if (!model) return -1;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (renderer.is3D()) return renderer.pickNode(x, y, rect.width, rect.height);
  const [worldX, worldY] = renderer.screenToWorld(x, y, rect.width, rect.height);
  return model.pick(
    worldX,
    worldY,
    100 / renderer.camera.zoom,
    (index) => Math.max(5, renderer.nodeScreenRadius(index)) / renderer.camera.zoom,
  );
}

function showTooltip(index: number, clientX: number, clientY: number): void {
  if (!model || index < 0) {
    tooltip.hidden = true;
    return;
  }
  const node = model.nodes[index];
  if (!node) return;
  tooltipTitle.textContent = node.label || node.title || node.url;
  tooltipMeta.textContent = `${node.domain || domainOf(node.url)} · ${exactFormatter.format(model.degree[index] ?? 0)} connections`;
  tooltip.style.left = `${Math.min(clientX, window.innerWidth - 350)}px`;
  tooltip.style.top = `${Math.min(clientY, window.innerHeight - 78)}px`;
  tooltip.hidden = false;
}

function openNode(node: GraphNode): void {
  const opened = window.open(node.url, "_blank", "noopener,noreferrer");
  if (!opened) toast("Your browser blocked the new tab.", true);
}

async function copyNode(node: GraphNode): Promise<void> {
  try {
    await navigator.clipboard.writeText(node.url);
    toast("URL copied");
  } catch {
    toast("Clipboard access was denied.", true);
  }
}

function crawlNode(node: GraphNode): void {
  crawlUrl.value = node.url;
  crawlUrl.focus();
  toast("URL loaded into the expedition form");
}

function isolateNeighborhood(index: number): void {
  if (!model) return;
  graphSearch.value = "";
  domainFilter.value = "";
  kindFilter.value = "";
  originalsFilter.checked = false;
  isolatedFilter.checked = false;
  const count = model.showNeighborhood(index);
  renderer.updateMeta();
  updateVisibleStats();
  renderer.focusNode(index, 0.9);
  statusMessage.textContent = `Isolated ${exactFormatter.format(count)} connected nodes`;
}

function selectedNode(): GraphNode | null {
  return currentDetails?.node ?? null;
}

function hideContextMenu(): void {
  contextMenu.hidden = true;
  contextNodeIndex = -1;
}

let pointerId = -1;
let pointerDownX = 0;
let pointerDownY = 0;
let pointerLastX = 0;
let pointerLastY = 0;
let pointerMoved = false;
let pointerButton = 0;
let pointerAction: "pan2d" | "orbit3d" | "pan3d" = "pan2d";
let suppressContextMenu = false;

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 1 && !(renderer.is3D() && event.button === 2)) {
    return;
  }
  event.preventDefault();
  hideContextMenu();
  pointerId = event.pointerId;
  pointerButton = event.button;
  pointerAction = renderer.is3D()
    ? event.button === 1 || event.button === 2 || event.shiftKey || event.ctrlKey
      ? "pan3d"
      : "orbit3d"
    : "pan2d";
  pointerDownX = pointerLastX = event.clientX;
  pointerDownY = pointerLastY = event.clientY;
  pointerMoved = false;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("is-dragging");
});

canvas.addEventListener("pointermove", (event) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (event.pointerId === pointerId) {
    const dx = event.clientX - pointerLastX;
    const dy = event.clientY - pointerLastY;
    if (Math.hypot(event.clientX - pointerDownX, event.clientY - pointerDownY) > 3) {
      pointerMoved = true;
    }
    if (pointerMoved) {
      if (pointerAction === "orbit3d") renderer.orbitBy(dx, dy);
      else if (pointerAction === "pan3d") renderer.pan3DBy(dx, dy, canvas.clientHeight);
      else renderer.panBy(dx, dy);
      if (pointerButton === 2) suppressContextMenu = true;
      updateCameraStatus();
    }
    pointerLastX = event.clientX;
    pointerLastY = event.clientY;
    return;
  }
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    showTooltip(pickAt(pointerX, pointerY), pointerX, pointerY);
  });
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerId !== pointerId) return;
  if (!pointerMoved && pointerButton === 0) {
    const index = pickAt(event.clientX, event.clientY);
    if (index >= 0) selectNode(index);
    else closeDetails();
  }
  canvas.classList.remove("is-dragging");
  canvas.releasePointerCapture(event.pointerId);
  pointerId = -1;
});

canvas.addEventListener("pointercancel", () => {
  canvas.classList.remove("is-dragging");
  pointerId = -1;
});

canvas.addEventListener("pointerleave", () => {
  tooltip.hidden = true;
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoomAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
      Math.exp(-event.deltaY * 0.0012),
      rect.width,
      rect.height,
    );
    updateCameraStatus();
  },
  { passive: false },
);

canvas.addEventListener("dblclick", (event) => {
  const index = pickAt(event.clientX, event.clientY);
  const node = index >= 0 ? model?.nodes[index] : null;
  if (node) openNode(node);
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (suppressContextMenu) {
    suppressContextMenu = false;
    hideContextMenu();
    return;
  }
  const index = pickAt(event.clientX, event.clientY);
  if (index < 0) {
    hideContextMenu();
    return;
  }
  selectNode(index);
  contextNodeIndex = index;
  contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
  contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 190)}px`;
  contextMenu.hidden = false;
});

contextMenu.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
  const node = contextNodeIndex >= 0 ? model?.nodes[contextNodeIndex] : null;
  if (!button || !node) return;
  switch (button.dataset.action) {
    case "open":
      openNode(node);
      break;
    case "copy":
      void copyNode(node);
      break;
    case "crawl":
      crawlNode(node);
      break;
    case "neighbors":
      isolateNeighborhood(contextNodeIndex);
      break;
  }
  hideContextMenu();
});

document.addEventListener("pointerdown", (event) => {
  if (!contextMenu.contains(event.target as Node) && event.target !== canvas) hideContextMenu();
});

for (const control of [domainFilter, kindFilter, originalsFilter, isolatedFilter]) {
  control.addEventListener("change", applyFilters);
}

graphSearch.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(applyFilters, 100);
});

graphSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!model) return;
  const index = model.findFirst(graphSearch.value);
  if (index >= 0) {
    selectNode(index, true);
    return;
  }
  void loadGraph({ query: graphSearch.value });
});

nodeScale.addEventListener("input", () => {
  renderer.camera.nodeScale = Number(nodeScale.value);
  nodeScaleValue.textContent = `${Number(nodeScale.value).toFixed(2)}×`;
});

edgeAlpha.addEventListener("input", () => {
  renderer.camera.edgeAlpha = Number(edgeAlpha.value);
  edgeAlphaValue.textContent = `${Math.round(Number(edgeAlpha.value) * 100)}%`;
});

function currentLayoutOptions(): { clusterSpread: number; nodeSpread: number } {
  return {
    clusterSpread: Number(clusterSpread.value),
    nodeSpread: Number(nodeSpread.value),
  };
}

let layoutTimer = 0;
function scheduleLayoutUpdate(): void {
  window.clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => {
    layoutTimer = 0;
    if (!model) return;
    model.setLayoutOptions(currentLayoutOptions());
    renderer.syncModel();
  }, 120);
}

clusterSpread.addEventListener("input", () => {
  clusterSpreadValue.textContent = `${Number(clusterSpread.value).toFixed(2)}×`;
  scheduleLayoutUpdate();
});

nodeSpread.addEventListener("input", () => {
  nodeSpreadValue.textContent = `${Number(nodeSpread.value).toFixed(2)}×`;
  scheduleLayoutUpdate();
});

function renderWorkerCount(workers: number): void {
  workerCount.value = String(workers);
}

async function refreshWorkerCount(): Promise<void> {
  try {
    const status = await fetchCrawlWorkers();
    renderWorkerCount(status.workers);
  } catch {
    workerCount.disabled = true;
    workerCount.placeholder = "n/a";
  }
}

workerCount.addEventListener("change", async () => {
  const requested = Math.max(0, Math.min(16, Math.round(Number(workerCount.value) || 0)));
  try {
    const status = await setCrawlWorkers(requested);
    renderWorkerCount(status.workers);
    toast(
      `Background workers set to ${status.workers} · ${status.active_jobs} crawl${
        status.active_jobs === 1 ? "" : "s"
      } running`,
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
    void refreshWorkerCount();
  }
});

crawlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  let url: URL;
  try {
    url = new URL(crawlUrl.value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    toast("Enter a complete HTTP or HTTPS URL.", true);
    return;
  }
  const depth = Math.min(10, Math.max(1, Number(crawlDepth.value) || 2));
  addPendingCrawl(url.href);
  beginCrawlActivity(url.href, depth);
  updateLiveIndicator();
  statusMessage.textContent = `Launching ${url.hostname} · ${exactFormatter.format(
    currentCrawlCount(),
  )} crawl${currentCrawlCount() === 1 ? "" : "s"} active`;
  try {
    const result = await launchCrawl({ starting_url: url.href, max_depth: depth });
    if (result.kind === "job" && result.job) {
      const activity = mergeJobActivity(result.job);
      activeCrawlIds.add(activity.id);
      consumePendingCrawl(url.href);
      statusMessage.textContent = "Crawl queued · a worker will pick it up shortly…";
    } else if (result.legacy) {
      const legacy = result.legacy;
      const completed =
        legacy.status === "completed" ||
        legacy.status === "complete" ||
        /crawl completed/i.test(legacy.message);
      if (completed) {
        finishTrackedCrawl(
          responseCrawlId(legacy),
          url.href,
          legacy.message || "Expedition added to the graph",
        );
      } else {
        consumePendingCrawl(url.href);
        statusMessage.textContent = "Crawl accepted · waiting for live updates…";
      }
    }
  } catch (error) {
    finishTrackedCrawl(
      null,
      url.href,
      error instanceof Error ? error.message : String(error),
      "failed",
    );
  } finally {
    consumePendingCrawl(url.href);
    updateLiveIndicator();
    if (completionResyncNeeded && currentCrawlCount() === 0) {
      completionResyncNeeded = false;
      void finalGraphResync();
    }
  }
});

for (const button of viewModeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.viewMode;
    if (mode === "2d" || mode === "3d") setViewMode(mode);
  });
}

fitButton.addEventListener("click", (event) => {
  if (renderer.is3D() && event.shiftKey) renderer.reset3DOrientation();
  fitGraph();
});
reloadButton.addEventListener("click", () => void loadGraph());
detailsClose.addEventListener("click", closeDetails);
detailOpen.addEventListener("click", () => {
  const node = selectedNode();
  if (node) openNode(node);
});
detailCopy.addEventListener("click", () => {
  const node = selectedNode();
  if (node) void copyNode(node);
});
detailCrawl.addEventListener("click", () => {
  const node = selectedNode();
  if (node) crawlNode(node);
});
detailNeighbors.addEventListener("click", () => {
  if (currentDetails) isolateNeighborhood(currentDetails.index);
});

clearButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Clear every node, connection, and search in this graph? This cannot be undone.",
  );
  if (!confirmed) return;
  const adminToken = window.prompt(
    "Enter the admin token. It is sent once and is never stored by WebPath Explorer.",
  );
  if (!adminToken) return;
  clearButton.disabled = true;
  setBusy(true, "Clearing graph…");
  try {
    toast(await clearGraph(adminToken));
    await loadGraph();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  } finally {
    clearButton.disabled = false;
    setBusy(false);
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const typing = target.matches("input, select, textarea");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    graphSearch.focus();
  } else if (event.key === "Escape") {
    hideContextMenu();
    closeDetails();
    if (typing) target.blur();
  } else if ((event.key === "f" || event.key === "F") && !typing) {
    if (renderer.is3D() && event.shiftKey) renderer.reset3DOrientation();
    fitGraph();
  } else if ((event.key === "+" || event.key === "=") && !typing) {
    if (renderer.is3D()) renderer.camera.distance = Math.max(20, renderer.camera.distance / 1.3);
    else renderer.camera.zoom = Math.min(64, renderer.camera.zoom * 1.3);
    updateCameraStatus();
  } else if (event.key === "-" && !typing) {
    if (renderer.is3D()) {
      renderer.camera.distance = Math.min(2_000_000, renderer.camera.distance * 1.3);
    } else {
      renderer.camera.zoom = Math.max(0.001, renderer.camera.zoom / 1.3);
    }
    updateCameraStatus();
  }
});

async function bootstrap(): Promise<void> {
  liveSocket.connect();
  updateLiveIndicator();
  void refreshCrawlJobs();
  void refreshWorkerCount();
  if (!navigator.gpu) {
    const message =
      "WebGPU is unavailable. Enable hardware acceleration or open this page in a current browser.";
    statusMessage.textContent = message;
    toast(message, true);
    return;
  }
  try {
    statusMessage.textContent = "Starting Shallot’s WebGPU graph…";
    shallotState = await startShallotRenderer(renderer);
    statusMessage.textContent = "Shallot ready · streaming the graph…";
    await loadGraph();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statusMessage.textContent = `Renderer unavailable · ${message}`;
    toast(message, true);
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    loadController?.abort();
    if (hoverFrame) cancelAnimationFrame(hoverFrame);
    window.clearTimeout(liveFlushTimer);
    window.clearTimeout(externalResyncTimer);
    window.clearTimeout(recentActivityTimer);
    window.clearTimeout(layoutTimer);
    if (crawlActivityFrame) cancelAnimationFrame(crawlActivityFrame);
    liveSocket.close();
    shallotState?.dispose();
    shallotState = null;
  });
}

window.addEventListener("beforeunload", () => liveSocket.close(), { once: true });

void bootstrap();
