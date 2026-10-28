# Live local investor preview

## Scope

This was a local-mode run of the primary SQLite app, not the hosted Supabase
app. It used one public issuer, Apple (AAPL), an isolated temporary database,
and the already configured Google News RSS, Yahoo Finance RSS, Yahoo quote, and
Yahoo chart collectors. The temporary database was
`/tmp/sentiment-desk-live-verify.5dZgMr/desk.sqlite`; no user database or
provider credential vault was opened. The app server listened on
`127.0.0.1:8787` and Vite served the UI at `127.0.0.1:5174` in local mode.

## Observed public data

The local health endpoint returned HTTP 200 with external requests enabled for
this isolated run. The first scheduled sweep returned successful receipts for
Google News RSS (100 parsed items), Yahoo Finance RSS (16), Yahoo chart (66),
and Yahoo quote (one AAPL quote plus the configured market context). The
Apple mentions endpoint returned HTTP 200 and ten source observations in the
requested 72-hour window. A visible record was attributed to
[Yahoo Finance](https://finance.yahoo.com/markets/stocks/articles/why-apple-aapl-stock-trading-231510875.html?.tsrc=rss)
and retrieved at `2026-10-10T21:42:58Z`; its publisher timestamp was absent,
so the record uses the aggregator-declared time rather than treating retrieval
time as publication time.

The Apple price endpoint returned HTTP 200 with 27 USD chart points. The
latest source observation was `2026-10-09T20:00:00Z`, retrieved at
`2026-10-10T21:48:44Z`. That is a delayed historical close, not a live quote.

The Yahoo Finance feed also returned a broad-market item whose saved issuer
identity was explicitly `false`. It remains reviewable as uncertain, and it
cannot be sent for a Jev assessment under the existing identity guard. This
is useful evidence that the user can see uncertainty in the real-source feed,
not a verified Apple-specific update.

## Provider and hosted limits

The temporary credential vault reported OpenAI, Gemini, and TypeSafe Jev as
unconfigured. No model request was made, so no bullish/bearish assessment or
chart point was generated. The visible app is the local surface; the Cloud
Core route was not live-tested because this checkout has no Supabase URL/key
and the isolated Docker context was stopped.

The official Google News terms found during this review limit its content to
personal, non-commercial display and prohibit public display or copying. The
Yahoo terms allow display of RSS-provided content only without modification,
with source attribution and a link, and also restrict creating competing
archives or data feeds. These feeds therefore do not establish a permitted
shared cloud news corpus. A hosted Jev feed needs a separately qualified
source and its own retention/display terms. [Google News terms](https://www.google.com/intl/en_us/terms_google_news.html),
[Yahoo terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html?ncid=mbr_idnedulnk00000001).

The UI was opened in Codex for the user to inspect. No browser automation or
rendered screenshot inspection was performed, so visual layout, the TradingView
frame, and a live model response remain unverified.
