#!/usr/bin/env python3
"""Check that private evidence stays optional, local, and issuer-scoped."""

import json
from pathlib import Path
import sys


SPEC = Path("project-record/3-project-specs/public-issuer-private-evidence.md")
CONTRACT = Path("engineering-contract.json")
UI = Path("web/src/components/PrivateEvidencePanel.tsx")
API = Path("server/app.ts")
STORE = Path("server/private-evidence-store.ts")
ANALYZER = Path("server/private-evidence-analysis.ts")
ANALYSIS_SERVICE = Path("server/private-evidence-analysis-service.ts")
CONFIG = Path("config/companies.json")
CONFIG_LOADER = Path("server/config.ts")
RUNTIME = Path("server/index.ts")
ENV = Path(".env.example")


def fail(message: str) -> int:
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def main() -> int:
    try:
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        spec = SPEC.read_text(encoding="utf-8")
        ui = UI.read_text(encoding="utf-8")
        api = API.read_text(encoding="utf-8")
        store = STORE.read_text(encoding="utf-8")
        analyzer = ANALYZER.read_text(encoding="utf-8")
        analysis_service = ANALYSIS_SERVICE.read_text(encoding="utf-8")
        runtime = RUNTIME.read_text(encoding="utf-8")
        env = ENV.read_text(encoding="utf-8")
        configured_companies = json.loads(CONFIG.read_text(encoding="utf-8"))["companies"]
        config_loader = CONFIG_LOADER.read_text(encoding="utf-8")
    except (OSError, json.JSONDecodeError) as error:
        return fail(f"required private-evidence scope input is unavailable or invalid: {error}")

    acceptance = contract.get("acceptance", [])
    if len(acceptance) <= 26:
        return fail("acceptance item 26 is missing")
    scope = acceptance[26]
    required = (
        "optional input only",
        "configured publicly listed-company inventory",
        "Privately held companies are out of scope",
        "250 items and 8 MiB",
        "never affect public sentiment",
        "never sent automatically",
        "GPT-6 Luna",
        "explicit in-app confirmation",
    )
    missing = [phrase for phrase in required if phrase.casefold() not in scope.casefold()]
    if missing:
        return fail(f"acceptance item 26 does not preserve the user scope: {missing}")
    if contract.get("risks", {}).get("sensitive_data") is not True:
        return fail("engineering contract must declare sensitive-data handling")
    if not configured_companies or any(item.get("listingStatus") != "publicly_listed" for item in configured_companies):
        return fail("every configured issuer must have explicit publicly_listed scope before private evidence is enabled")
    if 'listingStatus: z.literal("publicly_listed")' not in config_loader:
        return fail("company config parser must reject companies without a publicly_listed marker")

    checks = {item.get("id"): item for item in contract.get("checks", [])}
    workflow = checks.get("private-evidence-workflow")
    required_workflow_inputs = {
        "tests/private-evidence.test.ts", "tests/app-private-evidence.test.ts", "tests/private-evidence-panel.test.tsx",
        "tests/private-evidence-analysis.test.ts", "tests/private-evidence-analysis-service.test.ts",
        "server/private-evidence-analysis-service.ts",
    }
    if not workflow or not required_workflow_inputs.issubset(set(workflow.get("inputs", []))):
        return fail("private-evidence workflow check must include store, API, UI, Luna and budget-gate regressions")

    required_spec = (
        "already present in Sentiment Desk's configured publicly listed company inventory",
        "Privately held companies are out of scope",
        "not application-encrypted",
        "No actual user-owned document was provided",
        "standard Docker Compose service binds inside the container to `0.0.0.0`",
    )
    missing = [phrase for phrase in required_spec if phrase not in spec]
    if missing:
        return fail(f"scope specification is missing privacy, limitation, or uncertainty statements: {missing}")

    if "localStorage" in ui or "https://" in ui or "OPENAI_API_KEY" in ui:
        return fail("UI must use only same-origin local requests for private evidence")
    for phrase in (
        "the selected note's text, title, source label, optional user-asserted date, note ID, content hash and byte count, plus its issuer identity, are sent to OpenAI GPT-6 Luna only after a separate item-specific confirmation",
        "Its filename and local import time are not sent.",
        "OpenAI API data controls",
        "does not encrypt them",
        "Device backups may retain deleted copies",
    ):
        if phrase not in ui:
            return fail(f"UI is missing required privacy disclosure: {phrase}")
    for phrase in ("confirmExternalProcessing", "privateEvidenceAnalysisRecordSchema", "privateEvidenceCompanyIds?.has(companyId) === true"):
        if phrase not in api:
            return fail(f"API is missing the explicit selected-item boundary: {phrase}")
    for phrase in ('store: false', 'prompt_cache_options: { mode: "explicit" }', "tools: []", "cachedInputTokens !== 0", "ungrounded_output"):
        if phrase not in analyzer:
            return fail(f"GPT-6 Luna request profile or output validator is missing: {phrase}")
    for phrase in ("privateEvidenceAnalysisEnabled", "createPrivateEvidenceAnalysisService"):
        if phrase not in runtime:
            return fail(f"runtime is missing the shared provider budget gate: {phrase}")
    for phrase in ("storageCapacity()", "externalRequestAllowed()", "reserveOpenAIEvaluationBudget", "cancelBeforeDispatch", "maxDailyCostMicros"):
        if phrase not in analysis_service:
            return fail(f"selected-note analysis is missing a current storage, network, or shared-budget gate: {phrase}")
    if "OPENAI_PRIVATE_EVIDENCE_ANALYSIS_ENABLED=false" not in env:
        return fail("private-note model analysis must be independently disabled by default")
    for phrase in ("chmodSync(directory, 0o700)", "chmodSync(path, 0o600)", "isSymbolicLink()"):
        if phrase not in store:
            return fail(f"private store is missing filesystem boundary: {phrase}")
    for phrase in ("private_evidence_analysis_transition", "ON DELETE CASCADE", "beginAnalysis", "completeAnalysis"):
        if phrase not in store:
            return fail(f"private store must preserve a digest-bound one-attempt result lifecycle: {phrase}")

    print("SCOPE_RECORD=PASS: optional private evidence is listed-issuer-only and separate from public sentiment")
    print("PRIVACY_BOUNDARY=PASS: local UI disclosure, explicit selected-item Luna dispatch, shared budgets, and digest-bound storage are present")
    print("RUNTIME_ACCEPTANCE=REQUIRES focused tests and rendered-browser verification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
