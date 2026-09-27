# Sentiment Desk and Opportunity Radar — final verification

## Outcome

The local, single-user Sentiment Desk now stores source observations separately
from Jev judgments, preserves source identity and distinct clocks, exposes
persisted delivery state, and recovers over its SQLite volume. Opportunity
Radar is built on those saved judgments. Jev remains the only per-item
sentiment/event classifier; Radar uses deterministic aggregation and makes no
model call.

## Evidence

| Gate | Result | Evidence and limit |
| --- | --- | --- |
| Unit and API behavior | Pass | `npm test`: 52 tests across 8 files. Tests cover revisions and replay, no destructive title dedupe, missing and provider-observed time, invalid stored classifications, current/prior window counts, publisher/direction logic, pending and failed coverage, source links, pagination, invalid inputs, and quote cache provenance. Fixtures prove the cases they exercise. |
| Type and production build | Pass | `npm run typecheck` and `npm run build` passed on the final code. `git diff --check` passed. |
| Fresh production start | Pass with source gap | New isolated database, `DEMO=0`, Jev and optional provider credentials explicitly empty. The API served 24 companies and pending real RSS/SEC items with publisher time distinct from retrieval/ingestion. Google News RSS, Yahoo Finance RSS, SEC EDGAR, and quote delivery were current. GDELT returned HTTP 429 and appeared as failed; Finnhub, Reddit, and X appeared disabled. |
| Live Jev | Bounded fixture only | A prior controlled request to the real Jev service returned a valid `off_target` judgment. This final fresh-start run had no Jev key, so its live headlines correctly stayed pending. No claim is made that a current headline was scored in this pass. |
| Local UI workflow | Pass | Playwright CLI opened the fresh live and synthetic demo products. At 1280px and 390px, Desk/Radar navigation worked, selecting COIN persisted between views, and the document had no horizontal overflow at 390px. Live Radar showed pending and failed/disabled coverage without equating missing data to no activity. The demo evidence card exposed its source link, publisher timestamp, and collection clock and displayed `DEMO · SYNTHETIC EVIDENCE`. |
| Compose live/recovery | Pass | `env DOCKER_CONTEXT=colima-sentiment-desk-verify ./scripts/verify-live-compose.sh` rebuilt a credential-free image, found 27 network quotes and 24 companies, and confirmed that a real pending observation survived container recreation. The script removed its temporary Compose volume. The default Docker context was the separate Citrini profile and was not used. |

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

## GitHub checkpoint

The decision trail received an independent transcript cross-check with no
material discrepancies. Commit `603932b` (`feat(sentiment-desk): complete desk
and opportunity radar`) was pushed to `origin/codex/real-data-rebuild` on
2026-09-27. No pull request was opened. The repository remains without a
LICENSE, as requested.
