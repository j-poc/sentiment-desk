# Cloud core architecture and acceptance

**Status:** cloud core implemented and verified locally. The isolated PostgreSQL/API suite passes; a real authenticated browser journey through all three workflows also survives a PostgreSQL restart and reads back from the isolated database. Independent review is complete. Managed cloud deployment and a permitted live source receipt remain open.

## User requirement

The user clarified that Sentiment Desk's core app must be hostable in the
cloud, with live acquisition pipelines and durable application data outside a
developer laptop. This supersedes the local-SQLite-only assumption for the
hosted core workflow. It does not authorize deploying to an unspecified
account, collecting live data during this build, or treating operator source
allowlists as proof of source rights.

## Product acceptance

The cloud core must preserve the three investor tasks already in the product
contract:

1. Discover issuers without a ticker or prepared dataset. Candidate coverage,
  source, freshness, size qualification, and uncertainty are inspectable. An
  issuer directory alone cannot be labeled a small-cap screen or an
  investment ranking.
2. Inspect source-bound company facts, evidence, uncertainty, and missing
  information, then save a user's own research decision against the exact
  evidence version. No automatic thesis, recommendation, or materiality claim.
3. Explicitly save and compare a followed-company baseline. Preserve exact
  source record IDs and event, publication, retrieval, and ingestion times;
  label eligibility changes separately from material changes.

## Snapshot completion-time acceptance

For issuer-directory, CompanyFacts, and submissions snapshots, `completed_at`
means the database publication point after the source receipt and all normalized
rows pass validation. It remains null while a snapshot is being assembled. The
publication RPC assigns one database timestamp to both the snapshot and its
source run in the same transaction that advances the published head. This time
must be at or after `retrieved_at`. A failed publication leaves the prior head
unchanged and does not expose an incomplete snapshot.

Use this six-item binary rubric for the fix. The score is the number of yes
answers.

1. All three Edge Functions stage snapshots without claiming completion before
   their normalized rows exist.
2. The publication RPC assigns the same database-generated completion time to
   the snapshot and source run, at or after the source retrieval time.
3. A head cannot advance to an incomplete snapshot, and authenticated clients
   cannot read its staged snapshot or rows before that head switch; publication,
   timestamp assignment, and visibility remain atomic.
4. Failed or partial publication retains the last-good head and does not expose
   the uncompleted snapshot as research evidence.
5. Research decisions accept only successful, completed CompanyFacts and
   submissions snapshots and reject null completion times.
6. The local verifier exercises this contract for all three sources through
   their actual handlers and database functions, without external requests;
   the user-facing “completed” time refers to that publication timestamp.

### Timestamp correction design

Keep `completed_at` on the existing snapshot and run records. Each publication
RPC owns one database timestamp after it validates the source receipt and full
normalized row count, then assigns it to the snapshot, successful run, and
published head in the same transaction. A nullable snapshot time represents
staging; authenticated snapshot and row reads require a published snapshot.
Decision validation accepts only successful, completed source snapshots.
If a publication response is ambiguous, handlers read the request's saved
receipt before marking the attempt failed; status-guarded failure writes cannot
overwrite an already committed success.

This preserves the existing RPC arguments and consumer fields. The alternative
of adding a separate publication table would create a second snapshot lifecycle
and require broad changes to reads, saved-decision timestamps, and retention.
The implementation also carries over the useful recovery invariant that a
late directory error cannot replace a source run already committed as success.

The cloud schema has not been deployed to a remote project. The local-only,
uncommitted migration can therefore be corrected directly, with the isolated
database reset before applying the final schema. No user data migration or
historical timestamp backfill is in scope.

## Architecture decision

Use one PostgreSQL schema and Supabase Auth locally and in production, with RLS
on every exposed table. Keep the web client static and source acquisition behind
server-side Edge Functions. Paid cloud hosting is optional during development;
the isolated Supabase CLI stack supplies local PostgreSQL and the same function
runtime. Provider secrets and function credentials stay server-side. Browser
code never receives a service-role key.

