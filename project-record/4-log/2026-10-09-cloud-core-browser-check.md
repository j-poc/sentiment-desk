# Cloud core browser check

## Positive browser-to-database journey

**Observed:** 2026-10-09 UTC, Codex in-app browser  
**App:** `http://127.0.0.1:5174/`  
**Backend:** isolated local Supabase at `127.0.0.1:55321`; local Mailpit magic-link authentication  
**Data:** synthetic SEC-shaped records, no SEC refresh invoked, zero external SEC requests, zero remote writes

An authenticated disposable user searched the published directory by issuer
name without a ticker, saw the CIK and retrieval time, and saved the issuer to
the private workspace. Company research read a CompanyFacts revenue value and
a submissions filing for the same CIK. The user selected both exact rows and
saved an analyst-owned decision; the browser read back its rationale, as-of
time, selected row counts, and evidence digest. Following the issuer captured
baseline v1 with the exact one-filing snapshot.

The isolated PostgreSQL container was restarted without resetting its volume.
After browser reload, the app restored the local session and read back the
issuer, source snapshots, decision, and baseline v1. The disposable account,
rows, receipts, snapshots, heads, user state, and refresh leases were then
removed and verified absent.

Evidence record:
`.agents/skills/verify-sentiment-desk/evidence/cloud-core-browser-22b0d126-74a3-42a9-a186-e7b2d32759a2.json`.
The isolated API and Edge Function suite is in
`.agents/skills/verify-sentiment-desk/evidence/cloud-core-03ac87a0-22a6-4c81-a4a0-385c853888f3.json`
(95 recorded assertion entries passed, 0 failed, across 75 distinct labels).

## Earlier unretained gated observation

An earlier local observation was described as using a new account with source
gates closed and no published heads. No screenshot, DOM capture, or separate
evidence record was retained for it, so it is not counted as verified
evidence. The positive path above proves only the steps listed in its journey.

## Limits

Every source-shaped row in the positive journey was synthetic and seeded into
the disposable local database. The app's SEC refresh action was not invoked.
This proves the local rendered core workflows and local database restart
recovery. It does not establish current SEC availability, source-use rights,
small-cap qualification, a live source-to-consumer receipt, managed Postgres
deployment, or hosted durability.

The positive browser record is an observation summary. It contains no
screenshot, DOM capture, network trace, or database query transcript.
