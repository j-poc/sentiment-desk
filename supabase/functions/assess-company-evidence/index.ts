import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import {
  companyAssessmentInstructions,
  companyAssessmentJsonSchema,
  companyAssessmentUserPayload,
  validateCompanyEvidenceAssessment,
  parseCompanyAssessmentProviderResponse,
  COMPANY_ASSESSMENT_PROMPT_VERSION,
  type CompanyAssessmentProviderResponse,
  OPENAI_COMPANY_ASSESSMENT_MODEL,
  GEMINI_COMPANY_ASSESSMENT_MODEL,
  type CompanyAssessmentCitation,
  type CompanyAssessmentInputEvidence,
} from "../../../shared/company-evidence-assessment.ts";
import { canonicalSecFilingUrl, isValidSecFilingUrl, secFilingArchiveUrl } from "../../../shared/sec-filing-url.ts";

const MAX_REQUEST_BYTES = 8_192;
const MAX_PROVIDER_RESPONSE_BYTES = 65_536;
const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_FACTS = 12;
const MAX_FILINGS = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESSION_RE = /^[0-9]{10}-[0-9]{2}-[0-9]{6}$/;

type Provider = "openai" | "google_gemini";
interface RequestInput {
  provider: Provider;
  paidServiceAttested: boolean;
  cik: string;
  factSnapshotId: string;
  filingSnapshotId: string;
  factIds: string[];
  filingIds: string[];
}
interface FactRow {
  id: string; cik: string; taxonomy: string; concept: string; unit: string; value_text: string;
  period_start: string | null; period_end: string; filed_at: string; form: string; accession: string; reported_decimals: string | null;
}
interface FilingRow {
  id: string; cik: string; accession: string; form: string; filed_at: string; report_period: string | null;
  primary_document: string | null; source_url: string;
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return true;
  const allowed = Deno.env.get("APP_ALLOWED_ORIGINS")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  if (allowed.length > 0) return allowed.includes(origin);
  return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"].includes(origin);
}

function json(body: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-headers", "authorization, apikey, content-type, x-client-info, x-provider-api-key");
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    headers.set("vary", "origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStringIds(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((id) => typeof id === "string" && UUID_RE.test(id))
    && new Set(value).size === value.length;
}

export function parseAssessmentRequest(value: unknown): RequestInput | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "cik,factIds,factSnapshotId,filingIds,filingSnapshotId,provider"
    && keys !== "cik,factIds,factSnapshotId,filingIds,filingSnapshotId,paidServiceAttested,provider") return null;
  if (value.provider !== "openai" && value.provider !== "google_gemini") return null;
  if ("paidServiceAttested" in value && typeof value.paidServiceAttested !== "boolean") return null;
  if (typeof value.cik !== "string" || !/^\d{10}$/.test(value.cik) || value.cik === "0000000000") return null;
  if (typeof value.factSnapshotId !== "string" || !UUID_RE.test(value.factSnapshotId)
    || typeof value.filingSnapshotId !== "string" || !UUID_RE.test(value.filingSnapshotId)) return null;
  if (!validStringIds(value.factIds, MAX_FACTS) || !validStringIds(value.filingIds, MAX_FILINGS)
    || value.factIds.length + value.filingIds.length === 0) return null;
  return { provider: value.provider, paidServiceAttested: value.paidServiceAttested === true, cik: value.cik, factSnapshotId: value.factSnapshotId,
    filingSnapshotId: value.filingSnapshotId, factIds: value.factIds, filingIds: value.filingIds };
}

export { isValidSecFilingUrl };

export function sourceUrlForFact(cik: string, accession: string, filing: FilingRow | undefined): string {
  if (!ACCESSION_RE.test(accession)) throw new Error("invalid_source_row");
  if (filing) {
    const url = canonicalSecFilingUrl(filing.source_url, cik, accession, filing.primary_document);
    if (url) return url;
  }
  const url = secFilingArchiveUrl(cik, accession);
  if (!url) throw new Error("invalid_source_row");
  return url;
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  const length = response.headers.get("content-length");
  if (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_PROVIDER_RESPONSE_BYTES)) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { return null; }
}

function removeUnsupportedSchemaFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUnsupportedSchemaFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "maxLength")
    .map(([key, child]) => [key, removeUnsupportedSchemaFields(child)]));
}

