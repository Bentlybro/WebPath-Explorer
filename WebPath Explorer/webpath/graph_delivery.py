"""Progressive, snapshot-bounded graph delivery.

The legacy ``/api/graph`` response couples edge selection to one node page,
which loses edges whose endpoints land on different pages.  This module keeps
node and edge cursors independent: clients finish the node phase, then page
through every edge in the same bounded snapshot.

Route code is intentionally not included here.  ``GraphDelivery`` returns
JSON-compatible dictionaries that Flask can serialize directly or adapt to an
NDJSON response.
"""

from __future__ import annotations

import json
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable

from webpath.graph_store import GraphStore


PROTOCOL = "webpath.graph.v2"
DEFAULT_NODE_LIMIT = 4_096
DEFAULT_EDGE_LIMIT = 16_384
MAX_NODE_LIMIT = 16_384
MAX_EDGE_LIMIT = 65_536


class SnapshotUnavailable(LookupError):
    """Raised when a snapshot token is unknown or has expired."""


class UnknownRoot(LookupError):
    """Raised when a requested root URL is not present in the graph."""


def parse_cursor(value: Any, name: str = "after") -> int:
    """Parse a non-negative keyset cursor suitable for an HTTP query value."""
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be at least 0")
    return parsed


def parse_limit(
    value: Any,
    *,
    default: int,
    maximum: int,
    name: str = "limit",
) -> int:
    """Parse a positive, bounded page size suitable for an HTTP query value."""
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 1 or parsed > maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return parsed


@dataclass(frozen=True, slots=True)
class GraphFilters:
    """Normalized filters bound to a snapshot token."""

    query: str | None = None
    domain: str | None = None
    kind: str | None = None
    session_id: str | None = None
    search_id: int | None = None
    root_id: int | None = None


@dataclass(frozen=True, slots=True)
class GraphSnapshot:
    token: str
    node_high_water: int
    edge_high_water: int
    observation_high_water: int
    event_sequence: int
    filters: GraphFilters
    created_at: float
    expires_at: float
    node_count: int
    edge_count: int


class SnapshotRegistry:
    """Thread-safe, bounded TTL storage for opaque graph snapshots."""

    def __init__(
        self,
        *,
        ttl_seconds: float = 600,
        max_snapshots: int = 128,
        clock: Callable[[], float] = time.monotonic,
    ):
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be greater than 0")
        if max_snapshots < 1:
            raise ValueError("max_snapshots must be at least 1")
        self.ttl_seconds = float(ttl_seconds)
        self.max_snapshots = int(max_snapshots)
        self._clock = clock
        self._lock = threading.RLock()
        self._snapshots: OrderedDict[str, GraphSnapshot] = OrderedDict()

    def now(self) -> float:
        return self._clock()

    def add(self, snapshot: GraphSnapshot) -> None:
        with self._lock:
            self._purge_locked(self._clock())
            self._snapshots[snapshot.token] = snapshot
            self._snapshots.move_to_end(snapshot.token)
            while len(self._snapshots) > self.max_snapshots:
                self._snapshots.popitem(last=False)

    def get(self, token: str) -> GraphSnapshot:
        if not isinstance(token, str) or not token:
            raise SnapshotUnavailable("snapshot token is required")
        with self._lock:
            now = self._clock()
            snapshot = self._snapshots.get(token)
            if snapshot is None or snapshot.expires_at <= now:
                self._snapshots.pop(token, None)
                self._purge_locked(now)
                raise SnapshotUnavailable("snapshot is unknown or expired")
            self._snapshots.move_to_end(token)
            return snapshot

    def _purge_locked(self, now: float) -> None:
        expired = [
            token
            for token, snapshot in self._snapshots.items()
            if snapshot.expires_at <= now
        ]
        for token in expired:
            self._snapshots.pop(token, None)


