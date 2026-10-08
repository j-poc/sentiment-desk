# Luna response binding and SEC filing research tasks — 2026-10-08

## Observable acceptance

- A completed offline Luna evaluation attempt carries bounded raw response bytes
  whose SHA-256 is recomputed by the evaluator. The response identity, structured
  classification, and token usage must match those bytes. A changed classification
  with the original response is rejected; published evaluation reports omit raw
  response bodies.
- Each SEC research task is keyed by exact CIK and accession, retains its optional
  next question, SEC URL, feed receipt, observation time, and retrieval time, and
  can be resumed after the filing leaves the live feed. Saving a second filing for
  the same issuer preserves the first task. Removal targets only the selected
  filing, and a read-only old database without this new table returns an explicit
  unavailable state rather than a false empty task list.
- Neither workflow starts a source or classifier request. No product runtime data
  is seeded or synthesized.

## Implementation and verification

The Luna run artifact is now schema v2 and stores each completed response as a
maximum 64 KiB UTF-8 payload beside its digest. The parser verifies the digest,
response metadata, one non-refusal structured output, classification fields, and
usage counts. The report keeps the digest and receipt metadata but removes the raw
payload. The evaluator remains offline.

SEC tasks use a separate `sec_filing_research_tasks` table keyed by `(cik,
triggering_accession)`. My Research can edit the question and return to the exact
SEC filing with its receipt clocks. On read-only startup, if a v16 database does
not yet have this table, the API returns HTTP 503 for task operations and the UI
shows storage-aware retry guidance. Existing Desk reads stay available.

Verified so far:

- Luna response-binding suite: 36 tests passed, including classification tamper,
  response digest mismatch, and report body exclusion.
- SEC filing task/API/UI suite: 20 tests passed, including two filings for one
  issuer, restart persistence, feed rollover, scoped deletion, failed writes, and
  the older-v16 read-only startup case.
- `npm run typecheck` passed.

The integrated repository suite, refreshed ETL/engineering receipts, and rendered
My Research journey remain outstanding at this checkpoint. No API or classifier
request was made, and no production database row was added or changed.

## Whole-build status

The fresh independent whole-build review remains **FAIL**. Tickerless small-cap
discovery, a current real Luna run, paired AlphaSense outcomes, followed-company
baseline evidence, intended-investor task results, and a current rendered UI
inspection remain unverified or blocked. This bounded implementation does not
close those outcomes or qualify the product for release.
