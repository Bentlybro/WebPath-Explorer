"""Durable, bounded background execution for crawl jobs."""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

from .graph_store import GraphStore


TERMINAL_JOB_STATUSES = frozenset({"completed", "failed", "cancelled"})
JOB_STATUSES = frozenset(
    {
        "queued",
        "running",
        "completed",
        "failed",
        "cancel_requested",
        "cancelled",
    }
)


class CrawlCancelled(RuntimeError):
    """Raised by a cooperative crawl runner after cancellation is requested."""


ProgressCallback = Callable[..., None]
CancelPredicate = Callable[[], bool]
CrawlRunner = Callable[
    [dict[str, Any], ProgressCallback, CancelPredicate], dict[str, int]
]


class CrawlJobManager:
    """Claim durable jobs with a resizable set of process-local workers."""

    MAX_WORKERS = 16

    def __init__(
        self,
        store: GraphStore,
        runner: CrawlRunner,
        *,
        worker_count: int = 2,
        recover: bool = True,
        progress_interval: float = 0.25,
    ):
        self.store = store
        self.runner = runner
        self.worker_count = max(0, min(int(worker_count), self.MAX_WORKERS))
        self.progress_interval = max(0.05, float(progress_interval))
        self._condition = threading.Condition()
        self._stopping = threading.Event()
        self._cancel_events: dict[str, threading.Event] = {}
        self._threads: list[threading.Thread] = []
        self._thread_serial = 0
        if recover:
            self.store.recover_crawl_jobs()
        with self._condition:
            for _index in range(self.worker_count):
                self._start_worker_locked()

    def _start_worker_locked(self) -> None:
        """Start one worker thread. Caller must hold the condition lock."""
        self._thread_serial += 1
        thread = threading.Thread(
            target=self._worker,
            name=f"webpath-crawl-{self._thread_serial}",
            daemon=True,
        )
        thread.start()
        self._threads.append(thread)

    def _prune_threads_locked(self) -> None:
        self._threads[:] = [thread for thread in self._threads if thread.is_alive()]

    def set_worker_count(self, count: int) -> dict[str, int]:
        """Resize the pool at runtime.

        Extra workers start immediately. Surplus workers retire cooperatively
        between jobs, so a running crawl is never interrupted by a scale-down.
        """
        count = max(0, min(int(count), self.MAX_WORKERS))
        with self._condition:
            self.worker_count = count
            self._prune_threads_locked()
            while len(self._threads) < count:
                self._start_worker_locked()
            self._condition.notify_all()
            return self._status_locked()

    def worker_status(self) -> dict[str, int]:
        with self._condition:
            self._prune_threads_locked()
            return self._status_locked()

    def _status_locked(self) -> dict[str, int]:
        return {
            "workers": self.worker_count,
            "threads": len(self._threads),
            "active_jobs": len(self._cancel_events),
            "max_workers": self.MAX_WORKERS,
        }

    def submit(self, starting_url: str, max_depth: int) -> dict[str, Any]:
        job = self.store.create_crawl_job(
            str(uuid.uuid4()), starting_url, max_depth
        )
        self.wake()
        return job

    def submit(self, starting_url: str, max_depth: int) -> dict[str, Any]:
        job = self.store.create_crawl_job(
            str(uuid.uuid4()), starting_url, max_depth
        )
        self.wake()
        return job

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        job = self.store.request_crawl_job_cancel(job_id)
        if job and job["status"] == "cancel_requested":
            with self._condition:
                cancel_event = self._cancel_events.get(job_id)
                if cancel_event is not None:
                    cancel_event.set()
                self._condition.notify_all()
        return job

    def wake(self) -> None:
        with self._condition:
            self._condition.notify_all()

    def stop(self, timeout: float = 5) -> None:
        """Stop workers for application/test teardown without mutating jobs."""
        self._stopping.set()
        with self._condition:
            self._condition.notify_all()
        for thread in self._threads:
            thread.join(timeout=max(0, timeout))

    def _worker(self) -> None:
        while not self._stopping.is_set():
            with self._condition:
                self._prune_threads_locked()
                current = threading.current_thread()
                if len(self._threads) > self.worker_count:
                    # Scale-down: retire this surplus worker between jobs.
                    # The check and removal hold the lock, so exactly
                    # len(threads) - worker_count workers retire.
                    self._threads.remove(current)
                    return
            job = self.store.claim_next_crawl_job()
            if job is None:
                with self._condition:
                    self._condition.wait(timeout=0.5)
                continue
            job_id = str(job["id"])
            cancel_event = threading.Event()
            with self._condition:
                self._cancel_events[job_id] = cancel_event
            current = self.store.get_crawl_job(job_id)
            if current and current["status"] == "cancel_requested":
                cancel_event.set()

            pending_progress: dict[str, Any] = {}
            last_progress_flush = 0.0

            def flush_progress() -> None:
                nonlocal last_progress_flush
                if not pending_progress:
                    return
                values = dict(pending_progress)
                pending_progress.clear()
                self.store.update_crawl_job_progress(job_id, **values)
                last_progress_flush = time.monotonic()

            def progress(**values: Any) -> None:
                pending_progress.update(values)
                if time.monotonic() - last_progress_flush >= self.progress_interval:
                    flush_progress()

            try:
                if cancel_event.is_set():
                    raise CrawlCancelled("crawl cancelled before it started")
                result = self.runner(job, progress, cancel_event.is_set)
            except CrawlCancelled as exc:
                flush_progress()
                self.store.finish_crawl_job(job_id, "cancelled", error=str(exc))
            except Exception as exc:
                flush_progress()
                self.store.finish_crawl_job(
                    job_id,
                    "failed",
                    error=str(exc) or type(exc).__name__,
                )
            else:
                flush_progress()
                self.store.finish_crawl_job(
                    job_id,
                    "completed",
                    pages_visited=result.get("pages_visited"),
                    edges_observed=result.get("edges_observed"),
                )
            finally:
                with self._condition:
                    self._cancel_events.pop(job_id, None)
