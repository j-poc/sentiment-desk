# Recent SEC filing disclosure inspection

## Investor task

An investor without a ticker can find a filing in the real SEC 8-K inbox, understand what the issuer disclosed, then decide whether to save the issuer for further research. The existing list let the investor filter and save a lead, but required leaving the Desk to read the actual filing. That made the first useful step depend on external navigation and hid the source clocks and document provenance.

## Interaction decision

Keep the established compact filing list and expand one selected row inline. This keeps the issuer, exact accession, save action, filing index, and evidence together on narrow screens. An external-only link remains available for the full SEC page. A modal or second detail route would add navigation without improving source understanding for this bounded excerpt workflow.

Mobbin was inspected for finance-web hierarchy. The accessible Revolut Web preview showed general product/finance screens, not a filing-review task; the detailed reference flow was unavailable behind its paid gate. It supplied no evidence for changing the Desk's established visual system, so the interface keeps its current dark panel and compact typography.

## Observable acceptance

- The inbox makes no document request on render, refresh, or poll. One explicit “Inspect in Desk” action requests exactly the selected accession; in-flight duplicate actions coalesce.
- The server accepts detail requests only for an exact Form 8-K row in the current private-display receipt, validates the issuer CIK against SEC submissions metadata, and verifies the exact accession independently. Issuer CIK, accession CIK, and archive-path CIK remain distinct; the last comes from the already validated official filing-index URL.
- The action makes one issuer-submissions request and no more than two bounded document requests. SEC's existing source allowlist, global request gate, storage admission, pacing/cooldown, redirect controls, and contact-bearing User-Agent remain enforced.
- The panel shows filed date, report period, EDGAR acceptance time, metadata/document retrieval times, item codes and labels, source URL, bounded source excerpt, and document digest as separate evidence. Period of report is never labeled an event date.
- Item 2.02 text is shown as usable exhibit evidence only when existing extraction verifies a unique same-accession Exhibit 99.1 relationship. Missing, ambiguous, rate-limited, disabled, or failed requests stay visibly partial/blocked, with retry and the official SEC index link.
- No classifier is called, no document body is persisted, and no filing is ranked or summarized as investment merit.
- Keyboard controls remain native buttons and links. The inline panel wraps long source text and hashes without page-level horizontal overflow at 390px and 320px.

## Verification boundary

Focused unit and route tests use isolated in-memory provider responses only to exercise parsing, authorization boundaries, and failure behavior; they are not product data or proof of a live filing. Rendered acceptance must use an actual current SEC inbox receipt and the real SEC documents, when the runtime's source gates allow the user's explicit request. This slice does not complete issuer-universe discovery, fundamentals triage, current Luna operation, full followed-company materiality, intended-user outcome studies, or overall Desk readiness. Opportunity Radar remains disabled.
