import pytest

from webpath.graph_delivery import (
    GraphDelivery,
    SnapshotRegistry,
    SnapshotUnavailable,
)
from webpath.graph_store import GraphStore


def _collect_pages(fetch_page, token, *, limit):
    items = []
    cursor = 0
    pages = []
    while True:
        page = fetch_page(token, after=cursor, limit=limit)
        pages.append(page)
        items.extend(page["items"])
        next_cursor = page["page"]["next_after"]
        if next_cursor is None:
            return items, pages
        cursor = next_cursor


def test_independent_edge_cursor_preserves_cross_page_edges(tmp_path):
    store = GraphStore(tmp_path / "graph.db")
    store.initialize()
    node_ids = [
        store.upsert_node(f"https://example.com/{name}", title=name.upper())
        for name in ("a", "b", "c", "d")
    ]
    cross_page_edge = store.upsert_edge(node_ids[0], node_ids[2])
    second_edge = store.upsert_edge(node_ids[1], node_ids[3], relation="cites")

    delivery = GraphDelivery(store)
    manifest = delivery.create_manifest(event_sequence=27)
    token = manifest["snapshot"]
    nodes, node_pages = _collect_pages(delivery.node_page, token, limit=2)
    edges, edge_pages = _collect_pages(delivery.edge_page, token, limit=1)

    assert manifest["protocol"] == "webpath.graph.v2"
    assert manifest["event_sequence"] == 27
    assert manifest["counts"] == {"nodes": 4, "edges": 2}
    assert len(node_pages) == 2
    assert len(edge_pages) == 2
    assert {node["id"] for node in nodes} == set(node_ids)
    assert {edge["id"] for edge in edges} == {cross_page_edge, second_edge}
    assert any(
        edge["source"] == node_ids[0] and edge["target"] == node_ids[2]
        for edge in edges
    )
    assert all("kind" in edge and "metadata" in edge for edge in edges)


def test_post_manifest_appends_are_excluded_from_both_phases(tmp_path):
    store = GraphStore(tmp_path / "graph.db")
    store.initialize()
    first = store.upsert_node("https://example.com/first")
    second = store.upsert_node("https://example.com/second")
    original_edge = store.upsert_edge(first, second)

    delivery = GraphDelivery(store)
    manifest = delivery.create_manifest()

    appended = store.upsert_node("https://example.com/appended")
    appended_edge = store.upsert_edge(second, appended)

    nodes, _ = _collect_pages(
        delivery.node_page,
        manifest["snapshot"],
        limit=1,
    )
    edges, _ = _collect_pages(
        delivery.edge_page,
        manifest["snapshot"],
        limit=1,
    )

    assert {node["id"] for node in nodes} == {first, second}
    assert {edge["id"] for edge in edges} == {original_edge}
    assert appended > manifest["node_high_water"]
    assert appended_edge > manifest["edge_high_water"]


def test_filters_apply_identically_to_node_and_edge_phases(tmp_path):
    store = GraphStore(tmp_path / "graph.db")
    store.initialize()
    root = store.upsert_node(
        "https://example.com/root",
        title="Research Root",
        node_type="claim",
    )
    neighbor = store.upsert_node(
        "https://example.com/neighbor",
        title="Research Neighbor",
        node_type="claim",
    )
    unrelated = store.upsert_node(
        "https://elsewhere.test/unrelated",
        title="Other",
        node_type="page",
    )
    included_edge = store.upsert_edge(root, neighbor, relation="supports")
    store.upsert_edge(neighbor, unrelated)

    delivery = GraphDelivery(store)
    manifest = delivery.create_manifest(
        query="Research",
        domain="EXAMPLE.COM.",
        kind="claim",
        root=root,
    )
    nodes, _ = _collect_pages(
        delivery.node_page,
        manifest["snapshot"],
        limit=1,
    )
    edges, _ = _collect_pages(
        delivery.edge_page,
        manifest["snapshot"],
        limit=1,
    )

    assert {node["id"] for node in nodes} == {root, neighbor}
    assert [edge["id"] for edge in edges] == [included_edge]


def test_snapshot_tokens_expire(tmp_path):
    store = GraphStore(tmp_path / "graph.db")
    store.initialize()
    store.upsert_node("https://example.com/")
    now = [10.0]
    registry = SnapshotRegistry(ttl_seconds=5, clock=lambda: now[0])
    delivery = GraphDelivery(store, registry=registry)
    token = delivery.create_manifest()["snapshot"]

    now[0] = 15.0

    with pytest.raises(SnapshotUnavailable):
        delivery.node_page(token)
