import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { handle } from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
  console.log(`PASS ${message}`);
}

function sha256(value: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((bytes) =>
    [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("")
  );
}

Deno.test("company evidence Edge Function publishes fixture receipts and retains last-good snapshots", async () => {
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
    SEC_COMPANY_DATA_ENABLED: "true",
    SEC_USER_AGENT: "SentimentDesk local verification verifier@example.test",
    APP_ALLOWED_ORIGINS: "http://127.0.0.1:5173",
  })) Deno.env.set(key, value);

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const userIds: string[] = [];
  const requestKeys: string[] = [];
  const sourceRunIds: string[] = [];
  const directorySnapshotIds: string[] = [];
  const factsSnapshotIds: string[] = [];
  const submissionsSnapshotIds: string[] = [];
  const ciks = ["0000000009", "0000000010", "0000000011"];
  const ticker = `V${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  let activeMode = "success";
  let fetchCalls = 0;
  let authToken = "";

  async function must<T>(promise: Promise<{ data: T | null; error: { message: string; code?: string } | null }>, label: string): Promise<T> {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${result.error.message} (${result.error.code ?? "no code"})`);
    return result.data as T;
  }

  async function clearReleasedCompanyCooldown(label: string): Promise<void> {
    const sourceIds = ["sec_companyfacts", "sec_submissions"];
    const rows = await must(service.from("core_source_refresh_leases")
      .update({ next_allowed_at: new Date(Date.now() - 1000).toISOString() })
      .in("source_id", sourceIds).is("lease_token", null).select("source_id,lease_token"), label);
    assert(rows.length === sourceIds.length && rows.every((row) => row.lease_token === null),
      `${label}: only released CompanyFacts and submissions leases may have their cooldowns cleared`);
    console.log("PASS company cooldown reset updates only released leases");
  }

  async function createRun(sourceId: string, sourceUrl: string, rowCount: number, body: string, retrievedAt = new Date().toISOString()) {
    const runId = crypto.randomUUID();
    sourceRunIds.push(runId);
    const responseSha = await sha256(body);
    await must(service.from("core_source_runs").insert({ id: runId, request_key: crypto.randomUUID(), source_id: sourceId,
      source_url: sourceUrl, adapter_version: "verify-cloud-core-function/1", trigger_kind: "manual", status: "running", started_at: retrievedAt }), `insert ${sourceId} run`);
    await must(service.from("core_source_runs").update({ http_status: 200, retrieved_at: retrievedAt, response_sha256: responseSha,
      response_bytes: new TextEncoder().encode(body).byteLength, row_count: rowCount }).eq("id", runId), `record ${sourceId} response receipt`);
    return { id: runId, sha: responseSha, retrievedAt };
  }

  async function seedDirectoryAndIssuers(userId: string, reader: ReturnType<typeof createClient>) {
    const sourceUrl = "https://www.sec.gov/files/company_tickers_exchange.json";
    const entries = ciks.map((cik, index) => ({ cik, ticker: `${ticker}${index}`, name: `Verification Issuer ${index + 1}`, exchange: "Test Exchange" }));
    const body = JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: entries.map((row) => [Number(row.cik), row.name, row.ticker, row.exchange]) });
    const run = await createRun("sec_company_tickers_exchange", sourceUrl, entries.length, body);
    await must(service.from("sec_source_payloads").insert({ source_run_id: run.id, response_sha256: run.sha, response_body: body }), "store directory payload");
    const snapshotId = crypto.randomUUID();
    directorySnapshotIds.push(snapshotId);
    await must(service.from("sec_issuer_directory_snapshots").insert({ id: snapshotId, source_run_id: run.id,
      source_id: "sec_company_tickers_exchange", source_url: sourceUrl, source_response_sha256: run.sha,
      parser_version: "verify-cloud-core-function/1", retrieved_at: run.retrievedAt, completed_at: null, row_count: entries.length }), "create staged directory snapshot");
    const entryRows = await Promise.all(entries.map(async (entry) => ({ snapshot_id: snapshotId, cik: entry.cik,
      ticker: entry.ticker, issuer_name: entry.name, exchange: entry.exchange,
      source_row_sha256: await sha256(JSON.stringify(entry)) })));
    await must(service.from("sec_issuer_directory_entries").insert(entryRows), "insert directory entries");
    const stagedSnapshot = await must(reader.from("sec_issuer_directory_snapshots").select("id").eq("id", snapshotId), "read staged directory snapshot as authenticated user");
    const stagedEntries = await must(reader.from("sec_issuer_directory_entries").select("cik").eq("snapshot_id", snapshotId), "read staged directory entries as authenticated user");
    assert(stagedSnapshot.length === 0 && stagedEntries.length === 0, "authenticated users cannot read staged directory records");
    await must(service.rpc("publish_sec_issuer_directory_snapshot", { p_snapshot_id: snapshotId, p_expected_rows: entries.length }), "publish directory snapshot");
    const publishedSnapshot = await must(reader.from("sec_issuer_directory_snapshots").select("id").eq("id", snapshotId), "read published directory snapshot as authenticated user");
    assert(publishedSnapshot.length === 1, "authenticated users can read the directory snapshot after publication");
    console.log("PASS directory snapshot and entries become visible only after publication");
    for (const [index, entry] of entries.entries()) {
      await must(service.from("user_research_issuers").insert({ user_id: userId, cik: entry.cik, ticker: entry.ticker,
        issuer_name: entry.name, exchange: entry.exchange, selected_snapshot_id: snapshotId }).select("id").single(), `save issuer ${index + 1}`);
    }
  }

  async function seedOldFacts(cik: string, reader: ReturnType<typeof createClient>) {
    const sourceUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const retrievedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const run = await createRun("sec_companyfacts", sourceUrl, 1, `old-facts-${cik}`, retrievedAt);
    const snapshotId = crypto.randomUUID();
    factsSnapshotIds.push(snapshotId);
    await must(service.from("sec_companyfacts_snapshots").insert({ id: snapshotId, source_run_id: run.id, source_id: "sec_companyfacts",
      cik, source_response_sha256: run.sha, source_url: sourceUrl, retrieved_at: retrievedAt, completed_at: null,
      fact_count: 1, parser_version: "verify-cloud-core-function/1" }), "seed staged CompanyFacts snapshot");
    await must(service.from("sec_company_fact_values").insert({ snapshot_id: snapshotId, cik, taxonomy: "us-gaap",
      concept: "Revenues", unit: "USD", value_text: "41", period_start: "2025-01-01", period_end: "2025-12-31",
      filed_at: "2026-02-01", form: "10-K", accession: `${cik}-26-000001` }), "seed last-good CompanyFacts row");
    const stagedSnapshot = await must(reader.from("sec_companyfacts_snapshots").select("id").eq("id", snapshotId), "read staged CompanyFacts snapshot as authenticated user");
    const stagedFacts = await must(reader.from("sec_company_fact_values").select("id").eq("snapshot_id", snapshotId), "read staged CompanyFacts rows as authenticated user");
    assert(stagedSnapshot.length === 0 && stagedFacts.length === 0, "authenticated users cannot read staged CompanyFacts records");
    await must(service.rpc("publish_sec_companyfacts_snapshot", { p_snapshot_id: snapshotId, p_expected_facts: 1 }), "publish last-good CompanyFacts snapshot");
    const publishedSnapshot = await must(reader.from("sec_companyfacts_snapshots").select("id").eq("id", snapshotId), "read published CompanyFacts snapshot as authenticated user");
    const publishedFacts = await must(reader.from("sec_company_fact_values").select("id").eq("snapshot_id", snapshotId), "read published CompanyFacts rows as authenticated user");
    assert(publishedSnapshot.length === 1 && publishedFacts.length === 1, "CompanyFacts records become visible after publication");
    console.log("PASS CompanyFacts snapshots and rows become visible only after publication");
    return snapshotId;
  }

  async function seedOldSubmissions(cik: string, reader: ReturnType<typeof createClient>) {
    const sourceUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const retrievedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const run = await createRun("sec_submissions", sourceUrl, 1, `old-submissions-${cik}`, retrievedAt);
    const snapshotId = crypto.randomUUID();
    submissionsSnapshotIds.push(snapshotId);
    await must(service.from("sec_submissions_snapshots").insert({ id: snapshotId, source_run_id: run.id, source_id: "sec_submissions",
      cik, source_response_sha256: run.sha, source_url: sourceUrl, retrieved_at: retrievedAt, completed_at: null,
      filing_count: 1, parser_version: "verify-cloud-core-function/1" }), "seed staged submissions snapshot");
    const accession = `${cik}-26-000001`;
    await must(service.from("sec_filing_observations").insert({ snapshot_id: snapshotId, cik, accession, form: "10-K",
      filed_at: "2026-02-01", report_period: "2025-12-31", accepted_at: "2026-02-01T20:00:00Z", primary_document: "old.htm",
      source_url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/old.htm`, retrieved_at: retrievedAt }),
    "seed last-good filing row");
    const stagedSnapshot = await must(reader.from("sec_submissions_snapshots").select("id").eq("id", snapshotId), "read staged submissions snapshot as authenticated user");
    const stagedFilings = await must(reader.from("sec_filing_observations").select("id").eq("snapshot_id", snapshotId), "read staged filing rows as authenticated user");
    assert(stagedSnapshot.length === 0 && stagedFilings.length === 0, "authenticated users cannot read staged submissions records");
    await must(service.rpc("publish_sec_submissions_snapshot", { p_snapshot_id: snapshotId, p_expected_filings: 1 }), "publish last-good submissions snapshot");
    const publishedSnapshot = await must(reader.from("sec_submissions_snapshots").select("id").eq("id", snapshotId), "read published submissions snapshot as authenticated user");
    const publishedFilings = await must(reader.from("sec_filing_observations").select("id").eq("snapshot_id", snapshotId), "read published filing rows as authenticated user");
    assert(publishedSnapshot.length === 1 && publishedFilings.length === 1, "submissions records become visible after publication");
    console.log("PASS submissions snapshots and filing rows become visible only after publication");
    return snapshotId;
  }

  function responseFixture(urlValue: string | URL | Request, init?: RequestInit): Promise<Response> {
    fetchCalls += 1;
    const requestUrl = urlValue instanceof Request ? urlValue.url : urlValue.toString();
    const url = new URL(requestUrl);
    assert(url.hostname === "data.sec.gov", "only the intercepted SEC fixture host may be requested");
    assert(new Headers(init?.headers).get("User-Agent")?.includes("SentimentDesk local verification"), "function sends its configured User-Agent");
    const cik = url.pathname.match(/CIK([0-9]{10})\.json$/)?.[1];
    assert(cik, "function requests an exact CIK endpoint");
    const isFacts = url.pathname.includes("/companyfacts/");
    if (activeMode === "partial" && cik === ciks[1] && isFacts) return Promise.resolve(new Response("", { status: 503 }));
    if (activeMode === "failed" && cik === ciks[2]) return Promise.resolve(new Response("", { status: 503 }));
    const accession = `${cik === ciks[0] ? "0001193125" : cik}-26-000002`;
    const body = isFacts ? JSON.stringify({ cik: Number(cik), facts: { "us-gaap": { Revenues: { units: { USD: [
      { val: 42.125, form: "10-K", accn: accession, start: "2025-01-01", end: "2025-12-31", filed: "2026-03-15", fy: 2025, fp: "FY" },
    ] } } } } }) : JSON.stringify({ cik: Number(cik), filings: { recent: {
      accessionNumber: [accession], form: ["10-K"], filingDate: ["2026-03-15"], reportDate: ["2025-12-31"],
      acceptanceDateTime: ["2026-03-15T20:00:00.000Z"], primaryDocument: ["verification.htm"],
    } } });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  }

  async function invoke(cik: string, requestKey: string, fetchImpl = responseFixture): Promise<{ response: Response; body: Record<string, unknown> }> {
    requestKeys.push(requestKey);
    const response = await handle(new Request("http://local.test/refresh-sec-company-evidence", {
      method: "POST", headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ cik, requestKey }),
    }), fetchImpl);
    return { response, body: await response.json() as Record<string, unknown> };
  }

  const [existingDirectoryHead, existingFactsHeads, existingSubmissionsHeads, existingLeases] = await Promise.all([
    service.from("sec_issuer_directory_head").select("snapshot_id").eq("dataset", "company_tickers_exchange"),
    service.from("sec_companyfacts_head").select("cik").in("cik", ciks),
    service.from("sec_submissions_head").select("cik").in("cik", ciks),
    service.from("core_source_refresh_leases").select("source_id").in("source_id", ["sec_companyfacts", "sec_submissions"]),
  ]);
  for (const [result, label] of [
    [existingDirectoryHead, "check existing issuer-directory head"],
    [existingFactsHeads, "check existing CompanyFacts heads"],
    [existingSubmissionsHeads, "check existing submissions heads"],
    [existingLeases, "check existing company refresh leases"],
  ] as const) {
    if (result.error) throw new Error(`${label}: ${result.error.message} (${result.error.code ?? "no code"})`);
  }
  assert(existingDirectoryHead.data.length === 0 && existingFactsHeads.data.length === 0
    && existingSubmissionsHeads.data.length === 0 && existingLeases.data.length === 0,
  "company function fixture requires empty source heads and leases; run it only against a disposable local database");

  try {
    const email = `cloud-function-${crypto.randomUUID()}@example.test`;
    const password = `T9!${crypto.randomUUID()}Zz`;
    const { data: created, error: createError } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (createError || !created.user) throw new Error(`create local function verifier user: ${createError?.message ?? "missing user"}`);
    userIds.push(created.user.id);
    const user = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: signedIn, error: signInError } = await user.auth.signInWithPassword({ email, password });
    if (signInError || !signedIn.session) throw new Error(`sign in local function verifier user: ${signInError?.message ?? "missing session"}`);
    authToken = signedIn.session.access_token;
    await seedDirectoryAndIssuers(created.user.id, user);

    Deno.env.set("SEC_COMPANY_DATA_ENABLED", "false");
    const disabled = await invoke(ciks[0], crypto.randomUUID());
    assert(disabled.response.status === 503 && disabled.body.error === "sec_company_data_not_enabled" && fetchCalls === 0,
      "closed company-data source gate blocks transport after authentication");
    console.log("PASS company-data source gate blocks transport while disabled");
    Deno.env.set("SEC_COMPANY_DATA_ENABLED", "true");

    const successKey = crypto.randomUUID();
    const successful = await invoke(ciks[0], successKey);
    assert(successful.response.status === 200 && successful.body.state === "ready",
      `enabled local function publishes both SEC source snapshots (http ${successful.response.status}, state ${String(successful.body.state)}, facts ${JSON.stringify(successful.body.facts)}, submissions ${JSON.stringify(successful.body.submissions)})`);
    const fetchCountAfterSuccess = fetchCalls;
    assert(fetchCountAfterSuccess === 2, "successful refresh requests only the two fixed SEC endpoints");
    const successFacts = successful.body.facts as { receipt: { snapshotId: string } };
    const successSubmissions = successful.body.submissions as { receipt: { snapshotId: string } };
    const factsSnapshot = await must(service.from("sec_companyfacts_snapshots").select("retrieved_at,completed_at")
      .eq("id", successFacts.receipt.snapshotId).single(), "read published CompanyFacts snapshot times");
    const factsRun = await must(service.from("core_source_runs").select("retrieved_at,completed_at")
      .eq("source_id", "sec_companyfacts").eq("request_key", successKey).single(), "read published CompanyFacts run times");
    assert(factsSnapshot.completed_at === factsRun.completed_at && Date.parse(factsSnapshot.completed_at) >= Date.parse(factsRun.retrieved_at),
      "CompanyFacts snapshot completion time matches its published source run after retrieval");
    const submissionsSnapshot = await must(service.from("sec_submissions_snapshots").select("retrieved_at,completed_at")
      .eq("id", successSubmissions.receipt.snapshotId).single(), "read published submissions snapshot times");
    const submissionsRun = await must(service.from("core_source_runs").select("retrieved_at,completed_at")
      .eq("source_id", "sec_submissions").eq("request_key", successKey).single(), "read published submissions run times");
    assert(submissionsSnapshot.completed_at === submissionsRun.completed_at
      && Date.parse(submissionsSnapshot.completed_at) >= Date.parse(submissionsRun.retrieved_at),
    "submissions snapshot completion time matches its published source run after retrieval");
    const headsAfterSuccess = await must(service.from("sec_companyfacts_head").select("snapshot_id").eq("cik", ciks[0]).single(), "read refreshed facts head");
    assert(headsAfterSuccess.snapshot_id === successFacts.receipt.snapshotId, "CompanyFacts publication moves the matching CIK head");
    const submissionsHeadAfterSuccess = await must(service.from("sec_submissions_head").select("snapshot_id").eq("cik", ciks[0]).single(), "read refreshed submissions head");
    assert(submissionsHeadAfterSuccess.snapshot_id === successSubmissions.receipt.snapshotId, "submissions publication moves the matching CIK head");
    console.log("PASS enabled company refresh writes source receipts, snapshots, and exact CIK heads");
    const replay = await invoke(ciks[0], successKey);
    assert(replay.body.state === "ready" && fetchCalls === fetchCountAfterSuccess, "replayed request reuses saved receipts without another SEC fetch");
    console.log("PASS company refresh request key is idempotent at the Edge Function boundary");
    const freshSnapshot = await invoke(ciks[0], crypto.randomUUID());
    assert(freshSnapshot.body.state === "ready" && fetchCalls === fetchCountAfterSuccess,
      "a fresh published company snapshot is reused for a new request key without another SEC fetch");
    console.log("PASS fresh CompanyFacts and submissions snapshots are reused without another SEC fetch");

    const oldFacts = await seedOldFacts(ciks[1], user);
    const oldSubmissions = await seedOldSubmissions(ciks[1], user);
    await clearReleasedCompanyCooldown("clear released company refresh cooldowns");
    activeMode = "partial";
    const partial = await invoke(ciks[1], crypto.randomUUID());
    assert(partial.body.state === "partial", "one successful source produces an explicit partial refresh");
    assert((partial.body.facts as { state: string }).state === "failed", "failed CompanyFacts source is reported independently");
    assert((partial.body.submissions as { state: string }).state === "ready", "successful submissions source is reported independently");
    const retainedFacts = await must(service.from("sec_companyfacts_head").select("snapshot_id").eq("cik", ciks[1]).single(), "read retained facts head");
    assert(retainedFacts.snapshot_id === oldFacts, "failed facts refresh retains the last-good source head");
    const advancedSubmissions = await must(service.from("sec_submissions_head").select("snapshot_id").eq("cik", ciks[1]).single(), "read refreshed submissions head");
    assert(advancedSubmissions.snapshot_id !== oldSubmissions, "successful submissions refresh publishes its new source head");
    console.log("PASS partial refresh retains the failed source head and publishes the successful source");

    const failedFacts = await seedOldFacts(ciks[2], user);
    const failedSubmissions = await seedOldSubmissions(ciks[2], user);
    await clearReleasedCompanyCooldown("clear released company cooldowns before full failure");
    activeMode = "failed";
    const failed = await invoke(ciks[2], crypto.randomUUID());
    assert(failed.body.state === "failed", "two failed sources produce an explicit failed refresh");
    const retainedFailedFacts = await must(service.from("sec_companyfacts_head").select("snapshot_id").eq("cik", ciks[2]).single(), "read facts head after failed refresh");
    const retainedFailedSubmissions = await must(service.from("sec_submissions_head").select("snapshot_id").eq("cik", ciks[2]).single(), "read submissions head after failed refresh");
    assert(retainedFailedFacts.snapshot_id === failedFacts && retainedFailedSubmissions.snapshot_id === failedSubmissions,
      "fully failed refresh retains both last-good source heads");
    console.log("PASS fully failed refresh leaves both last-good source heads unchanged");
    assert(fetchCalls === 6, "all source fetches were intercepted by the local fixture transport");
    console.log("PASS company Edge Function made no external network request");
    await user.auth.signOut();
  } finally {
    const cleanupMust = async (result: { error: { message: string; code?: string } | null }, what: string) => {
      if (result.error) throw new Error(`${what}: ${result.error.message} (${result.error.code ?? "no code"})`);
    };
    for (const userId of userIds) {
      const { error } = await service.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete local function verifier user: ${error.message}`);
    }
    if (userIds.length) {
      const remainingUsers = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (remainingUsers.error) throw new Error(`verify company function user cleanup: ${remainingUsers.error.message}`);
      assert(!remainingUsers.data.users.some((user) => userIds.includes(user.id)), "company function verifier users are removed");
    }
    await cleanupMust(await service.from("sec_companyfacts_head").delete().in("cik", ciks), "delete verifier CompanyFacts heads");
    await cleanupMust(await service.from("sec_submissions_head").delete().in("cik", ciks), "delete verifier submissions heads");
    if (directorySnapshotIds.length) await cleanupMust(await service.from("sec_issuer_directory_head").delete()
      .eq("dataset", "company_tickers_exchange").in("snapshot_id", directorySnapshotIds), "delete verifier directory head");
    if (requestKeys.length) {
      const { data: runs, error } = await service.from("core_source_runs").select("id").in("request_key", requestKeys);
      if (error) throw new Error(`read verifier source runs before cleanup: ${error.message} (${error.code ?? "no code"})`);
      sourceRunIds.push(...(runs ?? []).map((run) => run.id));
    }
    const runIds = [...new Set(sourceRunIds)];
    if (runIds.length) {
      for (const [table, ids] of [
        ["sec_issuer_directory_snapshots", directorySnapshotIds],
        ["sec_companyfacts_snapshots", factsSnapshotIds],
        ["sec_submissions_snapshots", submissionsSnapshotIds],
      ] as const) {
        const { data: snapshots, error } = await service.from(table).select("id").in("source_run_id", runIds);
        if (error) throw new Error(`read verifier ${table} before cleanup: ${error.message} (${error.code ?? "no code"})`);
        ids.push(...(snapshots ?? []).map((snapshot) => snapshot.id));
      }
    }
    const allDirectorySnapshotIds = [...new Set(directorySnapshotIds)];
    const allFactsSnapshotIds = [...new Set(factsSnapshotIds)];
    const allSubmissionsSnapshotIds = [...new Set(submissionsSnapshotIds)];
    if (allDirectorySnapshotIds.length) await cleanupMust(await service.from("sec_issuer_directory_entries").delete().in("snapshot_id", allDirectorySnapshotIds), "delete verifier directory entries");
    if (allFactsSnapshotIds.length) await cleanupMust(await service.from("sec_company_fact_values").delete().in("snapshot_id", allFactsSnapshotIds), "delete verifier fact rows");
    if (allSubmissionsSnapshotIds.length) await cleanupMust(await service.from("sec_filing_observations").delete().in("snapshot_id", allSubmissionsSnapshotIds), "delete verifier filing rows");
    if (allDirectorySnapshotIds.length) await cleanupMust(await service.from("sec_issuer_directory_snapshots").delete().in("id", allDirectorySnapshotIds), "delete verifier directory snapshots");
    if (allFactsSnapshotIds.length) await cleanupMust(await service.from("sec_companyfacts_snapshots").delete().in("id", allFactsSnapshotIds), "delete verifier CompanyFacts snapshots");
    if (allSubmissionsSnapshotIds.length) await cleanupMust(await service.from("sec_submissions_snapshots").delete().in("id", allSubmissionsSnapshotIds), "delete verifier submissions snapshots");
    if (requestKeys.length) {
      await cleanupMust(await service.from("sec_source_payloads").delete().in("source_run_id", runIds), "delete verifier SEC payloads");
      await cleanupMust(await service.from("core_source_runs").delete().in("id", runIds), "delete verifier source runs");
    }
    await cleanupMust(await service.from("core_source_refresh_leases").delete()
      .in("source_id", ["sec_companyfacts", "sec_submissions"]).is("lease_token", null), "delete released verifier refresh leases");
    const remainingRuns = await service.from("core_source_runs").select("id").in("id", runIds);
    if (remainingRuns.error) throw new Error(`verify source run cleanup: ${remainingRuns.error.message}`);
    assert((remainingRuns.data ?? []).length === 0, "all company evidence verifier source runs are removed");
    const remainingDirectoryHead = await service.from("sec_issuer_directory_head").select("dataset").eq("dataset", "company_tickers_exchange");
    if (remainingDirectoryHead.error) throw new Error(`verify company directory head cleanup: ${remainingDirectoryHead.error.message}`);
    assert((remainingDirectoryHead.data ?? []).length === 0, "company verifier directory head is removed");
    const remainingLeases = await service.from("core_source_refresh_leases").select("source_id").in("source_id", ["sec_companyfacts", "sec_submissions"]);
    if (remainingLeases.error) throw new Error(`verify company refresh lease cleanup: ${remainingLeases.error.message}`);
    assert((remainingLeases.data ?? []).length === 0, "company verifier refresh leases are removed");
    console.log("PASS company fixture removed released leases and preserved active leases");
  }
});
