import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const startedAt = new Date().toISOString();
const runId = randomUUID();
const checks = [];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const supabaseProjectDir = process.env.SENTIMENT_DESK_SUPABASE_PROJECT_DIR ?? repoRoot;
const local = JSON.parse(execFileSync("supabase", ["--workdir", supabaseProjectDir, "status", "-o", "json"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const url = local.API_URL;
const publicKey = local.PUBLISHABLE_KEY ?? local.ANON_KEY;
const serviceKey = local.SERVICE_ROLE_KEY;
assert.equal(new URL(url).hostname, "127.0.0.1", "refusing to run against a non-local Supabase URL");
assert.equal(new URL(url).port, process.env.SENTIMENT_DESK_SUPABASE_API_PORT ?? "54321", "refusing to run against an unexpected API port");
assert.ok(publicKey && serviceKey, "local Supabase public and service keys must be available");

const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anonymous = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
const userIds = [];
const sourceRunIds = [];
const sourceSnapshotIds = { directory: [], facts: [], submissions: [] };
const sourceRowIds = { entries: [], facts: [], filings: [] };
const cik = "0000000002";
const otherCik = "0000000003";
const ticker = "TSTX";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function pass(message) { checks.push(message); console.log(`PASS ${message}`); }
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); pass(message); }
async function mustNoError(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message} (${result.error.code ?? "no code"})`);
  return result.data;
}
async function retryRead(read, what) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await read();
      if (!result.error) return result.data;
      lastError = result.error;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
async function sourceRun(sourceId, sourceUrl, rowCount, bodyText) {
  const id = randomUUID();
  const responseSha = digest(bodyText);
  const retrievedAt = new Date().toISOString();
  sourceRunIds.push(id);
  await mustNoError(await service.from("core_source_runs").insert({ id, request_key: randomUUID(), source_id: sourceId,
    source_url: sourceUrl, adapter_version: "verify-cloud-core/1", trigger_kind: "manual", status: "running", started_at: retrievedAt }), `create ${sourceId} run`);
  await mustNoError(await service.from("core_source_runs").update({ http_status: 200, retrieved_at: retrievedAt,
    response_sha256: responseSha, response_bytes: Buffer.byteLength(bodyText), row_count: rowCount }).eq("id", id), `record ${sourceId} receipt`);
  return { id, responseSha, retrievedAt };
}
async function createDirectorySnapshot() {
  const bodyText = JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [[2, "Test Issuer Limited", ticker, "Test Exchange"]] });
  const receipt = await sourceRun("sec_company_tickers_exchange", "https://www.sec.gov/files/company_tickers_exchange.json", 1, bodyText);
  const snapshotId = randomUUID();
  sourceSnapshotIds.directory.push(snapshotId);
  await mustNoError(await service.from("sec_source_payloads").insert({ source_run_id: receipt.id,
    response_sha256: receipt.responseSha, response_body: bodyText }), "store source response");
  await mustNoError(await service.from("sec_issuer_directory_snapshots").insert({ id: snapshotId, source_run_id: receipt.id,
    source_id: "sec_company_tickers_exchange", source_url: "https://www.sec.gov/files/company_tickers_exchange.json",
    source_response_sha256: receipt.responseSha, parser_version: "verify-cloud-core/1", retrieved_at: receipt.retrievedAt,
    completed_at: null, row_count: 1 }), "create staged directory snapshot");
  const entryId = randomUUID();
  sourceRowIds.entries.push(entryId);
  await mustNoError(await service.from("sec_issuer_directory_entries").insert({ snapshot_id: snapshotId, cik,
    ticker, issuer_name: "Test Issuer Limited", exchange: "Test Exchange", source_row_sha256: digest("directory-row") }), "create issuer row");
  await mustNoError(await service.rpc("publish_sec_issuer_directory_snapshot", { p_snapshot_id: snapshotId, p_expected_rows: 1 }), "publish SEC directory snapshot");
  const snapshot = await mustNoError(await service.from("sec_issuer_directory_snapshots").select("completed_at")
    .eq("id", snapshotId).single(), "read published directory snapshot time");
  const run = await mustNoError(await service.from("core_source_runs").select("completed_at,retrieved_at")
    .eq("id", receipt.id).single(), "read published directory run time");
  eq(snapshot.completed_at, run.completed_at, "directory snapshot and source run share the database publication time");
  assert.ok(Date.parse(snapshot.completed_at) >= Date.parse(run.retrieved_at), "directory publication follows source retrieval");
  pass("directory completion timestamp is assigned atomically at publication");
  return snapshotId;
}
async function publishFacts(targetCik, factValue, beforePublish) {
  const sourceUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${targetCik}.json`;
  const bodyText = JSON.stringify({ facts: { "us-gaap": { Revenues: { units: { USD: [{ val: factValue }] } } } } });
  const receipt = await sourceRun("sec_companyfacts", sourceUrl, 1, bodyText);
  const snapshotId = randomUUID();
  sourceSnapshotIds.facts.push(snapshotId);
  await mustNoError(await service.from("sec_companyfacts_snapshots").insert({ id: snapshotId, source_run_id: receipt.id,
    source_id: "sec_companyfacts", cik: targetCik, source_response_sha256: receipt.responseSha, source_url: sourceUrl,
    retrieved_at: receipt.retrievedAt, completed_at: null, fact_count: 1, parser_version: "verify-cloud-core/1" }), "create staged CompanyFacts snapshot");
  const mismatchedCik = targetCik === cik ? otherCik : cik;
  const wrongAccession = await service.from("sec_company_fact_values").insert({ id: randomUUID(), snapshot_id: snapshotId, cik: targetCik,
    taxonomy: "us-gaap", concept: "Revenues", unit: "USD", value_text: String(factValue), period_start: "2025-01-01",
    period_end: "2025-12-31", filed_at: "2026-02-01", form: "10-K", accession: `${mismatchedCik}-26-000099` });
  eq(wrongAccession.error?.code, "23514", "CompanyFacts rows reject an accession from another CIK");
  const { data, error } = await service.from("sec_company_fact_values").insert({ id: randomUUID(), snapshot_id: snapshotId, cik: targetCik,
    taxonomy: "us-gaap", concept: "Revenues", unit: "USD", value_text: String(factValue), period_start: "2025-01-01",
    period_end: "2025-12-31", filed_at: "2026-02-01", form: "10-K", accession: `${String(Number(targetCik)).padStart(10, "0")}-26-000001`,
    fiscal_year: 2025, fiscal_period: "FY", reported_decimals: "-6", frame: "CY2025" }).select("id").single();
  if (error) throw new Error(`insert CompanyFacts row: ${error.message} (${error.code})`);
  sourceRowIds.facts.push(data.id);
  if (beforePublish) await beforePublish({ snapshotId, retrievedAt: receipt.retrievedAt });
  await mustNoError(await service.rpc("publish_sec_companyfacts_snapshot", { p_snapshot_id: snapshotId, p_expected_facts: 1 }), "publish CompanyFacts snapshot");
  const publishedRun = await mustNoError(await service.from("core_source_runs").select("status,retrieved_at,completed_at")
    .eq("id", receipt.id).single(), "read CompanyFacts source run receipt");
  eq(publishedRun.status, "success", "CompanyFacts source receipt publishes before research decisions can reference it");
  const publishedSnapshot = await mustNoError(await service.from("sec_companyfacts_snapshots").select("completed_at")
    .eq("id", snapshotId).single(), "read published CompanyFacts snapshot time");
  eq(publishedSnapshot.completed_at, publishedRun.completed_at, "CompanyFacts snapshot and source run share the database publication time");
  assert.ok(Date.parse(publishedSnapshot.completed_at) >= Date.parse(publishedRun.retrieved_at), "CompanyFacts publication follows source retrieval");
  pass("CompanyFacts completion timestamp is assigned atomically at publication");
  return snapshotId;
}
async function publishSubmissions(targetCik, records, beforePublish) {
  const sourceUrl = `https://data.sec.gov/submissions/CIK${targetCik}.json`;
  const bodyText = JSON.stringify({ filings: records });
  const receipt = await sourceRun("sec_submissions", sourceUrl, records.length, bodyText);
  const snapshotId = randomUUID();
  sourceSnapshotIds.submissions.push(snapshotId);
  await mustNoError(await service.from("sec_submissions_snapshots").insert({ id: snapshotId, source_run_id: receipt.id,
    source_id: "sec_submissions", cik: targetCik, source_response_sha256: receipt.responseSha, source_url: sourceUrl,
    retrieved_at: receipt.retrievedAt, completed_at: null, filing_count: records.length, parser_version: "verify-cloud-core/1" }), "create staged submissions snapshot");
  const wrongCik = targetCik === cik ? otherCik : cik;
  const wrongAccession = `${wrongCik}-26-000099`;
  const mismatchRow = await service.from("sec_filing_observations").insert({ id: randomUUID(), snapshot_id: snapshotId, cik: targetCik,
    accession: wrongAccession, form: "10-K", filed_at: "2026-02-01", source_url: `https://www.sec.gov/Archives/edgar/data/${Number(targetCik)}/${wrongAccession.replaceAll("-", "")}/wrong.htm`,
    retrieved_at: receipt.retrievedAt });
  eq(mismatchRow.error?.code, "23514", "filing observations reject an accession from another CIK");
  const rows = records.map((record) => ({ id: randomUUID(), snapshot_id: snapshotId, cik: targetCik, ...record, retrieved_at: receipt.retrievedAt }));
  const { data, error } = await service.from("sec_filing_observations").insert(rows).select("id");
  if (error) throw new Error(`insert SEC filing rows: ${error.message} (${error.code})`);
  sourceRowIds.filings.push(...data.map((row) => row.id));
  if (beforePublish) await beforePublish({ snapshotId, retrievedAt: receipt.retrievedAt });
  await mustNoError(await service.rpc("publish_sec_submissions_snapshot", { p_snapshot_id: snapshotId, p_expected_filings: records.length }), "publish submissions snapshot");
  const publishedRun = await mustNoError(await service.from("core_source_runs").select("retrieved_at,completed_at")
    .eq("id", receipt.id).single(), "read submissions source run time");
  const publishedSnapshot = await mustNoError(await service.from("sec_submissions_snapshots").select("completed_at")
    .eq("id", snapshotId).single(), "read published submissions snapshot time");
  eq(publishedSnapshot.completed_at, publishedRun.completed_at, "submissions snapshot and source run share the database publication time");
  assert.ok(Date.parse(publishedSnapshot.completed_at) >= Date.parse(publishedRun.retrieved_at), "submissions publication follows source retrieval");
  pass("submissions completion timestamp is assigned atomically at publication");
  return snapshotId;
}
function filing(accession, filedAt) {
  const primary = `filing-${accession.slice(-6)}.htm`;
  const compact = accession.replaceAll("-", "");
  return { accession, form: "10-K", filed_at: filedAt, report_period: "2025-12-31", accepted_at: `${filedAt}T20:00:00Z`,
    primary_document: primary, source_url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${compact}/${primary}` };
}

async function cleanup() {
  const trackedRunIds = [...new Set(sourceRunIds)];
  for (const id of userIds) {
    const { error } = await service.auth.admin.deleteUser(id);
    if (error) throw new Error(`delete cloud-core verifier user: ${error.message}`);
  }
  if (sourceSnapshotIds.directory.length) await mustNoError(await service.from("sec_issuer_directory_head").delete().eq("snapshot_id", sourceSnapshotIds.directory[0]), "delete verifier directory head");
  if (sourceSnapshotIds.facts.length) await mustNoError(await service.from("sec_companyfacts_head").delete().in("snapshot_id", sourceSnapshotIds.facts), "delete verifier facts heads");
  if (sourceSnapshotIds.submissions.length) await mustNoError(await service.from("sec_submissions_head").delete().in("snapshot_id", sourceSnapshotIds.submissions), "delete verifier submissions heads");
  if (sourceSnapshotIds.directory.length) await mustNoError(await service.from("sec_issuer_directory_entries").delete().in("snapshot_id", sourceSnapshotIds.directory), "delete verifier directory rows");
  if (sourceSnapshotIds.facts.length) await mustNoError(await service.from("sec_company_fact_values").delete().in("snapshot_id", sourceSnapshotIds.facts), "delete verifier facts rows");
  if (sourceSnapshotIds.submissions.length) await mustNoError(await service.from("sec_filing_observations").delete().in("snapshot_id", sourceSnapshotIds.submissions), "delete verifier filing rows");
  if (sourceSnapshotIds.directory.length) await mustNoError(await service.from("sec_issuer_directory_snapshots").delete().in("id", sourceSnapshotIds.directory), "delete verifier directory snapshots");
  if (sourceSnapshotIds.facts.length) await mustNoError(await service.from("sec_companyfacts_snapshots").delete().in("id", sourceSnapshotIds.facts), "delete verifier facts snapshots");
  if (sourceSnapshotIds.submissions.length) await mustNoError(await service.from("sec_submissions_snapshots").delete().in("id", sourceSnapshotIds.submissions), "delete verifier submissions snapshots");
  if (trackedRunIds.length) {
    await mustNoError(await service.from("sec_source_payloads").delete().in("source_run_id", trackedRunIds), "delete verifier SEC payloads");
    await mustNoError(await service.from("core_source_runs").delete().in("id", trackedRunIds), "delete verifier source runs");
    const remainingRuns = await mustNoError(await service.from("core_source_runs").select("id").in("id", trackedRunIds), "verify verifier source-run cleanup");
    assert.equal(remainingRuns.length, 0, "all cloud-core verifier source runs are removed");
  }
  if (userIds.length) {
    const remainingUsers = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (remainingUsers.error) throw new Error(`verify cloud-core user cleanup: ${remainingUsers.error.message}`);
    assert.ok(!remainingUsers.data.users.some((user) => userIds.includes(user.id)), "all cloud-core verifier users are removed");
  }
  for (const [table, ids] of Object.entries(sourceSnapshotIds)) {
    if (!ids.length) continue;
    const tableName = table === "directory" ? "sec_issuer_directory_snapshots" : table === "facts" ? "sec_companyfacts_snapshots" : "sec_submissions_snapshots";
    const remainingSnapshots = await mustNoError(await service.from(tableName).select("id").in("id", ids), `verify verifier ${table} snapshot cleanup`);
    assert.equal(remainingSnapshots.length, 0, `all cloud-core verifier ${table} snapshots are removed`);
  }
}

let testUsers = [];
try {
  for (const [index, name] of ["primary", "isolated"].entries()) {
    const email = `cloud-core-${randomUUID()}@example.test`;
    const password = `T9!${randomUUID()}Zz`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`create test user ${name}: ${error?.message ?? "missing user"}`);
    userIds.push(data.user.id);
    const client = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error(`sign in test user ${name}: ${signedIn.error.message}`);
    testUsers.push({ client, userId: data.user.id });
    pass(`create authenticated user ${name}`);
  }

  const emptyHead = await service.from("sec_issuer_directory_head").select("dataset").limit(1);
  assert.deepEqual(emptyHead.data, [], "verification requires a fresh local source database");
  const existingCoreHeads = await Promise.all([
    service.from("sec_companyfacts_head").select("cik").in("cik", [cik, otherCik]),
    service.from("sec_submissions_head").select("cik").eq("cik", cik),
  ]);
  assert.deepEqual(existingCoreHeads.map((result) => result.data), [[], []], "verification requires unused local CIK heads");
  const directorySnapshotId = await createDirectorySnapshot();
  const [{ client: owner, userId }, { client: other }] = testUsers;
  const search = await mustNoError(await owner.rpc("search_sec_issuer_directory", { query_text: cik, max_results: 50 }), "search current CIK");
  eq(search.map((row) => row.cik), [cik], "authenticated issuer discovery returns the exact CIK");
  const { data: savedIssuer, error: saveError } = await owner.from("user_research_issuers").insert({ user_id: userId, cik,
    selected_snapshot_id: directorySnapshotId, ticker, issuer_name: "Test Issuer Limited", exchange: "Test Exchange" }).select("id").single();
  if (saveError) throw new Error(`save issuer: ${saveError.message} (${saveError.code})`);
  const otherIssuerRows = await mustNoError(await other.from("user_research_issuers").select("id"), "read other account issuers");
  eq(otherIssuerRows.length, 0, "issuer workspace is private to its owner");
  const anonymousRead = await anonymous.from("user_research_issuers").select("id");
  assert.ok(anonymousRead.error, "anonymous role cannot read private issuer workspaces");
  pass("anonymous role is denied issuer workspace access");

  const factSnapshotId = await publishFacts(cik, 125000000, async ({ snapshotId, retrievedAt }) => {
    const incompleteDecision = await owner.from("user_company_research_decisions").insert({ user_id: userId, cik,
      issuer_research_id: savedIssuer.id, companyfacts_snapshot_id: snapshotId, decision: "investigate_further",
      rationale: "An unpublished CompanyFacts snapshot must not be saved as decision evidence.",
      evidence_fact_ids: [], evidence_filing_ids: [], as_of: retrievedAt });
    eq(incompleteDecision.error?.code, "23514", "decision evidence rejects an unpublished CompanyFacts snapshot");
    const invisibleSnapshot = await mustNoError(await owner.from("sec_companyfacts_snapshots").select("id").eq("id", snapshotId),
      "read staged CompanyFacts snapshot as authenticated user");
    eq(invisibleSnapshot, [], "authenticated users cannot read a staged CompanyFacts snapshot");
    const invisibleFacts = await mustNoError(await owner.from("sec_company_fact_values").select("id").eq("snapshot_id", snapshotId),
      "read staged CompanyFacts rows as authenticated user");
    eq(invisibleFacts, [], "authenticated users cannot read staged CompanyFacts values");
  });
  const filingOne = filing("0000000002-26-000001", "2026-02-01");
  const submissionsSnapshotId = await publishSubmissions(cik, [filingOne], async ({ snapshotId }) => {
    const factsTime = await mustNoError(await service.from("sec_companyfacts_snapshots").select("completed_at")
      .eq("id", factSnapshotId).single(), "read published CompanyFacts completion before submissions validation");
    const incompleteDecision = await owner.from("user_company_research_decisions").insert({ user_id: userId, cik,
      issuer_research_id: savedIssuer.id, companyfacts_snapshot_id: factSnapshotId, submissions_snapshot_id: snapshotId,
      decision: "investigate_further", rationale: "An unpublished submissions snapshot must not be saved as decision evidence.",
      evidence_fact_ids: [], evidence_filing_ids: [], as_of: factsTime.completed_at });
    eq(incompleteDecision.error?.code, "23514", "decision evidence rejects an unpublished submissions snapshot");
    const invisibleSnapshot = await mustNoError(await owner.from("sec_submissions_snapshots").select("id").eq("id", snapshotId),
      "read staged submissions snapshot as authenticated user");
    eq(invisibleSnapshot, [], "authenticated users cannot read a staged submissions snapshot");
    const invisibleFilings = await mustNoError(await owner.from("sec_filing_observations").select("id").eq("snapshot_id", snapshotId),
      "read staged filing rows as authenticated user");
    eq(invisibleFilings, [], "authenticated users cannot read staged filing rows");
  });
  const factsMeta = await mustNoError(await service.from("sec_companyfacts_snapshots").select("completed_at").eq("id", factSnapshotId).single(), "read facts source time");
  const factRows = await mustNoError(await owner.from("sec_company_fact_values").select("id").eq("snapshot_id", factSnapshotId), "read exact CompanyFacts evidence");
  const filingRows = await mustNoError(await owner.from("sec_filing_observations").select("id").eq("snapshot_id", submissionsSnapshotId), "read exact filing evidence");
  const savedDecision = await owner.from("user_company_research_decisions").insert({ user_id: userId, cik, issuer_research_id: savedIssuer.id,
    companyfacts_snapshot_id: factSnapshotId, submissions_snapshot_id: submissionsSnapshotId,
    decision: "investigate_further", rationale: "Verify the reported revenue trend in the source filing.",
    evidence_fact_ids: [factRows[0].id], evidence_filing_ids: [filingRows[0].id],
    as_of: factsMeta.completed_at }).select("id,evidence_digest").single();
  assert.ok(!savedDecision.error, `save source-bound research decision: ${savedDecision.error?.message ?? ""}`);
  assert.match(savedDecision.data.evidence_digest, /^[0-9a-f]{64}$/);
  const removeIssuerWithHistory = await owner.from("user_research_issuers").delete().eq("id", savedIssuer.id);
  eq(removeIssuerWithHistory.error?.code, "23503", "issuer removal cannot cascade into saved research history");
  const preservedDecision = await mustNoError(await owner.from("user_company_research_decisions").select("id")
    .eq("id", savedDecision.data.id).single(), "read decision after blocked issuer removal");
  eq(preservedDecision.id, savedDecision.data.id, "saved research decision survives an issuer removal attempt");
  const otherDecisionRows = await mustNoError(await other.from("user_company_research_decisions").select("id"), "read other account decisions");
  eq(otherDecisionRows.length, 0, "saved research decisions are private to their owner");
  pass("decision receipt binds selected SEC fact and filing IDs");
  const tamper = await owner.from("user_company_research_decisions").update({ rationale: "changed" }).eq("id", savedDecision.data.id);
  assert.ok(tamper.error, "saved decisions must be immutable to their owner");
  pass("saved research decisions cannot be rewritten");

  const { data: follow, error: followError } = await owner.from("user_company_follows").insert({ user_id: userId, cik, issuer_research_id: savedIssuer.id })
    .select("id").single();
  if (followError) throw new Error(`save followed company: ${followError.message}`);
  const firstCapture = await owner.rpc("capture_user_followed_evidence_baseline", { p_follow_id: follow.id,
    p_capture_key: randomUUID(), p_expected_previous_baseline_id: null });
  assert.ok(!firstCapture.error, `capture first baseline: ${firstCapture.error?.message ?? ""}`);
  const firstBaseline = Array.isArray(firstCapture.data) ? firstCapture.data[0] : firstCapture.data;
  eq(firstBaseline.filing_ids, [filingRows[0].id], "first follow baseline stores the exact current filing record IDs");

  const filingTwo = filing("0000000002-26-000002", "2026-03-01");
  const nextSubmissionsSnapshotId = await publishSubmissions(cik, [filingOne, filingTwo]);
  const currentFilings = await mustNoError(await owner.rpc("read_user_followed_filing_changes", { p_follow_id: follow.id }), "compare current follow snapshot against the full baseline");
  eq(currentFilings.length, 1, "follow comparison returns one atomic snapshot envelope");
  eq(currentFilings[0].snapshot_id, nextSubmissionsSnapshotId, "change list metadata identifies the exact snapshot used for comparison");
  eq(currentFilings[0].snapshot_filing_count, 2, "change list metadata reports the exact compared snapshot count");
  eq(currentFilings[0].new_filing_count, 1, "follow comparison counts new accessions independently of the visible list");
  eq(currentFilings[0].new_filings.map((row) => row.accession), [filingTwo.accession], "follow comparison detects a new accession by stable SEC identity");
  const secondCapture = await owner.rpc("capture_user_followed_evidence_baseline", { p_follow_id: follow.id,
    p_capture_key: randomUUID(), p_expected_previous_baseline_id: firstBaseline.id });
  assert.ok(!secondCapture.error, `capture second baseline: ${secondCapture.error?.message ?? ""}`);
  const secondBaseline = Array.isArray(secondCapture.data) ? secondCapture.data[0] : secondCapture.data;
  eq(secondBaseline.version, 2, "follow baseline versions advance after compare");
  const staleCapture = await owner.rpc("capture_user_followed_evidence_baseline", { p_follow_id: follow.id,
    p_capture_key: randomUUID(), p_expected_previous_baseline_id: firstBaseline.id });
  eq(staleCapture.error?.code, "40001", "stale baseline capture is rejected");
  const otherFollows = await mustNoError(await other.from("user_company_follows").select("id"), "read other account follows");
  eq(otherFollows.length, 0, "followed companies and baselines are private to their owner");

  const largeBaselineFilings = Array.from({ length: 1200 }, (_, index) =>
    filing(`0000000002-26-${String(index + 10).padStart(6, "0")}`, "2025-01-01"));
  await publishSubmissions(cik, largeBaselineFilings);
  const largeBaselineCapture = await owner.rpc("capture_user_followed_evidence_baseline", { p_follow_id: follow.id,
    p_capture_key: randomUUID(), p_expected_previous_baseline_id: secondBaseline.id });
  assert.ok(!largeBaselineCapture.error, `capture full-size follow baseline: ${largeBaselineCapture.error?.message ?? ""}`);
  const thirdBaseline = Array.isArray(largeBaselineCapture.data) ? largeBaselineCapture.data[0] : largeBaselineCapture.data;
  eq(thirdBaseline.filing_count, 1200, "follow baseline stores all 1,200 source filing IDs");
  const newLargeSnapshotFiling = filing("0000000002-26-999999", "2026-03-15");
  await publishSubmissions(cik, [...largeBaselineFilings, newLargeSnapshotFiling]);
  const largeSnapshotChanges = await mustNoError(await owner.rpc("read_user_followed_filing_changes", { p_follow_id: follow.id }),
    "compare a snapshot larger than the browser row limit");
  eq(largeSnapshotChanges[0].new_filings.map((row) => row.accession), [newLargeSnapshotFiling.accession],
    "large follow comparison reports only the new accession outside the prior 1,200 records");
  eq(largeSnapshotChanges[0].new_filing_count, 1, "large comparison reports the total count of new accessions");
  const overflowFilings = Array.from({ length: 59 }, (_, index) =>
    filing(`0000000002-26-${String(990000 + index).padStart(6, "0")}`, "2026-03-16"));
  await publishSubmissions(cik, [...largeBaselineFilings, newLargeSnapshotFiling, ...overflowFilings]);
  const overflowChanges = await mustNoError(await owner.rpc("read_user_followed_filing_changes", { p_follow_id: follow.id }),
    "compare a follow snapshot with more accessions than the display limit");
  eq(overflowChanges[0].new_filing_count, 60, "large comparison reports all 60 new accessions");
  eq(overflowChanges[0].new_filings.length, 50, "large comparison bounds the browser payload to 50 filings");
  eq(overflowChanges[0].omitted_filing_count, 10, "large comparison explicitly reports accessions omitted from the bounded review list");

  const otherFactsSnapshot = await publishFacts(otherCik, 42);
  const otherFactsMeta = await mustNoError(await service.from("sec_companyfacts_snapshots").select("completed_at").eq("id", otherFactsSnapshot).single(), "read other-CIK facts source time");
  const wrongIdentity = await owner.from("user_company_research_decisions").insert({ user_id: userId, cik, issuer_research_id: savedIssuer.id,
    companyfacts_snapshot_id: otherFactsSnapshot, decision: "set_aside", rationale: "This should fail exact CIK validation.",
    evidence_fact_ids: [], evidence_filing_ids: [], as_of: otherFactsMeta.completed_at });
  assert.ok(wrongIdentity.error, "company facts from a different CIK cannot be attached to a decision");
  pass("cross-CIK decision evidence is rejected");

  const sourceTamper = await owner.from("sec_companyfacts_head").update({ updated_at: new Date().toISOString() }).eq("cik", cik);
  assert.ok(sourceTamper.error, "authenticated users cannot rewrite shared source heads");
  pass("shared SEC source heads are read-only to user clients");

  if (sourceSnapshotIds.directory.length) {
    await mustNoError(await service.from("sec_issuer_directory_head").delete()
      .eq("snapshot_id", sourceSnapshotIds.directory[0]), "release verifier directory head before Edge Function harnesses");
    pass("verifier releases its synthetic directory head before isolated handler fixtures");
  }

  const functionOutput = execFileSync("deno", ["test", "--no-check", "--allow-all",
    "supabase/functions/refresh-sec-company-evidence/index_test.ts"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(functionOutput);
  for (const line of functionOutput.split(/\r?\n/)) {
    if (line.startsWith("PASS ")) checks.push(`Edge Function: ${line.slice(5)}`);
  }
  const directoryFunctionOutput = execFileSync("deno", ["test", "--no-check", "--allow-all",
    "supabase/functions/refresh-sec-issuer-directory/index_test.ts"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(directoryFunctionOutput);
  for (const line of directoryFunctionOutput.split(/\r?\n/)) {
    if (line.startsWith("PASS ")) checks.push(`Directory Edge Function: ${line.slice(5)}`);
  }

  const uiTestOutput = execFileSync("npx", ["vitest", "run", "tests/cloud-research-desk-follow.test.tsx",
    "--reporter=dot", "--maxWorkers=1"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(uiTestOutput);
  pass("rendered follow/baseline UI recovers after an initial baseline capture failure");

  const projectId = readFileSync(join(repoRoot, "supabase", "config.toml"), "utf8").match(/^project_id\s*=\s*"([a-z0-9-]+)"/m)?.[1];
  assert.ok(projectId, "local Supabase project has a valid configured ID");
  const databaseContainer = `supabase_db_${projectId}`;
  const restart = execFileSync("docker", ["restart", databaseContainer], { encoding: "utf8", timeout: 45_000 }).trim();
  eq(restart, databaseContainer, "local Postgres container restarts without resetting its volume");
  const decisionAfterRestart = await retryRead(() => owner.from("user_company_research_decisions")
    .select("id,evidence_digest").eq("id", savedDecision.data.id).single(), "read saved decision after database restart");
  eq(decisionAfterRestart.evidence_digest, savedDecision.data.evidence_digest, "saved decision and evidence digest survive a database restart");
  const baselinesAfterRestart = await retryRead(() => owner.from("user_followed_evidence_baselines")
    .select("id,version,filing_count").eq("follow_id", follow.id).order("version", { ascending: true }), "read follow baselines after database restart");
  eq(baselinesAfterRestart.map((baseline) => [baseline.version, baseline.filing_count]), [[1, 1], [2, 2], [3, 1200]],
    "all versioned follow baselines and full filing counts survive a database restart");

  const directArchive = await owner.from("user_company_follows").update({ unfollowed_at: new Date().toISOString() }).eq("id", follow.id);
  assert.ok(directArchive.error, "authenticated clients cannot directly update follow rows");
  const archivedFollow = await owner.rpc("unfollow_user_company_follow", { p_follow_id: follow.id });
  assert.ok(!archivedFollow.error && archivedFollow.data, `unfollow archives the account row through its scoped database action: ${archivedFollow.error?.message ?? ""}`);
  pass("unfollow removes the active follow while preserving its account history");
  const archivedBaselines = await mustNoError(await owner.from("user_followed_evidence_baselines").select("version,filing_count")
    .eq("follow_id", follow.id).order("version", { ascending: true }), "read baselines after unfollow");
  eq(archivedBaselines.map((baseline) => [baseline.version, baseline.filing_count]), [[1, 1], [2, 2], [3, 1200]],
    "unfollow preserves each exact versioned filing baseline");
  const archivedHistory = await mustNoError(await owner.from("user_followed_evidence_baselines").select("version,filing_count")
    .eq("follow_id", follow.id).order("version", { ascending: true }), "read archived baseline history as its owner");
  eq(archivedHistory.length, 3, "the owner's history path can still read all archived baselines");
  const archivedCapture = await owner.rpc("capture_user_followed_evidence_baseline", { p_follow_id: follow.id,
    p_capture_key: randomUUID(), p_expected_previous_baseline_id: thirdBaseline.id });
  eq(archivedCapture.error?.code, "P0002", "archived follows cannot receive new baselines");
  const hardDelete = await owner.from("user_company_follows").delete().eq("id", follow.id).select("id");
  assert.ok(hardDelete.error, "authenticated users cannot hard-delete followed history");
  pass("followed history cannot be hard-deleted by the account client");
  const refollow = await owner.from("user_company_follows").insert({ user_id: userId, cik, issuer_research_id: savedIssuer.id })
    .select("id").single();
  assert.ok(!refollow.error && refollow.data.id !== follow.id, `an archived CIK can be followed again with a new history: ${refollow.error?.message ?? ""}`);
  const activeFollows = await mustNoError(await owner.from("user_company_follows").select("id").is("unfollowed_at", null), "read active follows after re-follow");
  eq(activeFollows.map((row) => row.id), [refollow.data.id], "re-follow creates one active row without replacing prior baseline history");

  pass("cloud core PostgreSQL integration verification complete");
} finally {
  await cleanup();
  for (const { client } of testUsers) await client.auth.signOut();
}

const completedAt = new Date().toISOString();
const sourcePaths = [
  "supabase/migrations/20261009154711_cloud_core_research.sql",
  "scripts/verify-cloud-core.mjs",
  "supabase/functions/refresh-sec-issuer-directory/index.ts",
  "supabase/functions/refresh-sec-issuer-directory/index_test.ts",
  "supabase/functions/refresh-sec-company-evidence/index.ts",
  "supabase/functions/refresh-sec-company-evidence/index_test.ts",
  "web/src/components/CloudResearchDesk.tsx",
  "tests/cloud-research-desk-follow.test.tsx",
  "web/src/components/CloudIssuerDirectory.tsx",
  "web/src/lib/cloud-issuer-directory-status.ts",
];
const sourceSha256 = Object.fromEntries(sourcePaths.map((path) => [path, digest(readFileSync(join(repoRoot, path)))]));
const evidence = {
  schemaVersion: "sentiment-desk-verification/1",
  featureId: "cloud-core",
  runId,
  startedAt,
  completedAt,
  gitHead: execFileSync("git", ["-C", process.env.SENTIMENT_DESK_SOURCE_REPO ?? repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceSha256,
  environment: { kind: "isolated local Supabase", apiHost: new URL(url).hostname, apiPort: Number(new URL(url).port) },
  dataBoundary: { fixtureRecords: "synthetic SEC-shaped data",
    edgeFunctions: "authenticated in-process handlers; disabled gates and enabled fixture paths use injected transports",
    renderedUi: "jsdom component check with synthetic issuer/snapshot and mocked Supabase responses",
    externalSecRequests: 0, remoteWrites: 0 },
  checks,
  result: { status: "passed", passed: checks.length, failed: 0 },
};
const evidenceDir = join(repoRoot, ".agents", "skills", "verify-sentiment-desk", "evidence");
mkdirSync(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, `cloud-core-${runId}.json`);
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const readback = JSON.parse(readFileSync(evidencePath, "utf8"));
assert.equal(readback.runId, runId, "verification evidence must read back the current run ID");
assert.equal(readback.result.status, "passed", "verification evidence must record a passing run");
console.log(`EVIDENCE ${relative(repoRoot, evidencePath)}`);
