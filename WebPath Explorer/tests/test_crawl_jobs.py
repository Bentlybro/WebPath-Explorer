import asyncio
import threading
import time

import map as app_module
from webpath.crawl_jobs import CrawlCancelled, CrawlJobManager
from webpath.graph_store import GraphStore, canonicalize_url


def wait_for_status(client, job_id, statuses, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/crawls/{job_id}")
        assert response.status_code == 200
        job = response.get_json()["job"]
        if job["status"] in statuses:
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach {statuses}")


def test_background_crawl_api_returns_immediately_and_records_progress(
    tmp_path, monkeypatch
):
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
        job_id=None,
        cancel_requested=None,
        on_progress=None,
    ):
        assert job_id
        assert on_progress
        on_progress(
            pages_visited=3,
            edges_observed=8,
            current_depth=2,
            current_url=f"{starting_url}page",
        )
        await asyncio.sleep(0.02)
        return {"pages_visited": 3, "edges_observed": 8}

    monkeypatch.setattr(app_module, "validate_public_url", fake_validate)
    monkeypatch.setattr(app_module, "crawl", fake_crawl)
    app = app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "jobs-api.db"),
            "CRAWL_JOB_WORKERS": 1,
        }
    )
    client = app.test_client()
    manager = app.extensions["crawl_job_manager"]
    try:
        response = client.post(
            "/api/crawls",
            json={"starting_url": "https://example.com/", "max_depth": 2},
        )
        assert response.status_code == 202
        assert response.headers["Location"]
        queued = response.get_json()["job"]
        assert queued["status"] == "queued"

        completed = wait_for_status(client, queued["id"], {"completed"})
        assert completed["search_id"] is not None
        assert completed["pages_visited"] == 3
        assert completed["edges_observed"] == 8
        assert completed["current_depth"] == 2
        assert completed["current_url"] == "https://example.com/page"
        assert completed["finished_at"]

        listed = client.get("/api/crawls?status=completed&limit=10")
        assert listed.status_code == 200
        assert [job["id"] for job in listed.get_json()["jobs"]] == [queued["id"]]
    finally:
        manager.stop()


def test_running_crawl_can_be_cancelled_cooperatively(tmp_path, monkeypatch):
    started = threading.Event()

    async def fake_validate(url):
        return canonicalize_url(url)

    async def cancellable_crawl(
        store,
        starting_url,
        max_depth,
        search_id,
        limits,
        events=None,
        event_batch_size=500,
        job_id=None,
        cancel_requested=None,
        on_progress=None,
    ):
        started.set()
        while not (cancel_requested and cancel_requested()):
            await asyncio.sleep(0.01)
        raise CrawlCancelled("test cancellation")

    monkeypatch.setattr(app_module, "validate_public_url", fake_validate)
    monkeypatch.setattr(app_module, "crawl", cancellable_crawl)
    app = app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "cancel-api.db"),
            "CRAWL_JOB_WORKERS": 1,
        }
    )
    client = app.test_client()
    manager = app.extensions["crawl_job_manager"]
    broker = app.extensions["event_broker"]
    try:
        with broker.subscribe() as subscription:
            response = client.post(
                "/api/crawls",
                json={"starting_url": "https://example.com/", "max_depth": 2},
            )
            job_id = response.get_json()["job"]["id"]
            assert started.wait(timeout=3)
            cancelled = client.delete(f"/api/crawls/{job_id}")
            assert cancelled.status_code == 202
            assert cancelled.get_json()["job"]["status"] == "cancel_requested"
            final = wait_for_status(client, job_id, {"cancelled"})
            event_types = []
            while not subscription.empty():
                event_types.append(subscription.get_nowait()["type"])

        assert final["finished_at"]
        assert "crawl_started" in event_types
        assert "crawl_cancelled" in event_types
    finally:
        manager.stop()


def test_queued_cancel_is_immediate_and_idempotent(tmp_path, monkeypatch):
    async def fake_validate(url):
        return canonicalize_url(url)

    monkeypatch.setattr(app_module, "validate_public_url", fake_validate)
    app = app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "queued-cancel.db"),
            "CRAWL_JOB_WORKERS": 0,
        }
    )
    client = app.test_client()
    response = client.post(
        "/api/crawls",
        json={"starting_url": "https://example.com/", "max_depth": 1},
    )
    job_id = response.get_json()["job"]["id"]

    first = client.delete(f"/api/crawls/{job_id}")
    second = client.delete(f"/api/crawls/{job_id}")
    assert first.status_code == second.status_code == 200
    assert first.get_json()["job"]["status"] == "cancelled"
    assert second.get_json()["job"]["status"] == "cancelled"


