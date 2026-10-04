#!/usr/bin/env python3
"""Fail-closed structural checks for private, task-level outcome evidence.

This verifies report shape and arithmetic, not the truth of source claims, source
rights, reviewer independence, participant eligibility, or recordings.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Any

EVIDENCE_ROOT = Path(".engineering-evidence")
TASKS = ("discover_without_ticker", "research_worthiness", "followed_company_change")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
OUTCOMES = {"desk", "alphasense", "tie", "non_evaluable"}


class EvidenceError(Exception):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


def private_file(relative: str, label: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute():
        raise EvidenceError("UNVERIFIED", f"{label} path must be workspace-relative")
    root = (Path.cwd() / EVIDENCE_ROOT).resolve()
    path = Path.cwd() / candidate
    current = Path.cwd()
    for part in candidate.parts:
        if part in ("", ".", ".."):
            if part == "..":
                raise EvidenceError("UNVERIFIED", f"{label} path escapes the workspace")
            continue
        current = current / part
        if current.is_symlink():
            raise EvidenceError("UNVERIFIED", f"{label} path contains a symlink")
    if not path.exists():
        raise EvidenceError("BLOCKED", f"{label} is missing")
    resolved = path.resolve()
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise EvidenceError("UNVERIFIED", f"{label} must be a regular file under {EVIDENCE_ROOT}")
    return resolved


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise EvidenceError("UNVERIFIED", f"{label} is unreadable or malformed") from error
    if not isinstance(value, dict):
        raise EvidenceError("UNVERIFIED", f"{label} must be a JSON object")
    return value


def require(condition: bool, message: str, status: str = "UNVERIFIED") -> None:
    if not condition:
        raise EvidenceError(status, message)


def finite(value: Any, label: str, minimum: float = 0.0) -> float:
    require(isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= minimum, f"{label} must be a finite number >= {minimum}")
    return float(value)


def timestamp(value: Any, label: str) -> datetime:
    require(isinstance(value, str), f"{label} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvidenceError("UNVERIFIED", f"{label} must be an ISO-8601 timestamp") from error
    require(parsed.tzinfo is not None, f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def binomial_two_sided(positive: int, negative: int) -> float:
    """Exact two-sided sign-test p-value, omitting ties."""
    n = positive + negative
    if n == 0:
        return 1.0
    tail = min(positive, negative)
    probability = sum(math.comb(n, k) for k in range(tail + 1)) / (2 ** n)
    return min(1.0, 2.0 * probability)


def validate_report_envelope(report: dict[str, Any], kind: str) -> None:
    require(report.get("schema_version") == 1, "outcome report schema_version must be 1")
    require(report.get("kind") == kind, f"outcome report kind must be {kind}")
    forbidden = {"status", "completed_paired_tasks", "distinct_issuers", "distinct_sectors",
                 "desk_wins", "alphasense_wins", "exact_p_value", "cluster_aware_p_value",
                 "pre_adjudication_agreement", "material_error_rates", "aggregate_summary"}
    require(not (forbidden & report.keys()), "self-declared aggregate outcome assertions are forbidden")
    bundle_rel = report.get("evidence_bundle")
    digest = report.get("evidence_bundle_sha256")
    require(isinstance(bundle_rel, str) and bundle_rel.startswith(f"{EVIDENCE_ROOT}/"),
            "evidence_bundle must name a private evidence file")
    require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None,
            "evidence_bundle_sha256 must be a lowercase SHA-256")


def read_ledger(report: dict[str, Any], kind: str) -> dict[str, Any]:
    validate_report_envelope(report, kind)
    path = private_file(report["evidence_bundle"], "evidence bundle")
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise EvidenceError("UNVERIFIED", "evidence bundle could not be read") from error
    require(hashlib.sha256(raw).hexdigest() == report["evidence_bundle_sha256"],
            "evidence bundle digest does not match", "UNVERIFIED")
    ledger = read_json(path, "evidence ledger")
    require(ledger.get("schema_version") == 1, "evidence ledger schema_version must be 1")
    require(ledger.get("kind") == kind, f"evidence ledger kind must be {kind}")
    return ledger


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def verify_artifact_ref(value: Any, label: str) -> None:
    require(isinstance(value, dict), f"{label} artifact reference is missing")
    relative, digest = value.get("path"), value.get("sha256")
    require(isinstance(relative, str) and relative.startswith(f"{EVIDENCE_ROOT}/"),
            f"{label} artifact must be under {EVIDENCE_ROOT}")
    require(isinstance(digest, str) and SHA256.fullmatch(digest) is not None,
            f"{label} artifact SHA-256 is invalid")
    path = private_file(relative, f"{label} artifact")
    try:
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as error:
        raise EvidenceError("UNVERIFIED", f"{label} artifact could not be read") from error
    require(actual == digest, f"{label} artifact digest does not match", "UNVERIFIED")


def verify_missing_attempt(value: Any, attempt_at: datetime, product: str) -> None:
    verify_artifact_ref(value, f"missing {product} output attempt")
    path = private_file(value["path"], f"missing {product} output attempt")
    attempt = read_json(path, f"missing {product} output attempt")
    require(attempt.get("schema_version") == 1
            and isinstance(attempt.get("attempt_id"), str) and attempt["attempt_id"].strip(),
            f"missing {product} output attempt receipt is incomplete", "UNVERIFIED")
    require(timestamp(attempt.get("attempted_at"), "attempt receipt attempted_at") == attempt_at,
            f"missing {product} output attempt receipt timestamp does not match", "UNVERIFIED")
    require(isinstance(attempt.get("outcome"), str)
            and attempt["outcome"] in {"no_response", "timeout", "provider_error", "empty_response"},
            f"missing {product} output attempt receipt does not evidence a failed response", "UNVERIFIED")


def artifact_manifest(ledger: dict[str, Any]) -> list[dict[str, str]]:
    found: set[tuple[str, str]] = set()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if isinstance(value.get("path"), str) and isinstance(value.get("sha256"), str):
                found.add((value["path"], value["sha256"]))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(ledger)
    return [{"path": path, "sha256": digest} for path, digest in sorted(found)]


def verify_authenticity_review(report: dict[str, Any], raw_ledger: bytes, ledger: dict[str, Any]) -> bool:
    reference = report.get("authenticity_review_artifact")
    verify_artifact_ref(reference, "independent authenticity review")
    review_path = private_file(reference["path"], "independent authenticity review")
    review = read_json(review_path, "independent authenticity review")
    require(review.get("schema_version") == 1 and review.get("status") == "PASS",
            "independent authenticity review is not PASS", "UNVERIFIED")
    require(review.get("ledger_sha256") == hashlib.sha256(raw_ledger).hexdigest(),
            "authenticity review is bound to a different ledger", "UNVERIFIED")
    require(review.get("artifact_manifest_sha256") == canonical_sha256(artifact_manifest(ledger)),
            "authenticity review is bound to a different artifact set", "UNVERIFIED")
    required_scopes = {"source_rights", "source_and_claim_truth", "reviewer_independence",
                       "participant_eligibility", "recordings", "prospectivity"}
    scopes = review.get("reviewed_scopes")
    require(isinstance(scopes, list) and all(isinstance(item, str) for item in scopes)
            and required_scopes.issubset(set(scopes)),
            "authenticity review does not cover all required scopes", "UNVERIFIED")
    reviewers = review.get("reviewers")
    require(isinstance(reviewers, list) and len(reviewers) >= 2,
            "two independent authenticity reviewers are required", "UNVERIFIED")
    keys: set[str] = set()
    evidence_paths: set[str] = set()
    for reviewer in reviewers:
        require(isinstance(reviewer, dict) and reviewer.get("independent") is True
                and reviewer.get("fresh_context") is True,
                "authenticity reviewers must record independent fresh reviews", "UNVERIFIED")
        key = reviewer.get("reviewer_key")
        require(isinstance(key, str) and key.strip(), "authenticity reviewer identity is missing", "UNVERIFIED")
        keys.add(key)
        evidence = reviewer.get("review_artifact")
        verify_artifact_ref(evidence, "reviewer workpaper")
        evidence_paths.add(evidence["path"])
    require(len(keys) >= 2 and len(evidence_paths) >= 2,
            "authenticity reviews need distinct reviewers and workpapers", "UNVERIFIED")
    limitations = review.get("limitations")
    require(isinstance(limitations, list)
            and any("cannot prove subagent execution" in item for item in limitations if isinstance(item, str))
            and any("cannot independently authenticate source truth" in item for item in limitations if isinstance(item, str)),
            "authenticity review must state what this checker cannot establish", "UNVERIFIED")
    return True


def validate_origins_and_signals(row: dict[str, Any], product: str, output_at: datetime) -> None:
    signals = row.get(f"{product}_signals")
    require(isinstance(signals, list) and len(signals) <= 3,
            f"{product} signals must be a list of at most three")
    signal_ids: set[str] = set()
    for signal in signals:
        require(isinstance(signal, dict), f"{product} signal must be an object")
        signal_id = signal.get("signal_id")
        require(isinstance(signal_id, str) and signal_id.strip() and signal_id not in signal_ids,
                f"{product} signal ids must be present and unique")
        signal_ids.add(signal_id)
        require(signal.get("qualified") is True, f"{product} signal qualification is missing")
        origins = signal.get("point_in_time_origins")
        require(isinstance(origins, list) and len(origins) >= 2,
                f"{product} signal needs at least two point-in-time origins")
        origin_ids: set[str] = set()
        source_refs: set[str] = set()
        for origin in origins:
            require(isinstance(origin, dict), "origin must be an object")
            origin_id = origin.get("origin_id")
            require(isinstance(origin_id, str) and origin_id.strip(), "origin_id is required")
            origin_ids.add(origin_id)
            require(isinstance(origin.get("source_ref"), str) and origin["source_ref"].strip(),
                    "origin source_ref is required")
            source_refs.add(origin["source_ref"])
            verify_artifact_ref(origin.get("artifact"), "point-in-time source")
            observed = timestamp(origin.get("observed_at"), "origin observed_at")
            require(observed <= timestamp(row.get("cutoff_at"), "task cutoff_at"),
                    "signal origin occurs after task cutoff")
            require(observed <= output_at, "signal origin occurs after product output", "FAIL")
        require(len(origin_ids) >= 2, "signal origins must be distinct")
        require(len(source_refs) >= 2, "signal needs two distinct source references")
        require(isinstance(signal.get("next_check"), str) and signal["next_check"].strip(),
                f"{product} signal needs a next check")


def validate_output_status(row: dict[str, Any], product: str, output_at: datetime | None,
                           window_start: datetime, window_end: datetime) -> str:
    status = row.get(f"{product}_output_status")
    require(isinstance(status, str) and status in {"supported_signals", "no_signal", "missing", "invalid", "unsupported"},
            f"{product} output status must be explicit")
    signals = row.get(f"{product}_signals", [])
    require(isinstance(signals, list), f"{product} signals must be a list")
    if status in {"missing", "invalid", "unsupported"}:
        require(not signals, f"{product} {status} output cannot contain signal claims", "FAIL")
        return status
    if status == "supported_signals":
        require(bool(signals), f"{product} supported_signals output contains no signals", "FAIL")
        return status
    require(output_at is not None, f"{product} no_signal output needs an output timestamp", "FAIL")
    require(not signals, f"{product} no_signal output must not contain signals", "FAIL")
    evidence = row.get(f"{product}_no_signal_evidence")
    require(isinstance(evidence, dict), f"{product} no_signal output needs a coverage record", "FAIL")
    scope = evidence.get("searched_scope")
    require(isinstance(scope, list) and bool(scope) and all(isinstance(item, str) and item.strip() for item in scope),
            f"{product} no_signal searched_scope must be explicit", "FAIL")
    require(timestamp(evidence.get("window_start"), "no-signal window_start") == window_start
            and timestamp(evidence.get("window_end"), "no-signal window_end") == window_end,
            f"{product} no_signal searched window must match the registered task window", "FAIL")
    freshness = timestamp(evidence.get("freshness_as_of"), "no-signal freshness_as_of")
    require(window_start <= freshness <= output_at, f"{product} no_signal freshness must be within the searched window and precede output", "FAIL")
    expected = evidence.get("expected_sources")
    require(isinstance(expected, list) and bool(expected) and all(isinstance(item, str) and item.strip() for item in expected)
            and len(set(expected)) == len(expected), f"{product} no_signal expected_sources must be unique and explicit", "FAIL")
    checked = evidence.get("checked_sources")
    require(isinstance(checked, list), f"{product} no_signal checked_sources must be a list", "FAIL")
    statuses: dict[str, str] = {}
    for source in checked:
        require(isinstance(source, dict), "no-signal source coverage row must be an object")
        source_id, source_status = source.get("source_id"), source.get("status")
        require(isinstance(source_id, str) and source_id in expected and source_id not in statuses,
                "no-signal checked source must be uniquely expected")
        require(isinstance(source_status, str) and source_status in {"complete", "partial", "unavailable"},
                "no-signal source status is invalid")
        checked_at = timestamp(source.get("checked_at"), "no-signal source checked_at")
        require(window_start <= checked_at <= output_at, "no-signal source check time is outside the query window")
        verify_artifact_ref(source.get("artifact"), "no-signal source coverage")
        statuses[source_id] = source_status
    complete = sum(statuses.get(source) == "complete" for source in expected)
    reported_coverage = finite(evidence.get("coverage_fraction"), "no-signal coverage_fraction")
    require(reported_coverage <= 1.0 and math.isclose(reported_coverage, complete / len(expected), abs_tol=1e-12),
            f"{product} no_signal coverage_fraction does not match checked sources", "FAIL")
    gaps = evidence.get("gaps")
    require(isinstance(gaps, list) and all(isinstance(item, str) and item.strip() for item in gaps),
            f"{product} no_signal gaps must be explicit", "FAIL")
    incomplete = {source for source in expected if statuses.get(source) != "complete"}
    require(incomplete.issubset(set(gaps)), f"{product} no_signal gaps omit incomplete sources", "FAIL")
    require(isinstance(evidence.get("uncertainty"), str) and evidence["uncertainty"].strip(),
            f"{product} no_signal uncertainty must be explicit", "FAIL")
    require(isinstance(evidence.get("next_check"), str) and evidence["next_check"].strip(),
            f"{product} no_signal next_check must be explicit", "FAIL")
    verify_artifact_ref(evidence.get("coverage_artifact"), f"{product} no-signal coverage report")
    return status


def validate_reviewers(row: dict[str, Any]) -> tuple[str, str, str]:
    reviews = row.get("reviews")
    require(isinstance(reviews, dict), "task reviews are missing")
    first, second, adjudication = (reviews.get(name) for name in ("reviewer_a", "reviewer_b", "adjudicator"))
    require(all(isinstance(item, dict) for item in (first, second, adjudication)),
            "two reviewer outcomes and an adjudicator outcome are required")
    ids = [first.get("reviewer_key"), second.get("reviewer_key"), adjudication.get("reviewer_key")]
    require(all(isinstance(value, str) and value.strip() for value in ids), "reviewer keys are required")
    require(len(set(ids)) == 3, "reviewers and adjudicator must have distinct identities")
    require(first.get("candidate_blinded") is True and second.get("candidate_blinded") is True,
            "both initial reviewers must record candidate blinding")
    require(first.get("independent") is True and second.get("independent") is True,
            "both initial reviews must record independent assessment")
    outcomes = [first.get("outcome"), second.get("outcome"), adjudication.get("outcome")]
    require(all(isinstance(outcome, str) and outcome in OUTCOMES for outcome in outcomes), "review outcome is invalid")
    for product in ("desk", "alphasense"):
        signal_ids = {item.get("signal_id") for item in row.get(f"{product}_signals", []) if isinstance(item, dict)}
        citation_key = f"supported_{product}_signal_ids"
        for name, review in (("reviewer A", first), ("reviewer B", second), ("adjudicator", adjudication)):
            if review["outcome"] == product:
                cited = review.get(citation_key)
                require(isinstance(cited, list) and bool(cited) and all(isinstance(item, str) for item in cited)
                        and len(set(cited)) == len(cited) and set(cited).issubset(signal_ids),
                        f"{name} {product} outcome must cite unique qualifying {product} signals", "FAIL")
        if outcomes[2] == product:
            adjudicator_cites = set(adjudication.get(citation_key, []))
            reviewer_support = any(review.get("outcome") == product
                                   and adjudicator_cites.intersection(review.get(citation_key, []))
                                   for review in (first, second))
            require(reviewer_support,
                    f"adjudicated {product} win lacks an overlapping reviewer-supported signal", "FAIL")
    for name, review in (("reviewer A", first), ("reviewer B", second), ("adjudicator", adjudication)):
        verify_artifact_ref(review.get("artifact"), name)
    return outcomes[0], outcomes[1], outcomes[2]


def verify_master_eval(ledger: dict[str, Any]) -> None:
    require(ledger.get("criteria_frozen_before_outputs") is True,
            "comparison criteria were not recorded as frozen before outputs")
    require(isinstance(ledger.get("criteria_sha256"), str)
            and SHA256.fullmatch(ledger["criteria_sha256"]) is not None,
            "frozen criteria digest is required")
    panel = ledger.get("review_panel")
    require(isinstance(panel, dict), "review_panel is missing")
    model_ids = panel.get("model_ids")
    require(isinstance(model_ids, list) and len(model_ids) == 2
            and all(isinstance(item, str) and item.strip() for item in model_ids)
            and len(set(model_ids)) == 2, "two distinct configured reviewer models are required")
    require(panel.get("candidate_identity_blinded") is True and panel.get("fresh_contexts") is True,
            "review panel blinding and separate contexts are not recorded")
    freeze = timestamp(ledger.get("criteria_frozen_at"), "criteria_frozen_at")
    cutoff = timestamp(ledger.get("evaluation_cutoff_at"), "evaluation_cutoff_at")
    require(freeze < cutoff, "criteria freeze must precede evaluation cutoff")
    rows = ledger.get("tasks")
    require(isinstance(rows, list), "paired task rows are missing", "UNVERIFIED")
    require(len(rows) == 30, f"exactly 30 preregistered paired task rows are required; received {len(rows)}",
            "UNVERIFIED")
    task_ids: set[str] = set()
    issuers: dict[str, int] = defaultdict(int)
    sectors: set[str] = set()
    outcomes: list[str] = []
    reviewer_matches = 0
    completed_pairs = 0
    status_counts = {product: {status: 0 for status in ("supported_signals", "no_signal", "missing", "invalid", "unsupported")}
                     for product in ("desk", "alphasense")}
    desk_errors = desk_claims = alpha_errors = alpha_claims = 0
    desk_error_tasks = alpha_error_tasks = 0
    for row in rows:
        require(isinstance(row, dict), "paired task row must be an object")
        task_id, issuer, sector, event_id = (row.get(key) for key in ("task_id", "issuer_id", "sector", "event_id"))
        require(all(isinstance(value, str) and value.strip() for value in (task_id, issuer, sector, event_id)),
                "task_id, issuer_id, sector and event_id are required")
        require(task_id not in task_ids, "paired task ids must be unique", "FAIL")
        task_ids.add(task_id)
        issuers[issuer] += 1
        require(issuers[issuer] <= 2, "an issuer may contribute at most two tasks", "FAIL")
        sectors.add(sector)
        registered = timestamp(row.get("registered_at"), "task registered_at")
        start = timestamp(row.get("window_start"), "task window_start")
        end = timestamp(row.get("window_end"), "task window_end")
        row_cutoff = timestamp(row.get("cutoff_at"), "task cutoff_at")
        require(registered <= start < end <= row_cutoff <= cutoff,
                "registration, window and cutoff chronology is invalid", "FAIL")
        require(registered <= freeze < cutoff, "criteria freeze must follow registration and precede cutoff", "FAIL")
        output_times: dict[str, datetime | None] = {}
        output_statuses: dict[str, str] = {}
        for product in ("desk", "alphasense"):
            status = row.get(f"{product}_output_status")
            if status == "missing":
                require(row.get(f"{product}_output_generated_at") is None
                        and row.get(f"{product}_output_artifact") is None,
                        f"missing {product} output cannot claim a generated timestamp or output artifact", "FAIL")
                attempt_at = timestamp(row.get(f"{product}_attempt_at"), f"{product} attempt_at")
                require(freeze < attempt_at <= row_cutoff,
                        f"missing {product} output attempt must follow criteria freeze and precede cutoff", "FAIL")
                verify_missing_attempt(row.get(f"{product}_attempt_artifact"), attempt_at, product)
                output_times[product] = None
            else:
                output_at = timestamp(row.get(f"{product}_output_generated_at"), f"{product} output_generated_at")
                require(freeze < output_at <= row_cutoff, "criteria must be frozen before both product outputs", "FAIL")
                output_times[product] = output_at
                verify_artifact_ref(row.get(f"{product}_output_artifact"), f"{product} output")
            output_statuses[product] = validate_output_status(row, product, output_times[product], start, end)
            status_counts[product][output_statuses[product]] += 1
        require(end - start == timedelta(days=7), "each task window must span exactly seven days", "FAIL")
        desk_signals = row.get("desk_signals", [])
        alpha_signals = row.get("alphasense_signals", [])
        require(len(desk_signals) <= 3 and len(alpha_signals) <= 3, "each product may return at most three signals", "FAIL")
        for product in ("desk", "alphasense"):
            if output_statuses[product] in {"supported_signals", "no_signal"}:
                require(output_times[product] is not None, f"{product} evaluable output timestamp is missing")
                validate_origins_and_signals(row, product, output_times[product])
        first, second, winner = validate_reviewers(row)
        failed_products = {product for product, status in output_statuses.items()
                           if status in {"missing", "invalid", "unsupported"}}
        if failed_products:
            require(first == second == winner == "non_evaluable",
                    "a task with missing, invalid, or unsupported output must be non_evaluable", "FAIL")
        else:
            require("non_evaluable" not in {first, second, winner},
                    "a complete output pair cannot be labeled non_evaluable", "FAIL")
            completed_pairs += 1
            reviewer_matches += first == second
        outcomes.append(winner)
        require(winner != "desk" or bool(desk_signals),
                "adjudicated Desk win must have a qualified Desk signal", "FAIL")
        require(winner != "alphasense" or bool(alpha_signals),
                "adjudicated AlphaSense win must have an AlphaSense signal", "FAIL")
        claims = row.get("claims")
        require(isinstance(claims, dict), "per-task material claim ledger is required")
        for product in ("desk", "alphasense"):
            product_claims = claims.get(product)
            require(isinstance(product_claims, list), f"{product} claim rows are required")
            require(output_statuses[product] != "missing" or not product_claims,
                    f"{product} missing output cannot have asserted claims", "FAIL")
            require(output_statuses[product] != "no_signal" or not product_claims,
                    f"{product} no_signal output must have zero claims", "FAIL")
            require(output_statuses[product] != "supported_signals" or bool(product_claims),
                    f"{product} supported_signals output needs claims", "FAIL")
            for claim in product_claims:
                require(isinstance(claim, dict) and isinstance(claim.get("claim_id"), str)
                        and claim["claim_id"].strip(), "each claim needs a claim_id")
                require(isinstance(claim.get("material_error"), bool), "claim material_error must be boolean")
                if product == "desk":
                    desk_claims += 1
                    desk_errors += claim["material_error"]
                else:
                    alpha_claims += 1
                    alpha_errors += claim["material_error"]
        row_desk_errors = sum(bool(item["material_error"]) for item in claims["desk"])
        row_alpha_errors = sum(bool(item["material_error"]) for item in claims["alphasense"])
        desk_error_tasks += row_desk_errors > 0 or output_statuses["desk"] in {"missing", "invalid", "unsupported"}
        alpha_error_tasks += row_alpha_errors > 0 or output_statuses["alphasense"] in {"missing", "invalid", "unsupported"}
        require(winner != "desk" or row_desk_errors == 0,
                "adjudicated Desk win contains a material-error claim", "FAIL")
    require(len(issuers) >= 15, "at least 15 distinct issuers are required", "FAIL")
    require(len(sectors) >= 6, "at least six distinct sectors are required", "FAIL")
    count_summary = " ".join(
        f"{product}=" + ",".join(f"{status}:{count}" for status, count in counts.items())
        for product, counts in status_counts.items())
    claim_summary = f"material_claim_errors={desk_errors}/{desk_claims}:{alpha_errors}/{alpha_claims}"
    print(f"MASTER_EVAL_COUNTS registered_tasks={len(rows)} completed_paired_tasks={completed_pairs} "
          f"task_errors={desk_error_tasks}/{len(rows)}:{alpha_error_tasks}/{len(rows)} "
          f"{claim_summary} {count_summary}")
    has_missing_output = any(counts["missing"] > 0 for counts in status_counts.values())
    require(completed_pairs == 30,
            f"30 completed paired tasks are required; only {completed_pairs}/30 were evaluable",
            "BLOCKED" if has_missing_output else "UNVERIFIED")
    require(reviewer_matches / completed_pairs >= 0.8,
            "pre-adjudication agreement across completed paired tasks is below 80%", "FAIL")
    require(desk_error_tasks / len(rows) <= alpha_error_tasks / len(rows),
            f"Desk per-task material/output error rate exceeds AlphaSense ({desk_error_tasks}/{len(rows)} > {alpha_error_tasks}/{len(rows)})",
            "FAIL")
    desk_wins = outcomes.count("desk")
    alpha_wins = outcomes.count("alphasense")
    exact_p = binomial_two_sided(desk_wins, alpha_wins)
    require(exact_p < 0.05, f"recomputed exact paired sign test is not significant (p={exact_p:.6g})", "FAIL")
    require(desk_wins / len(rows) >= 10 / 30,
            f"Desk win rate is below 10/30 tasks ({desk_wins}/{len(rows)})", "FAIL")
    require(alpha_wins / len(rows) <= 2 / 30,
            f"AlphaSense win rate exceeds 2/30 tasks ({alpha_wins}/{len(rows)})", "FAIL")
    # Build dependence components from preregistered issuer and event links, plus
    # explicitly declared time-dependence links. Clustering is independent of outcomes.
    parent = {task_id: task_id for task_id in task_ids}

    def find(item: str) -> str:
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    def union(left: str, right: str) -> None:
        a, b = find(left), find(right)
        if a != b:
            parent[max(a, b)] = min(a, b)

    group_owner: dict[tuple[str, str], str] = {}
    for row in rows:
        for dimension in ("issuer_id", "event_id"):
            key = (dimension, row[dimension])
            task_id = row["task_id"]
            if key in group_owner:
                union(task_id, group_owner[key])
            else:
                group_owner[key] = task_id
    links = ledger.get("time_dependence_links")
    require(isinstance(links, list), "preregistered time_dependence_links must be a list")
    for link in links:
        require(isinstance(link, dict), "time-dependence link must be an object")
        left, right = link.get("task_id_a"), link.get("task_id_b")
        require(isinstance(left, str) and isinstance(right, str) and left in task_ids and right in task_ids and left != right,
                "time-dependence link must reference two distinct registered tasks")
        require(isinstance(link.get("reason"), str) and link["reason"].strip(),
                "time-dependence link needs a preregistered reason")
        require(timestamp(link.get("registered_at"), "dependence link registered_at") <= freeze,
                "time-dependence links must be preregistered before criteria freeze", "FAIL")
        union(left, right)
    component_outcomes: dict[str, list[str]] = defaultdict(list)
    for row, winner in zip(rows, outcomes, strict=True):
        component_outcomes[find(row["task_id"])].append(winner)
    cluster_signs = []
    for clustered in component_outcomes.values():
        net = clustered.count("desk") - clustered.count("alphasense")
        if net:
            cluster_signs.append("desk" if net > 0 else "alphasense")
    independence = ledger.get("cluster_independence_review")
    require(isinstance(independence, dict) and independence.get("independence_justified") is True
            and independence.get("exchangeability_justified") is True
            and isinstance(independence.get("reviewer_key"), str)
            and independence["reviewer_key"].strip()
            and isinstance(independence.get("evidence_ref"), str)
            and independence["evidence_ref"].strip(),
            "independent cluster exchangeability review is not evidenced", "UNVERIFIED")
    conservative_p = binomial_two_sided(cluster_signs.count("desk"), cluster_signs.count("alphasense"))
    require(cluster_signs.count("desk") > cluster_signs.count("alphasense"),
            "issuer/event-cluster effect direction is not positive", "FAIL")
    require(conservative_p < 0.05,
            f"recomputed issuer/event-cluster sign test is not significant (p={conservative_p:.6g})", "FAIL")
    require(desk_claims > 0 and alpha_claims > 0, "both products must have material claims assessed")
    require(desk_errors / desk_claims <= alpha_errors / alpha_claims,
            "Desk material claim error rate exceeds AlphaSense", "FAIL")


def verify_investor_workflows(ledger: dict[str, Any]) -> None:
    require(ledger.get("uncoached") is True and ledger.get("cohort_eligibility_reviewed") is True,
            "uncoached sessions and eligible participants must be independently recorded")
    participants = ledger.get("participants")
    require(isinstance(participants, list), "participants must be a list")
    keys: set[str] = set()
    cohort_counts = {"serious_individual": 0, "professional_analyst": 0}
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    completed_durations: list[float] = []
    for participant in participants:
        require(isinstance(participant, dict), "participant row must be an object")
        key = participant.get("participant_key_sha256")
        require(isinstance(key, str) and SHA256.fullmatch(key) is not None, "participant identity must be pseudonymized with SHA-256")
        require(key not in keys, "participant identities must be unique", "FAIL")
        keys.add(key)
        audience = participant.get("audience")
        require(isinstance(audience, str) and audience in cohort_counts, "participant audience is outside the frozen cohorts")
        require(participant.get("eligible") is True and isinstance(participant.get("eligibility_evidence_ref"), str)
                and participant["eligibility_evidence_ref"].strip(), "participant eligibility evidence is required")
        verify_artifact_ref(participant.get("eligibility_evidence_artifact"), "participant eligibility")
        verify_artifact_ref(participant.get("session_recording_artifact"), "session recording")
        cohort_counts[audience] += 1
        tasks = participant.get("tasks")
        require(isinstance(tasks, list) and len(tasks) == len(TASKS), "each participant must attempt all three workflows")
        task_names = [item.get("task") for item in tasks if isinstance(item, dict)]
        require(len(task_names) == len(TASKS) and all(isinstance(item, str) for item in task_names)
                and set(task_names) == set(TASKS),
                "participant task set does not match the frozen workflows")
        for attempt in tasks:
            task = attempt["task"]
            grouped[(audience, task)].append(attempt)
            require(isinstance(attempt.get("completed"), bool) and isinstance(attempt.get("source_checked_result"), bool),
                    "task completion and source-check status must be explicit booleans")
            corrections = attempt.get("user_reported_factual_corrections")
            errors = attempt.get("critical_source_entity_or_time_errors")
            require(isinstance(corrections, int) and not isinstance(corrections, bool) and corrections >= 0,
                    "factual correction count is invalid")
            require(isinstance(errors, int) and not isinstance(errors, bool) and errors >= 0,
                    "critical error count is invalid")
            verify_artifact_ref(attempt.get("source_checked_evidence_artifact"), "source-checked result")
            if attempt["completed"] and attempt["source_checked_result"]:
                require(corrections <= 1, "a completed task has more than one factual correction", "FAIL")
                completed_durations.append(finite(attempt.get("time_to_source_checked_result_seconds"),
                                                  "time_to_source_checked_result_seconds"))
            require(isinstance(attempt.get("time_to_source_checked_result_seconds"), (int, float))
                    and not isinstance(attempt.get("time_to_source_checked_result_seconds"), bool)
                    and math.isfinite(attempt["time_to_source_checked_result_seconds"])
                    and attempt["time_to_source_checked_result_seconds"] >= 0,
                    "each task must record a nonnegative completion duration")
            require(errors == 0, "critical source, entity, or time error observed", "FAIL")
    require(len(participants) == len(keys), "participant ledger is incomplete")
    require(cohort_counts["serious_individual"] >= 5 and cohort_counts["professional_analyst"] >= 5,
            "at least five eligible participants from each audience are required", "UNVERIFIED")
    for audience, n in cohort_counts.items():
        for task in TASKS:
            attempts = grouped.get((audience, task), [])
            require(len(attempts) == n, f"{audience} {task} denominator is incomplete")
            completions = sum(item["completed"] and item["source_checked_result"] for item in attempts)
            require(completions / n >= 0.8, f"{audience} completion for {task} is below 80%", "FAIL")
    require(bool(completed_durations) and median(completed_durations) <= 600,
            "median time to a source-checked result exceeds ten minutes", "FAIL")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("master-eval", "investor-workflows"))
    parser.add_argument("report")
    parser.add_argument("--structural-only", action="store_true",
                        help="return success for structural fixture checks only; authenticity always remains UNVERIFIED")
    args = parser.parse_args()
    try:
        path = private_file(args.report, "outcome report")
        report = read_json(path, "outcome report")
        ledger = read_ledger(report, args.kind)
        if args.kind == "master-eval":
            verify_master_eval(ledger)
        else:
            verify_investor_workflows(ledger)
    except EvidenceError as error:
        print(f"{error.status}: {error}", file=sys.stderr)
        return 1
    print(f"STRUCTURAL_STATUS=PASS THRESHOLD_STATUS=PASS: {args.kind} task-level ledger meets recomputed rules")
    try:
        ledger_bytes = private_file(report["evidence_bundle"], "evidence bundle").read_bytes()
        verify_authenticity_review(report, ledger_bytes, ledger)
        print("REVIEW_ARTIFACT_BINDING=PASS")
    except EvidenceError as error:
        print(f"REVIEW_ARTIFACT_BINDING=UNVERIFIED ({error.status}: {error})", file=sys.stderr)
    print("AUTHENTICITY_STATUS=UNVERIFIED (local metadata and hashes cannot authenticate reviewers or source truth)")
    print("LIMITATION: checker cannot prove subagent execution or independently establish source truth")
    if args.structural_only:
        print("MODE=STRUCTURAL_ONLY; this is not product outcome-evidence acceptance")
        return 0
    print("BLOCKED: independent authenticity evidence requires external verification", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
