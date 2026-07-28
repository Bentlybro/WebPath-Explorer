"""WebPath Explorer HTTP API and bounded crawler.

Run directly for local development or import ``create_app`` from a WSGI
server.  Debug mode and public binding are opt-in environment settings.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import os
import queue
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

import aiohttp
from bs4 import BeautifulSoup
from flask import Flask, abort, current_app, jsonify, render_template, request
from flask_cors import CORS
from flask_sock import Sock
from simple_websocket import ConnectionClosed

from webpath.graph_store import GraphStore, canonicalize_url, utc_now
from webpath.live_events import EVENT_PROTOCOL, EventBroker


BASE_DIR = Path(__file__).resolve().parent
UNLIMITED_GRAPH_ITEMS = 2_147_483_647


@dataclass(frozen=True)
class CrawlLimits:
    max_pages: int
    concurrency: int
    request_timeout: float
    max_response_bytes: int


def _live_node(
    node_id: int,
    url: str,
    *,
    title: str | None = None,
    is_original: bool = False,
) -> dict[str, Any]:
    now = utc_now()
    domain = urlsplit(url).hostname or url
    return {
        "id": node_id,
        "url": url,
        "label": title or domain,
        "kind": "page",
        "is_original": is_original,
        "visit_count": 1,
        "first_seen": now,
        "last_seen": now,
    }


def _publish_graph_delta(
    events: EventBroker | None,
    *,
    search_id: int,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    pages_visited: int,
    edges_observed: int,
    depth: int,
    current_url: str,
    errors: list[dict[str, str]] | None = None,
    batch_size: int = 500,
) -> None:
    if events is None:
        return
    batch_size = max(1, batch_size)
    node_by_id = {int(node["id"]): node for node in nodes}
    batches: list[tuple[list[dict[str, Any]], list[dict[str, Any]]]] = []
    if edges:
        incident_ids: set[int] = set()
        for offset in range(0, len(edges), batch_size):
            edge_batch = edges[offset : offset + batch_size]
            batch_ids = {
                int(node_id)
                for edge in edge_batch
                for node_id in (edge["source"], edge["target"])
            }
            incident_ids.update(batch_ids)
            batches.append(
                (
                    [node_by_id[node_id] for node_id in batch_ids if node_id in node_by_id],
                    edge_batch,
                )
            )
        standalone = [
            node for node_id, node in node_by_id.items() if node_id not in incident_ids
        ]
        if standalone:
            batches[0][0].extend(standalone)
    else:
        batches = [
            (nodes[offset : offset + batch_size], [])
            for offset in range(0, max(len(nodes), 1), batch_size)
        ]
    for index, (node_batch, edge_batch) in enumerate(batches):
        events.publish(
            "graph_delta",
            search_id=search_id,
            nodes=node_batch,
            edges=edge_batch,
            pages_visited=pages_visited,
            edges_observed=edges_observed,
            depth=depth,
            current_url=current_url,
            errors=errors or [],
            batch={
                "index": index,
                "size": batch_size,
                "count": len(batches),
                "final": index == len(batches) - 1,
            },
        )


def _bounded_int(
    value: Any, name: str, *, minimum: int = 0, maximum: int
) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _graph_limit(value: Any, name: str) -> int:
    """Parse a graph response limit; ``all`` means no practical row cap."""
    if value is None or str(value).strip().lower() in {"all", "unlimited"}:
        return UNLIMITED_GRAPH_ITEMS
    return _bounded_int(
        value,
        name,
        minimum=0 if name == "edge_limit" else 1,
        maximum=UNLIMITED_GRAPH_ITEMS,
    )


async def validate_public_url(url: str) -> str:
    """Canonicalize a crawl URL and reject non-public network destinations.

    Validation is repeated for every fetched page, including redirect targets.
    Deployments that need a hard network boundary should additionally run the
    crawler in an egress-restricted container: application validation alone
    cannot completely eliminate DNS rebinding races.
    """
    canonical = canonicalize_url(url)
    hostname = urlsplit(canonical).hostname
    assert hostname is not None
    try:
        direct_ip = ipaddress.ip_address(hostname)
        addresses = [direct_ip]
    except ValueError:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(
                hostname,
                None,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise ValueError("URL hostname could not be resolved") from exc
        addresses = []
        for info in infos:
            try:
                addresses.append(ipaddress.ip_address(info[4][0]))
            except ValueError:
                continue
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("URL resolves to a private, reserved, or local address")
    return canonical


async def _fetch_page(
    session: aiohttp.ClientSession,
    url: str,
    limits: CrawlLimits,
) -> tuple[str, str | None, list[str]]:
    current = url
    for _ in range(6):
        current = await validate_public_url(current)
        async with session.get(current, allow_redirects=False) as response:
            if response.status in {301, 302, 303, 307, 308}:
                location = response.headers.get("Location")
                if not location:
                    raise ValueError("redirect response has no Location header")
                current = urljoin(current, location)
                continue
            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "").lower()
            if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                return current, None, []
            body = await response.content.read(limits.max_response_bytes + 1)
            if len(body) > limits.max_response_bytes:
                raise ValueError("response exceeded the configured size limit")
            encoding = response.charset or "utf-8"
            html = body.decode(encoding, errors="replace")
            soup = BeautifulSoup(html, "html.parser")
            title = soup.title.get_text(" ", strip=True)[:500] if soup.title else None
            links: list[str] = []
            for anchor in soup.find_all("a", href=True):
                candidate = urljoin(current, anchor["href"])
                try:
                    links.append(canonicalize_url(candidate))
                except ValueError:
                    continue
            return current, title, list(dict.fromkeys(links))
    raise ValueError("too many redirects")


async def crawl(
    store: GraphStore,
    starting_url: str,
    max_depth: int,
    search_id: int,
    limits: CrawlLimits,
    events: EventBroker | None = None,
    event_batch_size: int = 500,
) -> dict[str, int]:
    """Crawl in bounded breadth-first waves using one shared HTTP session."""
    starting_url = await validate_public_url(starting_url)
    visited: set[str] = set()
    scheduled: set[str] = {starting_url}
    current_wave = [starting_url]
    page_count = 0
    edge_count = 0
    semaphore = asyncio.Semaphore(limits.concurrency)
    timeout = aiohttp.ClientTimeout(total=limits.request_timeout)
    headers = {"User-Agent": "WebPathExplorer/2.0 (+local research graph)"}

    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        for _depth in range(1, max_depth + 1):
            if not current_wave or page_count >= limits.max_pages:
                break

            async def fetch(url: str):
                async with semaphore:
                    try:
                        return url, await _fetch_page(session, url, limits), None
                    except (
                        aiohttp.ClientError,
                        asyncio.TimeoutError,
                        ValueError,
                    ) as exc:
                        return url, None, str(exc) or type(exc).__name__

            remaining = limits.max_pages - page_count
            results = await asyncio.gather(*(fetch(url) for url in current_wave[:remaining]))
            next_wave: list[str] = []
            for requested_url, result, fetch_error in results:
                if requested_url in visited:
                    continue
                visited.add(requested_url)
                page_count += 1
                delta_nodes: dict[int, dict[str, Any]] = {}
                delta_edges: list[dict[str, Any]] = []
                if result is None:
                    node_id = store.upsert_node(requested_url)
                    delta_nodes[node_id] = _live_node(
                        node_id,
                        requested_url,
                        is_original=requested_url == starting_url,
                    )
                    _publish_graph_delta(
                        events,
                        search_id=search_id,
                        nodes=list(delta_nodes.values()),
                        edges=[],
                        pages_visited=page_count,
                        edges_observed=edge_count,
                        depth=_depth,
                        current_url=requested_url,
                        errors=[
                            {
                                "url": requested_url,
                                "message": fetch_error or "page fetch failed",
                            }
                        ],
                        batch_size=event_batch_size,
                    )
                    continue
                final_url, title, links = result
                source_id = store.upsert_node(
                    final_url,
                    title=title,
                    metadata={"last_search_id": search_id},
                )
                delta_nodes[source_id] = _live_node(
                    source_id,
                    final_url,
                    title=title,
                    is_original=requested_url == starting_url,
                )
                if final_url != requested_url:
                    requested_id = store.upsert_node(requested_url)
                    delta_nodes[requested_id] = _live_node(
                        requested_id,
                        requested_url,
                        is_original=requested_url == starting_url,
                    )
                    edge_id = store.upsert_edge(
                        requested_id,
                        source_id,
                        relation="redirects_to",
                        metadata={"search_id": search_id},
                    )
                    delta_edges.append(
                        {
                            "id": edge_id,
                            "source": requested_id,
                            "target": source_id,
                            "kind": "redirects_to",
                            "weight": 1,
                            "weight_delta": 1,
                        }
                    )
                for link in links:
                    target_id = store.upsert_node(link)
                    delta_nodes[target_id] = _live_node(target_id, link)
                    edge_id = store.upsert_edge(
                        source_id,
                        target_id,
                        metadata={"search_id": search_id},
                    )
                    edge_count += 1
                    delta_edges.append(
                        {
                            "id": edge_id,
                            "source": source_id,
                            "target": target_id,
                            "kind": "links_to",
                            "weight": 1,
                            "weight_delta": 1,
                        }
                    )
                    if (
                        link not in scheduled
                        and len(scheduled) < limits.max_pages
                    ):
                        scheduled.add(link)
                        next_wave.append(link)
                _publish_graph_delta(
                    events,
                    search_id=search_id,
                    nodes=list(delta_nodes.values()),
                    edges=delta_edges,
                    pages_visited=page_count,
                    edges_observed=edge_count,
                    depth=_depth,
                    current_url=final_url,
                    batch_size=event_batch_size,
                )
                if page_count >= limits.max_pages:
                    break
            current_wave = next_wave
            if events is not None:
                events.publish(
                    "crawl_progress",
                    search_id=search_id,
                    depth=_depth,
                    pages_visited=page_count,
                    edges_observed=edge_count,
                    queued_pages=len(next_wave),
                    max_pages=limits.max_pages,
                )
    return {"pages_visited": page_count, "edges_observed": edge_count}


def create_app(config: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__)
    app.config.from_mapping(
        DATABASE=os.environ.get(
            "WEBPATH_DB_PATH",
            os.environ.get("WEBPATH_DATABASE", str(BASE_DIR / "web_graph.db")),
        ),
        MAX_CONTENT_LENGTH=int(os.environ.get("WEBPATH_MAX_INGEST_BYTES", 4_000_000)),
        MAX_CRAWL_DEPTH=int(os.environ.get("WEBPATH_MAX_CRAWL_DEPTH", 6)),
        MAX_CRAWL_PAGES=int(os.environ.get("WEBPATH_MAX_CRAWL_PAGES", 500)),
        CRAWL_CONCURRENCY=int(os.environ.get("WEBPATH_CRAWL_CONCURRENCY", 12)),
        CRAWL_TIMEOUT=float(os.environ.get("WEBPATH_CRAWL_TIMEOUT", 15)),
        MAX_RESPONSE_BYTES=int(
            os.environ.get("WEBPATH_MAX_RESPONSE_BYTES", 2_000_000)
        ),
        ADMIN_TOKEN=os.environ.get("WEBPATH_ADMIN_TOKEN"),
        INGEST_TOKEN=os.environ.get("WEBPATH_INGEST_TOKEN"),
        EVENTS_TOKEN=os.environ.get("WEBPATH_EVENTS_TOKEN"),
        EVENT_HISTORY_SIZE=int(os.environ.get("WEBPATH_EVENT_HISTORY_SIZE", 2_000)),
        EVENT_QUEUE_SIZE=int(os.environ.get("WEBPATH_EVENT_QUEUE_SIZE", 256)),
        EVENT_BATCH_SIZE=int(os.environ.get("WEBPATH_EVENT_BATCH_SIZE", 500)),
        EVENT_HEARTBEAT_SECONDS=float(
            os.environ.get("WEBPATH_EVENT_HEARTBEAT_SECONDS", 15)
        ),
    )
    if config:
        app.config.update(config)

    store = GraphStore(app.config["DATABASE"])
    store.initialize()
    app.extensions["graph_store"] = store
    events = EventBroker(
        history_size=int(app.config["EVENT_HISTORY_SIZE"]),
        subscriber_queue_size=int(app.config["EVENT_QUEUE_SIZE"]),
    )
    app.extensions["event_broker"] = events
    sock = Sock(app)

    @sock.route("/ws")
    def live_events(ws):
        """Stream newline-free JSON WebSocket messages using webpath.events.v1.

        Reconnecting clients can send the last applied sequence as
        ``/ws?after=123``. If ``WEBPATH_EVENTS_TOKEN`` is configured, browser
        clients must additionally use ``/ws?token=...``.
        """
        configured_token = current_app.config.get("EVENTS_TOKEN")
        if configured_token and not hmac.compare_digest(
            str(configured_token), request.args.get("token", "")
        ):
            ws.close(reason=1008, message="invalid events token")
            return
        broker: EventBroker = current_app.extensions["event_broker"]
        try:
            after_sequence = _bounded_int(
                request.args.get("after", broker.sequence),
                "after",
                maximum=UNLIMITED_GRAPH_ITEMS,
            )
        except ValueError:
            ws.close(reason=1008, message="invalid after sequence")
            return

        try:
            with broker.subscribe(after_sequence=after_sequence) as subscription:
                ws.send(
                    json.dumps(
                        {
                            "protocol": EVENT_PROTOCOL,
                            "type": "connected",
                            "sequence": after_sequence,
                            "current_sequence": broker.sequence,
                            "timestamp": utc_now(),
                        },
                        separators=(",", ":"),
                    )
                )
                while True:
                    try:
                        event = subscription.get(
                            timeout=float(
                                current_app.config["EVENT_HEARTBEAT_SECONDS"]
                            )
                        )
                    except queue.Empty:
                        event = {
                            "protocol": EVENT_PROTOCOL,
                            "type": "heartbeat",
                            "sequence": broker.sequence,
                            "timestamp": utc_now(),
                        }
                    ws.send(json.dumps(event, separators=(",", ":")))
        except ConnectionClosed:
            return

    allowed_origins = os.environ.get("WEBPATH_CORS_ORIGINS", "").strip()
    if allowed_origins:
        CORS(
            app,
            resources={
                r"/api/*": {
                    "origins": [
                        origin.strip()
                        for origin in allowed_origins.split(",")
                        if origin.strip()
                    ]
                }
            },
        )

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.route("/api/search", methods=["GET", "POST"])
    def search():
        data = request.get_json(silent=True) if request.method == "POST" else request.args
        data = data or {}
        starting_url = data.get("starting_url")
        if not starting_url:
            abort(400, description="starting_url is required")
        active_events: EventBroker = current_app.extensions["event_broker"]
        try:
            max_depth = _bounded_int(
                data.get("max_depth", 4),
                "max_depth",
                minimum=1,
                maximum=int(current_app.config["MAX_CRAWL_DEPTH"]),
            )
            canonical = asyncio.run(validate_public_url(starting_url))
        except ValueError as exc:
            active_events.publish(
                "crawl_error",
                search_id=None,
                url=str(starting_url),
                error=str(exc),
            )
            abort(400, description=str(exc))

        active_store: GraphStore = current_app.extensions["graph_store"]
        search_id = active_store.create_legacy_search(canonical, max_depth)
        limits = CrawlLimits(
            max_pages=int(current_app.config["MAX_CRAWL_PAGES"]),
            concurrency=int(current_app.config["CRAWL_CONCURRENCY"]),
            request_timeout=float(current_app.config["CRAWL_TIMEOUT"]),
            max_response_bytes=int(current_app.config["MAX_RESPONSE_BYTES"]),
        )
        active_events.publish(
            "crawl_started",
            search_id=search_id,
            url=canonical,
            max_depth=max_depth,
            limits={
                "max_pages": limits.max_pages,
                "concurrency": limits.concurrency,
                "request_timeout": limits.request_timeout,
                "max_response_bytes": limits.max_response_bytes,
            },
        )
        try:
            result = asyncio.run(
                crawl(
                    active_store,
                    canonical,
                    max_depth,
                    search_id,
                    limits,
                    events=active_events,
                    event_batch_size=int(current_app.config["EVENT_BATCH_SIZE"]),
                )
            )
        except Exception as exc:
            active_store.complete_search(search_id, "failed")
            active_events.publish(
                "crawl_error",
                search_id=search_id,
                url=canonical,
                error=str(exc) or type(exc).__name__,
            )
            current_app.logger.exception("Crawl failed")
            return jsonify({"error": "crawl failed", "search_id": search_id}), 502
        active_store.complete_search(search_id)
        active_events.publish(
            "crawl_completed",
            search_id=search_id,
            url=canonical,
            **result,
        )
        return jsonify(
            {
                "message": f"Crawl completed for {canonical}",
                "original_search_id": search_id,
                "search_id": search_id,
                **result,
            }
        )

    @app.get("/api/graph")
    def get_graph():
        """Return a bounded, renderer-oriented graph slice.

        ``limit`` is an alias for ``node_limit``.  ``after_id`` provides stable
        keyset pagination; ``q``, ``domain``, ``session`` and ``search`` narrow
        a slice without requiring the client to download the whole graph.
        """
        try:
            node_limit = _graph_limit(
                request.args.get(
                    "node_limit", request.args.get("limit", "all")
                ),
                "node_limit",
            )
            edge_limit = _graph_limit(
                request.args.get("edge_limit", "all"),
                "edge_limit",
            )
            after_id = _bounded_int(
                request.args.get("after_id", 0), "after_id", maximum=2_147_483_647
            )
            search_value = request.args.get("search")
            search_id = (
                _bounded_int(
                    search_value, "search", minimum=1, maximum=2_147_483_647
                )
                if search_value
                else None
            )
        except ValueError as exc:
            abort(400, description=str(exc))
        active_store: GraphStore = current_app.extensions["graph_store"]
        root_value = request.args.get("root")
        root_id = None
        if root_value:
            try:
                root_id = int(root_value)
                if root_id < 1:
                    raise ValueError
            except ValueError:
                try:
                    root_id = active_store.node_id_for_url(root_value)
                except ValueError as exc:
                    abort(400, description=str(exc))
                if root_id is None:
                    abort(404, description="root URL is not in the graph")
        graph = active_store.graph_slice(
            after_id=after_id,
            node_limit=node_limit,
            edge_limit=edge_limit,
            root_id=root_id,
            query=request.args.get("q"),
            domain=request.args.get("domain"),
            session_id=request.args.get("session"),
            search_id=search_id,
        )
        stats = active_store.stats()
        renderer_nodes = []
        for node in graph["nodes"]:
            renderer_nodes.append(
                {
                    **node,
                    "label": node.get("title") or node.get("domain") or node["url"],
                    "kind": node.get("node_type") or "page",
                    "is_original": bool(node.get("is_original", False)),
                    "visit_count": int(node.get("visit_count", 1)),
                    "first_seen": node.get("first_seen_at"),
                    "last_seen": node.get("last_seen_at"),
                }
            )
        renderer_edges = [
            {
                **edge,
                "kind": edge.get("relation") or "links_to",
            }
            for edge in graph["edges"]
        ]
        page = graph["page"]
        truncated = bool(page["has_more"]) or (
            len(renderer_edges) >= page["edge_limit"] and page["edge_limit"] > 0
        )
        return jsonify(
            {
                "nodes": renderer_nodes,
                "edges": renderer_edges,
                "stats": {
                    "total_nodes": stats["nodes"],
                    "total_edges": stats["edges"],
                    "total_domains": stats["domains"],
                    "total_searches": stats["searches"],
                    "total_agents": stats["agents"],
                    "total_sessions": stats["sessions"],
                    "total_observations": stats["observations"],
                },
                "page": page,
                "meta": {
                    "total_nodes": stats["nodes"],
                    "total_edges": stats["edges"],
                    "returned_nodes": len(renderer_nodes),
                    "returned_edges": len(renderer_edges),
                    "returned": {
                        "nodes": len(renderer_nodes),
                        "edges": len(renderer_edges),
                    },
                    "total": {"nodes": stats["nodes"], "edges": stats["edges"]},
                    "truncated": truncated,
                },
            }
        )

    @app.get("/api/stats")
    def get_stats():
        active_store: GraphStore = current_app.extensions["graph_store"]
        return jsonify(active_store.stats())

    @app.post("/api/agent/ingest")
    @app.post("/api/ingest")
    def ingest_agent_observations():
        """Accept the agent/session/search/source/edge contract in GraphStore."""
        configured_token = current_app.config.get("INGEST_TOKEN")
        if configured_token and not hmac.compare_digest(
            str(configured_token), request.headers.get("X-Ingest-Token", "")
        ):
            abort(403, description="a valid X-Ingest-Token is required")
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            abort(400, description="a JSON object is required")
        active_store: GraphStore = current_app.extensions["graph_store"]
        try:
            result = active_store.ingest_agent_batch(payload)
        except (TypeError, ValueError) as exc:
            abort(400, description=str(exc))
        stats = active_store.stats()
        active_events: EventBroker = current_app.extensions["event_broker"]
        active_events.publish(
            "graph_changed",
            search_id=result.get("search_id"),
            reason="agent_ingest",
            agent_id=result.get("agent_id"),
            session_id=result.get("session_id"),
            nodes_touched=result.get("nodes_touched", 0),
            edges_touched=result.get("edges_touched", 0),
            totals={"nodes": stats["nodes"], "edges": stats["edges"]},
            refresh="/api/graph",
        )
        return jsonify(result), 201

    # Legacy read APIs are retained for the original frontend.  They are capped
    # to prevent one request from accidentally materialising an unbounded graph.
    @app.get("/api/nodes")
    def get_nodes():
        try:
            limit = _bounded_int(
                request.args.get("limit", 100_000),
                "limit",
                minimum=1,
                maximum=100_000,
            )
        except ValueError as exc:
            abort(400, description=str(exc))
        active_store: GraphStore = current_app.extensions["graph_store"]
        return jsonify(active_store.nodes(limit))

    @app.get("/api/edges")
    def get_edges():
        try:
            limit = _bounded_int(
                request.args.get("limit", 250_000),
                "limit",
                minimum=1,
                maximum=250_000,
            )
        except ValueError as exc:
            abort(400, description=str(exc))
        active_store: GraphStore = current_app.extensions["graph_store"]
        return jsonify(active_store.edges(limit))

    @app.get("/api/original_search_ids")
    def get_original_search_ids():
        active_store: GraphStore = current_app.extensions["graph_store"]
        return jsonify(active_store.legacy_searches())

    @app.post("/api/cleardb")
    def clear_db():
        configured_token = current_app.config.get("ADMIN_TOKEN")
        supplied_token = request.headers.get("X-Admin-Token", "")
        if not configured_token or not hmac.compare_digest(
            str(configured_token), supplied_token
        ):
            abort(403, description="a valid X-Admin-Token is required")
        active_store: GraphStore = current_app.extensions["graph_store"]
        active_store.clear_all()
        return jsonify({"message": "Database cleared successfully"})

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(413)
    def api_error(error):
        if request.path.startswith("/api/"):
            return (
                jsonify(
                    {
                        "error": getattr(error, "description", str(error)),
                        "status": getattr(error, "code", 500),
                    }
                ),
                getattr(error, "code", 500),
            )
        return error

    return app


app = create_app()


if __name__ == "__main__":
    app.run(
        host=os.environ.get("WEBPATH_HOST", "127.0.0.1"),
        port=int(os.environ.get("WEBPATH_PORT", "5000")),
        debug=os.environ.get("WEBPATH_DEBUG", "").lower() in {"1", "true", "yes"},
    )
