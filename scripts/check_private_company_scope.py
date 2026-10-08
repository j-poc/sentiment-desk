#!/usr/bin/env python3
"""Validate the recorded private-company scope boundary, not runtime readiness."""

from pathlib import Path
import sys


SPEC = Path("project-record/3-project-specs/private-company-narrative-slice.md")
REQUIRED = (
    "version 1.0, SHA-256 `6e7705a3edf0a5c5f91f4ec4cc9d645eae81c51017939d5baae156eb926d2ca6`",
    "**Status:** requirements integrated; runtime capability not implemented or qualified.",
    "## Current capability status",
    "| **Implemented** |",
    "| **Partial** |",
    "| **Missing** |",
    "| **Inapplicable to this slice** |",
    "| **Unverified** |",
    "## Smallest relevant next implementation slice",
    "## Runtime acceptance before enabling the slice",
    "No new source, account, credential, collection, retention entitlement, model call, private-data upload, or alert path is activated by this record.",
    "The existing SEC/Compose and Luna source/account/spend gates are unchanged.",
    "does not make the stale SEC receipt current",
    "Do not fill this gap with generated examples, synthetic product rows, or assumed source rights.",
    "A single original or official source may create an explicitly uncorroborated review draft",
    "Source independence governs corroboration and duplicate counting",
    "The configured Desk issuer and the claim's subject entity are separate identities",
    "keep claim form (reported metric, qualitative assertion, opinion/forecast, attention proxy, or mixed/unclear) separate from evidence basis",
    "Publicly reported business, investment, or contractual relationships may remain attributed narrative context",
    "Require zero critical unsupported financial assertions, wrong claim-subject entities, wrong units, or invented citations",
)


def main() -> int:
    try:
        content = SPEC.read_text(encoding="utf-8")
    except OSError as error:
        print(f"BLOCKED: private-company scope record is unavailable: {error}", file=sys.stderr)
        return 1

    missing = [marker for marker in REQUIRED if marker not in content]
    if missing:
        print("FAIL: private-company scope record is missing required scope or boundary statements", file=sys.stderr)
        for marker in missing:
            print(f"  missing: {marker}", file=sys.stderr)
        return 1

    print("SCOPE_RECORD=PASS: source, status matrix, selected slice, and unchanged gates are recorded")
    print("RUNTIME_STATUS=UNVERIFIED: this check does not establish private-company product behavior")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
