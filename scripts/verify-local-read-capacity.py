#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


REPO = Path(__file__).resolve().parents[1]
CORE_TABLES = ("source_observations", "jev_judgments", "source_deliveries", "price_points")
DENIED_SOURCE_LABELS = ("demo", "synthetic", "fixture")


class VerificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_db_fingerprint(path: Path) -> dict[str, str | None]:
    return {
        suffix or "database": sha256_file(candidate) if candidate.is_file() else None
        for suffix, candidate in (("", path), ("wal", Path(f"{path}-wal")))
    }


def read_snapshot(path: Path) -> dict[str, Any]:
    uri = path.resolve().as_uri() + "?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=15)
        connection.row_factory = sqlite3.Row
        quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        counts = {
            table: int(connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]) if table in tables else None
            for table in CORE_TABLES
        }
        identified = 0
        total_observations = counts["source_observations"] or 0
        if "source_observations" in tables:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(source_observations)")}
            require("collector" in columns, "saved source-observation table has no collector identity")
            source_kind = "lower(coalesce(source_kind, ''))" if "source_kind" in columns else "''"
            identified = int(connection.execute(
                f"""SELECT count(*) FROM source_observations
                    WHERE lower(collector) <> 'legacy_unknown'
                      AND lower(collector) NOT LIKE '%demo%'
                      AND lower(collector) NOT LIKE '%synthetic%'
                      AND lower(collector) NOT LIKE '%fixture%'
                      AND {source_kind} NOT LIKE '%demo%'
                      AND {source_kind} NOT LIKE '%synthetic%'
                      AND {source_kind} NOT LIKE '%fixture%'""",
            ).fetchone()[0])
        connection.close()
    except (OSError, sqlite3.Error) as error:
        raise VerificationError(f"could not read saved database read-only: {type(error).__name__}") from None
    require(quick_check == "ok", "saved database failed SQLite quick_check")
    require(identified > 0, "saved database has no identified, non-demo source observations")
    return {
        "database_bytes": path.stat().st_size,
        "database_sha256": sha256_file(path),
        "quick_check": quick_check,
        "identified_source_observations": identified,
        "source_observations": total_observations,
        "core_table_counts": counts,
    }


def create_read_only_backup(source: Path, target: Path) -> None:
    try:
        input_db = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
        output_db = sqlite3.connect(target)
        input_db.backup(output_db, pages=4096, sleep=0.01)
        output_db.close()
        input_db.close()
    except (OSError, sqlite3.Error) as error:
        raise VerificationError(f"could not create isolated database snapshot: {type(error).__name__}") from None


def core_counts(path: Path) -> dict[str, int | None]:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    counts = {
        table: int(connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]) if table in tables else None
        for table in CORE_TABLES
    }
    connection.close()
    return counts


