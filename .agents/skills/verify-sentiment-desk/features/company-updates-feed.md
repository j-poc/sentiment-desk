# Company updates and held-record review

Verify that selected-company updates use the same deterministic identity and business-relevance rules as GPT-6 Luna, while every saved source record remains accessible to the investor.

## Deterministic checks

From the repository root:

```sh
npm run typecheck
npm test -- --reporter=dot tests/scoring.test.ts tests/company-identity-feed.test.ts tests/analyst-feed.test.ts tests/mention-window.test.ts tests/company-research-review-api.test.ts tests/pipeline.test.ts tests/db.test.ts
```

These cases cover an option-contract quote page, shopping offer, routine `Stock Sold/Purchased/Bought by` investment-manager notices, broad market roundups such as “3 tech stocks accounting for over 20% of the S&P 500,” and a company demand update. Check that irrelevant rows are rejected before the capped Luna queue, absent from ordinary `all`/sentiment/recovery views, visible in `relevance_review` or `identity_review`, and still present in `history` with `companyBusinessRelevant: false` or `issuerIdentityStrong: false`. The queue uses the same `isFinanceRelevant` guard and still rechecks before provider dispatch.

## Saved-data runtime check

Use the running local Desk against a disposable copy of a real saved-data database. Keep external requests disabled and model request limits at zero. Do not trigger source refresh or a model request for this verification.

1. Read `GET /api/health`; confirm `externalRequestsEnabled` is false and the storage state is `ready`.
2. For the selected AAPL company, read `/api/companies/apple/mentions-page?filter=all&hours=168&limit=100`. Confirm consumer deals and raw option-contract quote pages do not appear in `items`, while a source-linked company business update remains when available. Read `investorRelevanceReviewCount`.
3. Read `/api/companies/apple/mentions-page?filter=relevance_review&limit=100`; held rows must have strong issuer identity and `companyBusinessRelevant: false`. Read `filter=history` and confirm the same IDs remain there.
4. In the ordinary browser Desk, select AAPL. Confirm the issuer feed contains business updates only, the held-record disclosure opens “Held from updates”, and full History still contains the excluded records. The market-price panel must retain its source, currency, observation/retrieval time and “market context” labeling. A zero Luna chart must remain explicitly empty, never neutral; historical Jev remains separate.

This runtime check proves filtering of the saved observations in this database only. It does not establish source freshness, source-use rights, or Luna classification quality. Record the latest source observation and retrieval timestamps separately.
