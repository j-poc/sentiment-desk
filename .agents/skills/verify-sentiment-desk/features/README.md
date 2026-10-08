# Sentiment Desk verification map

This directory maps three selected-company workflows: SEC fundamentals recovery, local private-evidence handling for configured public issuers, and the current-listed-issuer gate for Recent Filings. The verifier's isolated loopback API recipe uses temporary SQLite stores; it does not use the active runtime or claim live SEC availability or GPT-6 Luna quality.

## Baseline preconditions

- Run the recipe from the Sentiment Desk repository root with dependencies already installed.
- The recipe creates a fresh run ID, a temporary public-data database, a separate private-evidence database, and an ephemeral loopback port.
- The verifier doctor must identify the helper's own build and runtime before any refresh request.
- Fixture responses are explicitly deterministic test evidence. They do not stand in for a live SEC observation.
- The private-analysis callback is a local deterministic fixture. It does not send private data to OpenAI or establish that a real classification is correct.

## Driving conventions

- Start from a newly created isolated instance for every run.
- Use the public selected-company fundamentals HTTP routes.
- Prove both the API response and the snapshot/attempt readback after reopening SQLite.
- Preserve each run record under `../evidence/`; cleanup removes only the instance and temporary data.

## Features

- [SEC fundamentals recovery](./sec-fundamentals-recovery.md) covers partial revenue-only coverage, failed-refresh retention, and observation freshness.
- [Private-evidence explicit consent](./private-evidence-explicit-consent.md) covers issuer isolation, metadata-only listing, explicit item-bound analysis confirmation, duplicate-call suppression, separation from public sentiment, and durable readback.
- [SEC filing listed-issuer cache](./sec-filings-inbox-directory-cache.md) covers active Nasdaq/NYSE issuer verification, bounded local cache persistence across restart, offline reads, and fail-closed expiry or corruption.
