import {sharedSecResponse} from "../_shared/sec-acquisition.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import {
  parseSecIssuerDirectoryEntries,
  SEC_ISSUER_DIRECTORY_FRESH_FOR_MS,
  SEC_ISSUER_DIRECTORY_URL,
} from "../../../shared/sec-issuer-directory.ts";

const SOURCE_ID = "sec_company_tickers_exchange";
const ADAPTER_VERSION = "sec-issuer-directory/1";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024;
const COOLDOWN_SECONDS = 15 * 60;
const LEASE_SECONDS = 120;
const SOURCE_TIMEOUT_MS = 15_000;
const INSERT_BATCH_SIZE = 500;
const encoder = new TextEncoder();

interface Receipt {
  source: string;
  retrievedAt: string;
  sha256: string;
  rowCount: number;
  snapshotId: string;
}

class SourceError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly retryAfter?: string | null) {
    super(code);
  }
}

function configuredOrigins(): Set<string> {
  const configured = Deno.env.get("APP_ALLOWED_ORIGINS")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  if (configured.length > 0) return new Set(configured);
  return new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"]);
}

function responseJson(body: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-headers", "authorization, apikey, content-type, x-client-info");
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    headers.set("vary", "origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  const at = seconds == null ? Date.parse(value) : now + seconds * 1000;
  if (!Number.isFinite(at) || at <= now) return null;
  return Math.ceil((at - now) / 1000);
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
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
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fetchSecDirectory(userAgent: string, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Uint8Array; httpStatus: number; retrievedAt: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await (fetchImpl !== fetch ? fetchImpl(SEC_ISSUER_DIRECTORY_URL, {
      method: "GET",
      headers: { "User-Agent": userAgent, "Accept": "application/json" },
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    }) : sharedSecResponse(SEC_ISSUER_DIRECTORY_URL, MAX_RESPONSE_BYTES, SOURCE_TIMEOUT_MS, controller.signal));
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
    let bytes: Uint8Array;
    try { bytes = await readBoundedBody(response); }
    catch (error) {
      if (controller.signal.aborted) throw new SourceError("source_timeout", response.status);
      throw error;
    }
    return { bytes, httpStatus: response.status, retrievedAt: response.headers.get("x-dcc-sec-retrieved-at") ?? new Date().toISOString() };
  } catch (error) {
    if (controller.signal.aborted) throw new SourceError("source_timeout");
    if (error instanceof SourceError) throw error;
    throw new SourceError("source_network_error");
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function loadIdempotentReceipt(service: ReturnType<typeof createClient>, requestKey: string): Promise<Receipt | null> {
  const { data: run, error } = await service.from("core_source_runs")
    .select("id,status,retrieved_at,response_sha256,row_count")
    .eq("source_id", SOURCE_ID)
    .eq("request_key", requestKey)
    .maybeSingle();
  if (error) throw new Error("source_run_read_failed");
  if (!run || run.status !== "success" || !run.retrieved_at || !run.response_sha256 || run.row_count == null) return null;
  const { data: snapshot, error: snapshotError } = await service.from("sec_issuer_directory_snapshots")
    .select("id,completed_at,source_response_sha256,retrieved_at")
    .eq("source_run_id", run.id)
    .maybeSingle();
  if (snapshotError) throw new Error("source_snapshot_read_failed");
  if (!snapshot || !snapshot.completed_at || snapshot.source_response_sha256 !== run.response_sha256
    || snapshot.retrieved_at !== run.retrieved_at) return null;
  return {
    source: SEC_ISSUER_DIRECTORY_URL,
    retrievedAt: run.retrieved_at,
    sha256: run.response_sha256,
    rowCount: run.row_count,
    snapshotId: snapshot.id,
  };
}

async function loadCurrentFreshReceipt(service: ReturnType<typeof createClient>): Promise<Receipt | null> {
  const { data: head, error: headError } = await service.from("sec_issuer_directory_head")
    .select("snapshot_id")
    .eq("dataset", "company_tickers_exchange")
    .maybeSingle();
  if (headError || !head) return null;
  const { data: snapshot, error: snapshotError } = await service.from("sec_issuer_directory_snapshots")
    .select("id,source_run_id,source_response_sha256,retrieved_at,row_count")
    .eq("id", head.snapshot_id)
    .maybeSingle();
  const ageMs = snapshot ? Date.now() - Date.parse(snapshot.retrieved_at) : Number.NaN;
  if (snapshotError || !snapshot || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > SEC_ISSUER_DIRECTORY_FRESH_FOR_MS) return null;
  const { data: run, error: runError } = await service.from("core_source_runs")
    .select("status")
    .eq("id", snapshot.source_run_id)
    .maybeSingle();
  if (runError || run?.status !== "success") return null;
  return {
    source: SEC_ISSUER_DIRECTORY_URL,
    retrievedAt: snapshot.retrieved_at,
    sha256: snapshot.source_response_sha256,
    rowCount: snapshot.row_count,
    snapshotId: snapshot.id,
  };
}

async function markRunFailed(
  service: ReturnType<typeof createClient>,
  runId: string,
  failureCode: string,
  at: string,
  details: { httpStatus?: number; retrievedAt?: string; sha256?: string; responseBytes?: number; rowCount?: number } = {},
): Promise<void> {
  await service.from("core_source_runs").update({
    status: "failed",
    completed_at: at,
    failure_code: failureCode,
    http_status: details.httpStatus ?? null,
    retrieved_at: details.retrievedAt ?? null,
    response_sha256: details.sha256 ?? null,
    response_bytes: details.responseBytes ?? null,
    row_count: details.rowCount ?? null,
  }).eq("id", runId).eq("status", "running");
}

async function markRunPartial(service: ReturnType<typeof createClient>, runId: string, failureCode: string, at: string): Promise<void> {
  await service.from("core_source_runs").update({ status: "partial", completed_at: at, failure_code: failureCode })
    .eq("id", runId).eq("status", "running");
}

export async function handle(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const originHeader = request.headers.get("origin");
  const origin = originHeader && configuredOrigins().has(originHeader) ? originHeader : null;
  if (request.method === "OPTIONS") {
    if (originHeader && !origin) return responseJson({ error: "origin_not_allowed" }, 403, null);
    return new Response(null, { status: 204, headers: origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "600",
      "vary": "origin",
    } : {} });
  }
  if (request.method !== "POST") return responseJson({ error: "method_not_allowed" }, 405, origin);
  if (originHeader && !origin) return responseJson({ error: "origin_not_allowed" }, 403, null);

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return responseJson({ error: "json_required" }, 415, origin);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength != null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    return responseJson({ error: "request_too_large" }, 413, origin);
  }

  let input: unknown;
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAX_REQUEST_BYTES) return responseJson({ error: "request_too_large" }, 413, origin);
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return responseJson({ error: "invalid_json" }, 400, origin);
  }
  if (input == null || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input as Record<string, unknown>).length !== 1
    || typeof (input as { requestKey?: unknown }).requestKey !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((input as { requestKey: string }).requestKey)) {
    return responseJson({ error: "invalid_request" }, 400, origin);
  }
  const requestKey = (input as { requestKey: string }).requestKey.toLowerCase();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supabaseUrl || !publicKey || !serviceKey) return responseJson({ error: "cloud_auth_unavailable" }, 503, origin);
  if (!token) return responseJson({ error: "authentication_required" }, 401, origin);

  const userClient = createClient(supabaseUrl, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userResult, error: authError } = await userClient.auth.getUser(token);
  if (authError || !userResult.user) return responseJson({ error: "authentication_required" }, 401, origin);

  if (Deno.env.get("SEC_DIRECTORY_SOURCE_ENABLED") !== "true") {
    return responseJson({ error: "sec_directory_source_not_enabled", message: "SEC directory acquisition is disabled until its source-use scope is enabled by the operator." }, 503, origin);
  }
  const userAgent = Deno.env.get("SEC_USER_AGENT")?.trim() ?? "";
  if (!userAgent || /[\r\n\u0000-\u001f\u007f]/u.test(userAgent) || userAgent.length > 256) {
    return responseJson({ error: "sec_user_agent_not_configured" }, 503, origin);
  }

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const replay = await loadIdempotentReceipt(service, requestKey);
    if (replay) return responseJson({ state: "success", receipt: replay, message: "Reused the saved result for this refresh request." }, 200, origin);
    const current = await loadCurrentFreshReceipt(service);
    if (current) return responseJson({ state: "current", receipt: current, message: "The published SEC directory snapshot is within its 24-hour freshness window; no source request was needed." }, 200, origin);
  } catch {
    return responseJson({ error: "source_readback_failed" }, 503, origin);
  }

  const leaseToken = crypto.randomUUID();
  const { data: claims, error: claimError } = await service.rpc("claim_core_source_refresh", {
    p_source_id: SOURCE_ID,
    p_lease_token: leaseToken,
    p_cooldown_seconds: COOLDOWN_SECONDS,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (claimError) return responseJson({ error: "source_refresh_gate_failed" }, 503, origin);
  const claim = Array.isArray(claims) ? claims[0] : claims;
  if (!claim?.claimed) {
    return responseJson({ state: "rate_limited", nextAllowedAt: claim?.next_allowed_at ?? null, message: "The shared SEC refresh cooldown is still active." }, 200, origin);
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const { error: runError } = await service.from("core_source_runs").insert({
    id: runId,
    request_key: requestKey,
    source_id: SOURCE_ID,
    source_url: SEC_ISSUER_DIRECTORY_URL,
    adapter_version: ADAPTER_VERSION,
    trigger_kind: "manual",
    status: "running",
    started_at: startedAt,
  });
  if (runError) {
    await service.rpc("release_core_source_refresh", { p_source_id: SOURCE_ID, p_lease_token: leaseToken });
    return responseJson({ error: "source_run_write_failed" }, 503, origin);
  }

  let retrievedAt: string | undefined;
  let sourceSha: string | undefined;
  let responseBytes: number | undefined;
  let rowCount: number | undefined;
  let httpStatus: number | undefined;
  let nextAllowedAt: string | null = null;
  try {
    let bytes: Uint8Array;
    try {
      const source = await fetchSecDirectory(userAgent, fetchImpl);
      bytes = source.bytes;
      httpStatus = source.httpStatus;
      retrievedAt = source.retrievedAt;
    } catch (error) {
      if (error instanceof SourceError && (error.httpStatus === 429 || error.httpStatus === 503)) {
        const retrySeconds = parseRetryAfter(error.retryAfter ?? null, Date.now());
        if (retrySeconds != null) {
          nextAllowedAt = new Date(Date.now() + Math.min(Math.max(retrySeconds, COOLDOWN_SECONDS), 24 * 60 * 60) * 1000).toISOString();
          await service.rpc("defer_core_source_refresh", { p_source_id: SOURCE_ID, p_next_allowed_at: nextAllowedAt });
        }
      }
      throw error;
    }
    responseBytes = bytes.byteLength;
    sourceSha = await sha256(bytes);
    let sourceBody: string;
    let parsed: unknown;
    try {
      sourceBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      parsed = JSON.parse(sourceBody) as unknown;
    } catch {
      throw new SourceError("invalid_json_or_utf8", httpStatus);
    }
    let entries;
    try { entries = parseSecIssuerDirectoryEntries(parsed); }
    catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "invalid_shape";
      throw new SourceError(`directory_${code}`, httpStatus);
    }
    rowCount = entries.length;
    const { error: finalizeError } = await service.from("core_source_runs").update({
      http_status: httpStatus,
      retrieved_at: retrievedAt,
      response_sha256: sourceSha,
      response_bytes: responseBytes,
      row_count: rowCount,
    }).eq("id", runId);
    if (finalizeError) throw new SourceError("source_run_finalize_failed", httpStatus);

    const snapshotId = crypto.randomUUID();
    const { error: payloadError } = await service.from("sec_source_payloads").insert({
      source_run_id: runId,
      response_sha256: sourceSha,
      response_body: sourceBody,
    });
    if (payloadError) throw new SourceError("source_payload_write_failed", httpStatus);
    const { error: snapshotError } = await service.from("sec_issuer_directory_snapshots").insert({
      id: snapshotId,
      source_run_id: runId,
      source_id: SOURCE_ID,
      source_url: SEC_ISSUER_DIRECTORY_URL,
      source_response_sha256: sourceSha,
      parser_version: ADAPTER_VERSION,
      retrieved_at: retrievedAt,
      completed_at: null,
      row_count: rowCount,
    });
    if (snapshotError) throw new SourceError("source_snapshot_write_failed", httpStatus);

    for (let offset = 0; offset < entries.length; offset += INSERT_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + INSERT_BATCH_SIZE);
      const rows = await Promise.all(batch.map(async (entry) => ({
        snapshot_id: snapshotId,
        cik: entry.cik,
        ticker: entry.ticker,
        issuer_name: entry.name,
        exchange: entry.exchange,
        source_row_sha256: await sha256(encoder.encode(JSON.stringify(entry))),
      })));
      const { error: entriesError } = await service.from("sec_issuer_directory_entries").insert(rows);
      if (entriesError) throw new SourceError("source_entries_write_failed", httpStatus);
    }
    const { error: publishError } = await service.rpc("publish_sec_issuer_directory_snapshot", {
      p_snapshot_id: snapshotId,
      p_expected_rows: rowCount,
    });
    if (publishError) {
      const committed = await loadIdempotentReceipt(service, requestKey).catch(() => null);
      if (committed) {
        return responseJson({ state: "success", receipt: committed,
          message: "Publication completed; recovered its saved receipt after an uncertain response." }, 200, origin);
      }
      throw new SourceError("source_publish_failed", httpStatus);
    }
    const { error: cleanupError } = await service.rpc("cleanup_sec_issuer_directory_history");

    const receipt: Receipt = { source: SEC_ISSUER_DIRECTORY_URL, retrievedAt, sha256: sourceSha, rowCount, snapshotId };
    const cleanupMessage = cleanupError ? " Older unreferenced snapshot cleanup is pending." : "";
    return responseJson({ state: "success", receipt, message: `Published ${rowCount.toLocaleString()} SEC issuer mappings to the cloud directory.${cleanupMessage}` }, 200, origin);
  } catch (error) {
    const committed = await loadIdempotentReceipt(service, requestKey).catch(() => null);
    if (committed) {
      return responseJson({ state: "success", receipt: committed,
        message: "Publication completed; recovered its saved receipt after an uncertain response." }, 200, origin);
    }
    const at = new Date().toISOString();
    const failureCode = error instanceof SourceError ? error.code : "source_processing_failed";
    const failureStatus = error instanceof SourceError && error.httpStatus && error.httpStatus >= 400 ? error.httpStatus : 502;
    const responseStatus = httpStatus ?? (error instanceof SourceError ? error.httpStatus : undefined);
    const responseRetrievedAt = retrievedAt ?? (responseStatus == null ? undefined : at);
    if (sourceSha && retrievedAt && responseBytes != null && rowCount != null) {
      await markRunPartial(service, runId, "source_publish_failed", at);
    } else {
      await markRunFailed(service, runId, failureCode.slice(0, 80), at, {
        httpStatus: responseStatus,
        retrievedAt: responseRetrievedAt,
        sha256: sourceSha,
        responseBytes,
        rowCount,
      });
    }
    if ((error instanceof SourceError && error.httpStatus === 429) || nextAllowedAt != null) {
      return responseJson({ state: "rate_limited", nextAllowedAt, message: "SEC asked the cloud pipeline to wait before another refresh. The last published snapshot remains available." }, 200, origin);
    }
    return responseJson({ error: failureCode, message: "SEC refresh failed; the last published directory remains unchanged." }, failureStatus, origin);
  } finally {
    await service.rpc("release_core_source_refresh", { p_source_id: SOURCE_ID, p_lease_token: leaseToken });
  }
}

if (import.meta.main) Deno.serve((request) => handle(request));
