# Private-evidence explicit consent

Optional user-owned private evidence is analyst-only context for configured publicly listed issuers. It is stored in a separate local SQLite file and never enters public observations, sentiment counts, or source history. Sending a note to GPT-6 Luna requires a separate confirmation for the selected note and issuer.

## Sub-features

- `private-evidence-issuer-isolation` keeps each note scoped to an allowlisted configured issuer.
- `private-evidence-list-redaction` exposes metadata in the list while returning note text only for an exact selected-item read.
- `private-evidence-explicit-consent` rejects analysis without explicit confirmation and binds a confirmed attempt to the selected item and its content digest.
- `private-evidence-no-duplicate-dispatch` reuses a saved response instead of repeating model work.
- `private-evidence-public-separation` keeps note text and analysis out of public mentions and observation counts.
- `private-evidence-durable-readback` verifies the note and analysis after closing and reopening the separate store.

## How to get to it (user POV)

- Select a configured publicly listed issuer and open its private research evidence section.
- Save or open a local note; the list does not expose its content.
- Select one saved note and choose `Analyze this selected note`.
- Review the issuer, note, data sent, retention disclosure, and GPT-6 Luna model in the confirmation. Canceling must send no analysis request; confirming applies only to that note.

## Driving it with the isolated HTTP verifier

The shared helper `../verify-sec-fundamentals-recovery.ts` starts an owned loopback server and disposable SQLite stores. Its private-analysis adapter is an explicitly labeled local fixture, never a model-provider call.

- **Save and inspect locally.** The helper creates a verifier-only note for one public fixture issuer, checks metadata-only list output, and reads the exact note back through the local detail route. A second fixture issuer outside the allowlist must receive `404`.
- **Require consent.** A request without `confirmExternalProcessing: true` must receive `400`, leave no attempt row, and make zero analysis callback calls.
- **Bind the selected item.** A confirmed request must reserve an attempt using the saved note's company ID, item ID, and content digest, return a valid item-bound record, and keep the response `no-store`. A duplicate request must return the saved response without another callback.
- **Keep the boundary private.** The public mentions route and real-observation count remain empty after saving and analyzing the note.
- **Reopen and verify.** After the server and stores close, the note and analysis must remain readable from the reopened private store, while public observation count remains zero.
- **Check UI consent separately.** The component test `tests/private-evidence-panel.test.tsx` verifies that canceling the item-specific confirmation sends no `POST` and confirming sends only the selected issuer/note route with the explicit confirmation body.

This recipe proves local route, consent, and persistence behavior only. It uses no user-owned note, no account credential, no provider call, and no real GPT-6 Luna output. The fixture's category is not classifier-quality or investor-outcome evidence.

## Limits

- Current live account retention settings and the user's own note handling are not verified by the fixture.
- A passing local verifier does not demonstrate that Luna is enabled, that a real request succeeds, or that the resulting analysis is accurate.
- The helper does not replace rendered desktop/mobile UI review; that remains a separate acceptance check.
