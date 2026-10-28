import { buildProviderRequest, callProvider, handle, isValidSecFilingUrl, parseAssessmentRequest, sourceUrlForFact } from "./index.ts";
import { canonicalSecFilingUrl } from "../../../shared/sec-filing-url.ts";
import { GEMINI_COMPANY_ASSESSMENT_MODEL, OPENAI_COMPANY_ASSESSMENT_MODEL } from "../../../shared/company-evidence-assessment.ts";

const factSnapshotId = "11111111-1111-4111-8111-111111111111";
const filingSnapshotId = "22222222-2222-4222-8222-222222222222";
const factId = "33333333-3333-4333-8333-333333333333";
const filingId = "44444444-4444-4444-8444-444444444444";

const assessmentPayload = { stance: "insufficient_evidence", summary: "Reported revenue alone cannot establish the investment case.",
  summary_citation_ids: ["F1"], bullish_evidence: [], bearish_evidence: [], unknowns: ["Operating context is missing."] };
function providerEnvelope(provider: "openai" | "google_gemini"): Record<string, unknown> {
  return provider === "openai" ? { id: "resp_cloud_test", model: OPENAI_COMPANY_ASSESSMENT_MODEL, status: "completed",
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
    output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(assessmentPayload) }] }] }
    : { responseId: "gemini_cloud_test", modelVersion: GEMINI_COMPANY_ASSESSMENT_MODEL,
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 0, totalTokenCount: 130 },
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(assessmentPayload) }] } }] };
}
async function callFixture(provider: "openai" | "google_gemini", envelope: Record<string, unknown>) {
  const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify(envelope), { status: 200 }));
  return await callProvider(provider, "test-provider-key-123456", "{}", ["F1"], fetcher, new AbortController().signal);
}

for (const provider of ["openai", "google_gemini"] as const) {
  Deno.test(`${provider} cloud assessment preserves the successful provider envelope`, async () => {
    const result = await callFixture(provider, providerEnvelope(provider));
    if (!result || result.modelReturned !== (provider === "openai" ? OPENAI_COMPANY_ASSESSMENT_MODEL : GEMINI_COMPANY_ASSESSMENT_MODEL)
      || result.modelRequested !== result.modelReturned || result.responseId !== (provider === "openai" ? "resp_cloud_test" : "gemini_cloud_test")
      || result.providerStatus !== (provider === "openai" ? "completed" : "STOP")
      || result.usage?.inputTokens !== 100 || result.usage.outputTokens !== 30 || result.usage.totalTokens !== 130
      || result.usage.cachedInputTokens !== null || JSON.stringify(result.output) !== JSON.stringify(assessmentPayload)) {
      throw new Error("provider provenance was lost or fabricated");
    }
  });
  Deno.test(`${provider} cloud assessment rejects a mismatched or missing returned model`, async () => {
    const modelField = provider === "openai" ? "model" : "modelVersion";
    for (const model of ["unrequested-model", undefined]) {
      const envelope = providerEnvelope(provider);
      envelope[modelField] = model;
      if (await callFixture(provider, envelope) !== null) throw new Error("unattributable model output was accepted");
    }
  });
  Deno.test(`${provider} cloud assessment rejects an incomplete or missing completion state`, async () => {
    for (const status of ["incomplete", undefined]) {
      const envelope = providerEnvelope(provider);
      if (provider === "openai") envelope.status = status;
      else envelope.candidates = [{ finishReason: status, content: { parts: [{ text: JSON.stringify(assessmentPayload) }] } }];
      if (await callFixture(provider, envelope) !== null) throw new Error("incomplete provider output was accepted");
    }
  });
}

Deno.test("cloud assessment rejects invalid usage and incomplete message envelopes", async () => {
  const invalidUsage = { ...providerEnvelope("openai"), usage: { input_tokens: 100, output_tokens: 30, total_tokens: 999 } };
  const incompleteMessage = { ...providerEnvelope("openai"), output: [{ type: "message", status: "in_progress", content: [{ type: "output_text", text: JSON.stringify(assessmentPayload) }] }] };
  const missingId = { ...providerEnvelope("openai"), id: undefined };
  for (const envelope of [invalidUsage, incompleteMessage, missingId]) {
    if (await callFixture("openai", envelope) !== null) throw new Error("invalid envelope was accepted");
  }
});

Deno.test("assessment request accepts only provider and bounded source row identifiers", () => {
  const parsed = parseAssessmentRequest({ provider: "google_gemini", cik: "0001786108", factSnapshotId,
    filingSnapshotId, factIds: [factId], filingIds: [filingId], paidServiceAttested: true });
  if (!parsed || parsed.provider !== "google_gemini" || !parsed.paidServiceAttested || parsed.factIds[0] !== factId || parsed.filingIds[0] !== filingId) {
    throw new Error("valid request was not accepted");
  }
  const openAi = parseAssessmentRequest({ provider: "openai", cik: "0001786108", factSnapshotId,
    filingSnapshotId, factIds: [factId], filingIds: [filingId], paidServiceAttested: false });
  if (!openAi || openAi.provider !== "openai" || openAi.paidServiceAttested) throw new Error("OpenAI request was incorrectly gated by the Gemini-only attestation");
  if (parseAssessmentRequest({ provider: "google_gemini", cik: "0001786108", factSnapshotId,
    filingSnapshotId, factIds: [], filingIds: [] }) !== null) throw new Error("empty evidence was accepted");
  if (parseAssessmentRequest({ provider: "google_gemini", cik: "0001786108", factSnapshotId,
    filingSnapshotId, factIds: [factId, factId], filingIds: [] }) !== null) throw new Error("duplicate evidence id was accepted");
  if (parseAssessmentRequest({ provider: "google_gemini", cik: "0001786108", factSnapshotId,
    filingSnapshotId, factIds: Array.from({ length: 13 }, (_, index) => `33333333-3333-4333-8333-8${String(index + 1).padStart(11, "0")}`), filingIds: [] }) !== null) {
    throw new Error("oversized evidence request was accepted");
  }
  if (parseAssessmentRequest({ provider: "openai", cik: "0001786108", factSnapshotId,
    filingSnapshotId, factIds: [factId], filingIds: [], prompt: "client instructions" }) !== null) throw new Error("client prompt field was accepted");
});

