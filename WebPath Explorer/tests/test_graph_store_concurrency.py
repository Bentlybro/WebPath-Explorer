from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from webpath.graph_store import GraphStore


def test_concurrent_node_and_edge_upserts_are_serialized(tmp_path):
    store = GraphStore(tmp_path / "concurrent.db")
    store.initialize()
    source_id = store.upsert_node("https://example.com/")
    workers = 4
    operations_per_worker = 4
    distinct_targets = 2
    start = Barrier(workers)

    def write_graph():
        start.wait(timeout=5)
        for index in range(operations_per_worker):
            target_id = store.upsert_node(
                f"https://example.com/page/{index % distinct_targets}"
            )
            store.upsert_edge(source_id, target_id)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(write_graph) for _ in range(workers)]
        for future in futures:
            future.result(timeout=60)

    with store.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0] == 3
        assert conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0] == 2
        weights = [
            row[0] for row in conn.execute("SELECT weight FROM edges ORDER BY target")
        ]
    assert weights == [8] * distinct_targets


def test_write_connection_rolls_back_as_one_unit(tmp_path):
    store = GraphStore(tmp_path / "rollback.db")
    store.initialize()

    try:
        with store.write_connection() as conn:
            store.upsert_node("https://example.com/kept-out", conn=conn)
            raise RuntimeError("abort transaction")
    except RuntimeError:
        pass

    with store.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0] == 0
