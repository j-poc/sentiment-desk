import { describe,expect,it,vi } from "vitest";
import { CompanyEvidenceAssessmentError,CompanyEvidenceAssessmentService,companyAssessmentProviderRequest } from "../server/company-evidence-assessment.js";
import { ExternalRequestPausedError } from "../server/external-request-gate.js";
import type { Desk } from "../server/db.js";
import type { ModelProviderCredentialVault } from "../server/model-provider-credential-vault.js";
import type { PersistedFundamentalFact } from "../shared/company-fundamentals.js";
import { OPENAI_COMPANY_ASSESSMENT_MODEL, GEMINI_COMPANY_ASSESSMENT_MODEL } from "../shared/company-evidence-assessment.js";

const secret="provider-test-secret-that-never-leaves-server";
const fact=(id:string,concept:string,value:string):PersistedFundamentalFact=>({id,companyId:"issuer-a",cik:"0000000001",metric:"revenue",taxonomy:"us-gaap",concept,unit:"USD",value,
  reportedDecimals:"INF",reportedPrecisionStatus:"declared",startDate:"2025-01-01",endDate:"2025-12-31",filingFocusYear:2025,filingFocusPeriod:"FY",durationClass:"annual",
  form:"10-K",accession:`0000000001-26-00000${id.endsWith("1")?"1":"2"}`,filedAt:Date.UTC(2026,1,1),acceptedAt:Date.UTC(2026,1,1),retrievedAt:Date.UTC(2026,1,2),
  sourceUrl:`https://www.sec.gov/Archives/edgar/data/1/${id.endsWith("1")?"000000000126000001":"000000000126000002"}/a.htm`,responseSha256:"a".repeat(64),companyFactsDeliveryId:"f",submissionsDeliveryId:"s",amended:false});
const F1=fact("00000000-0000-4000-8000-000000000001","Revenue","100");
const F2=fact("00000000-0000-4000-8000-000000000002","OperatingIncome","10");
function setup(fetcher:typeof fetch,selected=[F1,F2],externalRequestsEnabled=()=>true){
  const attempts:Array<Record<string,unknown>>=[];let usageReviewRequired=false;
  const db={externalRequestAllowed:()=>true,companyAssessmentEvidence:(cik:string,ids:string[])=>cik==="0000000001"&&ids.every(id=>selected.some(f=>f.id===id))?{company:{cik,ticker:"TST",name:"Test Issuer"},snapshotId:"snapshot",facts:ids.map(id=>selected.find(f=>f.id===id)!)}:null,
    reserveCompanyEvidenceAssessment:(input:Record<string,unknown>)=>{attempts.push({phase:"reserved",...input});return usageReviewRequired&&!input.usageReviewAcknowledged?{kind:"usage_review_required",unresolvedCount:1}:{kind:"reserved",unresolvedCount:usageReviewRequired?1:0};},
    completeCompanyEvidenceAssessmentReservation:(input:Record<string,unknown>)=>attempts.push({phase:"receipt",...input}),
    latestCompanyEvidenceAssessment:()=>({snapshotId:"snapshot",assessment:null}),companyAssessmentUsageReviewState:()=>({required:usageReviewRequired,unresolvedCount:usageReviewRequired?1:0})} as unknown as Desk;
  const vault={load:vi.fn(async()=>secret)} as unknown as ModelProviderCredentialVault;
  return {service:new CompanyEvidenceAssessmentService({loopbackBound:true,externalRequestsEnabled,db,vault,fetcher,now:()=>Date.UTC(2026,5,1)}),attempts,vault,setUsageReview:(value:boolean)=>{usageReviewRequired=value;}};
}
const parsed={stance:"mixed",summary:"Revenue increased while operating income remains limited.",summary_citation_ids:["F1","F2"],
  bullish_evidence:[{claim:"Revenue increased.",citation_ids:["F1"]}],bearish_evidence:[{claim:"Operating income is lower than revenue.",citation_ids:["F2"]}],unknowns:["The selected facts do not establish persistence."]};
