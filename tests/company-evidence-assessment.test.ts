import { describe, expect, it } from "vitest";
import {
  companyAssessmentInstructions,
  companyAssessmentJsonSchema,
  companyAssessmentUserPayload,
  validateCompanyEvidenceAssessment,
  parseCompanyAssessmentProviderResponse,
  OPENAI_COMPANY_ASSESSMENT_MODEL,
  GEMINI_COMPANY_ASSESSMENT_MODEL,
} from "../shared/company-evidence-assessment.js";

const valid = {
  stance: "mixed",
  summary: "Revenue increased while operating cash flow declined.",
  summary_citation_ids: ["F1", "F2"],
  bullish_evidence: [{ claim: "Revenue increased year over year.", citation_ids: ["F1"] }],
  bearish_evidence: [{ claim: "Operating cash flow declined.", citation_ids: ["F2"] }],
  unknowns: ["The selected data do not establish whether the changes will continue."],
};

describe("company evidence assessment boundary", () => {
  const openaiEnvelope = { id: "resp_boundary_test", status: "completed", model: OPENAI_COMPANY_ASSESSMENT_MODEL,
    output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(valid) }] }] };
  const geminiEnvelope = { modelVersion: GEMINI_COMPANY_ASSESSMENT_MODEL,
    candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(valid) }] } }] };

  it("keeps absent usage and optional Gemini response IDs unknown", () => {
    expect(parseCompanyAssessmentProviderResponse("openai", openaiEnvelope)).toMatchObject({usage: null, responseId: "resp_boundary_test"});
    expect(parseCompanyAssessmentProviderResponse("google_gemini", geminiEnvelope)).toMatchObject({usage: null, responseId: null});
    expect(parseCompanyAssessmentProviderResponse("google_gemini", {...geminiEnvelope,
      usageMetadata: {promptTokenCount:100,candidatesTokenCount:30,totalTokenCount:135}})).toMatchObject({
      usage:{inputTokens:100,candidateTokens:30,outputTokens:null,reasoningTokens:null,totalTokens:135,cachedInputTokens:null}});
  });

  it("preserves actual OpenAI snapshots and rejects other model aliases", () => {
    const snapshot = `${OPENAI_COMPANY_ASSESSMENT_MODEL}-2026-10-01`;
    expect(parseCompanyAssessmentProviderResponse("openai", {...openaiEnvelope, model:snapshot})).toMatchObject({
      modelRequested:OPENAI_COMPANY_ASSESSMENT_MODEL,modelReturned:snapshot});
    expect(parseCompanyAssessmentProviderResponse("openai", {...openaiEnvelope, model:`${OPENAI_COMPANY_ASSESSMENT_MODEL}-preview`})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("google_gemini", {...geminiEnvelope, modelVersion:`${GEMINI_COMPANY_ASSESSMENT_MODEL}-other`})).toBeNull();
  });

  it("rejects invalid token counts and impossible complete totals", () => {
    for (const usage of [
      {input_tokens:-1,output_tokens:30,total_tokens:29},
      {input_tokens:100,output_tokens:30,total_tokens:131},
      {input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cached_tokens:101}},
      {input_tokens:100,output_tokens:30,total_tokens:130,output_tokens_details:{reasoning_tokens:31}},
    ]) expect(parseCompanyAssessmentProviderResponse("openai", {...openaiEnvelope,usage})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("google_gemini", {...geminiEnvelope,
      usageMetadata:{promptTokenCount:100,candidatesTokenCount:30,thoughtsTokenCount:5,totalTokenCount:130}})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("google_gemini", {...geminiEnvelope,
      usageMetadata:{promptTokenCount:100,candidatesTokenCount:30,totalTokenCount:129}})).toBeNull();
  });

  it("rejects refusal, blocked, ambiguous, or incomplete structured-output messages", () => {
    expect(parseCompanyAssessmentProviderResponse("openai", {...openaiEnvelope,output:[{type:"message",status:"completed",content:[{type:"refusal",refusal:"No"}]}]})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("openai", {...openaiEnvelope,incomplete_details:{reason:"max_output_tokens"}})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("openai", {...openaiEnvelope,output:[...openaiEnvelope.output,...openaiEnvelope.output]})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("google_gemini", {...geminiEnvelope,promptFeedback:{blockReason:"SAFETY"}})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("google_gemini", {...geminiEnvelope,candidates:[...geminiEnvelope.candidates,...geminiEnvelope.candidates]})).toBeNull();
    expect(parseCompanyAssessmentProviderResponse("google_gemini", {...geminiEnvelope,promptFeedback:{safetyRatings:[]}})).not.toBeNull();
  });

  it("requires each summary and evidence claim to cite only selected evidence IDs", () => {
    const allowed = new Set(["F1", "F2"]);
    expect(validateCompanyEvidenceAssessment(valid, allowed)).toMatchObject({
      stance: "mixed", summaryCitationIds: ["F1", "F2"],
      bullishEvidence: [{ citationIds: ["F1"] }], bearishEvidence: [{ citationIds: ["F2"] }],
    });
    expect(validateCompanyEvidenceAssessment({ ...valid, summary_citation_ids: [] }, allowed)).toBeNull();
    expect(validateCompanyEvidenceAssessment({ ...valid, summary_citation_ids: ["F3"] }, allowed)).toBeNull();
    expect(validateCompanyEvidenceAssessment({ ...valid, summary_citation_ids: ["F1", "F1"] }, allowed)).toBeNull();
  });

  it("rejects unsupported stances and uncited factual evidence points", () => {
    expect(validateCompanyEvidenceAssessment({ ...valid, stance: "bullish", bullish_evidence: [] }, new Set(["F1", "F2"]))).toBeNull();
    expect(validateCompanyEvidenceAssessment({ ...valid,
      bullish_evidence: [{ claim: "Revenue increased.", citation_ids: [] }],
    }, new Set(["F1", "F2"]))).toBeNull();
  });

  it("rejects common recommendations, forecasts, targets, and valuation wording", () => {
    const prohibited = ["Buy now. Revenue doubled.", "Revenue will double next year.", "Investors should buy.",
      "The price target is $200.", "Fair value is $200.", "Revenue is expected to grow.", "The company is likely to outperform."];
    for (const summary of prohibited) {
      expect(validateCompanyEvidenceAssessment({ ...valid, summary }, new Set(["F1", "F2"])), summary).toBeNull();
    }
  });

  it("allows valuation to be named as an unknown without asserting a value", () => {
    expect(validateCompanyEvidenceAssessment({ ...valid, unknowns: ["Valuation remains unknown."] }, new Set(["F1", "F2"])))
      .toMatchObject({ stance: "mixed", unknowns: ["Valuation remains unknown."] });
  });

  it("builds a closed JSON schema and explicitly requires cited summary claims", () => {
    const schema = companyAssessmentJsonSchema(["F2", "F1", "F1"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("summary_citation_ids");
    expect(JSON.stringify(schema.properties.summary_citation_ids)).toContain("F1");
    expect(companyAssessmentInstructions()).toContain("summary_citation_ids");
    expect(companyAssessmentInstructions()).toContain("reported_decimals");
    expect(companyAssessmentInstructions()).toContain("Do not provide a recommendation, forecast, price target, valuation, probability");
  });

  it("preserves SEC-reported precision in the exact provider evidence payload", () => {
    const payload = companyAssessmentUserPayload({ cik: "0000000001", ticker: "TST", name: "Test Issuer" }, [{
      citation_id: "F1", kind: "reported_financial_fact", concept: "Revenue", value: "1001", unit: "USD",
      reported_decimals: "0", period_start: "2025-01-01", period_end: "2025-12-31", form: "10-K", filed_at: "2026-02-01",
      accession: "0000000001-26-000001", source_url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/index.json",
    }]);
    expect(payload).toContain('"reported_decimals": "0"');
  });
});
