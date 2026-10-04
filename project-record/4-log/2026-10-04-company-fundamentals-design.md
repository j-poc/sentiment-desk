# Selected-company SEC fundamentals triage — design checkpoint

Trace ID: `TRACE-20261004-sec-fundamental-triage`

Status: implemented and locally verified; live SEC and whole-product acceptance remain unverified.

## Throughput checkpoint

- [x] Blocking first steps. Confirmed branch `codex/real-data-rebuild`, clean pushed base `39a028f`, current SEC request gates, empty/live status, and the component-only candidate's focused checks. Live acquisition stays blocked until the Sentiment Desk process has its own valid `SEC_USER_AGENT`.
- [x] Independent workstreams. The persisted UI component and its state/accessibility tests are complete in their own files. Server parsing, persistence, and API remain one coupled ownership slice; there is no second concurrent writer.
- [x] Shared mutable state. No new provider profile or Desk database migration is allowed during design. Product requests must use existing SEC approval and storage gates; all candidate design scans are read-only.
- [x] Smallest safe decomposition. Compared direct SEC retrieval and the registered Data Hub route, selected one receipt/fact contract, and integrated parser, additive schema, API, App wiring, and isolated tests in dependency order.

## Design worklist

1. [x] Ground SEC identity, fetch, storage, API, and UI boundaries in the existing code.
2. [x] Compare independent architecture candidates against the stated slice criteria.
3. [x] Implement bounded SEC facts persistence and selected-company UI wiring.
4. [ ] Verify, independently review, trace, and checkpoint the integrated result; real-source display and code-bound ETL evidence remain required.

## User outcome

When an investor opens a selected company, they need a fast way to check what
the issuer actually reported, compare like periods, inspect the filing, and
decide what to investigate next. Today's Desk has source headlines and saved
price history but no filing-backed fundamental view. This slice adds an
evidence-linked company view; it does not claim a company is a small-cap,
materially changed, a buy, or an investment opportunity.

## Observable slice acceptance

1. An explicit refresh for a configured company is admitted only when the
   existing SEC identity, external-request, source-rights, and storage gates
   are ready. Otherwise the user sees the exact blocked state and the request
   sends no HTTP traffic.
2. A successful bounded SEC acquisition saves real CompanyFacts values with a
   source-delivery receipt and exact issuer CIK, taxonomy and concept, unit,
   start/end dates, form, accession, filing date, SEC acceptance time,
   retrieval time, response digest, and immutable filing URL. Facts without a
   matching acceptance record are withheld from period comparisons and shown
   only in coverage diagnostics.
3. Period identity uses the fact's exact start/end dates and does not use the
   filing's fiscal-year/period focus metadata. Comparative rows are retained
   only with an accession-linked filing whose report date contains the fact's
   period. Differing or unresolved rows for the same period, unsupported tags,
   incompatible periods, amendments, and unknown acceptance times remain
   visible as coverage limits. Comparisons require both values in the same
   filing, the same taxonomy/concept/unit and duration, and exact one-calendar-
   year alignment of both boundaries; shifted 52/53-week windows abstain.
4. The selected-company view uses only persisted SEC evidence. It shows actual
   reported values and dates, direct filing links, the filing calendar date
   and separate acceptance/retrieval timestamps, a chart with breaks across
   missing or shifted periods,
   exact same-filing comparisons where eligible, and a fact-linked question
   for further research. It does not relabel report-focus metadata as the
   fact's period. It states that SEC aggregate facts omit custom and
   dimensional disclosures and that comparisons do not establish cause or
   investment merit.
5. Loading, blocked, true-empty, stale, partial, and failed states are
   distinct. Retry is explicit and safe. A failed refresh preserves the last
   accepted values. A new installation renders no fabricated value or chart.
6. Persistence, restart/reload, zero-fact partial writes, exact replay,
   conflict/duplicate handling, request bounds, parsing, period selection,
   and empty/blocked/error keyboard/mobile states pass isolated verification.
   No synthetic financial fact is used in the product. Bounded source-shaped
   fictional facts may appear only in offline test fixtures and temporary test
   databases; no fixture seeds the product database, is displayed by the app,
   or counts as SEC source evidence. At least one actual SEC-backed saved view must
   be rendered in the local Desk before this slice can be called live-verified.

This is one selected-company workflow, not completion of the broader frozen
contract. No-ticker small-cap discovery, price/share/corporate-action support,
interpreted material-change monitoring, new GPT-6 Luna outputs and usage
reconciliation, the agent-reviewed Master Eval, intended-user outcomes, and
all current ETL/evidence gates remain separate exit conditions. Opportunity
Radar stays disabled.

