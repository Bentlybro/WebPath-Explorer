"""Provide thread-safe fan-out for WebPath Explorer live events."""

from __future__ import annotations

import queue
import threading
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator


EVENT_PROTOCOL = "webpath.events.v1"


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class EventBroker:
    """Broadcast JSON-compatible events to independent bounded subscribers.

    Publishing never waits on a slow WebSocket. When a subscriber falls behind,
    its oldest queued message is discarded in favour of the latest graph state.
    A short shared history allows reconnecting clients to provide
    ``?after=<sequence>`` and catch up without restarting a crawl.
    """

    def __init__(self, *, history_size: int = 2_000, subscriber_queue_size: int = 256):
        self._lock = threading.Lock()
        self._sequence = 0
        self._history: deque[dict[str, Any]] = deque(maxlen=max(0, history_size))
        self._subscribers: set[queue.Queue[dict[str, Any]]] = set()
        self._subscriber_queue_size = max(8, subscriber_queue_size)

    @property
    def sequence(self) -> int:
        with self._lock:
            return self._sequence

    def publish(
        self,
        event_type: str,
        *,
        search_id: int | None = None,
        **payload: Any,
    ) -> dict[str, Any]:
        with self._lock:
            self._sequence += 1
            event = {
                "protocol": EVENT_PROTOCOL,
                "type": event_type,
                "sequence": self._sequence,
                "timestamp": _timestamp(),
                "search_id": search_id,
                **payload,
            }
            self._history.append(event)
            subscribers = tuple(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    pass
                try:
                    subscriber.put_nowait(event)
                except queue.Full:
                    # A simultaneous consumer/publisher race is harmless; the
                    # next event or reconnect history will restore fresh state.
                    pass
        return event

    @contextmanager
    def subscribe(
        self, *, after_sequence: int = 0
    ) -> Iterator[queue.Queue[dict[str, Any]]]:
        subscriber: queue.Queue[dict[str, Any]] = queue.Queue(
            maxsize=self._subscriber_queue_size
        )
        with self._lock:
            history = [
                event
                for event in self._history
                if int(event["sequence"]) > after_sequence
            ]
            # Retain the newest events if reconnect history exceeds this
            # subscriber's queue.
            for event in history[-self._subscriber_queue_size :]:
                subscriber.put_nowait(event)
            self._subscribers.add(subscriber)
        try:
            yield subscriber
        finally:
            with self._lock:
                self._subscribers.discard(subscriber)
