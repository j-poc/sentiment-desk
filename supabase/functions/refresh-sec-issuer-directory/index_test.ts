import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { SEC_ISSUER_DIRECTORY_URL } from "../../../shared/sec-issuer-directory.ts";
import { handle } from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

Deno.test("issuer directory Edge Function publishes, reuses, and protects its last-good snapshot", async () => {
  const projectDir = Deno.env.get("SENTIMENT_DESK_SUPABASE_PROJECT_DIR");
  const statusOutput = await new Deno.Command("supabase", {
    args: projectDir ? ["--workdir", projectDir, "status", "-o", "json"] : ["status", "-o", "json"], stdout: "piped", stderr: "null",
  }).output();
  assert(statusOutput.success, "local Supabase status is available");
  const local = JSON.parse(new TextDecoder().decode(statusOutput.stdout));
  const url = local.API_URL as string;
  const publicKey = (local.ANON_KEY ?? local.PUBLISHABLE_KEY) as string;
  const serviceKey = local.SERVICE_ROLE_KEY as string;
  assert(new URL(url).hostname === "127.0.0.1"
    && new URL(url).port === (Deno.env.get("SENTIMENT_DESK_SUPABASE_API_PORT") ?? "54321"), "test refuses a non-local or unexpected API");
  assert(publicKey && serviceKey, "local Supabase credentials are available");

  for (const [key, value] of Object.entries({
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: publicKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    SEC_DIRECTORY_SOURCE_ENABLED: "false",
    SEC_USER_AGENT: "SentimentDesk local verification directory@example.test",
    APP_ALLOWED_ORIGINS: "http://127.0.0.1:5173",
  })) Deno.env.set(key, value);

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const sourceId = "sec_company_tickers_exchange";
  const dataset = "company_tickers_exchange";
  const cik = "9999999998";
  const requestKeys: string[] = [];
  const sourceRunIds: string[] = [];
  const snapshotIds: string[] = [];
  const user = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let userId: string | null = null;
  let authToken = "";
  let mode: "success" | "invalid" | "unavailable" = "success";
  let fetchCalls = 0;
  const sourceBody = JSON.stringify({
    fields: ["cik", "name", "ticker", "exchange"],
    data: [[Number(cik), "Directory Verification Issuer", "DVFY", "NYSE"]],
  });
  const sourceDigest = await sha256(sourceBody);

  async function must<T>(promise: Promise<{ data: T | null; error: { message: string; code?: string } | null }>, label: string): Promise<T> {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${result.error.message} (${result.error.code ?? "no code"})`);
    return result.data as T;
  }

  async function clearReleasedDirectoryCooldown(label: string): Promise<void> {
    const rows = await must(service.from("core_source_refresh_leases")
      .update({ next_allowed_at: new Date(Date.now() - 1000).toISOString() })
      .eq("source_id", sourceId).is("lease_token", null).select("source_id,lease_token"), label);
    assert(rows.length === 1 && rows[0].lease_token === null,
      `${label}: only a released directory lease may have its cooldown cleared`);
    pass("directory cooldown reset updates only a released lease");
  }

  async function invoke(requestKey: string, token = authToken, fetchImpl: typeof fetch = fixtureFetch): Promise<{ response: Response; body: Record<string, unknown> }> {
    requestKeys.push(requestKey);
    const response = await handle(new Request("http://local.test/refresh-sec-issuer-directory", {
      method: "POST",
      headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ requestKey }),
    }), fetchImpl);
    return { response, body: await response.json() as Record<string, unknown> };
  }

  const existingDirectoryHead = await must(service.from("sec_issuer_directory_head").select("snapshot_id")
    .eq("dataset", dataset).maybeSingle(), "check directory head before running isolated function fixture");
  assert(existingDirectoryHead === null,
    "directory function fixture requires an empty directory head; run it only against a disposable local database");
  const existingDirectoryLease = await must(service.from("core_source_refresh_leases").select("source_id")
    .eq("source_id", sourceId).maybeSingle(), "check directory refresh lease before running isolated function fixture");
  assert(existingDirectoryLease === null,
    "directory function fixture requires an empty directory refresh lease; run it only against a disposable local database");
  pass("directory fixture refuses to run while a pre-existing refresh lease is present");

  async function publishStaleSnapshot(): Promise<string> {
    const retrievedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const staleBody = JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"],
      data: [[Number(cik), "Last Good Directory Issuer", "GOOD", "NYSE"]] });
    const runId = crypto.randomUUID();
    sourceRunIds.push(runId);
    const requestKey = crypto.randomUUID();
    const staleDigest = await sha256(staleBody);
    await must(service.from("core_source_runs").insert({ id: runId, request_key: requestKey, source_id: sourceId,
      source_url: SEC_ISSUER_DIRECTORY_URL, adapter_version: "verify-cloud-core-directory/1", trigger_kind: "manual",
      status: "running", started_at: retrievedAt }), "create last-good directory run");
    await must(service.from("core_source_runs").update({ http_status: 200, retrieved_at: retrievedAt,
      response_sha256: staleDigest, response_bytes: new TextEncoder().encode(staleBody).byteLength, row_count: 1 }).eq("id", runId), "record last-good directory receipt");
    const snapshotId = crypto.randomUUID();
    snapshotIds.push(snapshotId);
    await must(service.from("sec_source_payloads").insert({ source_run_id: runId, response_sha256: staleDigest, response_body: staleBody }), "store last-good directory payload");
    await must(service.from("sec_issuer_directory_snapshots").insert({ id: snapshotId, source_run_id: runId,
      source_id: sourceId, source_url: SEC_ISSUER_DIRECTORY_URL, source_response_sha256: staleDigest,
      parser_version: "verify-cloud-core-directory/1", retrieved_at: retrievedAt, completed_at: null, row_count: 1 }), "create staged last-good directory snapshot");
    await must(service.from("sec_issuer_directory_entries").insert({ snapshot_id: snapshotId, cik, ticker: "GOOD",
      issuer_name: "Last Good Directory Issuer", exchange: "NYSE", source_row_sha256: await sha256(JSON.stringify({
        cik, ticker: "GOOD", name: "Last Good Directory Issuer", exchange: "NYSE",
      })) }), "create last-good directory entry");
    const stagedSnapshot = await must(user.from("sec_issuer_directory_snapshots").select("id").eq("id", snapshotId),
      "read staged directory snapshot as authenticated user");
    const stagedEntries = await must(user.from("sec_issuer_directory_entries").select("cik").eq("snapshot_id", snapshotId),
      "read staged directory entries as authenticated user");
    assert(stagedSnapshot.length === 0 && stagedEntries.length === 0,
      "authenticated users cannot read a staged directory snapshot or its rows");
    await must(service.rpc("publish_sec_issuer_directory_snapshot", { p_snapshot_id: snapshotId, p_expected_rows: 1 }), "publish last-good directory snapshot");
    const publishedSnapshot = await must(user.from("sec_issuer_directory_snapshots").select("id").eq("id", snapshotId),
      "read published directory snapshot as authenticated user");
    assert(publishedSnapshot.length === 1, "authenticated users can read a directory snapshot after atomic publication");
    pass("directory staging remains private until atomic publication");
    return snapshotId;
  }

  async function fixtureFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    fetchCalls += 1;
    const requestUrl = input instanceof Request ? input.url : input.toString();
    assert(requestUrl === SEC_ISSUER_DIRECTORY_URL, "directory handler requests only the fixed SEC directory URL");
    assert(new Headers(init?.headers).get("User-Agent") === "SentimentDesk local verification directory@example.test",
      "directory handler sends the configured User-Agent");
    if (mode === "invalid") return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    if (mode === "unavailable") return new Response("", { status: 503, headers: { "retry-after": "3600" } });
    return new Response(sourceBody, { status: 200, headers: { "content-type": "application/json" } });
  }

  try {
    const email = `directory-function-${crypto.randomUUID()}@example.test`;
    const password = `T9!${crypto.randomUUID()}Zz`;
    const { data: created, error: createError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError || !created.user) throw new Error(`create local directory verifier user: ${createError?.message ?? "missing user"}`);
    userId = created.user.id;
    const { data: signedIn, error: signInError } = await user.auth.signInWithPassword({ email, password });
    if (signInError || !signedIn.session) throw new Error(`sign in directory verifier user: ${signInError?.message ?? "missing session"}`);
    authToken = signedIn.session.access_token;

    const unauthenticated = await invoke(crypto.randomUUID(), "");
    assert(unauthenticated.response.status === 401 && fetchCalls === 0, "unauthenticated refresh fails before source transport");
    pass("issuer directory refresh requires authentication before source transport");

    const disabled = await invoke(crypto.randomUUID());
    assert(disabled.response.status === 503 && disabled.body.error === "sec_directory_source_not_enabled" && fetchCalls === 0,
      "source gate blocks directory transport until enabled");
    pass("issuer directory source gate prevents an SEC request when disabled");

    Deno.env.set("SEC_DIRECTORY_SOURCE_ENABLED", "true");
    const requestKey = crypto.randomUUID();
    const published = await invoke(requestKey);
    assert(published.response.status === 200 && published.body.state === "success", "enabled directory refresh publishes a successful snapshot");
    const receipt = published.body.receipt as { source: string; retrievedAt: string; sha256: string; rowCount: number; snapshotId: string };
    assert(receipt.source === SEC_ISSUER_DIRECTORY_URL && receipt.sha256 === sourceDigest && receipt.rowCount === 1,
      "published receipt binds source URL, response digest, and parsed row count");
    assert(Number.isFinite(Date.parse(receipt.retrievedAt)), "published receipt includes retrieval time");
    snapshotIds.push(receipt.snapshotId);
    assert(fetchCalls === 1, "successful refresh made one intercepted source request");
    const head = await must(service.from("sec_issuer_directory_head").select("snapshot_id").eq("dataset", dataset).single(), "read published directory head");
    assert(head.snapshot_id === receipt.snapshotId, "successful refresh moves the published directory head");
    const rows = await must(service.from("sec_issuer_directory_entries").select("cik,ticker,issuer_name,exchange")
      .eq("snapshot_id", receipt.snapshotId), "read published directory entries");
    assert(JSON.stringify(rows) === JSON.stringify([{ cik, ticker: "DVFY", issuer_name: "Directory Verification Issuer", exchange: "NYSE" }]),
      "published directory entry retains normalized CIK and identity fields");
    const snapshot = await must(service.from("sec_issuer_directory_snapshots").select("retrieved_at,completed_at")
      .eq("id", receipt.snapshotId).single(), "read published directory snapshot times");
    const run = await must(service.from("core_source_runs").select("status,retrieved_at,completed_at,response_sha256,row_count")
      .eq("source_id", sourceId).eq("request_key", requestKey).single(), "read source receipt run");
    sourceRunIds.push((await must(service.from("core_source_runs").select("id").eq("source_id", sourceId).eq("request_key", requestKey).single(), "read source run id")).id);
    assert(run.status === "success" && run.response_sha256 === sourceDigest && run.row_count === 1,
      "directory source run persists its successful response receipt");
    assert(snapshot.completed_at === run.completed_at && Date.parse(snapshot.completed_at) >= Date.parse(run.retrieved_at),
      "directory snapshot completion time matches its published source run after retrieval");
    pass("enabled directory refresh publishes normalized entries and an exact source receipt");

    const replay = await invoke(requestKey);
    assert(replay.response.status === 200 && replay.body.state === "success" && fetchCalls === 1,
      "request-key replay returns its saved receipt without another source call");
    const current = await invoke(crypto.randomUUID());
    assert(current.response.status === 200 && current.body.state === "current" && fetchCalls === 1,
      "a fresh published directory avoids another source request");
    pass("directory replay and fresh-snapshot checks do not refetch the source");

    const staleSnapshotId = await publishStaleSnapshot();
    await clearReleasedDirectoryCooldown("clear released local directory refresh cooldown");
    mode = "invalid";
    const invalidKey = crypto.randomUUID();
    const invalid = await invoke(invalidKey);
    assert(invalid.response.status === 502 && invalid.body.error === "directory_invalid_shape",
      `malformed SEC directory response is rejected with a bounded failure code (http ${invalid.response.status}, error ${String(invalid.body.error)}, state ${String(invalid.body.state)})`);
    const retainedHead = await must(service.from("sec_issuer_directory_head").select("snapshot_id").eq("dataset", dataset).single(), "read directory head after parse failure");
    assert(retainedHead.snapshot_id === staleSnapshotId, "malformed response leaves the last-good directory head unchanged");
    const invalidRun = await must(service.from("core_source_runs").select("id,status,failure_code")
      .eq("source_id", sourceId).eq("request_key", invalidKey).single(), "read failed directory run");
    sourceRunIds.push(invalidRun.id);
    assert(invalidRun.status === "failed" && invalidRun.failure_code === "directory_invalid_shape", "malformed response is retained as a failed source receipt");
    pass("malformed directory response preserves the last-good snapshot and records failure");

    await clearReleasedDirectoryCooldown("clear released directory cooldown before retry-after test");
    mode = "unavailable";
    const unavailable = await invoke(crypto.randomUUID());
    assert(unavailable.response.status === 200 && unavailable.body.state === "rate_limited"
      && typeof unavailable.body.nextAllowedAt === "string", "SEC 503 retry-after becomes a bounded rate-limited state");
    const retryHead = await must(service.from("sec_issuer_directory_head").select("snapshot_id").eq("dataset", dataset).single(), "read head after 503");
    assert(retryHead.snapshot_id === staleSnapshotId, "SEC 503 leaves the last-good directory head unchanged");
    assert(fetchCalls === 3, "all directory source calls used the injected local transport");
    pass("directory rate limiting retains the previous snapshot without external requests");
  } finally {
    const cleanupMust = async (result: { error: { message: string; code?: string } | null }, what: string) => {
      if (result.error) throw new Error(`${what}: ${result.error.message} (${result.error.code ?? "no code"})`);
    };
    const { error: signOutError } = await user.auth.signOut();
    if (signOutError) throw new Error(`sign out directory verifier user: ${signOutError.message}`);
    if (userId) {
      const { error } = await service.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete local directory verifier user: ${error.message}`);
    }
    if (requestKeys.length) {
      const { data: runs, error } = await service.from("core_source_runs").select("id").eq("source_id", sourceId).in("request_key", requestKeys);
      if (error) throw new Error(`read directory verifier source runs before cleanup: ${error.message} (${error.code ?? "no code"})`);
      sourceRunIds.push(...(runs ?? []).map((run) => run.id));
    }
    const runIds = [...new Set(sourceRunIds)];
    if (runIds.length) {
      const { data: snapshots, error } = await service.from("sec_issuer_directory_snapshots").select("id").in("source_run_id", runIds);
      if (error) throw new Error(`read directory verifier snapshots before cleanup: ${error.message} (${error.code ?? "no code"})`);
      snapshotIds.push(...(snapshots ?? []).map((snapshot) => snapshot.id));
    }
    const allSnapshotIds = [...new Set(snapshotIds)];
    if (allSnapshotIds.length) {
      await cleanupMust(await service.from("sec_issuer_directory_head").delete()
        .eq("dataset", dataset).in("snapshot_id", allSnapshotIds), "delete verifier directory head");
    }
    if (allSnapshotIds.length) await cleanupMust(await service.from("sec_issuer_directory_entries").delete().in("snapshot_id", allSnapshotIds), "delete verifier directory entries");
    if (allSnapshotIds.length) await cleanupMust(await service.from("sec_issuer_directory_snapshots").delete().in("id", allSnapshotIds), "delete verifier directory snapshots");
    if (runIds.length) {
      await cleanupMust(await service.from("sec_source_payloads").delete().in("source_run_id", runIds), "delete verifier SEC payloads");
      await cleanupMust(await service.from("core_source_runs").delete().in("id", runIds), "delete directory verifier source runs");
    }
    await cleanupMust(await service.from("core_source_refresh_leases").delete()
      .eq("source_id", sourceId).is("lease_token", null), "delete released directory verifier refresh lease");

    const remainingHead = await service.from("sec_issuer_directory_head").select("dataset").eq("dataset", dataset);
    if (remainingHead.error) throw new Error(`verify directory head cleanup: ${remainingHead.error.message}`);
    assert((remainingHead.data ?? []).length === 0, "directory verifier head is removed");
    const remainingLease = await service.from("core_source_refresh_leases").select("source_id").eq("source_id", sourceId);
    if (remainingLease.error) throw new Error(`verify directory lease cleanup: ${remainingLease.error.message}`);
    assert((remainingLease.data ?? []).length === 0, "directory verifier refresh lease is removed");
    pass("directory fixture removes and verifies its refresh lease");
    if (userId) {
      const remainingUsers = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (remainingUsers.error) throw new Error(`verify directory user cleanup: ${remainingUsers.error.message}`);
      assert(!remainingUsers.data.users.some((user) => user.id === userId), "directory verifier user is removed");
    }
    if (allSnapshotIds.length) {
      const remainingSnapshots = await service.from("sec_issuer_directory_snapshots").select("id").in("id", allSnapshotIds);
      if (remainingSnapshots.error) throw new Error(`verify directory snapshot cleanup: ${remainingSnapshots.error.message}`);
      assert((remainingSnapshots.data ?? []).length === 0, "all directory verifier snapshots are removed");
      const remainingEntries = await service.from("sec_issuer_directory_entries").select("snapshot_id").in("snapshot_id", allSnapshotIds);
      if (remainingEntries.error) throw new Error(`verify directory entry cleanup: ${remainingEntries.error.message}`);
      assert((remainingEntries.data ?? []).length === 0, "all directory verifier entries are removed");
    }
    if (runIds.length) {
      const remainingRuns = await service.from("core_source_runs").select("id").in("id", runIds);
      if (remainingRuns.error) throw new Error(`verify directory source-run cleanup: ${remainingRuns.error.message}`);
      assert((remainingRuns.data ?? []).length === 0, "all directory verifier source runs are removed");
      const remainingPayloads = await service.from("sec_source_payloads").select("source_run_id").in("source_run_id", runIds);
      if (remainingPayloads.error) throw new Error(`verify directory payload cleanup: ${remainingPayloads.error.message}`);
      assert((remainingPayloads.data ?? []).length === 0, "all directory verifier SEC payloads are removed");
    }
  }
});
