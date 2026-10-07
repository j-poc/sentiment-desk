# Sentiment Desk verification map

This directory maps the selected-company SEC fundamentals recovery journey. The verifier starts a disposable local API instance with a temporary SQLite database; it does not use the active runtime or claim live SEC coverage.

## Baseline preconditions

- Run the recipe from the Sentiment Desk repository root with dependencies already installed.
- The recipe creates a fresh run ID, a temporary database, and an ephemeral loopback port.
- The verifier doctor must identify the helper's own build and runtime before any refresh request.
- Fixture responses are explicitly deterministic test evidence. They do not stand in for a live SEC observation.

## Driving conventions

- Start from a newly created isolated instance for every run.
- Use the public selected-company fundamentals HTTP routes.
- Prove both the API response and the snapshot/attempt readback after reopening SQLite.
- Preserve each run record under `../evidence/`; cleanup removes only the instance and temporary data.

## Features

- [SEC fundamentals recovery](./sec-fundamentals-recovery.md) covers partial revenue-only coverage, failed-refresh retention, and observation freshness.