Deno.test("Gemini requests without affirmative Paid Services attestation stop before credentials or provider dispatch", async () => {
  let providerCalls = 0;
  const fetcher: typeof fetch = async () => {
    providerCalls += 1;
    return new Response("{}", { status: 200 });
  };
  for (const paidServiceAttested of [undefined, false]) {
    const body = { provider: "google_gemini", cik: "0001786108", factSnapshotId, filingSnapshotId,
      factIds: [factId], filingIds: [filingId], ...(paidServiceAttested === undefined ? {} : { paidServiceAttested }) };
    const response = await handle(new Request("https://desk.example/functions/v1/assess-company-evidence", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), fetcher);
    const result = await response.json() as { error?: string };
    if (response.status !== 400 || result.error !== "gemini_paid_service_attestation_required") {
      throw new Error("Gemini request without a true Paid Services attestation was not blocked before provider credentials/authentication");
    }
  }
  const openAiResponse = await handle(new Request("https://desk.example/functions/v1/assess-company-evidence", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "openai", cik: "0001786108", factSnapshotId, filingSnapshotId,
      factIds: [factId], filingIds: [filingId], paidServiceAttested: false }),
  }), fetcher);
  const openAiResult = await openAiResponse.json() as { error?: string };
  if (openAiResponse.status !== 400 || openAiResult.error !== "provider_key_required") {
    throw new Error("OpenAI request was incorrectly blocked by the Gemini-only Paid Services attestation");
  }
  if (providerCalls !== 0) throw new Error("Provider request was dispatched without a true Paid Services attestation");
});

Deno.test("SEC filing citations canonicalize archive identity to the selected issuer", () => {
  const accession = "0001193125-26-418097";
  const observed = "https://www.sec.gov/Archives/edgar/data/1786108/000119312526418097/trin-20261008.htm";
  const oldAgentPath = observed.replace("/1786108/", "/1193125/");
  if (!isValidSecFilingUrl(observed, accession, "trin-20261008.htm")) throw new Error("observed issuer archive URL was rejected");
  if (!isValidSecFilingUrl(oldAgentPath, accession, "trin-20261008.htm")) throw new Error("prior saved archive URL could not be normalized");
  if (canonicalSecFilingUrl(oldAgentPath, "0001786108", accession, "trin-20261008.htm") !== observed) {
    throw new Error("prior saved URL was not normalized to the submission issuer's archive");
  }
  if (isValidSecFilingUrl(observed.replace("www.sec.gov", "example.com"), accession, "trin-20261008.htm")) throw new Error("non-SEC host was accepted");
  if (isValidSecFilingUrl(observed, accession, "../outside.htm")) throw new Error("unsafe primary document was accepted");
});

Deno.test("fact citation URL uses only a user-selected filing, matching the request preview", () => {
  const accession = "0001193125-26-418097";
  const selectedFiling = { id: filingId, cik: "0001786108", accession, form: "10-K", filed_at: "2026-10-08",
    report_period: "2026-06-30", primary_document: "trin-20261008.htm",
    source_url: "https://www.sec.gov/Archives/edgar/data/1193125/000119312526418097/trin-20261008.htm" };
  const direct = "https://www.sec.gov/Archives/edgar/data/1786108/000119312526418097/trin-20261008.htm";
  const index = "https://www.sec.gov/Archives/edgar/data/1786108/000119312526418097/index.json";
  if (sourceUrlForFact("0001786108", accession, selectedFiling) !== direct) throw new Error("selected filing URL was not canonicalized");
  if (sourceUrlForFact("0001786108", accession, undefined) !== index) throw new Error("unselected filing leaked into the fact citation URL");
});

Deno.test("provider request keeps BYOK in the provider authorization header", () => {
  const apiKey = "AIzaSy-example-provider-key-123456";
  const evidence = JSON.stringify({ company: { ticker: "TST" }, evidence: [{ citation_id: "F1", value: "123" }] });
  const gemini = buildProviderRequest("google_gemini", apiKey, evidence, ["F1"]);
  const geminiBody = JSON.stringify(gemini.body);
  if (!gemini.url.startsWith("https://generativelanguage.googleapis.com/") || !gemini.headers["x-goog-api-key"].includes(apiKey)
    || gemini.url.includes(apiKey) || geminiBody.includes(apiKey) || !geminiBody.includes('"responseFormat"')
    || !geminiBody.includes('"mimeType":"application/json"') || geminiBody.includes("maxLength")) {
    throw new Error("Gemini request does not follow the expected request-only structured-output contract");
  }
  const openai = buildProviderRequest("openai", "sk-example-key-123456", evidence, ["F1"]);
  if (!openai.url.endsWith("/v1/responses") || openai.body.store !== false
    || JSON.stringify(openai.body).includes("sk-example-key-123456") || openai.headers.authorization !== "Bearer sk-example-key-123456") {
    throw new Error("OpenAI request does not follow the expected request-only response contract");
  }
});
