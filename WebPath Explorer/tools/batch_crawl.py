"""Launch bounded WebPath crawls concurrently through the running API."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

import aiohttp


DEFAULT_SEED_FILE = Path(__file__).with_name("crawl_seeds.txt")
DEFAULT_REQUEST_TIMEOUT = 900.0
RETRYABLE_HTTP_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Queue several WebPath Explorer crawls with bounded parallelism."
    )
    parser.add_argument("urls", nargs="*", help="Additional HTTP(S) starting URLs")
    parser.add_argument(
        "--seed-file",
        type=Path,
        default=DEFAULT_SEED_FILE,
        help="Text file containing one starting URL per line",
    )
    parser.add_argument("--depth", type=int, default=4, help="Depth for every crawl")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="Number of independent crawls allowed to run at once",
    )
    parser.add_argument(
        "--server",
        default="http://127.0.0.1:5000",
        help="Running WebPath Explorer server",
    )
    parser.add_argument(
        "--request-timeout",
        type=float,
        default=DEFAULT_REQUEST_TIMEOUT,
        help="Maximum seconds to wait for one crawl response (default: 900)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help=(
            "Retries for connection failures and transient HTTP responses; "
            "timed-out crawls are not retried because the server may still be running them"
        ),
    )
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=2.0,
        help="Initial retry delay in seconds; subsequent delays use exponential backoff",
    )
    return parser.parse_args()


def load_seeds(path: Path, extras: list[str]) -> list[str]:
    seeds = list(extras)
    if path.exists():
        seeds.extend(
            line.strip()
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
    return list(dict.fromkeys(seeds))


async def crawl_one(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    endpoint: str,
    url: str,
    depth: int,
    retries: int,
    retry_delay: float,
) -> dict[str, Any]:
    max_attempts = retries + 1
    for attempt in range(1, max_attempts + 1):
        try:
            # Acquire the slot per attempt.  Exiting this block releases it before
            # retry backoff, so a failed seed cannot starve every queued seed.
            async with semaphore:
                print(
                    json.dumps(
                        {
                            "event": "start",
                            "url": url,
                            "depth": depth,
                            "attempt": attempt,
                            "max_attempts": max_attempts,
                        }
                    ),
                    flush=True,
                )
                async with session.post(
                    endpoint,
                    json={"starting_url": url, "max_depth": depth},
                ) as response:
                    body = await response.text()
                    try:
                        payload: Any = json.loads(body)
                    except json.JSONDecodeError:
                        payload = {"body": body[:1_000]}
                    result = {
                        "event": "complete" if response.ok else "error",
                        "url": url,
                        "attempt": attempt,
                        "http_status": response.status,
                        "result": payload,
                    }

            if (
                response.status in RETRYABLE_HTTP_STATUSES
                and attempt < max_attempts
            ):
                delay = retry_delay * (2 ** (attempt - 1))
                print(
                    json.dumps(
                        {
                            "event": "retry",
                            "url": url,
                            "attempt": attempt,
                            "reason": f"HTTP {response.status}",
                            "delay_seconds": delay,
                        }
                    ),
                    flush=True,
                )
                await asyncio.sleep(delay)
                continue

            print(json.dumps(result, ensure_ascii=False), flush=True)
            return result
        except asyncio.TimeoutError as exc:
            # Do not automatically retry a timed-out POST: Flask may continue
            # the crawl after the client disconnects, and retrying would create
            # duplicate search records and load.
            result = {
                "event": "error",
                "url": url,
                "attempt": attempt,
                "error": str(exc) or type(exc).__name__,
            }
            print(json.dumps(result), flush=True)
            return result
        except aiohttp.ClientError as exc:
            if isinstance(exc, aiohttp.ClientConnectorError) and attempt < max_attempts:
                delay = retry_delay * (2 ** (attempt - 1))
                print(
                    json.dumps(
                        {
                            "event": "retry",
                            "url": url,
                            "attempt": attempt,
                            "reason": str(exc) or type(exc).__name__,
                            "delay_seconds": delay,
                        }
                    ),
                    flush=True,
                )
                await asyncio.sleep(delay)
                continue

            result = {
                "event": "error",
                "url": url,
                "attempt": attempt,
                "error": str(exc) or type(exc).__name__,
            }
            print(json.dumps(result), flush=True)
            return result
        except Exception as exc:
            # Keep one unexpected client-side failure from cancelling every
            # other seed in asyncio.gather().
            result = {
                "event": "error",
                "url": url,
                "attempt": attempt,
                "error": str(exc) or type(exc).__name__,
            }
            print(json.dumps(result), flush=True)
            return result

    raise AssertionError("crawl attempt loop exited without a result")


async def run(args: argparse.Namespace) -> int:
    seeds = load_seeds(args.seed_file, args.urls)
    if not seeds:
        raise SystemExit("No crawl seeds were supplied")
    if not 1 <= args.depth <= 10:
        raise SystemExit("--depth must be between 1 and 10")
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be at least 1")
    if args.request_timeout <= 0:
        raise SystemExit("--request-timeout must be greater than 0")
    if args.retries < 0:
        raise SystemExit("--retries must be at least 0")
    if args.retry_delay < 0:
        raise SystemExit("--retry-delay must be at least 0")

    endpoint = f"{args.server.rstrip('/')}/api/search"
    semaphore = asyncio.Semaphore(args.concurrency)
    timeout = aiohttp.ClientTimeout(
        total=args.request_timeout,
        connect=min(30.0, args.request_timeout),
    )
    connector = aiohttp.TCPConnector(limit=args.concurrency)
    print(
        json.dumps(
            {
                "event": "batch-start",
                "seed_count": len(seeds),
                "depth": args.depth,
                "concurrency": args.concurrency,
                "endpoint": endpoint,
                "request_timeout": args.request_timeout,
                "retries": args.retries,
            }
        ),
        flush=True,
    )
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        results = await asyncio.gather(
            *(
                crawl_one(
                    session,
                    semaphore,
                    endpoint,
                    url,
                    args.depth,
                    args.retries,
                    args.retry_delay,
                )
                for url in seeds
            )
        )

    failures = sum(result["event"] == "error" for result in results)
    print(
        json.dumps(
            {
                "event": "batch-complete",
                "completed": len(results) - failures,
                "failed": failures,
            }
        ),
        flush=True,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
