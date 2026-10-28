/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {CompanyFundamentals,type CompanyFundamentalsProps,type PersistedFundamentalFact} from "../web/src/components/CompanyFundamentals.js";

const api=vi.hoisted(()=>({request:vi.fn(),readback:vi.fn()}));
vi.mock("../web/src/lib/api.js",async importOriginal=>({...await importOriginal<typeof import("../web/src/lib/api.js")>(),requestCompanyEvidenceAssessment:api.request,getCompanyEvidenceAssessment:api.readback}));
const fact:PersistedFundamentalFact={id:"00000000-0000-4000-8000-000000000001",companyId:"issuer-a",cik:"0000000001",metric:"revenue",taxonomy:"us-gaap",concept:"Revenue",unit:"USD",value:"123000",reportedDecimals:"-3",reportedPrecisionStatus:"declared",startDate:"2025-01-01",endDate:"2025-12-31",filingFocusYear:2025,filingFocusPeriod:"FY",durationClass:"annual",form:"10-K",accession:"0000000001-26-000001",filedAt:Date.UTC(2026,1,1),acceptedAt:Date.UTC(2026,1,1),retrievedAt:Date.UTC(2026,1,2),sourceUrl:"https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.htm",responseSha256:"a".repeat(64),companyFactsDeliveryId:"f",submissionsDeliveryId:"s",amended:false};
const secondFact:PersistedFundamentalFact={...fact,id:"00000000-0000-4000-8000-000000000002",concept:"OperatingIncome",value:"10000",accession:"0000000001-26-000002",sourceUrl:"https://www.sec.gov/Archives/edgar/data/1/000000000126000002/b.htm"};
const props:CompanyFundamentalsProps={companyId:"issuer-a",snapshotId:"snapshot-a",companyName:"Test Issuer",ticker:"TST",state:"ready",facts:[fact,secondFact],comparisons:[],points:[],coverage:[],refreshAllowed:false,onRefresh:vi.fn()};
function setValue(element:HTMLSelectElement,value:string){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event("change",{bubbles:true}));}
async function selectOpenAI(container:HTMLDivElement){await act(async()=>setValue(container.querySelector("select")!,"openai"));}
describe("local company assessment consent UI",()=>{let container:HTMLDivElement,root:Root;
  beforeEach(()=>{(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;api.request.mockReset();api.readback.mockReset();api.readback.mockResolvedValue(null);api.request.mockResolvedValue({provider:"google_gemini",model:"gemini-3.8-flash",promptVersion:"sec-company-evidence-assessment/1",generatedAt:"2026-10-01T00:00:00.000Z",assessment:{stance:"insufficient_evidence",summary:"Selected evidence is too sparse to establish a direction.",summaryCitationIds:["F1"],bullishEvidence:[],bearishEvidence:[],unknowns:["A multi-period trend is unknown."]},citations:[{id:"F1",factId:fact.id,label:"Revenue · 10-K",sourceUrl:fact.sourceUrl}]});container=document.createElement("div");document.body.append(container);root=createRoot(container);});
  afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
  it("previews the selected facts, applies Gemini paid-service gate, and sends one confirmed request",async()=>{
    await act(async()=>root.render(<CompanyFundamentals {...props}/>));
    expect(container.textContent).toContain("Preview exact data sent");expect(container.textContent).toContain(fact.accession);expect(container.textContent).toContain(fact.sourceUrl);
    const provider=container.querySelector("select")!;await act(async()=>setValue(provider,"google_gemini"));
    expect(container.textContent).toContain("a free-tier-only project is not eligible");expect(container.textContent).toContain("active Cloud Billing");
    expect(container.textContent).toContain("Google's Gemini API terms limit use to professional or business purposes, not consumer use");expect(container.textContent).toContain("Sentiment Desk cannot determine whether your personal or retail-investing use meets that requirement");
    const send=[...container.querySelectorAll("button")].find(button=>button.textContent?.includes("Send selected SEC facts")) as HTMLButtonElement;
    expect(send.disabled).toBe(true);expect(api.request).not.toHaveBeenCalled();
    const confirm=[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("I reviewed this exact preview"))!;
    const paid=[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("active Cloud Billing"))!;
    await act(async()=>{confirm.click();paid.click();});expect(send.disabled).toBe(false);
    const secondFactCheckbox=[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("OperatingIncome"))!;
    await act(async()=>secondFactCheckbox.click());
    expect(send.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("I reviewed this exact preview"))!.checked).toBe(false);
    await act(async()=>{[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("I reviewed this exact preview"))!.click();
      [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("active Cloud Billing"))!.click();});
    expect(send.disabled).toBe(false);
    await act(async()=>{send.click();await Promise.resolve();});
    expect(api.request).toHaveBeenCalledTimes(1);expect(api.request).toHaveBeenCalledWith("issuer-a",{cik:"0000000001",factIds:[fact.id],provider:"google_gemini",confirmSend:true,paidServiceAttested:true,usageReviewAcknowledged:false});
    expect(container.textContent).toContain("INSUFFICIENT EVIDENCE");expect(container.textContent).toContain("model-generated and not independently verified");
  });
  it("restores a saved result only for the current SEC snapshot and shows its fact lineage",async()=>{
    api.readback.mockResolvedValue({snapshotId:"snapshot-a",assessment:{reservationId:"attempt-a",provider:"openai",model:"gpt-6-luna",promptVersion:"sec-company-evidence-assessment/1",selectedFactIds:[fact.id],status:"completed",startedAt:Date.UTC(2026,9,1),completedAt:Date.UTC(2026,9,1),result:{provider:"openai",model:"gpt-6-luna",promptVersion:"sec-company-evidence-assessment/1",generatedAt:"2026-10-01T00:00:00.000Z",assessment:{stance:"bullish",summary:"Revenue expanded in the reported period.",summaryCitationIds:["F1"],bullishEvidence:[{claim:"Revenue was reported.",citationIds:["F1"]}],bearishEvidence:[],unknowns:["Persistence remains unknown."]},citations:[{id:"F1",factId:fact.id,label:"Revenue · 10-K",sourceUrl:fact.sourceUrl}]}},usageReview:{required:false,unresolvedCount:0}});
    await act(async()=>root.render(<CompanyFundamentals {...props}/>));
    await selectOpenAI(container);
    expect(container.textContent).toContain("SAVED RESULT");expect(container.textContent).toContain("Saved for Revenue.");expect(container.textContent).toContain("Revenue expanded in the reported period.");
    expect(api.readback).toHaveBeenCalledWith("issuer-a","openai",expect.any(AbortSignal));expect(api.request).not.toHaveBeenCalled();
  });
  it("withholds a saved result from a different SEC snapshot and pauses sending until status is reloaded",async()=>{
    api.readback.mockResolvedValue({snapshotId:"snapshot-old",assessment:{reservationId:"attempt-old",provider:"openai",model:"gpt-6-luna",promptVersion:"sec-company-evidence-assessment/1",selectedFactIds:[fact.id],status:"completed",startedAt:Date.UTC(2026,8,1),completedAt:Date.UTC(2026,8,1),result:{provider:"openai",model:"gpt-6-luna",promptVersion:"sec-company-evidence-assessment/1",generatedAt:"2026-09-01T00:00:00.000Z",assessment:{stance:"bearish",summary:"Stale snapshot summary must remain hidden.",summaryCitationIds:["F1"],bullishEvidence:[],bearishEvidence:[{claim:"A stale claim.",citationIds:["F1"]}],unknowns:[]},citations:[{id:"F1",factId:fact.id,label:"Revenue · 10-K",sourceUrl:fact.sourceUrl}]}},usageReview:{required:false,unresolvedCount:0}});
    await act(async()=>root.render(<CompanyFundamentals {...props}/>));
    await selectOpenAI(container);
    expect(container.textContent).toContain("Saved assessment status could not be checked");expect(container.textContent).not.toContain("SAVED RESULT");expect(container.textContent).not.toContain("Stale snapshot summary must remain hidden.");
    const send=[...container.querySelectorAll("button")].find(button=>button.textContent?.includes("Send selected SEC facts")) as HTMLButtonElement;
    expect(send.disabled).toBe(true);expect(api.request).not.toHaveBeenCalled();
  });
  it("requires provider usage review before authorizing a new attempt after unknown delivery",async()=>{
    api.readback.mockResolvedValue({snapshotId:"snapshot-a",assessment:{reservationId:"attempt-a",provider:"openai",model:"gpt-6-luna",promptVersion:"sec-company-evidence-assessment/1",selectedFactIds:[fact.id],status:"unknown_delivery",startedAt:Date.UTC(2026,9,1),completedAt:null,result:null},usageReview:{required:true,unresolvedCount:1}});
    await act(async()=>root.render(<CompanyFundamentals {...props}/>));
    await selectOpenAI(container);
    expect(container.textContent).toContain("The provider may have received this request");
    const send=[...container.querySelectorAll("button")].find(button=>button.textContent?.includes("Send selected SEC facts")) as HTMLButtonElement;
    expect(send.disabled).toBe(true);expect(api.request).not.toHaveBeenCalled();
    const review=[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("I reviewed provider usage"))!;
    const confirm=[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item=>item.parentElement?.textContent?.includes("I reviewed this exact preview"))!;
    await act(async()=>review.click());expect(send.disabled).toBe(true);
    await act(async()=>confirm.click());expect(send.disabled).toBe(false);
    await act(async()=>{send.click();await Promise.resolve();});
    expect(api.request).toHaveBeenCalledWith("issuer-a",{cik:"0000000001",factIds:[fact.id,secondFact.id],provider:"openai",confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:true});
  });
});