```text
Cloud web client + Supabase Auth
          |
          +-- RLS-scoped reads/writes --> managed Postgres
          |
          +-- explicit refresh -------> server-side Edge Function
                                      |
                                      +--> authorized source API/feed
                                      +--> idempotent Postgres snapshot + receipt
Cron (disabled until source scope is cleared) --^ 
```

Shared public source records and user-owned research state have distinct
owners. Authenticated user rows carry `auth.uid()` and are isolated by RLS.
Source snapshots retain source identity, exact CIK, source URL, response digest,
retrieval and run state. Writes are idempotent and append-only where a prior
decision or baseline must remain auditable. The currently running SQLite app
remains a development/legacy path only until each core consumer has moved and
cloud readback has been verified; it is not evidence of cloud readiness.

The cloud UI now connects all three core workflows to the shared database:
SEC issuer discovery and saved CIK workspaces; receipt-bound CompanyFacts and
filings with an analyst-owned saved decision; followed-company accession
comparisons with explicit versioned baselines. The source refresh functions
are on-demand, idempotent, bounded, rate-limited, and disabled until operator
source settings are configured. The existing SQLite app remains a development
and legacy path; no local records are silently copied or dual-written. A
backfill needs an explicit mapping, reconciliation report, and cutover barrier
that preserves writes.

Follow comparisons return the exact current snapshot metadata and baseline
from one database operation. The browser list is bounded to 50 accessions and
names any omitted count. Unfollow is an owner-scoped database action; archived
baseline history remains visible, and a later re-follow starts a separate
active history.

## Source and deployment boundary

The SEC documents that its submissions and CompanyFacts APIs provide public
JSON, need no API key, and update as filings are disseminated. Its developer
guidance requires an identified User-Agent and limits access to fair use. This
supports a bounded adapter design, not an unbounded fetch or a universal
redistribution license. Market-data price, corporate-action, and shares
coverage still lacks a verified permitted source. The app must not label an
issuer small-cap until that source chain is resolved and tested.

No remote Supabase project reference, deployment credentials, or transactional
email provider are present in this checkout. The local Supabase stack runs the
same PostgreSQL migration and function handlers. Source parsers, authenticated
RLS isolation, source-snapshot publication, immutable decisions, baseline
versioning, stale-version rejection, and closed source gates have been
exercised locally. A prior migration-lint run was reported as successful, but
its command output was not retained. It is not part of the saved API evidence.
Remote deployment and a permitted live SEC receipt remain unverified until an
operator configures hosting, contact details, and source-use scope.

Current isolated API/function proof is retained at
`.agents/skills/verify-sentiment-desk/evidence/cloud-core-03ac87a0-22a6-4c81-a4a0-385c853888f3.json`:
95 recorded assertion entries passed, 0 failed, against disposable local
Supabase. These entries use 75 distinct labels. The artifact does not attach a
scenario ID to each repeated label. Synthetic
SEC-shaped fixtures and injected transports exercise snapshot receipts,
atomic publication timestamps, staged-row privacy, CIK/accession identity,
immutable decisions, exact baseline history, function authentication and
source gates, replay, last-good preservation, cleanup guards, and PostgreSQL
restart readback. The Edge test harness only resets cooldowns and removes
leases whose `lease_token` is null, and it asserts the expected released rows
were touched. Active leases remain intact and cause the verifier readback to
fail. External SEC requests and remote writes were zero. Its
rendered jsdom follow-retry check uses mocked Supabase and is separate from the
full browser journey below.

The positive browser-to-database journey is recorded at
`.agents/skills/verify-sentiment-desk/evidence/cloud-core-browser-22b0d126-74a3-42a9-a186-e7b2d32759a2.json`.
Using a disposable local magic-link account and synthetic published source
rows, the in-app browser searched by issuer name without a ticker, saved the
issuer, saved a decision with one selected fact and filing, followed the
issuer, captured baseline v1, restarted PostgreSQL without resetting the
volume, and read the saved issuer, decision, and baseline back after browser
reload. The fixture account, rows, receipts, snapshots, heads, and leases were
then removed and verified absent. This proves the local rendered workflows and
local persistence path. The records are synthetic; this does not prove a live
source receipt, SEC source-use rights, a managed deployment, or hosted
durability.

