import { createHash, randomUUID } from "node:crypto";
import {
  companyAssessmentInstructions, companyAssessmentJsonSchema, companyAssessmentUserPayload,
  validateCompanyEvidenceAssessment, parseCompanyAssessmentProviderResponse, OPENAI_COMPANY_ASSESSMENT_MODEL, GEMINI_COMPANY_ASSESSMENT_MODEL,
  COMPANY_ASSESSMENT_PROMPT_VERSION, type CompanyAssessmentCitation, type CompanyAssessmentInputEvidence,
  type CompanyAssessmentResult, type CompanyAssessmentReadback,
} from "../shared/company-evidence-assessment.js";
import type { Desk } from "./db.js";
import { ModelProviderCredentialVault } from "./model-provider-credential-vault.js";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import { canonicalSecFilingUrl } from "../shared/sec-filing-url.js";

export type CompanyAssessmentProvider = "openai" | "google_gemini";
export class CompanyEvidenceAssessmentError extends Error {
  constructor(readonly code:string,readonly status:number){super(code);this.name="CompanyEvidenceAssessmentError";}
}
const MAX_FACTS=12, MAX_BYTES=16_384, MAX_RESPONSE_BYTES=65_536, TIMEOUT_MS=30_000, DAILY_LIMIT=10;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}
function withoutMaxLength(value:unknown):unknown{
  if(Array.isArray(value))return value.map(withoutMaxLength);if(!record(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!=="maxLength").map(([key,v])=>[key,withoutMaxLength(v)]));
}
async function boundedResponseText(response:Response):Promise<string|null>{
  if(!response.body)return null;const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE_BYTES){await reader.cancel();return null;}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{return null;}
}
export function companyAssessmentProviderRequest(provider:CompanyAssessmentProvider,key:string,input:string,citationIds:string[]):{url:string;headers:Record<string,string>;body:Record<string,unknown>}{
  const schema=companyAssessmentJsonSchema(citationIds);
  if(provider==="openai")return {url:"https://api.openai.com/v1/responses",headers:{authorization:`Bearer ${key}`,"content-type":"application/json",accept:"application/json"},body:{model:OPENAI_COMPANY_ASSESSMENT_MODEL,instructions:companyAssessmentInstructions(),input,store:false,max_output_tokens:1800,text:{format:{type:"json_schema",name:"company_evidence_assessment",strict:true,schema}}}};
  return {url:`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_COMPANY_ASSESSMENT_MODEL}:generateContent`,headers:{"x-goog-api-key":key,"content-type":"application/json",accept:"application/json"},body:{systemInstruction:{parts:[{text:companyAssessmentInstructions()}]},contents:[{role:"user",parts:[{text:input}]}],generationConfig:{responseFormat:{text:{mimeType:"application/json",schema:withoutMaxLength(schema)}},temperature:0.2,maxOutputTokens:1800}}};
}

