# Local BYOK provider keys and assessments

This feature is the loopback-only workflow for a user to save their own OpenAI, Google Gemini, or TypeSafe Jev key, verify model access, review the exact fields for one saved public source, and explicitly request one assessment. Categorical results and TypeSafe Jev results have separate persistence, models, and company series.

## Focused checks

Run from the repository root:

```sh
npx vitest run tests/typesafe-jev-byok.test.ts tests/typesafe-jev-byok-api.test.ts tests/model-provider-credential-vault.test.ts tests/model-provider-settings-ui.test.tsx tests/model-provider-classifier.test.ts tests/external-request-gate.test.ts
npm run typecheck
npm run build
```

The fake provider tests prove local contract and persistence behavior only. They do not consume a real account quota or evaluate provider quality. The credential vault test verifies provider-scoped encrypted files and OS-keyring key handling; the route test verifies that saved credentials never appear in status or responses. TypeSafe result tests verify that a confirmed source produces a Jev-only record while the observation remains pending in the automatic scoring queue.

## Live local desk

The current UI can be checked with these public-data routes:

- `GET /api/companies/apple/mentions?hours=24&limit=5` — confirm source title, publisher, source URL, and retrieval time.
- `GET /api/companies/apple/price?ticker=AAPL&hours=72` — confirm Yahoo delivery, currency, retrieval time, and non-empty source-attributed points.
- `GET /api/sec-issuer-directory?q=AAPL` — confirm a current SEC ticker/exchange mapping and its retrieval receipt.
- `GET /api/model-providers/status` — confirm supported model IDs, local usage, limits, and configured booleans only.

Do not infer a live provider response from public-source or price availability. A provider request is only authorized after the user has entered that provider key in the local Model API Keys panel, reviewed the specific source and provider disclosure, and checked the one-item send confirmation. Never copy the key into a test command, chat, screenshot, or verification record.

## Data boundaries

- OpenAI and Gemini results use the shared bounded categorical schema, with exact provider, model, prompt, source identity, and retrieval provenance.
- TypeSafe results use `typesafe_jev_byok_attempts` and `typesafe_jev_byok_results` and retain the TypeSafe model and fixed Jev rubric digest. They do not update `mentions`, `jev_judgments`, or OpenAI/Gemini classifications.
- The TypeSafe URL gate allows only authenticated `GET https://api.typesafe.ai/v1/models` and user-authorized `POST https://api.typesafe.ai/v1/systemone`.
- Local request, request-byte, conservative cost, and connection-check ceilings are persisted. Unknown outcomes stay visible and require provider-usage review before another request; there is no automatic retry.
- Free-tier Gemini disclosure must remain adjacent to the source-send confirmation: submitted content may be used to improve Google products, and provider terms/quota/billing remain provider-controlled.
- The app is loopback-only for these credentials. The OS keychain is not cloud account storage.

When a user has not entered a key or approved a source, stop at public-data and fixture checks. Record live provider behavior as unverified rather than substituting fixture output.