export function buildProviderRequest(provider: Provider, apiKey: string, input: string, citationIds: string[]): {
  url: string; headers: Record<string, string>; body: Record<string, unknown>;
} {
  const schema = companyAssessmentJsonSchema(citationIds);
  if (provider === "openai") return {
    url: "https://api.openai.com/v1/responses",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: { model: OPENAI_COMPANY_ASSESSMENT_MODEL, instructions: companyAssessmentInstructions(), input,
      store: false, max_output_tokens: 1800,
      text: { format: { type: "json_schema", name: "company_evidence_assessment", strict: true, schema } } },
  };
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_COMPANY_ASSESSMENT_MODEL}:generateContent`,
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: { systemInstruction: { parts: [{ text: companyAssessmentInstructions() }] },
      contents: [{ role: "user", parts: [{ text: input }] }],
      generationConfig: { responseFormat: { text: { mimeType: "application/json", schema: removeUnsupportedSchemaFields(schema) } }, temperature: 0.2, maxOutputTokens: 1800 } },
  };
}

export async function callProvider(provider: Provider, apiKey: string, input: string, citationIds: string[], fetchImpl: typeof fetch,
  callerSignal: AbortSignal): Promise<CompanyAssessmentProviderResponse | null> {
  const controller = new AbortController();
  if (callerSignal.aborted) return null;
  const abortWithCaller = () => controller.abort();
  callerSignal.addEventListener("abort", abortWithCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const providerRequest = buildProviderRequest(provider, apiKey, input, citationIds);
    const response = await fetchImpl(providerRequest.url, { method: "POST", headers: providerRequest.headers, body: JSON.stringify(providerRequest.body), signal: controller.signal,
      redirect: "error", cache: "no-store" });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const decoded = await readBoundedJson(response);
    return parseCompanyAssessmentProviderResponse(provider, decoded);
  } catch { return null; }
  finally { clearTimeout(timeout); callerSignal.removeEventListener("abort", abortWithCaller); }
}

export async function handle(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!originAllowed(origin)) return json({ error: "origin_not_allowed" }, 403, null);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: origin ? {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-provider-api-key",
    "access-control-allow-methods": "POST, OPTIONS", "access-control-max-age": "600", vary: "origin",
  } : {} });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return json({ error: "json_required" }, 415, origin);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength != null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) return json({ error: "request_too_large" }, 413, origin);
  let raw: unknown;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_REQUEST_BYTES) return json({ error: "request_too_large" }, 413, origin);
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { return json({ error: "invalid_json" }, 400, origin); }
  const input = parseAssessmentRequest(raw);
  if (!input) return json({ error: "invalid_request" }, 400, origin);
  if (input.provider === "google_gemini" && !input.paidServiceAttested) {
    return json({ error: "gemini_paid_service_attestation_required" }, 400, origin);
  }
  const apiKey = request.headers.get("x-provider-api-key")?.trim() ?? "";
  if (apiKey.length < 16 || apiKey.length > 4096 || /[\r\n\u0000-\u001f\u007f]/u.test(apiKey)) return json({ error: "provider_key_required" }, 400, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supabaseUrl || !publicKey || !serviceKey) return json({ error: "cloud_auth_unavailable" }, 503, origin);
  if (!bearer) return json({ error: "authentication_required" }, 401, origin);
  const auth = createClient(supabaseUrl, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authResult, error: authError } = await auth.auth.getUser(bearer);
  if (authError || !authResult.user) return json({ error: "authentication_required" }, 401, origin);

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const userId = authResult.user.id;
  const [issuerResult, factsHeadResult, filingsHeadResult] = await Promise.all([
    service.from("user_research_issuers").select("id,ticker,issuer_name,cik").eq("user_id", userId).eq("cik", input.cik).maybeSingle(),
    service.from("sec_companyfacts_head").select("snapshot_id").eq("cik", input.cik).maybeSingle(),
    service.from("sec_submissions_head").select("snapshot_id").eq("cik", input.cik).maybeSingle(),
  ]);
  if (issuerResult.error || !issuerResult.data) return json({ error: "research_issuer_not_found" }, 404, origin);
  if (factsHeadResult.error || filingsHeadResult.error) return json({ error: "source_snapshot_unavailable" }, 503, origin);
  if (factsHeadResult.data?.snapshot_id !== input.factSnapshotId || filingsHeadResult.data?.snapshot_id !== input.filingSnapshotId) {
    return json({ error: "source_snapshot_changed" }, 409, origin);
  }

  const [factsSnapshotResult, filingsSnapshotResult] = await Promise.all([
    service.from("sec_companyfacts_snapshots").select("id,cik,completed_at").eq("id", input.factSnapshotId).eq("cik", input.cik).maybeSingle(),
    service.from("sec_submissions_snapshots").select("id,cik,completed_at").eq("id", input.filingSnapshotId).eq("cik", input.cik).maybeSingle(),
  ]);
  if (factsSnapshotResult.error || filingsSnapshotResult.error || !factsSnapshotResult.data?.completed_at || !filingsSnapshotResult.data?.completed_at) {
    return json({ error: "source_snapshot_unavailable" }, 503, origin);
  }

  const [factResult, filingResult] = await Promise.all([
    input.factIds.length ? service.from("sec_company_fact_values")
      .select("id,cik,taxonomy,concept,unit,value_text,period_start,period_end,filed_at,form,accession,reported_decimals")
      .eq("snapshot_id", input.factSnapshotId).eq("cik", input.cik).in("id", input.factIds) : Promise.resolve({ data: [], error: null }),
    input.filingIds.length ? service.from("sec_filing_observations")
      .select("id,cik,accession,form,filed_at,report_period,primary_document,source_url")
      .eq("snapshot_id", input.filingSnapshotId).eq("cik", input.cik).in("id", input.filingIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (factResult.error || filingResult.error) return json({ error: "selected_source_unavailable" }, 503, origin);
  const factsById = new Map(((factResult.data ?? []) as FactRow[]).map((row) => [row.id, row]));
  const filingsById = new Map(((filingResult.data ?? []) as FilingRow[]).map((row) => [row.id, row]));
  const facts = input.factIds.flatMap((id) => factsById.has(id) ? [factsById.get(id)!] : []);
  const filings = input.filingIds.flatMap((id) => filingsById.has(id) ? [filingsById.get(id)!] : []);
  if (facts.length !== input.factIds.length || filings.length !== input.filingIds.length) return json({ error: "selected_source_changed" }, 409, origin);

  if (filings.some((filing) => !ACCESSION_RE.test(filing.accession)
    || !canonicalSecFilingUrl(filing.source_url, input.cik, filing.accession, filing.primary_document))) {
    return json({ error: "selected_source_unavailable" }, 503, origin);
  }
  // Resolve fact citations only from filings the user selected and saw in the
  // preview. Otherwise both preview and request use the accession index URL.
  const filingsByAccession = new Map(filings.map((row) => [row.accession, row]));

  const citations: CompanyAssessmentCitation[] = [];
  const evidence: CompanyAssessmentInputEvidence[] = [];
  facts.forEach((fact, index) => {
    const id = `F${index + 1}`;
    const filing = filingsByAccession.get(fact.accession);
    citations.push({ id, factId: fact.id,
      label: `${fact.concept} · ${fact.form} · filed ${fact.filed_at} · period ${fact.period_start ? `${fact.period_start} to ` : "instant "}${fact.period_end}`,
      sourceUrl: sourceUrlForFact(input.cik, fact.accession, filing) });
    evidence.push({ citation_id: id, kind: "reported_financial_fact", concept: fact.concept, value: fact.value_text, unit: fact.unit,
      reported_decimals: fact.reported_decimals,
      period_start: fact.period_start, period_end: fact.period_end, form: fact.form, filed_at: fact.filed_at,
      accession: fact.accession, source_url: citations.at(-1)!.sourceUrl });
  });
  filings.forEach((filing, index) => {
    const id = `S${index + 1}`;
    const sourceUrl = canonicalSecFilingUrl(filing.source_url, input.cik, filing.accession, filing.primary_document)!;
    citations.push({ id, filingId: filing.id, label: `${filing.form} · filed ${filing.filed_at} · report period ${filing.report_period ?? "not supplied"}`,
      sourceUrl });
    evidence.push({ citation_id: id, kind: "sec_filing_metadata", form: filing.form, filed_at: filing.filed_at,
      report_period: filing.report_period, accession: filing.accession, source_url: sourceUrl });
  });
  if (citations.length === 0) return json({ error: "selected_source_unavailable" }, 503, origin);

  const company = { cik: input.cik, ticker: issuerResult.data.ticker, name: issuerResult.data.issuer_name };
  const payload = companyAssessmentUserPayload(company, evidence);
  const providerResponse = await callProvider(input.provider, apiKey, payload, citations.map((citation) => citation.id), fetchImpl, request.signal);
  if (!providerResponse) return json({ error: "provider_request_failed" }, 502, origin);
  const assessment = validateCompanyEvidenceAssessment(providerResponse.output, new Set(citations.map((citation) => citation.id)));
  if (!assessment) return json({ error: "provider_output_invalid" }, 502, origin);
  const { output: _output, ...provenance } = providerResponse;
  const result = { provider: input.provider, model: providerResponse.modelReturned, ...provenance,
    promptVersion: COMPANY_ASSESSMENT_PROMPT_VERSION, generatedAt: new Date().toISOString(), assessment, citations };
  if (JSON.stringify(result).includes(apiKey)) return json({ error: "provider_output_invalid" }, 502, origin);
  return json(result, 200, origin);
}

if (import.meta.main) Deno.serve((request) => handle(request));
