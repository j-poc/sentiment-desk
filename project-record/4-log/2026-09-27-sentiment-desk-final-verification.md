# Sentiment Desk and Opportunity Radar — final verification

## Outcome

The local, single-user Sentiment Desk now stores source observations separately
from Jev judgments, preserves source identity and distinct clocks, exposes
persisted delivery state, and recovers over its SQLite volume. Opportunity
Radar is built on those saved judgments. Jev remains the only per-item
sentiment/event classifier; Radar uses deterministic aggregation and makes no
model call.

Latest readiness: ready for the tested local, keyless workflow; **not 10/10
release-ready**. The live Jev path was not exercised because no key is
configured. No operator requeue path exists for terminal Jev failures, and
provider billing/model compatibility, labeled Jev quality, and source-use
terms remain unverified.

## Evidence

| Gate | Result | Evidence and limit |
| --- | --- | --- |
| Unit and API behavior | Pass | `npm test`: 63 tests across 11 files. Tests cover revisions and replay, source identity/time, Jev contract/model validation, bounded retry behavior, pipeline idempotency, scheduler shutdown, active SSE shutdown, Radar windows/pagination, delivery health, and quote cache provenance. Fixtures prove only the cases they exercise. |
| Type and production build | Pass | `npm run typecheck`, `npm run build`, and `git diff --check` passed after hardening. |
| Fresh production start | Pass with source gap | New isolated database, `DEMO=0`, Jev and optional provider credentials explicitly empty. The API served 24 companies and pending real RSS/SEC items with publisher time distinct from retrieval/ingestion. Google News RSS, Yahoo Finance RSS, SEC EDGAR, and quote delivery were current. GDELT returned HTTP 429 and appeared as failed; Finnhub, Reddit, and X appeared disabled. |
| Live Jev | Bounded fixture only | A prior controlled request to the real Jev service returned a valid `off_target` judgment. This final fresh-start run had no Jev key, so its live headlines correctly stayed pending. No claim is made that a current headline was scored in this pass. |
| Local UI workflow | Pass | Playwright CLI opened the fresh live and synthetic demo products. At 1280px and 390px, Desk/Radar navigation worked, selecting COIN persisted between views, and the document had no horizontal overflow at 390px. Live Radar showed pending and failed/disabled coverage without equating missing data to no activity. The demo evidence card exposed its source link, publisher timestamp, and collection clock and displayed `DEMO · SYNTHETIC EVIDENCE`. |
| Compose live/recovery | Pass | `DOCKER_CONTEXT=colima-sentiment-desk-verify ./scripts/verify-live-compose.sh` rebuilt a credential-free image, found 27 network quotes and 24 companies, and confirmed that a real pending observation survived container recreation. Latest output: `LIVE_SMOKE_RESULT quotes=27 companies=24 dbSizeBytes=2215936 pendingId=nvidia:<redacted> collector=google_news_rss timeBasis=publisher_declared`; recovery confirmed `pendingObservationPreserved=true`. The script removed its temporary Compose volume. The separate Citrini profile was not used. |
| SSE shutdown | Pass | An active HTTP SSE request was opened in a regression test; hub shutdown ended its response and the HTTP server close callback completed before database close. |
| Mobile drawer accessibility | Pass | At 390×844, drawer uses dialog semantics, focuses Close on open, traps Tab, disables background interaction and app shortcuts, and restores focus on Escape. Document width equals viewport. |

## Quality-pass findings

- Corrected duplicated “ago” text where callers appended a suffix already
  supplied by the shared time formatter.
- Reduced the default Radar screen to categories with activity; inactive
  categories are behind a disclosure. Evidence is paginated so rows beyond the
  initial five headline groups stay inspectable.
- Removed the unused title-only digest and fuzzy duplicate helpers. They
  described cross-source collapse even though storage now deliberately keeps
  each collector/source identity as its own immutable observation.
- Regression tests confirm that an item with only provider time remains
  pending/untimed for publication-window analysis rather than receiving a
  made-up local source time.
- Confirmed that a failed GDELT request does not prevent other sources from
  delivering and remains visible to the user.
- Closed the mobile filter overflow and drawer keyboard/modal defects; verified
  the actual browser behavior at 390px and Radar at 1280px.
- Enforced exact Jev model identity and made shutdown wait for in-flight
  scheduler, quote, and pipeline work before closing SQLite.

## Limits and choices

GDELT was rate-limited in the fresh local run. Social sources and Finnhub were
disabled. Provider display, model-use, and retention terms remain unreviewed;
public availability is not a license. The repository intentionally has no
LICENSE because the user chose to defer licensing. Radar covers the connected
company news/filing records and does not claim retail flow, sentiment velocity
across the public web, narrative clusters, event identity, value-chain
relationships, alpha, or investment merit.

The first Radar release keeps the selected company shared between Desk and
Radar, defaults to 24 hours, and groups only exact-normalized headline matches.
Those interface choices remain easy to revise; they are not claims about
researcher preference.

## Independent readiness verdicts

Three fresh read-only reviews gave separate qualitative scores: 8.5/10 for
source operations and overall scoped readiness, 8.5/10 for local Jev
implementation (7/10 for release readiness), and 9/10 for UI/Radar. The scores
are not combined into a composite rating. Reviewers found the strict response
validation, bounded transient retry scheduling, shutdown, snapshot, and
accessibility issues resolved. The Jev reviewer noted the lack of an operator
requeue action for terminal failures; outcome-unknown failures are
intentionally not retried automatically because a request may already have
incurred a charge.

No fresh live headline was scored by Jev in this run. A prior controlled Jev
fixture returned `off_target`, but that does not establish current real-source
end-to-end behavior. Therefore the app is locally usable for source-backed
research with pending Jev items and is not ready to claim 10/10.

## GitHub checkpoint

The earlier checkpoint `603932b` (`feat(sentiment-desk): complete desk and
opportunity radar`) was pushed to `origin/codex/real-data-rebuild` on
2026-09-27. The hardening and final review updates are being checkpointed
separately on the same branch. No pull request was opened. The repository
remains without a LICENSE, as requested.
