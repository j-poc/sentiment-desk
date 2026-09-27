# 2026-09-27 — Opportunity Radar first-release comparison

## Baseline

The live Sentiment Desk is the source of truth for company observations and
Jev judgments. It records news and filings with publisher, collection, and
provider times, plus optional credentialed social/news connectors. This
comparison is about the first cross-item view; it does not change the per-item
Jev rubric or collector contracts. At the time of the experiment, GDELT was
failing in the local smoke while Google News, Yahoo Finance news, SEC, and
quotes had recent successful delivery; X, Finnhub, and Reddit were disabled.

## Candidate workflows

| Candidate | Expected user result | Cheapest comparable test | Main limitation |
| --- | --- | --- | --- |
| **A. Jev taxonomy activity with exact headline groups** | Compare current and previous equal windows, see publisher breadth and direction, then open the evidence. | One persisted-row scenario containing syndicated copies, a second publisher, a distinct headline, a separate Jev category, missing time, and pending/failure states. | Event categories are broad buckets; headlines are not event identity and cannot establish systemic demand. |
| **B. Cross-headline narrative clustering** | See paraphrased descriptions of a shared micro-trend joined as one emerging theme. | The same row scenario plus a separately labeled set of paraphrase and hard-negative headlines; a reviewer would judge cluster precision and recall. | Needs a validated similarity model/threshold and independent labels; a false merge creates a misleading market signal. A second model/prompt also needs cost and AI evaluation. |
| **C. Research queue ranked by Jev novelty/surprise** | Move quickly from the desk into the newest high-novelty source items, with opposing judgments visible. | Rank the same source rows and confirm every result retains its publisher and clock. | Helps triage but does not answer collective coverage convergence; one item can dominate without independent corroboration. |

## Shared scenario comparison

1. One publisher's article arrives through Google News and Yahoo Finance.
   Candidate A shows one exact headline group and one publisher, preserving
   both source rows. Candidate B should combine them but requires resolving
   whether they are truly the same story. Candidate C shows two queue rows and
   risks visually overstating evidence.
2. A second publisher uses the same normalized title with a negative Jev
   judgment. Candidate A keeps one headline group, two publishers, and both
   directions. Candidate B can show convergence only if it carries publisher
   evidence and contradictory judgments; a single synthesized direction would
   hide the disagreement. Candidate C shows the disagreement but leaves the
   researcher to count publishers.
3. A different product headline and a results headline arrive in the same
   window. Candidate A keeps the two product headline groups separate and
   places results in another Jev category. Candidate B risks false merging
   from shared company vocabulary. Candidate C keeps both records but offers
   no comparison.
4. A scored observation has provider time but no publisher time; another item
   is pending. Candidate A excludes the first from publication velocity and
   reports the untimed and unjudged counts. Candidate B needs its own explicit
   temporal inclusion rule. Candidate C could order by retrieval but would not
   claim publication velocity.
5. A collector fails while old observations remain. Candidate A preserves
   the failed delivery state beside any prior evidence. Candidate B risks
   presenting an apparently stable narrative from stale input. Candidate C
   can still open the last item but cannot itself communicate feed health.

## Selection and evaluation

Keep Candidate A for the first Radar release. It most directly supports
inspectable cross-source comparison on data already persisted by the verified
Sentiment Desk, and its headline/publisher proxies can be computed without
changing model behavior or source permissions. Do not label a category as a
shared theme or an opportunity. Candidate B remains a later experiment only
after a representative, human-labeled clustering set and explicit model
evaluation exist. Candidate C remains a possible navigation affordance if
researchers need first-response triage more often than window comparison.

The selected candidate's objective proxy is exact expected counts in a
persisted SQLite/API scenario. This proves aggregation semantics, not that the
view improves decision quality, detects alpha, or represents the full public
web. Browser automation checks that the comparison, source links, timing, and
degraded coverage are visible at 1280px and 390px; this is not observed-user
usability research.

## Results

- Candidate A was selected. Independent expectations for the SQLite/API row
  fixture confirmed current/prior totals, exact normalized headline groups,
  publisher counts, directional judgments, categories, untimed and pending
  rows, source URLs, failed delivery, pagination, invalid category rejection,
  and unknown company handling.
- The pure-test run initially found an expected-ordering error in the test,
  not the implementation: evidence is ordered by latest publisher time. The
  assertion now checks the independently expected set. Later cleanup removed
  a legacy title-digest and fuzzy-duplicate helper that no longer participated
  in ingestion; identity remains collector plus provider source ID/URL and
  immutable revision.
- Final verification on 2026-09-27: `npm test` passed 52 tests across 8 files;
  `npm run typecheck`, `npm run build`, and `git diff --check` passed. Browser
  checks at 1280px and 390px verified shared company selection, Radar state,
  and source clocks; width stayed 390px on the 390px viewport. The active demo
  example displayed `DEMO · SYNTHETIC EVIDENCE` and was not treated as Jev.
- A fresh production start with empty credentials showed real publisher-timed
  RSS/SEC observations pending, current RSS/SEC/quote delivery, a visible GDELT
  HTTP 429 failure, and disabled optional providers. The isolated Compose
  check passed again on the final code revision: 27 quotes/24 companies and a
  real pending observation persisted across container recreation. It used
  only the `colima-sentiment-desk-verify` Docker context.
- Candidate A is accepted for this first release. This result proves the
  aggregation contract and visible source path; it does not prove cross-web
  coverage, real-world event identity, thematic clustering, researcher
  decision benefit, or alpha. Provider terms remain unreviewed and GDELT was
  rate-limited at the fresh-start check.
