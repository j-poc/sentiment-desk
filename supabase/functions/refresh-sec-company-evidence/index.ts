import {sharedSecResponse} from "../_shared/sec-acquisition.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { parse as parseLosslessJson } from "npm:lossless-json@4.3.1";
import {
  parseSecCompanyFacts,
  parseSecSubmissions,
  SEC_COMPANY_DATA_FRESH_FOR_MS,
  SEC_COMPANY_FACT_LIMIT,
  SEC_COMPANYFACTS_URL,
  SEC_SUBMISSIONS_URL,
} from "../_shared/sec-company-data.ts";

const FACTS_SOURCE = "sec_companyfacts";
const SUBMISSIONS_SOURCE = "sec_submissions";
const ADAPTER_VERSION = "sec-company-research/1";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const COOLDOWN_SECONDS = 5;
const LEASE_SECONDS = 120;
const SOURCE_TIMEOUT_MS = 20_000;
const INSERT_BATCH_SIZE = 500;
const encoder = new TextEncoder();

interface SourceReceipt {
  source: string;
  retrievedAt: string;
  sha256: string;
  rowCount: number;
  snapshotId: string;
}

interface ExistingRun {
  id: string;
  status: string;
  retrieved_at: string | null;
  response_sha256: string | null;
  row_count: number | null;
}

class SourceError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly retryAfter?: string | null) { super(code); }
}

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  const allowed = Deno.env.get("APP_ALLOWED_ORIGINS")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  if (allowed.length > 0) return allowed.includes(origin);
  return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"].includes(origin);
}

function retrySeconds(value: string | null): number | null {
  if (!value) return null;
  const now = Date.now();
  const rawSeconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  const nextTime = rawSeconds == null ? Date.parse(value) : now + rawSeconds * 1000;
  if (!Number.isFinite(nextTime) || nextTime <= now) return null;
  return Math.ceil((nextTime - now) / 1000);
}

function json(body: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-headers", "authorization, apikey, content-type, x-client-info");
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    headers.set("vary", "origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fetchSec(fetchImpl: typeof fetch, url: string, userAgent: string): Promise<{ body: unknown; bytes: number; sha: string; httpStatus: number; retrievedAt: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await (fetchImpl !== fetch ? fetchImpl(url, { method: "GET", headers: { "User-Agent": userAgent, Accept: "application/json" },
      redirect: "manual", cache: "no-store", signal: controller.signal }) : sharedSecResponse(url, MAX_RESPONSE_BYTES, SOURCE_TIMEOUT_MS, controller.signal));
    if (!response.ok || response.redirected || response.status < 200 || response.status >= 300) {
      const retryAfter = response.headers.get("retry-after");
      await response.body?.cancel();
      throw new SourceError(`http_${response.status}`, response.status, retryAfter);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType && contentType !== "application/json") {
      await response.body?.cancel();
      throw new SourceError("unexpected_content_type", response.status);
    }
    const declared = response.headers.get("content-length");
    if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
      await response.body?.cancel();
      throw new SourceError("response_too_large", response.status);
    }
    if (!response.body) throw new SourceError("response_body_missing", response.status);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new SourceError("response_too_large", response.status);
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const sha = await sha256(bytes);
    let body: unknown;
    try { body = parseLosslessJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new SourceError("invalid_json_or_utf8", response.status); }
    return { body, bytes: length, sha, httpStatus: response.status, retrievedAt: response.headers.get("x-dcc-sec-retrieved-at") ?? new Date().toISOString() };
  } catch (error) {
    if (controller.signal.aborted) throw new SourceError("source_timeout");
    if (error instanceof SourceError) throw error;
    throw new SourceError("source_network_error");
  } finally { clearTimeout(timeout); }
}