def source_tree_digest() -> str:
    digest = hashlib.sha256()
    files = [REPO / "package.json", REPO / "package-lock.json"]
    for directory in (REPO / "server", REPO / "config", REPO / "scripts"):
        files.extend(path for path in directory.rglob("*") if path.is_file() and "__pycache__" not in path.parts)
    for path in sorted(set(files)):
        if not path.is_file():
            continue
        digest.update(path.relative_to(REPO).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def available_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def install_network_guard(directory: Path) -> Path:
    guard = directory / "network-guard.cjs"
    guard.write_text('''
const fs = require("node:fs");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    fs.appendFileSync(process.env.NETWORK_GUARD_LOG, JSON.stringify({ origin: url.origin, pathname: url.pathname }) + "\\n");
    throw new Error("local capacity verifier blocked an external fetch");
  }
  return originalFetch(input, init);
};
''', encoding="utf-8")
    return guard


def request_json(base_url: str, route: str, timeout_seconds: int = 15) -> tuple[dict[str, Any] | list[Any], float, int]:
    started = time.perf_counter()
    request = urllib.request.Request(base_url + route, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            status = response.status
            raw = response.read()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise VerificationError(f"GET {route} failed: {type(error).__name__}") from None
    latency_ms = (time.perf_counter() - started) * 1000
    require(status == 200, f"GET {route} returned HTTP {status}")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise VerificationError(f"GET {route} returned invalid JSON") from None
    require(isinstance(payload, (dict, list)), f"GET {route} returned an unexpected JSON shape")
    return payload, latency_ms, len(raw)


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def latency_summary(samples: list[dict[str, Any]], wall_ms: float, concurrency: int) -> dict[str, Any]:
    latencies = [sample["latency_ms"] for sample in samples]
    by_route: dict[str, dict[str, Any]] = {}
    for route in sorted({sample["route_name"] for sample in samples}):
        selected = [sample for sample in samples if sample["route_name"] == route]
        values = [sample["latency_ms"] for sample in selected]
        by_route[route] = {
            "requests": len(selected),
            "p50_ms": round(percentile(values, 0.50), 1),
            "p95_ms": round(percentile(values, 0.95), 1),
            "p99_ms": round(percentile(values, 0.99), 1),
            "max_ms": round(max(values), 1),
            "median_response_bytes": int(percentile([sample["response_bytes"] for sample in selected], 0.50)),
            "min_returned_rows": min(sample["rows"] for sample in selected),
            "max_returned_rows": max(sample["rows"] for sample in selected),
        }
    return {
        "requests": len(samples),
        "concurrency": concurrency,
        "wall_elapsed_ms": round(wall_ms, 1),
        "sum_request_latency_ms": round(sum(latencies), 1),
        "routes": by_route,
    }


def validate_mentions(payload: dict[str, Any] | list[Any]) -> int:
    require(isinstance(payload, dict) and isinstance(payload.get("items"), list), "mentions page shape changed")
    items = payload["items"]
    require(len(items) <= 100, "mentions page exceeded the requested 100-row limit")
    for item in items:
        require(isinstance(item, dict), "mentions page contains a non-object row")
        collector = str(item.get("collector", "")).lower()
        source = item.get("source") or {}
        require(isinstance(source, dict), "mentions page contains malformed source metadata")
        kind = str(source.get("kind", "")).lower()
        require(not any(label in collector or label in kind for label in DENIED_SOURCE_LABELS),
                "saved research response contains a demo, synthetic, or fixture row")
        require(collector not in ("", "legacy_unknown"), "saved research response contains an unidentified collector")
    return len(items)


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure local saved-data API reads on a disposable copy of the real desk database.")
    parser.add_argument("--db", type=Path, default=REPO / "data/desk.db", help="real saved database to read without modifying")
    parser.add_argument("--rounds", type=int, default=24, help="serial and mixed-pool request rounds per route")
    arguments = parser.parse_args()
    require(sys.version_info >= (3, 10), "Python 3.10 or newer is required")
    require(1 <= arguments.rounds <= 100, "rounds must be between 1 and 100")
    source_db = arguments.db.expanduser().resolve()
    require(source_db.is_file(), f"saved database does not exist: {source_db}")
    server_entry = REPO / "dist/server/index.js"
    require(server_entry.is_file(), "production API build is missing; run npm run build first")
    node = shutil.which("node")
    require(node is not None, "Node.js is not on PATH")
    node = str(Path(node).resolve())
    node_version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    companies = json.loads((REPO / "config/companies.json").read_text(encoding="utf-8"))["companies"]
    require(bool(companies), "configured company universe is empty")
    input_snapshot = read_snapshot(source_db)
    initial_fingerprint = source_db_fingerprint(source_db)

    with tempfile.TemporaryDirectory(prefix="sentiment-desk-read-capacity-") as temporary:
        temporary_path = Path(temporary)
        cloned_db = temporary_path / "desk.db"
        create_read_only_backup(source_db, cloned_db)
        clone_counts_before = core_counts(cloned_db)
        guard_log = temporary_path / "external-fetch-attempts.jsonl"
        guard_path = install_network_guard(temporary_path)
        port = available_port()
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(temporary_path),
            "TMPDIR": str(temporary_path),
            "DB_PATH": str(cloned_db),
            "COMPANIES_PATH": str(REPO / "config/companies.json"),
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "NETWORK_GUARD_LOG": str(guard_log),
            "EXTERNAL_REQUESTS_ENABLED": "false",
            "EXTERNAL_SOURCE_COLLECTORS": "",
            "SOURCE_RIGHTS_APPROVED_COLLECTORS": "",
            "TYPESAFE_ACCOUNT_USE_APPROVED": "false",
            "TYPESAFE_API_KEY": "",
            "TYPESAFE_ALLOWED_COLLECTORS": "",
            "TYPESAFE_MAX_REQUESTS_PER_DAY": "0",
            "TYPESAFE_MAX_REQUEST_BYTES_PER_DAY": "0",
            "FINNHUB_API_KEY": "",
            "SEC_USER_AGENT": "",
            "REDDIT_CLIENT_ID": "",
            "REDDIT_CLIENT_SECRET": "",
            "X_BEARER_TOKEN": "",
            "ALERT_WEBHOOK_URL": "",
        }
        child = subprocess.Popen(
            [node, "--require", str(guard_path), str(server_entry)],
            cwd=REPO,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        base_url = f"http://127.0.0.1:{port}"
        try:
            health: dict[str, Any] | None = None
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                require(child.poll() is None, f"isolated API process exited with status {child.returncode}")
                try:
                    response = urllib.request.urlopen(base_url + "/api/health", timeout=0.5)
                    if response.status == 200:
                        health = json.loads(response.read())
                        break
                except (urllib.error.URLError, TimeoutError, OSError):
                    time.sleep(0.1)
            require(health is not None, "isolated API did not become healthy within 15 seconds")
            require(health.get("externalRequestsEnabled") is False, "external source collection was not disabled")
            require(health.get("opportunityRadarEnabled") is False, "Opportunity Radar unexpectedly enabled")
            require(health.get("health", {}).get("jev", {}).get("enabled") is False, "Jev unexpectedly enabled")
            require(not health.get("deliveryHealth") or all(not row.get("enabled") for row in health["deliveryHealth"]),
                    "one or more external collectors were enabled")

            company_payload, _, _ = request_json(base_url, "/api/companies")
            require(isinstance(company_payload, list), "companies endpoint returned an unexpected shape")
            company_ids = [str(company["id"]) for company in company_payload]
            configured_ids = [str(company["id"]) for company in companies]
            require(len(company_ids) == len(configured_ids) and set(company_ids) == set(configured_ids),
                    "API company selection does not match the configured real universe")
            focus_company_id = "adobe" if "adobe" in company_ids else company_ids[0]

            def series_rows(payload: Any) -> int:
                require(isinstance(payload, dict) and isinstance(payload.get("points"), list), "series response shape changed")
                return len(payload["points"])

            def series_route(company_id: str) -> tuple[str, str, Callable[[Any], int]]:
                route = f"/api/companies/{company_id}/series?hours=168"
                return "series", route, series_rows

            def company_rows(payload: Any) -> int:
                api_ids = [str(company["id"]) for company in payload] if isinstance(payload, list) else []
                require(len(api_ids) == len(configured_ids) and set(api_ids) == set(configured_ids),
                        "companies endpoint changed its configured company selection")
                return len(payload)

            def health_rows(payload: Any) -> int:
                require(isinstance(payload, dict) and payload.get("externalRequestsEnabled") is False,
                        "health endpoint changed its external-request state")
                return int(payload.get("sseClients", 0))

            routes: list[tuple[str, str, Callable[[Any], int]]] = [
                ("health", "/api/health", health_rows),
                ("companies", "/api/companies", company_rows),
                series_route(focus_company_id),
                ("mentions_page", f"/api/companies/{focus_company_id}/mentions-page?hours=168&limit=100&filter=all", validate_mentions),
            ]

            def sample(route_name: str, route: str, validate: Callable[[Any], int]) -> dict[str, Any]:
                payload, latency_ms, response_bytes = request_json(base_url, route)
                return {"route_name": route_name, "latency_ms": latency_ms, "response_bytes": response_bytes,
                        "rows": validate(payload)}

            serial_samples: list[dict[str, Any]] = []
            serial_started = time.perf_counter()
            for route_name, route, validate in routes:
                for _ in range(arguments.rounds):
                    serial_samples.append(sample(route_name, route, validate))
            serial_wall_ms = (time.perf_counter() - serial_started) * 1000

            mixed_tasks = [task for _ in range(arguments.rounds) for task in routes]
            mixed_started = time.perf_counter()
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                mixed_samples = list(pool.map(lambda task: sample(*task), mixed_tasks))
            mixed_wall_ms = (time.perf_counter() - mixed_started) * 1000

            company_tasks = [series_route(company_id) for company_id in company_ids]
            company_started = time.perf_counter()
            with concurrent.futures.ThreadPoolExecutor(max_workers=len(company_tasks)) as pool:
                company_samples = list(pool.map(lambda task: sample(*task), company_tasks))
            company_wall_ms = (time.perf_counter() - company_started) * 1000

            sampled_mention_rows = 0
            for company_id in company_ids:
                mention_route = f"/api/companies/{company_id}/mentions-page?hours=168&limit=100&filter=all"
                mention_payload, _, _ = request_json(base_url, mention_route)
                sampled_mention_rows += validate_mentions(mention_payload)

            require(child.poll() is None, f"isolated API process exited with status {child.returncode} during the workload")
            network_attempts = guard_log.read_text(encoding="utf-8").splitlines() if guard_log.exists() else []
            require(not network_attempts, "network guard observed an external fetch; workload was not offline")
        finally:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)

        clone_counts_after = core_counts(cloned_db)
        require(clone_counts_before == clone_counts_after, "read-only API workload changed a core source or judgment row count")
        clone_check = sqlite3.connect(cloned_db.resolve().as_uri() + "?mode=ro", uri=True)
        clone_integrity = clone_check.execute("PRAGMA quick_check").fetchone()[0]
        clone_check.close()
        require(clone_integrity == "ok", "isolated database snapshot failed SQLite quick_check after the workload")

    final_fingerprint = source_db_fingerprint(source_db)
    require(initial_fingerprint == final_fingerprint,
            "the real saved database or WAL changed during the check; discard measurements and rerun without concurrent writers")
    require(input_snapshot["core_table_counts"] == clone_counts_after,
            "real database and isolated clone core counts differ after read-only backup")

    report = {
        "status": "PASS",
        "pass_meaning": "all saved-data reads returned HTTP 200; external requests were blocked; sampled mention pages for every configured company contained only identified non-demo rows; source database and judgment counts remained unchanged",
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scope": "local saved-data API reads on a disposable online-backup snapshot; no external providers or Jev",
        "limit": "does not establish sustained throughput, multiple users, concurrent writes, larger history, or production scale",
        "git_head": subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, check=True, capture_output=True, text=True).stdout.strip(),
        "source_tree_sha256": source_tree_digest(),
        "server_bundle_sha256": sha256_file(server_entry),
        "node_version": node_version,
        "python_version": sys.version.split()[0],
        "real_saved_database": input_snapshot,
        "configured_company_count": len(companies),
        "companies_with_mentions_page_checked": len(company_ids),
        "mention_rows_checked_for_source_labels": sampled_mention_rows,
        "workloads": {
            "serial_reads": latency_summary(serial_samples, serial_wall_ms, 1),
            "mixed_eight_worker_interleaved_reads": latency_summary(mixed_samples, mixed_wall_ms, 8),
            "configured_company_selection_burst": latency_summary(company_samples, company_wall_ms, len(company_tasks)),
        },
        "core_table_counts_before_and_after_api_reads": clone_counts_after,
        "isolated_database_quick_check": clone_integrity,
        "external_fetch_attempts": 0,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        raise SystemExit(f"FAIL: {error}")
