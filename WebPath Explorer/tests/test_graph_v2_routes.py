import pytest

import map as app_module


@pytest.fixture()
def app(tmp_path):
    return app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "graph.db"),
        }
    )


@pytest.fixture()
def client(app):
    return app.test_client()


def _seed_graph(app):
    store = app.extensions["graph_store"]
    node_ids = [
        store.upsert_node(f"https://example.com/{name}", title=name.upper())
        for name in ("a", "b", "c", "d")
    ]
    cross_page_edge = store.upsert_edge(node_ids[0], node_ids[2])
    second_edge = store.upsert_edge(node_ids[1], node_ids[3], relation="cites")
    return node_ids, {cross_page_edge, second_edge}


def _collect_pages(client, phase, token, *, limit):
    items = []
    cursor = 0
    while True:
        response = client.get(
            f"/api/graph/v2/{phase}",
            query_string={"snapshot": token, "after": cursor, "limit": limit},
        )
        assert response.status_code == 200
        page = response.get_json()
        assert page["protocol"] == "webpath.graph.v2"
        assert page["snapshot"] == token
        assert page["type"] == phase
        assert page["page"]["after"] == cursor
        assert page["page"]["returned"] == len(page["items"])
        items.extend(page["items"])
        if page["page"]["done"]:
            assert page["page"]["next_after"] is None
            return items
        cursor = page["page"]["next_after"]
        assert cursor is not None


def test_manifest_and_progressive_pages_round_trip(app, client):
    node_ids, edge_ids = _seed_graph(app)

    response = client.get("/api/graph/v2/manifest")
    assert response.status_code == 200
    manifest = response.get_json()
    assert manifest["protocol"] == "webpath.graph.v2"
    assert manifest["snapshot"]
    assert manifest["counts"] == {"nodes": 4, "edges": 2}
    assert manifest["node_high_water"] == max(node_ids)
    assert manifest["edge_high_water"] == max(edge_ids)
    assert manifest["event_sequence"] == 0
    assert manifest["recommended_limits"] == {"nodes": 4096, "edges": 16384}
    assert manifest["ttl_seconds"] == 600

    nodes = _collect_pages(client, "nodes", manifest["snapshot"], limit=2)
    edges = _collect_pages(client, "edges", manifest["snapshot"], limit=1)

    assert {node["id"] for node in nodes} == set(node_ids)
    assert {edge["id"] for edge in edges} == edge_ids
    for node in nodes:
        assert {
            "id",
            "url",
            "label",
            "kind",
            "is_original",
            "visit_count",
            "first_seen",
            "last_seen",
            "metadata",
        } <= node.keys()
    for edge in edges:
        assert {"id", "source", "target", "kind", "metadata"} <= edge.keys()
    # The independent edge cursor preserves edges whose endpoints landed on
    # different node pages.
    assert any(
        edge["source"] == node_ids[0] and edge["target"] == node_ids[2]
        for edge in edges
    )


def test_manifest_filters_bind_to_the_snapshot(app, client):
    node_ids, _ = _seed_graph(app)

    manifest = client.get(
        "/api/graph/v2/manifest",
        query_string={"q": "example.com", "kind": "page"},
    ).get_json()
    nodes = _collect_pages(client, "nodes", manifest["snapshot"], limit=10)
    edges = _collect_pages(client, "edges", manifest["snapshot"], limit=10)
    assert {node["id"] for node in nodes} == set(node_ids)
    assert len(edges) == 2

    filtered = client.get(
        "/api/graph/v2/manifest", query_string={"q": "no-such-title"}
    ).get_json()
    assert filtered["counts"] == {"nodes": 0, "edges": 0}
    nodes = _collect_pages(client, "nodes", filtered["snapshot"], limit=10)
    assert nodes == []


def test_unknown_or_missing_snapshot_returns_409(client):
    missing = client.get("/api/graph/v2/nodes")
    assert missing.status_code == 409
    assert missing.get_json() == {"error": "snapshot_invalidated"}

    unknown = client.get(
        "/api/graph/v2/edges", query_string={"snapshot": "not-a-token"}
    )
    assert unknown.status_code == 409
    assert unknown.get_json() == {"error": "snapshot_invalidated"}


def test_expired_snapshot_returns_409(app, client):
    delivery = app.extensions["graph_delivery"]
    delivery.registry.ttl_seconds = 0.01
    manifest = client.get("/api/graph/v2/manifest").get_json()

    import time

    time.sleep(0.05)
    response = client.get(
        "/api/graph/v2/nodes", query_string={"snapshot": manifest["snapshot"]}
    )
    assert response.status_code == 409
    assert response.get_json() == {"error": "snapshot_invalidated"}


def test_unknown_root_returns_404(client):
    response = client.get(
        "/api/graph/v2/manifest",
        query_string={"root": "https://missing.example/"},
    )
    assert response.status_code == 404
    assert "root" in response.get_json()["error"].lower()


def test_invalid_cursors_limits_and_filters_return_400(app, client):
    _seed_graph(app)
    token = client.get("/api/graph/v2/manifest").get_json()["snapshot"]

    for phase in ("nodes", "edges"):
        for query in (
            {"snapshot": token, "after": -1},
            {"snapshot": token, "after": "abc"},
            {"snapshot": token, "limit": 0},
            {"snapshot": token, "limit": "many"},
            {"snapshot": token, "limit": 1_000_000},
        ):
            response = client.get(f"/api/graph/v2/{phase}", query_string=query)
            assert response.status_code == 400, (phase, query)
            assert "error" in response.get_json()

    assert (
        client.get(
            "/api/graph/v2/manifest", query_string={"search": 0}
        ).status_code
        == 400
    )
    assert (
        client.get(
            "/api/graph/v2/manifest", query_string={"root": 0}
        ).status_code
        == 400
    )


def test_pages_exclude_post_manifest_appends(app, client):
    node_ids, edge_ids = _seed_graph(app)
    manifest = client.get("/api/graph/v2/manifest").get_json()

    store = app.extensions["graph_store"]
    appended = store.upsert_node("https://example.com/appended")
    store.upsert_edge(node_ids[3], appended)

    nodes = _collect_pages(client, "nodes", manifest["snapshot"], limit=10)
    edges = _collect_pages(client, "edges", manifest["snapshot"], limit=10)
    assert {node["id"] for node in nodes} == set(node_ids)
    assert {edge["id"] for edge in edges} == edge_ids
