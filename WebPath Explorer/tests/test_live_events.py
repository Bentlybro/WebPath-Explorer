import asyncio
import queue

import map as app_module
import pytest
from webpath.graph_store import GraphStore, canonicalize_url
from webpath.live_events import EVENT_PROTOCOL, EventBroker


@pytest.fixture()
def app(tmp_path):
    return app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "live-graph.db"),
            "ADMIN_TOKEN": "test-admin-token",
            "EVENT_HEARTBEAT_SECONDS": 0.05,
        }
    )


@pytest.fixture()
def client(app):
    return app.test_client()


def _drain(subscription):
    events = []
    while True:
        try:
            events.append(subscription.get_nowait())
        except queue.Empty:
            return events


def test_event_broker_sequences_fans_out_and_replays():
    broker = EventBroker(history_size=10, subscriber_queue_size=10)
    with broker.subscribe() as first:
        published = broker.publish("crawl_started", search_id=9, url="https://example.com/")
        assert first.get_nowait() == published

    with broker.subscribe(after_sequence=0) as reconnect:
        replayed = reconnect.get_nowait()
        assert replayed["protocol"] == EVENT_PROTOCOL
        assert replayed["type"] == "crawl_started"
        assert replayed["sequence"] == 1
        assert replayed["search_id"] == 9


def test_search_publishes_lifecycle_events(client, app, monkeypatch):
    async def fake_validate(url):
        return canonicalize_url(url)

    async def fake_crawl(
        store,
        starting_url,
        max_depth,
        search_id,
        limits,
        events=None,
        event_batch_size=500,
    ):
        node_id = store.upsert_node(starting_url, title="Example")
        app_module._publish_graph_delta(
            events,
            search_id=search_id,
            nodes=[
                {
                    "id": node_id,
                    "url": starting_url,
                    "label": "Example",
                    "kind": "page",
                    "is_original": True,
                    "visit_count": 1,
                    "first_seen": "2026-07-28T12:00:00+00:00",
                    "last_seen": "2026-07-28T12:00:00+00:00",
                }
            ],
            edges=[],
            pages_visited=1,
            edges_observed=0,
            depth=1,
            current_url=starting_url,
            batch_size=event_batch_size,
        )
        return {"pages_visited": 1, "edges_observed": 0}

    monkeypatch.setattr(app_module, "validate_public_url", fake_validate)
    monkeypatch.setattr(app_module, "crawl", fake_crawl)
    broker = app.extensions["event_broker"]
    with broker.subscribe() as subscription:
        response = client.post(
            "/api/search",
            json={"starting_url": "https://example.com/", "max_depth": 1},
        )
        events = _drain(subscription)

    assert response.status_code == 200
    assert [event["type"] for event in events] == [
        "crawl_started",
        "graph_delta",
        "crawl_completed",
    ]
    search_id = response.get_json()["search_id"]
    assert all(event["search_id"] == search_id for event in events)
    delta = events[1]
    assert delta["nodes"][0]["label"] == "Example"
    assert delta["pages_visited"] == 1


def test_crawl_emits_incremental_renderer_deltas(tmp_path, monkeypatch):
    store = GraphStore(tmp_path / "crawl-events.db")
    store.initialize()
    broker = EventBroker()

    async def fake_validate(url):
        return canonicalize_url(url)

    async def fake_fetch(_session, url, _limits):
        return (
            url,
            "Root page",
            ["https://example.com/a", "https://example.com/b"],
        )

    monkeypatch.setattr(app_module, "validate_public_url", fake_validate)
    monkeypatch.setattr(app_module, "_fetch_page", fake_fetch)
    limits = app_module.CrawlLimits(
        max_pages=10,
        concurrency=2,
        request_timeout=1,
        max_response_bytes=1_000,
    )

    with broker.subscribe() as subscription:
        result = asyncio.run(
            app_module.crawl(
                store,
                "https://example.com/",
                1,
                7,
                limits,
                events=broker,
                event_batch_size=1,
            )
        )
        events = _drain(subscription)

    deltas = [event for event in events if event["type"] == "graph_delta"]
    assert result == {"pages_visited": 1, "edges_observed": 2}
    assert len(deltas) == 2
    assert sum(len(event["edges"]) for event in deltas) == 2
    assert all(event["nodes"] for event in deltas)
    assert {edge["kind"] for event in deltas for edge in event["edges"]} == {
        "links_to"
    }
    assert events[-1]["type"] == "crawl_progress"


def test_agent_ingest_publishes_graph_changed(client, app):
    broker = app.extensions["event_broker"]
    with broker.subscribe() as subscription:
        response = client.post(
            "/api/ingest",
            json={
                "agent": {"id": "codex"},
                "session": {"id": "live-session"},
                "sources": [{"url": "https://example.com/live"}],
            },
        )
        events = _drain(subscription)

    assert response.status_code == 201
    assert len(events) == 1
    assert events[0]["type"] == "graph_changed"
    assert events[0]["reason"] == "agent_ingest"
    assert events[0]["totals"] == {"nodes": 1, "edges": 0}


def test_websocket_route_is_registered(app):
    assert any(rule.rule == "/ws" for rule in app.url_map.iter_rules())