async function existingRun(service: ReturnType<typeof createClient>, sourceId: string, requestKey: string): Promise<ExistingRun | null> {
  const { data, error } = await service.from("core_source_runs").select("id,status,retrieved_at,response_sha256,row_count")
    .eq("source_id", sourceId).eq("request_key", requestKey).maybeSingle();
  if (error) throw new Error("source_run_read_failed");
  return data as ExistingRun | null;
}

async function receiptForRun(service: ReturnType<typeof createClient>, sourceId: string, run: ExistingRun): Promise<SourceReceipt | null> {
  if (run.status !== "success" || !run.retrieved_at || !run.response_sha256 || run.row_count == null) return null;
  const table = sourceId === FACTS_SOURCE ? "sec_companyfacts_snapshots" : "sec_submissions_snapshots";
  const { data, error } = await service.from(table)
    .select("id,completed_at,source_response_sha256,retrieved_at")
    .eq("source_run_id", run.id).maybeSingle();
  if (error || !data) return null;
  if (!data.completed_at || data.source_response_sha256 !== run.response_sha256 || data.retrieved_at !== run.retrieved_at) return null;
  return { source: sourceId, retrievedAt: run.retrieved_at, sha256: run.response_sha256, rowCount: run.row_count, snapshotId: data.id };
}

async function currentFreshReceipt(service: ReturnType<typeof createClient>, sourceId: string, cik: string): Promise<SourceReceipt | null> {
  const headTable = sourceId === FACTS_SOURCE ? "sec_companyfacts_head" : "sec_submissions_head";
  const snapshotTable = sourceId === FACTS_SOURCE ? "sec_companyfacts_snapshots" : "sec_submissions_snapshots";
  const { data: head, error: headError } = await service.from(headTable).select("snapshot_id").eq("cik", cik).maybeSingle();
  if (headError || !head) return null;
  const countColumn = sourceId === FACTS_SOURCE ? "fact_count" : "filing_count";
  const { data: snapshot, error: snapshotError } = await service.from(snapshotTable)
    .select(`id,source_run_id,source_response_sha256,retrieved_at,${countColumn}`)
    .eq("id", head.snapshot_id).maybeSingle();
  if (snapshotError || !snapshot) return null;
  const age = Date.now() - Date.parse(snapshot.retrieved_at);
  if (!Number.isFinite(age) || age < 0 || age > SEC_COMPANY_DATA_FRESH_FOR_MS) return null;
  const { data: run, error: runError } = await service.from("core_source_runs").select("status")
    .eq("id", snapshot.source_run_id).maybeSingle();
  if (runError || run?.status !== "success") return null;
  return { source: sourceId, retrievedAt: snapshot.retrieved_at, sha256: snapshot.source_response_sha256,
    rowCount: snapshot[countColumn], snapshotId: snapshot.id };
}

async function refreshFacts(service: ReturnType<typeof createClient>, cik: string, requestKey: string, userAgent: string,
  fetchImpl: typeof fetch): Promise<SourceReceipt> {
  const sourceUrl = SEC_COMPANYFACTS_URL(cik);
  const previous = await existingRun(service, FACTS_SOURCE, requestKey);
  if (previous) {
    const replay = await receiptForRun(service, FACTS_SOURCE, previous);
    if (replay) return replay;
    if (previous.status === "running") throw new SourceError("refresh_request_in_progress", 409);
    throw new SourceError("refresh_request_already_failed", 409);
  }
  const fresh = await currentFreshReceipt(service, FACTS_SOURCE, cik);
  if (fresh) return fresh;
  return await refreshOne(service, { sourceId: FACTS_SOURCE, sourceUrl, cik, requestKey, userAgent,
    parser: (body) => parseSecCompanyFacts(body, cik), snapshotTable: "sec_companyfacts_snapshots",
    rowTable: "sec_company_fact_values", headPublishRpc: "publish_sec_companyfacts_snapshot", fetchImpl,
    rowCountArgument: "p_expected_facts", makeSnapshot: (runId, id, receipt, parsed) => ({ id, source_run_id: runId, source_id: FACTS_SOURCE,
      cik, source_response_sha256: receipt.sha, source_url: sourceUrl, retrieved_at: receipt.retrievedAt,
      completed_at: null, fact_count: parsed.length, parser_version: ADAPTER_VERSION }),
    makeRows: (snapshotId, rows) => rows.map((row) => ({ snapshot_id: snapshotId, ...row })),
  });
}

