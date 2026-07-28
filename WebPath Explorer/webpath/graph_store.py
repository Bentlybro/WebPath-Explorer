"""Provide durable SQLite storage for WebPath Explorer.

The migration strategy in this module is deliberately additive.  The original
``nodes``, ``edges`` and ``original_searches`` tables are retained so databases
created by early versions of WebPath Explorer continue to work.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import SplitResult, urlsplit, urlunsplit


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def canonicalize_url(value: str) -> str:
    """Return a conservative canonical form without changing URL semantics."""
    if not isinstance(value, str):
        raise ValueError("URL must be a string")
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise ValueError("URL must be an absolute HTTP or HTTPS URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError("URLs containing credentials are not accepted")

    host = parts.hostname.rstrip(".").lower()
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError("URL contains an invalid port") from exc
    if ":" in host:
        host = f"[{host}]"
    default_port = (parts.scheme.lower() == "http" and port == 80) or (
        parts.scheme.lower() == "https" and port == 443
    )
    netloc = host if port is None or default_port else f"{host}:{port}"
    path = parts.path or "/"
    canonical = SplitResult(
        parts.scheme.lower(),
        netloc,
        path,
        parts.query,
        "",  # fragments are client-side and never identify a fetched resource
    )
    return urlunsplit(canonical)


def _json(value: Any) -> str:
    if value is None:
        value = {}
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _decode_json(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


class GraphStore:
    """SQLite-backed graph store with idempotent schema initialization."""

    def __init__(self, database: str | Path):
        self.database = str(database)
        # A Flask process shares one GraphStore across crawler threads. SQLite
        # permits concurrent readers but only one writer, so serialize complete
        # read-modify-write transactions instead of allowing two deferred
        # transactions to race while upgrading their locks.
        self._write_lock = threading.RLock()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.database, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def write_connection(self) -> Iterator[sqlite3.Connection]:
        """Yield a process-serialized transaction with the write lock acquired.

        ``BEGIN IMMEDIATE`` makes SQLite wait (using ``busy_timeout``) before
        any read-modify-write work starts. This avoids the lock-upgrade race
        that deferred transactions can hit during concurrent crawls.
        """
        with self._write_lock:
            with self.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    yield conn
                except Exception:
                    conn.rollback()
                    raise
                else:
                    conn.commit()

    def initialize(self) -> None:
        database_path = Path(self.database)
        if self.database != ":memory:":
            database_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            # WAL is persistent and improves the read/write behaviour of a graph
            # that is being viewed while agents append observations.
            if self.database != ":memory:":
                conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS nodes (
                    id INTEGER PRIMARY KEY,
                    url TEXT UNIQUE
                );
                CREATE TABLE IF NOT EXISTS edges (
                    source INTEGER,
                    target INTEGER,
                    FOREIGN KEY(source) REFERENCES nodes(id),
                    FOREIGN KEY(target) REFERENCES nodes(id)
                );
                CREATE TABLE IF NOT EXISTS original_searches (
                    url TEXT,
                    max_depth TEXT,
                    search_date TEXT,
                    is_original TEXT
                );
                """
            )
            self._ensure_columns(
                conn,
                "nodes",
                {
                    "canonical_url": "TEXT",
                    "domain": "TEXT",
                    "title": "TEXT",
                    "node_type": "TEXT NOT NULL DEFAULT 'page'",
                    "is_original": "INTEGER NOT NULL DEFAULT 0",
                    "visit_count": "INTEGER NOT NULL DEFAULT 1",
                    "first_seen_at": "TEXT",
                    "last_seen_at": "TEXT",
                    "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
                },
            )
            self._ensure_columns(
                conn,
                "edges",
                {
                    "relation": "TEXT NOT NULL DEFAULT 'links_to'",
                    "weight": "INTEGER NOT NULL DEFAULT 1",
                    "first_seen_at": "TEXT",
                    "last_seen_at": "TEXT",
                    "metadata_json": "TEXT NOT NULL DEFAULT '{}'",
                },
            )
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS research_sessions (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    title TEXT,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(agent_id) REFERENCES agents(id)
                );
                CREATE TABLE IF NOT EXISTS searches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    external_id TEXT,
                    session_id TEXT,
                    agent_id TEXT,
                    query TEXT,
                    starting_url TEXT,
                    max_depth INTEGER,
                    status TEXT NOT NULL DEFAULT 'recorded',
                    created_at TEXT NOT NULL,
                    completed_at TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    legacy_rowid INTEGER,
                    FOREIGN KEY(session_id) REFERENCES research_sessions(id),
                    FOREIGN KEY(agent_id) REFERENCES agents(id)
                );
                CREATE TABLE IF NOT EXISTS observations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT UNIQUE,
                    event_type TEXT NOT NULL,
                    agent_id TEXT,
                    session_id TEXT,
                    search_id INTEGER,
                    source_node_id INTEGER,
                    target_node_id INTEGER,
                    observed_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY(agent_id) REFERENCES agents(id),
                    FOREIGN KEY(session_id) REFERENCES research_sessions(id),
                    FOREIGN KEY(search_id) REFERENCES searches(id),
                    FOREIGN KEY(source_node_id) REFERENCES nodes(id),
                    FOREIGN KEY(target_node_id) REFERENCES nodes(id)
                );
                CREATE INDEX IF NOT EXISTS idx_nodes_canonical_url
                    ON nodes(canonical_url);
                CREATE INDEX IF NOT EXISTS idx_nodes_domain_id
                    ON nodes(domain, id);
                CREATE INDEX IF NOT EXISTS idx_edges_source
                    ON edges(source);
                CREATE INDEX IF NOT EXISTS idx_edges_target
                    ON edges(target);
                CREATE INDEX IF NOT EXISTS idx_searches_session
                    ON searches(session_id, id);
                CREATE INDEX IF NOT EXISTS idx_searches_external
                    ON searches(agent_id, external_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_searches_legacy
                    ON searches(legacy_rowid) WHERE legacy_rowid IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_observations_session
                    ON observations(session_id, id);
                CREATE INDEX IF NOT EXISTS idx_observations_search
                    ON observations(search_id, id);
                CREATE INDEX IF NOT EXISTS idx_observations_source
                    ON observations(source_node_id, id);
                """
            )
            # A unique index is safe on new databases.  Old databases may have
            # duplicate edge rows, which we preserve instead of deleting during
            # an automatic migration.
            try:
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique "
                    "ON edges(source, target, relation)"
                )
            except sqlite3.IntegrityError:
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_edges_relation "
                    "ON edges(source, target, relation)"
                )
            now = utc_now()
            conn.execute(
                """
                UPDATE nodes SET
                    canonical_url = COALESCE(canonical_url, url),
                    domain = COALESCE(domain, ''),
                    first_seen_at = COALESCE(first_seen_at, ?),
                    last_seen_at = COALESCE(last_seen_at, ?),
                    metadata_json = COALESCE(metadata_json, '{}')
                """,
                (now, now),
            )
            conn.execute(
                """
                UPDATE edges SET
                    relation = COALESCE(relation, 'links_to'),
                    weight = COALESCE(weight, 1),
                    first_seen_at = COALESCE(first_seen_at, ?),
                    last_seen_at = COALESCE(last_seen_at, ?),
                    metadata_json = COALESCE(metadata_json, '{}')
                """,
                (now, now),
            )
            self._migrate_legacy_searches(conn)
            conn.execute(
                """
                UPDATE nodes SET is_original = 1
                WHERE url IN (
                    SELECT url FROM original_searches WHERE url IS NOT NULL
                )
                """
            )
            conn.commit()

    @staticmethod
    def _ensure_columns(
        conn: sqlite3.Connection, table: str, columns: dict[str, str]
    ) -> None:
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, declaration in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")

    @staticmethod
    def _migrate_legacy_searches(conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT rowid, url, max_depth, search_date FROM original_searches"
        ).fetchall()
        for row in rows:
            try:
                max_depth = int(row["max_depth"])
            except (TypeError, ValueError):
                max_depth = None
            conn.execute(
                """
                INSERT OR IGNORE INTO searches
                    (starting_url, max_depth, status, created_at, legacy_rowid)
                VALUES (?, ?, 'legacy', ?, ?)
                """,
                (row["url"], max_depth, row["search_date"] or utc_now(), row["rowid"]),
            )

    def upsert_node(
        self,
        url: str,
        *,
        title: str | None = None,
        node_type: str = "page",
        metadata: dict[str, Any] | None = None,
        observed_at: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> int:
        canonical = canonicalize_url(url)
        domain = urlsplit(canonical).hostname or ""
        now = observed_at or utc_now()

        def execute(active: sqlite3.Connection) -> int:
            row = active.execute(
                "SELECT id, metadata_json FROM nodes "
                "WHERE canonical_url = ? OR url = ? ORDER BY id LIMIT 1",
                (canonical, canonical),
            ).fetchone()
            if row:
                merged = _decode_json(row["metadata_json"])
                if metadata:
                    merged.update(metadata)
                active.execute(
                    """
                    UPDATE nodes SET
                        canonical_url = ?, domain = ?,
                        title = COALESCE(?, title),
                        node_type = COALESCE(?, node_type),
                        visit_count = COALESCE(visit_count, 0) + 1,
                        last_seen_at = ?, metadata_json = ?
                    WHERE id = ?
                    """,
                    (canonical, domain, title, node_type, now, _json(merged), row["id"]),
                )
                return int(row["id"])
            cursor = active.execute(
                """
                INSERT INTO nodes
                    (url, canonical_url, domain, title, node_type,
                     first_seen_at, last_seen_at, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    canonical,
                    canonical,
                    domain,
                    title,
                    node_type,
                    now,
                    now,
                    _json(metadata),
                ),
            )
            return int(cursor.lastrowid)

        if conn is not None:
            with self._write_lock:
                return execute(conn)
        with self.write_connection() as active:
            return execute(active)

    def upsert_edge(
        self,
        source_id: int,
        target_id: int,
        *,
        relation: str = "links_to",
        metadata: dict[str, Any] | None = None,
        observed_at: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> int:
        relation = (relation or "links_to").strip()[:80]
        now = observed_at or utc_now()

        def execute(active: sqlite3.Connection) -> int:
            row = active.execute(
                """
                SELECT rowid, weight, metadata_json FROM edges
                WHERE source = ? AND target = ? AND relation = ?
                ORDER BY rowid LIMIT 1
                """,
                (source_id, target_id, relation),
            ).fetchone()
            if row:
                merged = _decode_json(row["metadata_json"])
                if metadata:
                    merged.update(metadata)
                active.execute(
                    """
                    UPDATE edges SET weight = ?, last_seen_at = ?, metadata_json = ?
                    WHERE rowid = ?
                    """,
                    (
                        int(row["weight"] or 1) + 1,
                        now,
                        _json(merged),
                        row["rowid"],
                    ),
                )
                return int(row["rowid"])
            cursor = active.execute(
                """
                INSERT INTO edges
                    (source, target, relation, weight, first_seen_at,
                     last_seen_at, metadata_json)
                VALUES (?, ?, ?, 1, ?, ?, ?)
                """,
                (source_id, target_id, relation, now, now, _json(metadata)),
            )
            return int(cursor.lastrowid)

        if conn is not None:
            with self._write_lock:
                return execute(conn)
        with self.write_connection() as active:
            return execute(active)

    def create_legacy_search(self, url: str, max_depth: int) -> int:
        now = utc_now()
        with self.write_connection() as conn:
            node_id = self.upsert_node(url, conn=conn)
            conn.execute(
                "UPDATE nodes SET is_original = 1 WHERE id = ?",
                (node_id,),
            )
            legacy = conn.execute(
                """
                INSERT INTO original_searches
                    (url, max_depth, search_date, is_original)
                VALUES (?, ?, ?, ?)
                """,
                (url, max_depth, now, "1"),
            )
            search = conn.execute(
                """
                INSERT INTO searches
                    (starting_url, max_depth, status, created_at, legacy_rowid)
                VALUES (?, ?, 'crawling', ?, ?)
                """,
                (url, max_depth, now, legacy.lastrowid),
            )
            return int(search.lastrowid)

    def complete_search(self, search_id: int, status: str = "completed") -> None:
        with self.write_connection() as conn:
            conn.execute(
                "UPDATE searches SET status = ?, completed_at = ? WHERE id = ?",
                (status, utc_now(), search_id),
            )

    def ingest_agent_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Ingest one provenance-rich agent research batch atomically.

        Contract::

            {
              "agent": {"id": "codex", "name": "Codex", "metadata": {}},
              "session": {"id": "thread-123", "title": "...",
                          "started_at": "<ISO-8601>", "metadata": {}},
              "search": {"id": "tool-call-9", "query": "...",
                         "started_at": "<ISO-8601>", "metadata": {}},  # optional
              "sources": [{"url": "https://...", "title": "...",
                           "event_id": "...", "observed_at": "...",
                           "metadata": {}}],
              "edges": [{"source_url": "https://...",
                         "target_url": "https://...",
                         "relation": "links_to", "event_id": "...",
                         "observed_at": "...", "metadata": {}}]
            }

        ``event_id`` values make retries idempotent at the observation level.
        Source and edge entities are always canonical upserts; observations are
        append-only unless an event ID is replayed.
        """
        agent = payload.get("agent")
        session = payload.get("session")
        if not isinstance(agent, dict) or not str(agent.get("id", "")).strip():
            raise ValueError("agent.id is required")
        if not isinstance(session, dict) or not str(session.get("id", "")).strip():
            raise ValueError("session.id is required")
        sources = payload.get("sources", [])
        edges = payload.get("edges", [])
        if not isinstance(sources, list) or not isinstance(edges, list):
            raise ValueError("sources and edges must be arrays")
        if len(sources) > 5_000 or len(edges) > 20_000:
            raise ValueError("ingestion batch is too large")

        agent_id = str(agent["id"]).strip()[:200]
        session_id = str(session["id"]).strip()[:200]
        now = utc_now()
        inserted_observations = 0
        duplicate_observations = 0
        source_ids: dict[str, int] = {}
        search_id: int | None = None

        with self.write_connection() as conn:
            existing_agent = conn.execute(
                "SELECT metadata_json FROM agents WHERE id = ?", (agent_id,)
            ).fetchone()
            agent_metadata = _decode_json(
                existing_agent["metadata_json"] if existing_agent else None
            )
            agent_metadata.update(agent.get("metadata") or {})
            conn.execute(
                """
                INSERT INTO agents
                    (id, name, first_seen_at, last_seen_at, metadata_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = COALESCE(excluded.name, agents.name),
                    last_seen_at = excluded.last_seen_at,
                    metadata_json = excluded.metadata_json
                """,
                (
                    agent_id,
                    agent.get("name"),
                    now,
                    now,
                    _json(agent_metadata),
                ),
            )
            conn.execute(
                """
                INSERT INTO research_sessions
                    (id, agent_id, title, started_at, ended_at, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = COALESCE(excluded.title, research_sessions.title),
                    ended_at = COALESCE(excluded.ended_at, research_sessions.ended_at),
                    metadata_json = excluded.metadata_json
                """,
                (
                    session_id,
                    agent_id,
                    session.get("title"),
                    session.get("started_at") or now,
                    session.get("ended_at"),
                    _json(session.get("metadata")),
                ),
            )

            search = payload.get("search")
            if search is not None:
                if not isinstance(search, dict):
                    raise ValueError("search must be an object")
                external_id = str(search.get("id", "")).strip() or None
                existing_search = None
                if external_id:
                    existing_search = conn.execute(
                        """
                        SELECT id FROM searches
                        WHERE agent_id = ? AND external_id = ?
                        ORDER BY id LIMIT 1
                        """,
                        (agent_id, external_id),
                    ).fetchone()
                if existing_search:
                    search_id = int(existing_search["id"])
                    conn.execute(
                        """
                        UPDATE searches SET
                            query = COALESCE(?, query),
                            status = COALESCE(?, status),
                            completed_at = COALESCE(?, completed_at),
                            metadata_json = ?
                        WHERE id = ?
                        """,
                        (
                            search.get("query"),
                            search.get("status"),
                            search.get("completed_at"),
                            _json(search.get("metadata")),
                            search_id,
                        ),
                    )
                else:
                    cursor = conn.execute(
                        """
                        INSERT INTO searches
                            (external_id, session_id, agent_id, query,
                             starting_url, status, created_at, completed_at,
                             metadata_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            external_id,
                            session_id,
                            agent_id,
                            search.get("query"),
                            search.get("starting_url"),
                            search.get("status") or "recorded",
                            search.get("started_at") or now,
                            search.get("completed_at"),
                            _json(search.get("metadata")),
                        ),
                    )
                    search_id = int(cursor.lastrowid)
                inserted, duplicate = self._insert_observation(
                    conn,
                    event_id=search.get("event_id"),
                    event_type="search",
                    agent_id=agent_id,
                    session_id=session_id,
                    search_id=search_id,
                    observed_at=search.get("started_at") or now,
                    payload=search,
                )
                inserted_observations += inserted
                duplicate_observations += duplicate

            for source in sources:
                if not isinstance(source, dict) or not source.get("url"):
                    raise ValueError("each source must be an object with a URL")
                prior = self._existing_observation(conn, source.get("event_id"))
                if prior:
                    if prior["event_type"] != "source" or not prior["source_node_id"]:
                        raise ValueError("event_id was already used by another event")
                    source_ids[canonicalize_url(source["url"])] = int(
                        prior["source_node_id"]
                    )
                    duplicate_observations += 1
                    continue
                node_id = self.upsert_node(
                    source["url"],
                    title=source.get("title"),
                    node_type=source.get("node_type") or "page",
                    metadata=source.get("metadata"),
                    observed_at=source.get("observed_at"),
                    conn=conn,
                )
                source_ids[canonicalize_url(source["url"])] = node_id
                inserted, duplicate = self._insert_observation(
                    conn,
                    event_id=source.get("event_id"),
                    event_type="source",
                    agent_id=agent_id,
                    session_id=session_id,
                    search_id=search_id,
                    source_node_id=node_id,
                    observed_at=source.get("observed_at") or now,
                    payload=source,
                )
                inserted_observations += inserted
                duplicate_observations += duplicate

            for edge in edges:
                if not isinstance(edge, dict):
                    raise ValueError("each edge must be an object")
                source_url = edge.get("source_url")
                target_url = edge.get("target_url")
                if not source_url or not target_url:
                    raise ValueError("each edge needs source_url and target_url")
                source_key = canonicalize_url(source_url)
                target_key = canonicalize_url(target_url)
                prior = self._existing_observation(conn, edge.get("event_id"))
                if prior:
                    if (
                        prior["event_type"] != "edge"
                        or not prior["source_node_id"]
                        or not prior["target_node_id"]
                    ):
                        raise ValueError("event_id was already used by another event")
                    source_ids[source_key] = int(prior["source_node_id"])
                    source_ids[target_key] = int(prior["target_node_id"])
                    duplicate_observations += 1
                    continue
                source_node_id = source_ids.get(source_key) or self.upsert_node(
                    source_url, conn=conn
                )
                target_node_id = source_ids.get(target_key) or self.upsert_node(
                    target_url, conn=conn
                )
                source_ids[source_key] = source_node_id
                source_ids[target_key] = target_node_id
                self.upsert_edge(
                    source_node_id,
                    target_node_id,
                    relation=edge.get("relation") or "links_to",
                    metadata=edge.get("metadata"),
                    observed_at=edge.get("observed_at"),
                    conn=conn,
                )
                inserted, duplicate = self._insert_observation(
                    conn,
                    event_id=edge.get("event_id"),
                    event_type="edge",
                    agent_id=agent_id,
                    session_id=session_id,
                    search_id=search_id,
                    source_node_id=source_node_id,
                    target_node_id=target_node_id,
                    observed_at=edge.get("observed_at") or now,
                    payload=edge,
                )
                inserted_observations += inserted
                duplicate_observations += duplicate

        return {
            "agent_id": agent_id,
            "session_id": session_id,
            "search_id": search_id,
            "nodes_touched": len(source_ids),
            "edges_touched": len(edges),
            "observations_inserted": inserted_observations,
            "observations_replayed": duplicate_observations,
        }

    @staticmethod
    def _existing_observation(
        conn: sqlite3.Connection, event_id: str | None
    ) -> sqlite3.Row | None:
        if not event_id:
            return None
        return conn.execute(
            """
            SELECT event_type, source_node_id, target_node_id
            FROM observations WHERE event_id = ?
            """,
            (str(event_id)[:200],),
        ).fetchone()

    @staticmethod
    def _insert_observation(
        conn: sqlite3.Connection,
        *,
        event_id: str | None,
        event_type: str,
        agent_id: str,
        session_id: str,
        search_id: int | None,
        observed_at: str,
        payload: dict[str, Any],
        source_node_id: int | None = None,
        target_node_id: int | None = None,
    ) -> tuple[int, int]:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO observations
                (event_id, event_type, agent_id, session_id, search_id,
                 source_node_id, target_node_id, observed_at, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(event_id)[:200] if event_id else None,
                event_type,
                agent_id,
                session_id,
                search_id,
                source_node_id,
                target_node_id,
                observed_at,
                _json(payload),
            ),
        )
        inserted = 1 if cursor.rowcount else 0
        return inserted, 1 - inserted

    def graph_slice(
        self,
        *,
        after_id: int = 0,
        node_limit: int = 1_000,
        edge_limit: int = 5_000,
        root_id: int | None = None,
        query: str | None = None,
        domain: str | None = None,
        session_id: str | None = None,
        search_id: int | None = None,
    ) -> dict[str, Any]:
        node_limit = max(1, min(node_limit, 2_147_483_647))
        edge_limit = max(0, min(edge_limit, 2_147_483_647))
        where = ["n.id > ?"]
        params: list[Any] = [after_id]
        if root_id is not None:
            where.append(
                "(n.id = ? OR n.id IN "
                "(SELECT target FROM edges WHERE source = ?) OR n.id IN "
                "(SELECT source FROM edges WHERE target = ?))"
            )
            params.extend([root_id, root_id, root_id])
        if query:
            where.append(
                "(n.url LIKE ? ESCAPE '\\' OR n.title LIKE ? ESCAPE '\\' "
                "OR n.domain LIKE ? ESCAPE '\\')"
            )
            escaped = (
                query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            )
            params.extend([f"%{escaped}%"] * 3)
        if domain:
            where.append("n.domain = ?")
            params.append(domain.lower().rstrip("."))
        if session_id:
            where.append(
                "EXISTS (SELECT 1 FROM observations o "
                "WHERE (o.source_node_id = n.id OR o.target_node_id = n.id) "
                "AND o.session_id = ?)"
            )
            params.append(session_id)
        if search_id is not None:
            where.append(
                "EXISTS (SELECT 1 FROM observations o "
                "WHERE (o.source_node_id = n.id OR o.target_node_id = n.id) "
                "AND o.search_id = ?)"
            )
            params.append(search_id)
        where_sql = " AND ".join(where)
        sql = (
            "SELECT n.* FROM nodes n WHERE "
            + where_sql
            + " ORDER BY n.id LIMIT ?"
        )
        node_params = [*params, node_limit + 1]
        with self.connection() as conn:
            rows = conn.execute(sql, node_params).fetchall()
            has_more = len(rows) > node_limit
            rows = rows[:node_limit]
            nodes = [self._node_dict(row) for row in rows]
            edges: list[dict[str, Any]] = []
            if nodes and edge_limit:
                edge_rows = conn.execute(
                    f"""
                    WITH selected_nodes AS (
                        SELECT n.id FROM nodes n
                        WHERE {where_sql}
                        ORDER BY n.id
                        LIMIT ?
                    )
                    SELECT e.rowid AS id, e.source, e.target, e.relation,
                           e.weight, e.first_seen_at, e.last_seen_at,
                           e.metadata_json
                    FROM edges e
                    JOIN selected_nodes source_node ON source_node.id = e.source
                    JOIN selected_nodes target_node ON target_node.id = e.target
                    ORDER BY e.rowid
                    LIMIT ?
                    """,
                    [*params, node_limit, edge_limit],
                ).fetchall()
                edges = [self._edge_dict(row) for row in edge_rows]
        return {
            "nodes": nodes,
            "edges": edges,
            "page": {
                "after_id": after_id,
                "next_after_id": nodes[-1]["id"] if has_more and nodes else None,
                "has_more": has_more,
                "node_limit": node_limit,
                "edge_limit": edge_limit,
            },
        }

    def node_id_for_url(self, url: str) -> int | None:
        canonical = canonicalize_url(url)
        with self.connection() as conn:
            row = conn.execute(
                "SELECT id FROM nodes WHERE canonical_url = ? OR url = ? "
                "ORDER BY id LIMIT 1",
                (canonical, canonical),
            ).fetchone()
        return int(row["id"]) if row else None

    @staticmethod
    def _node_dict(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["metadata"] = _decode_json(item.pop("metadata_json", None))
        return item

    @staticmethod
    def _edge_dict(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["metadata"] = _decode_json(item.pop("metadata_json", None))
        return item

    def nodes(self, limit: int = 100_000) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 100_000))
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM nodes ORDER BY id LIMIT ?", (limit,)).fetchall()
        return [self._node_dict(row) for row in rows]

    def edges(self, limit: int = 250_000) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 250_000))
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT rowid AS id, source, target, relation, weight,
                       first_seen_at, last_seen_at, metadata_json
                FROM edges ORDER BY rowid LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [self._edge_dict(row) for row in rows]

    def legacy_searches(self) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT rowid AS id, * FROM original_searches ORDER BY rowid"
            ).fetchall()
        return [dict(row) for row in rows]

    def stats(self) -> dict[str, Any]:
        tables = {
            "nodes": "nodes",
            "edges": "edges",
            "domains": "(SELECT DISTINCT domain FROM nodes WHERE domain <> '')",
            "searches": "searches",
            "agents": "agents",
            "sessions": "research_sessions",
            "observations": "observations",
        }
        with self.connection() as conn:
            counts = {
                name: int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                for name, table in tables.items()
            }
            latest = conn.execute(
                """
                SELECT MAX(value) FROM (
                    SELECT MAX(last_seen_at) AS value FROM nodes
                    UNION ALL SELECT MAX(last_seen_at) FROM edges
                    UNION ALL SELECT MAX(observed_at) FROM observations
                )
                """
            ).fetchone()[0]
            event_rows = conn.execute(
                "SELECT event_type, COUNT(*) AS count FROM observations "
                "GROUP BY event_type ORDER BY event_type"
            ).fetchall()
        return {
            **counts,
            "last_updated_at": latest,
            "observation_types": {
                row["event_type"]: int(row["count"]) for row in event_rows
            },
        }

    def clear_all(self) -> None:
        with self.write_connection() as conn:
            # Children are deleted first because foreign keys are enforced.
            for table in (
                "observations",
                "searches",
                "research_sessions",
                "agents",
                "edges",
                "nodes",
                "original_searches",
            ):
                conn.execute(f"DELETE FROM {table}")