## Source and implementation choice

The SEC's official XBRL CompanyFacts API returns a company's standard, whole-
entity facts in one JSON response; its companion submissions route provides
the accession-specific acceptance timestamp required for point-in-time
comparison. The existing TypeScript SEC adapter already owns identity,
contact-header validation, pacing, and source-delivery lineage. Extend that
route and its SQLite evidence boundary rather than adding another provider
package.

The shared Public Data Hub was inspected and its registered service was
recovered on loopback. Its authenticated source inventory supports SEC
submissions and facts, but its pinned CompanyFacts profile selects only one
taxonomy/concept/unit at a time; each stored profile also has its own
long-lived revision and receipt. That is suitable for individual facts but
does not match a whole selected-company multi-metric refresh at the existing
issuer breadth. The authenticated source inventory reports SEC live
verification as `unverified`; this task has not created a Hub profile or
requested data through it. OpenBB documents an SEC `compare_company_facts`
helper, but it remains fact-selected and would add a Python provider/runtime
boundary without improving the required filing-time lineage. The direct
official endpoint is therefore the smaller complete route for this result.

SEC official documents reviewed 2026-10-04:

- EDGAR APIs: `https://www.sec.gov/search-filings/edgar-application-programming-interfaces`
- Fair-access rate and declared User-Agent: `https://www.sec.gov/about/webmaster-frequently-asked-questions`
- OpenBB V5 comparison capability: `https://docs.openbb.co/odp/python/reference/sec/compare_company_facts`
- EDGAR XBRL Guide, August 2026: `https://www.sec.gov/files/edgar/filer-information/specifications/xbrl-guide.pdf`

The present Sentiment Desk process does not inherit a valid `SEC_USER_AGENT`.
The bounded SEC probe stopped before network access. The Hub has a separate
valid private SEC contact in its own installation; this project will not read,
copy, or expose that credential. Product live verification remains
`Unverified` until the actual Sentiment Desk request process sees its own
configured identity and the authorized isolated request succeeds.

## Architecture decision

Selected direct SEC retrieval and local immutable storage. A fresh GPT-6.1 Sol
xhigh architecture candidate scored it 20/24 against the registered Data Hub
candidate at 11/24. A separate GPT-6 Astra cross-judge agreed. The direct path
reuses the existing SEC fair-access identity, pacing, storage and request gates
and fits a full multi-metric CompanyFacts response. The Hub profile accepts one
CIK/taxonomy/concept/unit and has a shared 64-profile limit; 24 configured
companies x four metrics is already 96 before acceptance-time profiles. The
Hub also has no current evidence that its normalized CompanyFacts result
preserves submissions acceptance timestamps.

Graft from the Hub candidate: retain a durable explicit refresh attempt state,
claim the idempotency key before network work, and recover interrupted attempts
without replacing the last accepted snapshot. Add a bounded policy for recent
submissions and show missing historical acceptance joins; do not promise
unbounded history from three requests. The independent reviewer found the
existing SEC helper parses only 8-Ks and uses unbounded `res.json()`, so the
fundamentals adapter must have its own size-limited JSON reader and form-neutral
submissions join.

## Integrated evidence

The standalone component's focused tests and typecheck passed before
integration. Independent source review found `renderChart` tested decimal
strings as numbers before conversion, suppressing every populated SEC chart.
That defect is fixed by validating decimal text, converting once, then checking
the numeric drawing coordinate. Empty-state tests still contain no SEC values.

Backend persistence, App wiring, receipt-linked API paths, zero-fact recovery,
and period handling are implemented in the current local candidate. An
isolated selected-company view has not yet been populated from a real SEC
response. The actual Desk process has no configured SEC contact identity, so
no real SEC refresh or positive factual chart has been verified. The running
Desk also has no OpenAI API credential, so no live Luna request was made. The
current contract and ETL receipts are not passing, and this candidate has not
yet been pushed. The product database was not migrated during design or
verification.

## Period and persistence correction — 2026-10-04

The whole-build detector found that the zero-fact `partial` state was rejected
by persistence. A zero-fact empty snapshot remains `empty`; a zero-fact result
with coverage diagnostics is now durably `partial`; `ready` still requires at
least one fact. The isolated SQLite regression verifies the partial snapshot,
attempt state, three separate SEC request receipts, and one shared content
blob for identical non-financial response bytes.

