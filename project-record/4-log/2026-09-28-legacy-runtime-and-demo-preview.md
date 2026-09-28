# 2026-09-28 — Legacy runtime discovery and isolated demo preview

## User outcome

The user asked to continue Sentiment Desk hardening, inspect similar failures,
show the working interface, and checkpoint changes to GitHub. This follow-up
checks the actual process behind the local UI and keeps fabricated demo stories
distinct from external market data.

## Legacy runtime observation

The original in-app tab showed a connection failure, but a read-only request to
`127.0.0.1:8794/api/health` found an older Sentiment Desk v0.2.0 process bound
to loopback. Its health response identified `demo=false`, Jev enabled with the
configured `jev-latest` alias, 3,339 Jev failures, and the latest error
`expected jev-latest, received jev-1.13.0`; it also reported 14,275 successful
RSS deliveries.

The aggregate health response does not reveal the historical request bodies,
whether every failure reached TypeSafe, the provider's usage/billing outcome,
or whether the requests contained publisher text. The process database,
provider request logs, and credentials were not inspected. The old process was
stopped after observing the repeated mismatch, and its persisted database was
left in place. No historical payload or billing conclusion is claimed.

## Isolated local preview

Port 8794 now serves the local demo build from a distinct temporary database:
`/private/tmp/sentiment-desk-ui-demo.mgozTZ/desk.db`. The API returns
`demo=true`; public news, SEC, GDELT, Reddit, X, and Finnhub collection are
disabled. Sentiment examples run through the local `demo-sim` judge. The app
does poll Yahoo Finance quotes; the UI shows Yahoo Finance as the source, its
source timestamp, and retrieval age. At inspection the displayed quote source
time was 2026-09-25 and the retrieval was under a minute old, so the quote was
retrieved recently but the underlying observation was stale by several days.

At the time of this initial audit, demo stories used the source label
`Synthetic example` and `https://example.invalid/demo/...` URLs. A fresh browser
accessibility tree showed those rows in the preview tape. The later user
direction was stricter: the application must use real, attributable data only.
The follow-up in `2026-09-28-real-data-only-runtime.md` retires that UI/runtime
path and records the real-source browser check.

The UI audit also found that demo health displayed `jev-latest · live`, a
synthetic request count, and an estimated synthetic cost. The broader fix
removes the demo ingestion/judgment runtime and filters preserved legacy
simulation records from current research views. The historical database was
not inspected or rewritten.

## Limits and next checks

- Historical TypeSafe payloads and billing are unknown; do not use the prior
  process health counters as evidence of publisher-text transmission or an
  invoice.
- The isolated demo preview described above was stopped after the user
  clarified that the product must contain real data only.
- Quote transport is external and read-only. A successful recent retrieval
  does not make the older quote observation current; UI freshness labels must
  remain visible.
- Source-use rights, TypeSafe retention, billing semantics, and labeled
  real-source Jev quality remain release gates. The synthetic Jev pilot does
  not close them.
