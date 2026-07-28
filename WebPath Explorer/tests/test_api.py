import asyncio
import sqlite3

import pytest

import map as app_module
from webpath.graph_store import GraphStore, canonicalize_url


@pytest.fixture()
def app(tmp_path):
    application = app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "graph.db"),
            "ADMIN_TOKEN": "test-admin-token",
        }
    )
    return application


@pytest.fixture()
def client(app):
    return app.test_client()


def agent_batch():
    return {
        "agent": {
            "id": "codex",
            "name": "Codex",
            "metadata": {"model": "test-model"},
        },
        "session": {
            "id": "thread-123",
            "title": "Shallot research",
            "started_at": "2026-07-28T12:00:00+00:00",
        },
        "search": {
            "id": "search-call-1",
            "event_id": "event-search-1",
            "query": "fast graph renderer",
        },
        "sources": [
            {
                "url": "HTTPS://Example.com:443/research#section",
                "title": "Renderer research",
                "event_id": "event-source-1",
            }
        ],
        "edges": [
            {
                "source_url": "https://example.com/research",
                "target_url": "https://openai.com/",
                "relation": "cites",
                "event_id": "event-edge-1",
                "metadata": {"rank": 1},
            }
        ],
    }


def test_agent_ingestion_is_atomic_and_event_idempotent(client):
    first = client.post("/api/agent/ingest", json=agent_batch())
    assert first.status_code == 201
    assert first.get_json()["observations_inserted"] == 3

    replay = client.post("/api/agent/ingest", json=agent_batch())
    assert replay.status_code == 201
    assert replay.get_json()["observations_inserted"] == 0
    assert replay.get_json()["observations_replayed"] == 3

    graph = client.get("/api/graph").get_json()
    assert graph["meta"]["total"] == {"nodes": 2, "edges": 1}
    assert graph["stats"]["total_nodes"] == 2
    assert graph["stats"]["total_edges"] == 1
    assert {node["url"] for node in graph["nodes"]} == {
        "https://example.com/research",
        "https://openai.com/",
    }
    assert graph["edges"][0]["kind"] == "cites"
    assert graph["edges"][0]["weight"] == 1

    stats = client.get("/api/stats").get_json()
    assert stats["agents"] == 1
    assert stats["sessions"] == 1
    assert stats["searches"] == 1
    assert stats["observations"] == 3


def test_ingestion_validation_rolls_back_entire_batch(client):
    payload = agent_batch()
    payload["sources"].append({"title": "Missing URL"})
    response = client.post("/api/ingest", json=payload)
    assert response.status_code == 400
    assert client.get("/api/stats").get_json()["nodes"] == 0
    assert client.get("/api/stats").get_json()["observations"] == 0


def test_optional_ingestion_token_is_enforced(tmp_path):
    protected = app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "protected.db"),
            "INGEST_TOKEN": "agent-secret",
        }
    ).test_client()
    assert protected.post("/api/ingest", json=agent_batch()).status_code == 403
    assert (
        protected.post(
            "/api/ingest",
            json=agent_batch(),
            headers={"X-Ingest-Token": "agent-secret"},
        ).status_code
        == 201
    )


def test_graph_is_bounded_paginated_and_renderer_compatible(client):
    payload = agent_batch()
    payload["sources"].extend(
        [
            {
                "url": "https://docs.example.org/a",
                "event_id": "event-source-2",
            },
            {
                "url": "https://docs.example.org/b",
                "event_id": "event-source-3",
            },
        ]
    )
    assert client.post("/api/ingest", json=payload).status_code == 201

    response = client.get("/api/graph?limit=2&edge_limit=20")
    assert response.status_code == 200
    graph = response.get_json()
    assert graph["meta"]["returned"]["nodes"] == 2
    assert graph["meta"]["total"]["nodes"] == 4
    assert graph["meta"]["truncated"] is True
    assert graph["page"]["has_more"] is True
    assert graph["page"]["next_after_id"] == graph["nodes"][-1]["id"]
    for node in graph["nodes"]:
        assert {
            "id",
            "url",
            "label",
            "kind",
            "is_original",
            "visit_count",
            "first_seen",
            "last_seen",
        } <= node.keys()

    filtered = client.get("/api/graph?q=docs.example.org").get_json()
    assert len(filtered["nodes"]) == 2
    by_search = client.get("/api/graph?search=1").get_json()
    assert len(by_search["nodes"]) == 4
    rooted = client.get("/api/graph?root=https://example.com/research").get_json()
    assert {node["url"] for node in rooted["nodes"]} == {
        "https://example.com/research",
        "https://openai.com/",
    }


def test_clear_database_requires_admin_token(client):
    assert client.post("/api/cleardb").status_code == 403
    assert (
        client.post(
            "/api/cleardb", headers={"X-Admin-Token": "test-admin-token"}
        ).status_code
        == 200
    )


def test_crawler_rejects_private_network_without_fetching(client):
    response = client.post(
        "/api/search", json={"starting_url": "http://127.0.0.1/admin", "max_depth": 1}
    )
    assert response.status_code == 400
    assert "private" in response.get_json()["error"].lower()


def test_url_canonicalization_is_conservative():
    assert (
        canonicalize_url("HTTPS://Example.COM:443/a?b=1#client")
        == "https://example.com/a?b=1"
    )
    with pytest.raises(ValueError):
        canonicalize_url("file:///etc/passwd")
    with pytest.raises(ValueError):
        canonicalize_url("https://user:secret@example.com/")


def test_existing_legacy_database_is_migrated_without_data_loss(tmp_path):
    database = tmp_path / "legacy.db"
    conn = sqlite3.connect(database)
    conn.executescript(
        """
        CREATE TABLE nodes (
            id INTEGER PRIMARY KEY,
            url TEXT UNIQUE
        );
        CREATE TABLE edges (
            source INTEGER,
            target INTEGER
        );
        CREATE TABLE original_searches (
            url TEXT,
            max_depth TEXT,
            search_date TEXT,
            is_original TEXT
        );
        INSERT INTO nodes (id, url) VALUES (7, 'https://example.com/');
        INSERT INTO original_searches
            (url, max_depth, search_date, is_original)
        VALUES ('https://example.com/', '3', '2025-01-01', '1');
        """
    )
    conn.commit()
    conn.close()

    store = GraphStore(database)
    store.initialize()
    store.initialize()

    with store.connection() as migrated:
        assert migrated.execute("SELECT COUNT(*) FROM nodes").fetchone()[0] == 1
        assert (
            migrated.execute("SELECT COUNT(*) FROM original_searches").fetchone()[0]
            == 1
        )
        assert migrated.execute("SELECT COUNT(*) FROM searches").fetchone()[0] == 1
        node = migrated.execute("SELECT * FROM nodes WHERE id = 7").fetchone()
        assert node["canonical_url"] == "https://example.com/"
        edge_columns = {
            row["name"] for row in migrated.execute("PRAGMA table_info(edges)")
        }
        assert {"relation", "weight", "first_seen_at", "last_seen_at"} <= edge_columns


def test_public_url_validator_rejects_non_global_literal():
    with pytest.raises(ValueError):
        asyncio.run(app_module.validate_public_url("http://[::1]/"))