def test_manager_recovers_interrupted_jobs_and_failed_searches(tmp_path):
    store = GraphStore(tmp_path / "recovery.db")
    store.initialize()
    job = store.create_crawl_job(
        "durable-job", "https://example.com/", 2
    )
    claimed = store.claim_next_crawl_job()
    assert claimed and claimed["id"] == job["id"]
    search_id = store.create_legacy_search("https://example.com/", 2)
    store.attach_crawl_job_search(job["id"], search_id)

    manager = CrawlJobManager(store, lambda *_args: {}, worker_count=0)
    try:
        recovered = store.get_crawl_job(job["id"])
        assert recovered and recovered["status"] == "queued"
        with store.connection() as conn:
            search = conn.execute(
                "SELECT status, completed_at FROM searches WHERE id = ?",
                (search_id,),
            ).fetchone()
        assert search["status"] == "failed"
        assert search["completed_at"]
    finally:
        manager.stop()


def test_worker_pool_resizes_at_runtime(tmp_path):
    store = GraphStore(tmp_path / "resize.db")
    store.initialize()
    release = threading.Event()
    started = []

    def blocking_runner(job, _progress, _cancel):
        started.append(job["id"])
        release.wait(timeout=5)
        return {"pages_visited": 1, "edges_observed": 0}

    manager = CrawlJobManager(store, blocking_runner, worker_count=1)
    try:
        first = manager.submit("https://example.com/1", 1)
        second = manager.submit("https://example.com/2", 1)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not started:
            time.sleep(0.01)
        assert started == [first["id"]]

        status = manager.set_worker_count(3)
        assert status["workers"] == 3
        assert status["threads"] == 3
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(started) < 2:
            time.sleep(0.01)
        assert started == [first["id"], second["id"]]

        status = manager.set_worker_count(1)
        assert status["workers"] == 1
        release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = manager.worker_status()
            if current["threads"] == 1:
                break
            time.sleep(0.02)
        else:
            raise AssertionError("surplus workers did not retire")

        status = manager.set_worker_count(99)
        assert status["workers"] == CrawlJobManager.MAX_WORKERS
    finally:
        release.set()
        manager.stop()


def test_worker_routes_expose_and_resize_the_pool(tmp_path, monkeypatch):
    async def fake_validate(url):
        return canonicalize_url(url)

    monkeypatch.setattr(app_module, "validate_public_url", fake_validate)
    app = app_module.create_app(
        {
            "TESTING": True,
            "DATABASE": str(tmp_path / "workers-api.db"),
            "CRAWL_JOB_WORKERS": 0,
        }
    )
    client = app.test_client()
    manager = app.extensions["crawl_job_manager"]
    try:
        status = client.get("/api/crawls/workers")
        assert status.status_code == 200
        assert status.get_json()["workers"] == 0

        resized = client.put("/api/crawls/workers", json={"workers": 4})
        assert resized.status_code == 200
        assert resized.get_json()["workers"] == 4
        assert resized.get_json()["threads"] == 4
        assert client.get("/api/crawls/workers").get_json()["threads"] == 4

        assert (
            client.put("/api/crawls/workers", json={"workers": -1}).status_code
            == 400
        )
        assert (
            client.put("/api/crawls/workers", json={"workers": "many"}).status_code
            == 400
        )
        assert client.put("/api/crawls/workers", json={}).status_code == 400

        # The static workers route never collides with job lookups.
        assert client.get("/api/crawls/workers").status_code == 200
        assert client.get("/api/crawls/not-a-job").status_code == 404
    finally:
        manager.stop()


def test_manager_coalesces_progress_and_flushes_final_values(tmp_path):
    store = GraphStore(tmp_path / "coalesced-progress.db")
    store.initialize()
    progress_writes = []
    original_update = store.update_crawl_job_progress

    def record_update(job_id, **values):
        progress_writes.append(dict(values))
        original_update(job_id, **values)

    store.update_crawl_job_progress = record_update

    def noisy_runner(_job, progress, _cancel_requested):
        for index in range(100):
            progress(
                pages_visited=index + 1,
                edges_observed=(index + 1) * 2,
                current_depth=4,
                current_url=f"https://example.com/{index}",
            )
        return {"pages_visited": 100, "edges_observed": 200}

    manager = CrawlJobManager(
        store,
        noisy_runner,
        worker_count=1,
        progress_interval=0.25,
    )
    try:
        job = manager.submit("https://example.com/", 4)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            final = store.get_crawl_job(job["id"])
            if final and final["status"] == "completed":
                break
            time.sleep(0.01)
        else:
            raise AssertionError("coalesced progress job did not complete")

        assert len(progress_writes) <= 2
        assert final["pages_visited"] == 100
        assert final["edges_observed"] == 200
        assert final["current_depth"] == 4
        assert final["current_url"] == "https://example.com/99"
    finally:
        manager.stop()