class GraphDelivery:
    """Create stable manifests and page nodes and edges independently."""

    def __init__(
        self,
        store: GraphStore,
        *,
        ttl_seconds: float = 600,
        max_snapshots: int = 128,
        registry: SnapshotRegistry | None = None,
    ):
        self.store = store
        self.registry = registry or SnapshotRegistry(
            ttl_seconds=ttl_seconds,
            max_snapshots=max_snapshots,
        )

    def create_manifest(
        self,
        *,
        query: str | None = None,
        domain: str | None = None,
        kind: str | None = None,
        session: str | None = None,
        search: int | str | None = None,
        root: int | str | None = None,
        event_sequence: int = 0,
    ) -> dict[str, Any]:
        """Capture append-stable high-water marks and return an opaque manifest."""
        filters = GraphFilters(
            query=_optional_text(query),
            domain=_normalize_domain(domain),
            kind=_optional_text(kind),
            session_id=_optional_text(session),
            search_id=_optional_positive_int(search, "search"),
            root_id=self._resolve_root(root),
        )
        event_sequence = parse_cursor(event_sequence, "event_sequence")
        token = secrets.token_urlsafe(24)
        now = self.registry.now()

        with self.store.connection() as conn:
            # One short read transaction captures mutually consistent high-water
            # marks.  Paging later does not retain a reader that prevents WAL
            # checkpoints.
            conn.execute("BEGIN")
            try:
                node_high_water = int(
                    conn.execute(
                        "SELECT COALESCE(MAX(id), 0) FROM nodes"
                    ).fetchone()[0]
                )
                edge_high_water = int(
                    conn.execute(
                        "SELECT COALESCE(MAX(rowid), 0) FROM edges"
                    ).fetchone()[0]
                )
                observation_high_water = int(
                    conn.execute(
                        "SELECT COALESCE(MAX(id), 0) FROM observations"
                    ).fetchone()[0]
                )
                provisional = GraphSnapshot(
                    token=token,
                    node_high_water=node_high_water,
                    edge_high_water=edge_high_water,
                    observation_high_water=observation_high_water,
                    event_sequence=event_sequence,
                    filters=filters,
                    created_at=now,
                    expires_at=now + self.registry.ttl_seconds,
                    node_count=0,
                    edge_count=0,
                )
                node_where, node_params = self._node_predicate("n", provisional)
                node_count = int(
                    conn.execute(
                        f"SELECT COUNT(*) FROM nodes n WHERE {node_where}",
                        node_params,
                    ).fetchone()[0]
                )
                edge_where, edge_params = self._edge_predicate(provisional)
                edge_count = int(
                    conn.execute(
                        "SELECT COUNT(*) FROM edges e "
                        "JOIN nodes source_node ON source_node.id = e.source "
                        "JOIN nodes target_node ON target_node.id = e.target "
                        f"WHERE {edge_where}",
                        edge_params,
                    ).fetchone()[0]
                )
            finally:
                conn.rollback()

        snapshot = GraphSnapshot(
            token=token,
            node_high_water=node_high_water,
            edge_high_water=edge_high_water,
            observation_high_water=observation_high_water,
            event_sequence=event_sequence,
            filters=filters,
            created_at=now,
            expires_at=now + self.registry.ttl_seconds,
            node_count=node_count,
            edge_count=edge_count,
        )
        self.registry.add(snapshot)
        return {
            "protocol": PROTOCOL,
            "snapshot": token,
            "node_high_water": node_high_water,
            "edge_high_water": edge_high_water,
            "event_sequence": event_sequence,
            "counts": {"nodes": node_count, "edges": edge_count},
            "recommended_limits": {
                "nodes": DEFAULT_NODE_LIMIT,
                "edges": DEFAULT_EDGE_LIMIT,
            },
            "ttl_seconds": self.registry.ttl_seconds,
        }

    def node_page(
        self,
        snapshot_token: str,
        *,
        after: Any = 0,
        limit: Any = None,
    ) -> dict[str, Any]:
        snapshot = self.registry.get(snapshot_token)
        cursor = parse_cursor(after)
        page_limit = parse_limit(
            limit,
            default=DEFAULT_NODE_LIMIT,
            maximum=MAX_NODE_LIMIT,
        )
        where, params = self._node_predicate("n", snapshot)
        with self.store.connection() as conn:
            rows = conn.execute(
                "SELECT n.* FROM nodes n "
                f"WHERE {where} AND n.id > ? "
                "ORDER BY n.id LIMIT ?",
                [*params, cursor, page_limit + 1],
            ).fetchall()
        has_more = len(rows) > page_limit
        rows = rows[:page_limit]
        items = [_renderer_node(row) for row in rows]
        return _page(
            snapshot,
            "nodes",
            cursor,
            page_limit,
            items,
            int(rows[-1]["id"]) if has_more and rows else None,
        )

    def edge_page(
        self,
        snapshot_token: str,
        *,
        after: Any = 0,
        limit: Any = None,
    ) -> dict[str, Any]:
        snapshot = self.registry.get(snapshot_token)
        cursor = parse_cursor(after)
        page_limit = parse_limit(
            limit,
            default=DEFAULT_EDGE_LIMIT,
            maximum=MAX_EDGE_LIMIT,
        )
        where, params = self._edge_predicate(snapshot)
        with self.store.connection() as conn:
            rows = conn.execute(
                "SELECT e.rowid AS id, e.source, e.target, e.relation, "
                "e.weight, e.first_seen_at, e.last_seen_at, e.metadata_json "
                "FROM edges e "
                "JOIN nodes source_node ON source_node.id = e.source "
                "JOIN nodes target_node ON target_node.id = e.target "
                f"WHERE {where} AND e.rowid > ? "
                "ORDER BY e.rowid LIMIT ?",
                [*params, cursor, page_limit + 1],
            ).fetchall()
        has_more = len(rows) > page_limit
        rows = rows[:page_limit]
        items = [_renderer_edge(row) for row in rows]
        return _page(
            snapshot,
            "edges",
            cursor,
            page_limit,
            items,
            int(rows[-1]["id"]) if has_more and rows else None,
        )

    def _resolve_root(self, root: int | str | None) -> int | None:
        if root is None or root == "":
            return None
        try:
            root_id = int(root)
        except (TypeError, ValueError):
            root_id = self.store.node_id_for_url(str(root))
            if root_id is None:
                raise UnknownRoot("root URL is not in the graph")
            return root_id
        if root_id < 1:
            raise ValueError("root must be a positive node ID or URL")
        return root_id

    def _node_predicate(
        self,
        alias: str,
        snapshot: GraphSnapshot,
    ) -> tuple[str, list[Any]]:
        filters = snapshot.filters
        clauses = [f"{alias}.id <= ?"]
        params: list[Any] = [snapshot.node_high_water]
        if filters.root_id is not None:
            clauses.append(
                f"({alias}.id = ? OR {alias}.id IN ("
                "SELECT root_edge.target FROM edges root_edge "
                "WHERE root_edge.rowid <= ? AND root_edge.source = ?) "
                f"OR {alias}.id IN ("
                "SELECT root_edge.source FROM edges root_edge "
                "WHERE root_edge.rowid <= ? AND root_edge.target = ?))"
            )
            params.extend(
                [
                    filters.root_id,
                    snapshot.edge_high_water,
                    filters.root_id,
                    snapshot.edge_high_water,
                    filters.root_id,
                ]
            )
        if filters.query:
            clauses.append(
                f"({alias}.url LIKE ? ESCAPE '\\' "
                f"OR {alias}.title LIKE ? ESCAPE '\\' "
                f"OR {alias}.domain LIKE ? ESCAPE '\\')"
            )
            escaped = (
                filters.query.replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            params.extend([f"%{escaped}%"] * 3)
        if filters.domain:
            clauses.append(f"{alias}.domain = ?")
            params.append(filters.domain)
        if filters.kind:
            clauses.append(f"{alias}.node_type = ?")
            params.append(filters.kind)
        if filters.session_id:
            clauses.append(
                "EXISTS (SELECT 1 FROM observations o "
                f"WHERE (o.source_node_id = {alias}.id "
                f"OR o.target_node_id = {alias}.id) "
                "AND o.session_id = ? AND o.id <= ?)"
            )
            params.extend(
                [filters.session_id, snapshot.observation_high_water]
            )
        if filters.search_id is not None:
            clauses.append(
                "EXISTS (SELECT 1 FROM observations o "
                f"WHERE (o.source_node_id = {alias}.id "
                f"OR o.target_node_id = {alias}.id) "
                "AND o.search_id = ? AND o.id <= ?)"
            )
            params.extend(
                [filters.search_id, snapshot.observation_high_water]
            )
        return " AND ".join(clauses), params

    def _edge_predicate(
        self,
        snapshot: GraphSnapshot,
    ) -> tuple[str, list[Any]]:
        source_where, source_params = self._node_predicate(
            "source_node", snapshot
        )
        target_where, target_params = self._node_predicate(
            "target_node", snapshot
        )
        return (
            f"e.rowid <= ? AND ({source_where}) AND ({target_where})",
            [
                snapshot.edge_high_water,
                *source_params,
                *target_params,
            ],
        )


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalize_domain(value: Any) -> str | None:
    normalized = _optional_text(value)
    return normalized.lower().rstrip(".") if normalized else None


def _optional_positive_int(value: Any, name: str) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 1:
        raise ValueError(f"{name} must be at least 1")
    return parsed


def _metadata(value: Any) -> dict[str, Any]:
    if not value:
        return {}
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _renderer_node(row: Any) -> dict[str, Any]:
    item = dict(row)
    item["metadata"] = _metadata(item.pop("metadata_json", None))
    item["label"] = item.get("title") or item.get("domain") or item["url"]
    item["kind"] = item.get("node_type") or "page"
    item["is_original"] = bool(item.get("is_original", False))
    item["visit_count"] = int(item.get("visit_count") or 1)
    item["first_seen"] = item.get("first_seen_at")
    item["last_seen"] = item.get("last_seen_at")
    return item


def _renderer_edge(row: Any) -> dict[str, Any]:
    item = dict(row)
    item["metadata"] = _metadata(item.pop("metadata_json", None))
    item["kind"] = item.get("relation") or "links_to"
    return item


def _page(
    snapshot: GraphSnapshot,
    phase: str,
    after: int,
    limit: int,
    items: list[dict[str, Any]],
    next_after: int | None,
) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "snapshot": snapshot.token,
        "type": phase,
        "items": items,
        "page": {
            "after": after,
            "next_after": next_after,
            "done": next_after is None,
            "limit": limit,
            "returned": len(items),
        },
    }
