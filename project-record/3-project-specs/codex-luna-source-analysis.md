# Existing Codex account: source analysis

The user authorized reuse of the existing local Codex sign-in on 2026-10-18.
The separate Desk OAuth connection remains disconnected. Each source still
requires its own affirmative confirmation after the exact text preview.

Observable acceptance, established before implementation:

1. Existing ChatGPT credentials are handed to an isolated native Codex process
   in memory. No credentials, global instructions, skills, tools, or unrelated
   records enter the model request. A localhost capture verifies that boundary
   without inference or real data. Parent configuration is unchanged.
2. Reading a source, status, or chart cannot trigger inference. Missing consent,
   paused external requests, unsuitable sources, and unavailable authentication
   cannot dispatch. One confirmed item creates at most one active request.
3. A successful native completion is schema- and source-validated and saved
   durably with thread/turn identity and actual usage. Requested/configured Luna
   is never misrepresented as a returned model: the latter remains unknown.
4. The primary sentiment chart reads only these saved results, uses actual source
   timestamps, distinguishes missing evidence from neutrality, and opens the
   exact source underlying a count. Issuer switching cannot retain stale data.
5. Interrupted/uncertain analyses cannot be resubmitted automatically by the Desk. Local daily limits
   survive restart. Auth renewal remains owned by Codex; the Desk fails and asks
   for reopening Codex when its token snapshot expires.

The 20/day ceiling counts confirmed native turns, not provider HTTP attempts.
The built-in Codex provider owns its transport retries; the Desk cannot override
those retry settings. It cancels on observable retry/error notifications and
retains uncertain dispatches for review. It never starts another turn by itself.

The current public app-server documentation describes external ChatGPT token
handoff as experimental. The pinned CLI schema still marks it internal-only;
this mismatch is recorded and reviewed rather than hidden. No internal raw
Responses event is used. Codex receipts remain separate from API receipts.

Native protocol tests and an HTTP/persistence integration test establish software
behavior. Actual model success and UI readiness additionally require an explicitly
approved real item and a rendered browser flow. Fixture results never enter the
product database or establish model quality or golden-suite readiness.