function providerEnvelope(provider: "openai" | "google_gemini" = "openai", payload: unknown = parsed): Record<string, unknown> {
  return provider === "openai" ? { id: "resp_assessment_test", model: OPENAI_COMPANY_ASSESSMENT_MODEL, status: "completed",
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 5 } },
    output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(payload) }] }] }
    : { responseId: "gemini_assessment_test", modelVersion: GEMINI_COMPANY_ASSESSMENT_MODEL,
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 5, totalTokenCount: 135 },
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(payload) }] } }] };
}
function providerResponse(envelope = providerEnvelope()){return new Response(JSON.stringify(envelope),{status:200,headers:{"content-type":"application/json"}});}

describe("local company evidence assessment",()=>{
  it("requires explicit send approval and a Gemini paid-service attestation before key access",async()=>{
    const fetcher=vi.fn<typeof fetch>();const {service,vault}=setup(fetcher);
    await expect(service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id],provider:"google_gemini",confirmSend:false,paidServiceAttested:true,usageReviewAcknowledged:false})).rejects.toMatchObject({code:"send_confirmation_required"});
    await expect(service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id],provider:"google_gemini",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false})).rejects.toMatchObject({code:"gemini_paid_service_attestation_required"});
    expect(vault.load).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
  });
  it("honors the global external request switch before key access or reservation",async()=>{
    const fetcher=vi.fn<typeof fetch>();const {service,vault,attempts}=setup(fetcher,undefined,()=>false);
    await expect(service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id],provider:"openai",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false})).rejects.toMatchObject({code:"external_requests_disabled"});
    expect(vault.load).not.toHaveBeenCalled();expect(attempts).toHaveLength(0);expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends only server-loaded selected facts, validates citations, and appends the result without the key",async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>providerResponse());const {service,attempts}=setup(fetcher);
    const result=await service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id,F2.id],provider:"openai",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false});
    expect(result.assessment.stance).toBe("mixed");expect(result.citations.map(c=>c.factId)).toEqual([F1.id,F2.id]);
    expect(result).toMatchObject({model: OPENAI_COMPANY_ASSESSMENT_MODEL, modelRequested: OPENAI_COMPANY_ASSESSMENT_MODEL,
      modelReturned: OPENAI_COMPANY_ASSESSMENT_MODEL, responseId: "resp_assessment_test", providerStatus: "completed",
      usage: {inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: null, outputTokens: 30, reasoningTokens: 5, totalTokens: 130}});
    const [url,init]=fetcher.mock.calls[0]!;expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect((init?.headers as Record<string,string>).authorization).toBe(`Bearer ${secret}`);
    expect(String(init?.body)).toContain("Revenue");expect(String(init?.body)).not.toContain(secret);
    expect(attempts).toHaveLength(2);expect(attempts[0]).toMatchObject({phase:"reserved",snapshotId:"snapshot",factIds:[F1.id,F2.id],usageReviewAcknowledged:false});expect(attempts[1]).toMatchObject({phase:"receipt",status:"completed",reservationId:attempts[0]!.id,result});
    expect(JSON.stringify(attempts)).not.toContain(secret);
  });
  it("rejects company/snapshot selection changes and unselected citations",async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>providerResponse());const {service,attempts}=setup(fetcher);
    await expect(service.assess({companyId:"other-company",cik:"0000000001",factIds:[F1.id],provider:"openai",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false})).rejects.toMatchObject({code:"selected_source_changed"});
    const invalidBody={...parsed,summary_citation_ids:["F99"]};
    const invalidFetcher=vi.fn<typeof fetch>(async()=>providerResponse(providerEnvelope("openai", invalidBody)));
    const invalid=setup(invalidFetcher);
    await expect(invalid.service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id],provider:"openai",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false})).rejects.toMatchObject({code:"provider_output_invalid"});
    expect(fetcher).not.toHaveBeenCalled();expect(attempts).toHaveLength(0);expect(invalid.attempts[1]).toMatchObject({status:"invalid_output",result:null,reservationId:invalid.attempts[0]!.id});
  });
  it("records ambiguous delivery and never retries it automatically",async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>{throw new Error("socket closed after request dispatch");});const {service,attempts}=setup(fetcher);
    await expect(service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id],provider:"openai",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false})).rejects.toBeInstanceOf(CompanyEvidenceAssessmentError);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(attempts[1]).toMatchObject({status:"unknown_delivery",result:null,reservationId:attempts[0]!.id});
  });
  it("records a final-boundary pause as not sent and does not mark provider usage unknown",async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>{throw new ExternalRequestPausedError();});const {service,attempts}=setup(fetcher);
    await expect(service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id],provider:"openai",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false}))
      .rejects.toMatchObject({code:"external_requests_paused",status:503});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(attempts[1]).toMatchObject({status:"not_sent",result:null,reservationId:attempts[0]!.id});
  });
  it("requires usage review before dispatch after unresolved delivery and includes it on the next reservation",async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>providerResponse());const {service,attempts,setUsageReview}=setup(fetcher);setUsageReview(true);
    const input={companyId:"issuer-a",cik:"0000000001",factIds:[F1.id,F2.id],provider:"openai" as const,confirmSend:true,paidServiceAttested:false};
    await expect(service.assess({...input,usageReviewAcknowledged:false})).rejects.toMatchObject({code:"usage_review_required"});expect(fetcher).not.toHaveBeenCalled();
    await service.assess({...input,usageReviewAcknowledged:true});expect(fetcher).toHaveBeenCalledTimes(1);expect(attempts.at(-2)).toMatchObject({phase:"reserved",usageReviewAcknowledged:true});
  });
  it("keeps OpenAI and Gemini transport credentials in headers and separate from user evidence",()=>{
    const openai=companyAssessmentProviderRequest("openai",secret,"evidence",["F1"]);
    const gemini=companyAssessmentProviderRequest("google_gemini",secret,"evidence",["F1"]);
    expect(openai.headers.authorization).toBe(`Bearer ${secret}`);expect(JSON.stringify(openai.body)).not.toContain(secret);
    expect(gemini.headers["x-goog-api-key"]).toBe(secret);expect(JSON.stringify(gemini.body)).not.toContain(secret);
  });
  it("preserves Gemini response identity, completion state, and thought-inclusive output usage", async () => {
    const {service, attempts}=setup(async()=>providerResponse(providerEnvelope("google_gemini")));
    const result=await service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id,F2.id],provider:"google_gemini",confirmSend:true,paidServiceAttested:true,usageReviewAcknowledged:false});
    expect(result).toMatchObject({model: GEMINI_COMPANY_ASSESSMENT_MODEL, modelRequested: GEMINI_COMPANY_ASSESSMENT_MODEL,
      modelReturned: GEMINI_COMPANY_ASSESSMENT_MODEL, responseId: "gemini_assessment_test", providerStatus: "STOP",
      usage:{inputTokens:100,cachedInputTokens:null,cacheWriteInputTokens:null,outputTokens:35,reasoningTokens:5,totalTokens:135}});
    expect(attempts[1]).toMatchObject({status:"completed",result});
  });
  for (const provider of ["openai", "google_gemini"] as const) {
    it(`${provider} rejects unverified model and completion envelopes before saving an assessment`, async () => {
      const modelField=provider==="openai"?"model":"modelVersion";
      const badEnvelopes=[{...providerEnvelope(provider),[modelField]:"unrequested-model"},
        {...providerEnvelope(provider),[modelField]:undefined},
        provider==="openai"?{...providerEnvelope(provider),status:"incomplete"}:{...providerEnvelope(provider),candidates:[{finishReason:"MAX_TOKENS",content:{role:"model",parts:[{text:JSON.stringify(parsed)}]}}]},
        provider==="openai"?{...providerEnvelope(provider),id:undefined}:{...providerEnvelope(provider),responseId:secret}];
      for (const envelope of badEnvelopes) {
        const fetcher=vi.fn<typeof fetch>(async()=>providerResponse(envelope));const {service,attempts}=setup(fetcher);
        await expect(service.assess({companyId:"issuer-a",cik:"0000000001",factIds:[F1.id,F2.id],provider,confirmSend:true,paidServiceAttested:true,usageReviewAcknowledged:false})).rejects.toMatchObject({code:"provider_output_invalid"});
        expect(fetcher).toHaveBeenCalledTimes(1);expect(attempts[1]).toMatchObject({status:"invalid_output",result:null});
        expect(JSON.stringify(attempts)).not.toContain(secret);
      }
    });
  }
});