The browser JSON is an observation summary, not a screenshot, DOM capture,
network trace, or database transcript. It records only discovery, a research
decision, follow and baseline, restart and reload, and cleanup. The empty-state,
bounded-list, unfollow, and re-follow behaviors below remain verification
recipe coverage, not browser states proved by this retained journey.

## Binary review rubric

Each reviewer answers each item **yes/no** from current code and a real core UI
or isolated Supabase workflow; the score is the number of yes answers (0–10).
Tests and static inspection are supporting evidence, not proof that a hosted
path works.

1. The core app can be hosted with stateless web/API instances and does not
   require a laptop path or SQLite file for core discovery and research state.
2. A new authenticated user reaches a meaningful no-ticker issuer discovery
   path without uploading or configuring a local dataset.
3. Public source snapshots live in managed Postgres; provenance and freshness
   are visible, and no user can rewrite source receipts.
4. User research workspaces, decisions, and followed baselines survive
   instance replacement and are isolated between authenticated users by RLS.
5. No browser bundle or route exposes service-role or provider credentials.
6. SEC acquisition runs server-side, is bounded and rate-limited, and stores an
   idempotent receipt with CIK and retrieval metadata.
7. An explicit refresh reports current, stale, partial, and failed outcomes and
   retains a last-good snapshot without calling it current.
8. Issuer identity is CIK-scoped; name/ticker ambiguity and mismatches fail
   closed before facts or research records are joined.
9. Saved research decisions and follow baselines bind to the exact source
   version/record IDs and remain append-only or versioned.
10. The rendered core workflows and interruption/restart recovery pass against
    an isolated cloud-compatible database; any live/deploy claim is backed by
    a permitted source-to-consumer receipt.

## Release evidence still required

The integrated product does not claim small-cap qualification: a permitted
price, shares, and corporate-action source chain remains open. The app records
the investor's own research decision instead of computing research worthiness
or materiality. Followed-company changes are accession leads rather than
material-change interpretations. A live permitted SEC source receipt and
managed Postgres deployment remain unverified, so hosted readiness is not
claimed. The frozen AlphaSense benchmark and participant study remain outside
the user's current core implementation scope; this implementation does not
pass or remove their independent release gates.

## Independent review outcome

The three independent engineering, finance, and user-workflow reviewers each
scored the core rubric 9/10: yes on items 1, 2, and 4–10; no on item 3 because
the retained evidence is local PostgreSQL rather than a managed deployment.
All three scored the publication-time rubric 6/6. The final finance and
engineering rechecks confirmed the released-lease predicates and current
source hashes. Their lease-safety conclusion follows from the atomic SQL
predicates; no two-worker contention run was recorded. Reviewers found no
remaining material defect in the local core paths. This does not close the
managed deployment or permitted live-source evidence gaps above.

The reported binary answers and follow-up rechecks are transcribed in
[the final review record](../4-log/2026-10-10-cloud-core-final-review.md).
Those reports came from the current Codex task. This file preserves their
reported results but is not a new runtime test artifact. The API evidence's
recorded Git HEAD predates the uncommitted cloud-core files. Its ten file
hashes match the current bytes, so the evidence binds to this working tree,
not to that commit alone. The user's existing uncommitted work remains
preserved.

## Documentation checked

- [SEC EDGAR API documentation](https://www.sec.gov/search-filings/edgar-application-programming-interfaces): public submissions and CompanyFacts JSON routes, update cadence, and API access context.
- [SEC Webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions): programmatic access and User-Agent guidance.
- [Supabase Cron](https://supabase.com/docs/guides/cron) and [scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions): hosted recurring jobs and Vault-backed function invocation.
- [Supabase CLI local development](https://supabase.com/docs/guides/local-development/cli/getting-started): local migrations and isolated stack.
- [Supabase Data API exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically): new projects may require explicit grants in addition to RLS.