export class CompanyEvidenceAssessmentService {
  private inFlight=false;
  constructor(private readonly options:{loopbackBound:boolean;externalRequestsEnabled?:()=>boolean;db:Desk;vault:ModelProviderCredentialVault;fetcher?:typeof fetch;now?:()=>number}){}
  private now(){return (this.options.now??Date.now)();}
  async assess(input:{companyId:string;cik:string;factIds:string[];provider:CompanyAssessmentProvider;confirmSend:boolean;paidServiceAttested:boolean;usageReviewAcknowledged:boolean;signal?:AbortSignal}):Promise<CompanyAssessmentResult>{
    if(this.inFlight)throw new CompanyEvidenceAssessmentError("assessment_request_in_progress",429);
    this.inFlight=true;
    try{return await this.runAssessment(input);}finally{this.inFlight=false;}
  }
  private async runAssessment(input:{companyId:string;cik:string;factIds:string[];provider:CompanyAssessmentProvider;confirmSend:boolean;paidServiceAttested:boolean;usageReviewAcknowledged:boolean;signal?:AbortSignal}):Promise<CompanyAssessmentResult>{
    if(!this.options.loopbackBound)throw new CompanyEvidenceAssessmentError("loopback_only",403);
    if(!input.confirmSend)throw new CompanyEvidenceAssessmentError("send_confirmation_required",400);
    if(input.provider==="google_gemini"&&!input.paidServiceAttested)throw new CompanyEvidenceAssessmentError("gemini_paid_service_attestation_required",400);
    if(!/^\d{10}$/.test(input.cik)||input.factIds.length<1||input.factIds.length>MAX_FACTS||input.factIds.some(id=>!UUID.test(id))||new Set(input.factIds).size!==input.factIds.length)
      throw new CompanyEvidenceAssessmentError("invalid_request",400);
    if(this.options.externalRequestsEnabled&&!this.options.externalRequestsEnabled())throw new CompanyEvidenceAssessmentError("external_requests_disabled",503);
    if(!this.options.db.externalRequestAllowed())throw new CompanyEvidenceAssessmentError("storage_requests_paused",503);
    const selected=this.options.db.companyAssessmentEvidence(input.cik,input.factIds);
    if(!selected||selected.facts.some(fact=>fact.companyId!==input.companyId))throw new CompanyEvidenceAssessmentError("selected_source_changed",409);
    const evidence:CompanyAssessmentInputEvidence[]=[],citations:CompanyAssessmentCitation[]=[];
    for(const [index,fact] of selected.facts.entries()){
      let url:URL;try{url=new URL(fact.sourceUrl);}catch{throw new CompanyEvidenceAssessmentError("selected_source_unavailable",503);}
      const document=url.pathname.split("/").at(-1)??"";
      const sourceUrl=canonicalSecFilingUrl(fact.sourceUrl,input.cik,fact.accession,document);
      if(url.protocol!=="https:"||url.hostname!=="www.sec.gov"||!sourceUrl||fact.filedAt===null)throw new CompanyEvidenceAssessmentError("selected_source_unavailable",503);
      const id=`F${index+1}`;
      citations.push({id,factId:fact.id,label:`${fact.concept} · ${fact.form} · filed ${new Date(fact.filedAt).toISOString().slice(0,10)} · period ${fact.startDate?`${fact.startDate} to `:"instant "}${fact.endDate}`,sourceUrl});
      evidence.push({citation_id:id,kind:"reported_financial_fact",concept:fact.concept,value:fact.value,unit:fact.unit,reported_decimals:fact.reportedDecimals,
        period_start:fact.startDate,period_end:fact.endDate,form:fact.form,filed_at:new Date(fact.filedAt).toISOString().slice(0,10),accession:fact.accession,source_url:sourceUrl});
    }
    const payload=companyAssessmentUserPayload(selected.company,evidence),requestSha256=createHash("sha256").update(payload).digest("hex");
    if(Buffer.byteLength(payload)>MAX_BYTES)throw new CompanyEvidenceAssessmentError("request_too_large",413);
    let key:string|null=null;try{key=await this.options.vault.load(input.provider);}catch{throw new CompanyEvidenceAssessmentError("saved_credential_unavailable",503);}
    if(!key)throw new CompanyEvidenceAssessmentError("provider_key_not_configured",409);
    const startedAt=this.now(),attemptId=randomUUID(),model=input.provider==="openai"?OPENAI_COMPANY_ASSESSMENT_MODEL:GEMINI_COMPANY_ASSESSMENT_MODEL;
    const req=companyAssessmentProviderRequest(input.provider,key,payload,citations.map(c=>c.id));
    const reserved=this.options.db.reserveCompanyEvidenceAssessment({id:attemptId,companyId:selected.facts[0]!.companyId,cik:input.cik,snapshotId:selected.snapshotId,
      provider:input.provider,model,promptVersion:COMPANY_ASSESSMENT_PROMPT_VERSION,factIds:input.factIds,requestSha256,budgetDay:new Date(startedAt).toISOString().slice(0,10),
      reservedAt:startedAt,usageReviewAcknowledged:input.usageReviewAcknowledged,dailyLimit:DAILY_LIMIT});
    if(reserved.kind==="source_changed")throw new CompanyEvidenceAssessmentError("selected_source_changed",409);
    if(reserved.kind==="usage_review_required")throw new CompanyEvidenceAssessmentError("usage_review_required",409);
    if(reserved.kind==="daily_limit")throw new CompanyEvidenceAssessmentError("daily_request_limit",429);
    const controller=new AbortController();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},TIMEOUT_MS);
    const abort=()=>controller.abort();input.signal?.addEventListener("abort",abort,{once:true});
    let status:"completed"|"invalid_output"|"rejected"|"unknown_delivery"|"not_sent"="unknown_delivery",result:CompanyAssessmentResult|null=null;
    try{
      const response=await (this.options.fetcher??fetch)(req.url,{method:"POST",headers:req.headers,body:JSON.stringify(req.body),signal:controller.signal,redirect:"error",cache:"no-store"});
      if(!response.ok){await response.body?.cancel();status="rejected";}
      else {
        const len=response.headers.get("content-length");if(len&&(!/^\d+$/.test(len)||Number(len)>MAX_RESPONSE_BYTES)){await response.body?.cancel();status="invalid_output";}
        else {
          const bodyText=await boundedResponseText(response);
          if(bodyText===null)status="invalid_output";
          else {
            let decoded:unknown;try{decoded=JSON.parse(bodyText) as unknown;}catch{decoded=null;}
            const providerResponse=parseCompanyAssessmentProviderResponse(input.provider,decoded);
            const assessment=providerResponse&&validateCompanyEvidenceAssessment(providerResponse.output,new Set(citations.map(c=>c.id)));
            if(!assessment||!providerResponse)status="invalid_output";
            else {const {output:_output,...provenance}=providerResponse;
              result={provider:input.provider,model:providerResponse.modelReturned,...provenance,promptVersion:COMPANY_ASSESSMENT_PROMPT_VERSION,generatedAt:new Date(this.now()).toISOString(),assessment,citations};
              if(JSON.stringify(result).includes(key)){result=null;status="invalid_output";}else status="completed";}
          }
        }
      }
    }catch(error){status=error instanceof ExternalRequestPausedError?"not_sent":"unknown_delivery";}
    finally{clearTimeout(timer);input.signal?.removeEventListener("abort",abort);key=null;}
    // A timeout/connection loss after dispatch is ambiguous. Save it and never retry automatically.
    if(timedOut)status="unknown_delivery";
    this.options.db.completeCompanyEvidenceAssessmentReservation({reservationId:attemptId,status,completedAt:this.now(),result});
    if(status!=="completed")throw new CompanyEvidenceAssessmentError(status==="not_sent"?"external_requests_paused":status==="unknown_delivery"?"unknown_delivery":status==="rejected"?"provider_rejected":"provider_output_invalid",status==="rejected"?502:status==="unknown_delivery"?504:status==="not_sent"?503:502);
    return result!;
  }
  readback(companyId:string,provider:CompanyAssessmentProvider):CompanyAssessmentReadback|null{
    const latest=this.options.db.latestCompanyEvidenceAssessment(companyId,provider);
    if(!latest)return null;
    return {...latest,usageReview:this.options.db.companyAssessmentUsageReviewState(provider)};
  }
}