The detector and an independent GPT-6.1 Sol xhigh advisor also found that SEC
`fy`/`fp` metadata had been used as fact-period identity and that requiring the
filing report date to equal every fact's end date discarded comparative rows.
The current SEC XBRL Guide describes Document Fiscal Year/Period Focus as the
filer's fiscal year and the report's fiscal period, while numeric facts have
their own period start/end [SEC EDGAR XBRL Guide, August 2026]. These fields
are retained as filing-focus metadata, never shown as the fact period.

Policy v2 now matches each row by issuer/accession/form/filing date and only
admits periods no later than the matched filing report date. It groups vintages
by exact metric/taxonomy/concept/unit/start/end/duration before applying the
history bound. A conflicting value, an unmatched row for the same period, or
too many vintages withholds that period and comparison. It does not guess which
filing is a restatement. A comparison is emitted only when current and prior
facts share one accession and both date boundaries shift by exactly one
calendar year. The chart uses actual date spacing and breaks the line when
observed annual points skip a year or use shifted 52/53-week dates.

Focused tests passed **57 tests across 8 files** and `npm run typecheck` passed
after one type-only test correction. The engineering contract and SEC ETL
declaration now include this workflow and its test paths. Their checks are
currently non-passing: the engineering receipt is missing, and ETL evidence is
stale for the modified contract/code and still lacks its required keyless
Compose smoke. The shell has no `SEC_USER_AGENT`; no SEC request was sent. The
in-app browser remains unavailable while the Mac is locked, so actual
populated and responsive rendering is unverified. The full Desk remains open.

## Investor-usability review fixes — 2026-10-04

An independent finance-platform review identified two direct-reading defects
in this view. The filing date is a SEC calendar date, not an event timestamp;
render it date-only while leaving SEC acceptance and local retrieval clocks
with their real time values. The annual revenue plot now labels its visible
linear USD range and exposes the source-returned point strings, dates, units,
and precision status
through a keyboard-accessible table. The plot carries the same unit on every
point and withholds itself if point units or metrics differ. Empty and true
blocked states still render no factual marks.

Source precision is retained only when returned by CompanyFacts. Missing
precision stays explicitly unknown, leaves arithmetic qualified as a
difference between returned values, and suppresses percentage change; malformed
precision withholds comparison. For declared values, comparison withholds
direction when the difference falls within the full precision increment of
each fact combined. This uses the SEC guide's documented rounding-or-truncation
semantics and does not rescale the source value. The accessible table no longer
calls source-returned values “exact.”

Offline parser/service regressions use fictional, source-shaped SEC responses
and temporary SQLite. They verify precision readback, conservative boundary
handling, and percentage suppression without calling a provider or touching
the product database. These tests are not real SEC evidence. The isolated
browser preview remains empty/saved-only; a populated SEC view, mobile/keyboard
browser workflow, and fresh independent whole-product review remain pending.


## Precision review correction and filing triage — 2026-10-04

An independent finance review found that a finite-precision reported-value
difference could exceed its conservative bound while the service still emitted
a point percentage. The difference may support a direction while its exact
percentage remains uncertain. The service now emits a percentage only when
both SEC facts declare `decimals=INF`; finite, missing, and invalid precision
cannot render as an unqualified percentage. The UI also suppresses a supplied
percentage unless both persisted inputs carry that declaration and explains
the suppression. An isolated regression uses a $4 million difference against a
$2 million combined precision bound to verify this case.

The generic driver question has been replaced with a three-part filing triage:
what the eligible saved comparison supports, what totals-only facts cannot
establish (drivers, materiality, persistence, or narrative counterevidence),
and a concrete filing check. If no eligible comparison exists, the panel says
there is no supported material-change finding and tells the investor to locate
a calendar-matched statement. It does not invent a company thesis or imply a
trade decision.

The isolated real-data preview still contains no eligible observations, saved
SEC facts, price history, or chart points, and external requests remain off.
These UI states are truthful but cannot verify populated-data usability. No
provider, Luna, or Jev request was made; no application database was opened or
changed. The full-build review on the prior candidate scored 3/10 for investor
task readiness. Tickerless small-cap discovery, source-backed driver and
counterevidence synthesis, live Luna operation, price-lineage reconciliation,
and uncoached investor task outcomes remain unresolved. Full-suite, build,
engineering and live-data gates, and a fresh review of the final candidate are
still required; no completion claim is supported.