async function refreshSubmissions(service: ReturnType<typeof createClient>, cik: string, requestKey: string, userAgent: string,
  fetchImpl: typeof fetch): Promise<SourceReceipt> {
  const sourceUrl = SEC_SUBMISSIONS_URL(cik);
  const previous = await existingRun(service, SUBMISSIONS_SOURCE, requestKey);
  if (previous) {
    const replay = await receiptForRun(service, SUBMISSIONS_SOURCE, previous);
    if (replay) return replay;
    if (previous.status === "running") throw new SourceError("refresh_request_in_progress", 409);
    throw new SourceError("refresh_request_already_failed", 409);
  }
  const fresh = await currentFreshReceipt(service, SUBMISSIONS_SOURCE, cik);
  if (fresh) return fresh;
  return await refreshOne(service, { sourceId: SUBMISSIONS_SOURCE, sourceUrl, cik, requestKey, userAgent,
    parser: (body) => parseSecSubmissions(body, cik), snapshotTable: "sec_submissions_snapshots",
    rowTable: "sec_filing_observations", headPublishRpc: "publish_sec_submissions_snapshot", fetchImpl,
    rowCountArgument: "p_expected_filings", makeSnapshot: (runId, id, receipt, parsed) => ({ id, source_run_id: runId, source_id: SUBMISSIONS_SOURCE,
      cik, source_response_sha256: receipt.sha, source_url: sourceUrl, retrieved_at: receipt.retrievedAt,
      completed_at: null, filing_count: parsed.length, parser_version: ADAPTER_VERSION }),
    makeRows: (snapshotId, rows, retrievedAt) => rows.map((row) => ({ snapshot_id: snapshotId, ...row, retrieved_at: retrievedAt })),
  });
}

