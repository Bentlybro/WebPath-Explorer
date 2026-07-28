"""Provide a dependency-free client for agents that publish WebPath research.

Agent runtimes may import :class:`WebPathClient` or invoke this file with a
JSON batch path. Delivery uses stable event IDs supplied by the caller, so a
failed request can safely be retried with the same payload.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_ENDPOINT = "http://127.0.0.1:5000/api/agent/ingest"


class WebPathClient:
    """Publish provenance-rich research batches to a WebPath Explorer."""

    def __init__(
        self,
        endpoint: str | None = None,
        token: str | None = None,
        timeout: float = 15,
    ):
        self.endpoint = endpoint or os.environ.get(
            "WEBPATH_INGEST_URL", DEFAULT_ENDPOINT
        )
        self.token = token or os.environ.get("WEBPATH_INGEST_TOKEN")
        self.timeout = timeout

    def ingest(self, batch: dict[str, Any]) -> dict[str, Any]:
        """Send one atomic ingestion batch and return the decoded response."""
        if not isinstance(batch, dict):
            raise TypeError("batch must be a JSON object")
        body = json.dumps(batch, separators=(",", ":")).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "WebPathAgentClient/1.0",
        }
        if self.token:
            headers["X-Ingest-Token"] = self.token
        request = Request(self.endpoint, data=body, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=self.timeout) as response:
                result = json.load(response)
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"WebPath rejected the batch ({exc.code}): {detail}") from exc
        except URLError as exc:
            raise RuntimeError(f"WebPath is unavailable: {exc.reason}") from exc
        if not isinstance(result, dict):
            raise RuntimeError("WebPath returned an invalid response")
        return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Publish an AI-agent research batch to WebPath Explorer."
    )
    parser.add_argument(
        "batch",
        nargs="?",
        default="-",
        help="JSON batch file, or - to read stdin (default).",
    )
    parser.add_argument(
        "--endpoint",
        default=None,
        help=f"Ingestion URL (default: WEBPATH_INGEST_URL or {DEFAULT_ENDPOINT}).",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Ingestion token (default: WEBPATH_INGEST_TOKEN).",
    )
    parser.add_argument("--timeout", type=float, default=15)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.batch == "-":
            batch = json.load(sys.stdin)
        else:
            with Path(args.batch).open(encoding="utf-8") as handle:
                batch = json.load(handle)
        result = WebPathClient(args.endpoint, args.token, args.timeout).ingest(batch)
    except (OSError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