async function refreshOne<T>(service: ReturnType<typeof createClient>, options: {
  sourceId: string; sourceUrl: string; cik: string; requestKey: string; userAgent: string;
  fetchImpl: typeof fetch;
  parser: (body: unknown) => T[]; snapshotTable: string; rowTable: string; headPublishRpc: string; rowCountArgument: string;
  makeSnapshot: (runId: string, id: string, receipt: { sha: string; retrievedAt: string }, parsed: T[]) => Record<string, unknown>;
  makeRows: (snapshotId: string, rows: T[], retrievedAt: string) => Record<string, unknown>[];
}): Promise<SourceReceipt> {
  const leaseToken = crypto.randomUUID();
  const { data: claims, error: claimError } = await service.rpc("claim_core_source_refresh", {
    p_source_id: options.sourceId, p_lease_token: leaseToken,
    p_cooldown_seconds: COOLDOWN_SECONDS, p_lease_seconds: LEASE_SECONDS,
  });
  if (claimError) throw new SourceError("source_refresh_gate_failed", 503);
  const claim = Array.isArray(claims) ? claims[0] : claims;
  if (!claim?.claimed) throw new SourceError("source_refresh_rate_limited", 429);
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const { error: runError } = await service.from("core_source_runs").insert({
    id: runId, request_key: options.requestKey, source_id: options.sourceId, source_url: options.sourceUrl,
    adapter_version: ADAPTER_VERSION, trigger_kind: "manual", status: "running", started_at: startedAt,
  });
  if (runError) {
    await service.rpc("release_core_source_refresh", { p_source_id: options.sourceId, p_lease_token: leaseToken });
    throw new SourceError(runError.code === "23505" ? "refresh_request_in_progress" : "source_run_write_failed", 503);
  }

  let retrievedAt: string | undefined;
  let responseSha: string | undefined;
  let responseBytes: number | undefined;
  let rowCount: number | undefined;
  let httpStatus: number | undefined;
  try {
    const response = await fetchSec(options.fetchImpl, options.sourceUrl, options.userAgent);
    retrievedAt = response.retrievedAt;
    responseSha = response.sha;
    responseBytes = response.bytes;
    httpStatus = response.httpStatus;
    const parsed = options.parser(response.body);
    rowCount = parsed.length;
    if (rowCount > SEC_COMPANY_FACT_LIMIT) throw new SourceError("source_row_limit_exceeded", httpStatus);
    const { error: receiptError } = await service.from("core_source_runs").update({
      http_status: httpStatus, retrieved_at: retrievedAt, response_sha256: responseSha,
      response_bytes: responseBytes, row_count: rowCount,
    }).eq("id", runId);
    if (receiptError) throw new SourceError("source_run_finalize_failed", httpStatus);
    const snapshotId = crypto.randomUUID();
    const snapshot = options.makeSnapshot(runId, snapshotId, { sha: responseSha, retrievedAt }, parsed);
    const { error: snapshotError } = await service.from(options.snapshotTable).insert(snapshot);
    if (snapshotError) throw new SourceError("source_snapshot_write_failed", httpStatus);
    const rows = options.makeRows(snapshotId, parsed, retrievedAt);
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const { error: rowsError } = await service.from(options.rowTable).insert(rows.slice(offset, offset + INSERT_BATCH_SIZE));
      if (rowsError) throw new SourceError("source_rows_write_failed", httpStatus);
    }
    const { error: publishError } = await service.rpc(options.headPublishRpc, {
      p_snapshot_id: snapshotId, [options.rowCountArgument]: rowCount,
    });
    if (publishError) {
      const committedRun = await existingRun(service, options.sourceId, options.requestKey).catch(() => null);
      const committedReceipt = committedRun ? await receiptForRun(service, options.sourceId, committedRun) : null;
      if (committedReceipt) return committedReceipt;
      throw new SourceError("source_publish_failed", httpStatus);
    }
    await service.rpc("cleanup_sec_company_evidence_history");
    return { source: options.sourceId, retrievedAt, sha256: responseSha, rowCount, snapshotId };
  } catch (error) {
    const committedRun = await existingRun(service, options.sourceId, options.requestKey).catch(() => null);
    const committedReceipt = committedRun ? await receiptForRun(service, options.sourceId, committedRun) : null;
    if (committedReceipt) return committedReceipt;
    const at = new Date().toISOString();
    const failureCode = error instanceof SourceError ? error.code : "source_processing_failed";
    if (error instanceof SourceError && (error.httpStatus === 429 || error.httpStatus === 503)) {
      const retry = retrySeconds(error.retryAfter ?? null);
      const seconds = Math.min(Math.max(retry ?? COOLDOWN_SECONDS, COOLDOWN_SECONDS), 24 * 60 * 60);
      await service.rpc("defer_core_source_refresh", {
        p_source_id: options.sourceId, p_next_allowed_at: new Date(Date.now() + seconds * 1_000).toISOString(),
      });
    }
    if (retrievedAt && responseSha && responseBytes != null && rowCount != null) {
      await service.from("core_source_runs").update({ status: "partial", completed_at: at, failure_code: failureCode })
        .eq("id", runId).eq("status", "running");
    } else {
      await service.from("core_source_runs").update({ status: "failed", completed_at: at, failure_code: failureCode,
        http_status: httpStatus ?? (error instanceof SourceError ? error.httpStatus ?? null : null),
        retrieved_at: retrievedAt ?? null, response_sha256: responseSha ?? null,
        response_bytes: responseBytes ?? null, row_count: rowCount ?? null,
      }).eq("id", runId).eq("status", "running");
    }
    if (error instanceof SourceError) throw error;
    throw new SourceError(failureCode, 502);
  } finally {
    await service.rpc("release_core_source_refresh", { p_source_id: options.sourceId, p_lease_token: leaseToken });
  }
}

export async function handle(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const originHeader = request.headers.get("origin");
  if (!isOriginAllowed(originHeader)) return json({ error: "origin_not_allowed" }, 403, null);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: originHeader ? {
    "access-control-allow-origin": originHeader,
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS", "access-control-max-age": "600", vary: "origin",
  } : {} });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, originHeader);
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json({ error: "json_required" }, 415, originHeader);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength != null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 1024)) return json({ error: "request_too_large" }, 413, originHeader);
  let input: unknown;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 1024) return json({ error: "request_too_large" }, 413, originHeader);
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return json({ error: "invalid_json" }, 400, originHeader); }
  if (input == null || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input as Record<string, unknown>).sort().join(",") !== "cik,requestKey"
    || typeof (input as { cik?: unknown }).cik !== "string" || !/^\d{10}$/.test((input as { cik: string }).cik)
    || typeof (input as { requestKey?: unknown }).requestKey !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((input as { requestKey: string }).requestKey)) {
    return json({ error: "invalid_request" }, 400, originHeader);
  }
  const { cik, requestKey: rawRequestKey } = input as { cik: string; requestKey: string };
  const requestKey = rawRequestKey.toLowerCase();
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!url || !anonKey || !serviceKey || !bearer) return json({ error: "cloud_auth_unavailable" }, 503, originHeader);
  const auth = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await auth.auth.getUser(bearer);
  if (authError || !authData.user) return json({ error: "authentication_required" }, 401, originHeader);
  if (Deno.env.get("SEC_COMPANY_DATA_ENABLED") !== "true") return json({ error: "sec_company_data_not_enabled", message: "SEC company evidence acquisition is disabled until its source-use scope is enabled by the operator." }, 503, originHeader);
  const userAgent = Deno.env.get("SEC_USER_AGENT")?.trim() ?? "";
  if (!userAgent || /[\r\n\u0000-\u001f\u007f]/u.test(userAgent) || userAgent.length > 256) return json({ error: "sec_user_agent_not_configured" }, 503, originHeader);
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: issuer, error: issuerError } = await service.from("user_research_issuers").select("id")
    .eq("user_id", authData.user.id).eq("cik", cik).maybeSingle();
  if (issuerError || !issuer) return json({ error: "research_issuer_not_found" }, 404, originHeader);

  const [factsResult, submissionsResult] = await Promise.allSettled([
    refreshFacts(service, cik, requestKey, userAgent, fetchImpl),
    refreshSubmissions(service, cik, requestKey, userAgent, fetchImpl),
  ]);
  const facts = factsResult.status === "fulfilled" ? { state: "ready", receipt: factsResult.value }
    : { state: factsResult.reason instanceof SourceError && factsResult.reason.code === "source_refresh_rate_limited" ? "rate_limited" : "failed",
      error: factsResult.reason instanceof SourceError ? factsResult.reason.code : "source_processing_failed" };
  const submissions = submissionsResult.status === "fulfilled" ? { state: "ready", receipt: submissionsResult.value }
    : { state: submissionsResult.reason instanceof SourceError && submissionsResult.reason.code === "source_refresh_rate_limited" ? "rate_limited" : "failed",
      error: submissionsResult.reason instanceof SourceError ? submissionsResult.reason.code : "source_processing_failed" };
  const readyCount = [facts, submissions].filter((state) => state.state === "ready").length;
  const state = readyCount === 2 ? "ready" : readyCount === 0 ? "failed" : "partial";
  return json({ state, message: state === "ready" ? "Current or newly retrieved SEC facts and filing history are saved for this CIK." : state === "partial"
    ? "One SEC source is available; the other is incomplete. The last published snapshots remain available."
    : "SEC refresh did not publish current evidence. Existing snapshots remain available.", facts, submissions }, 200, originHeader);
}

if (import.meta.main) Deno.serve((request) => handle(request));
