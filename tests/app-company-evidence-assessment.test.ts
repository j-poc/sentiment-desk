import { afterEach,describe,expect,it,vi } from "vitest";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp,type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { loadCompanies } from "../server/config.js";

const company=loadCompanies().find(item=>item.ticker==="AAPL")!;const desks:Desk[]=[];const dirs:string[]=[];
afterEach(()=>{while(desks.length)desks.pop()!.close();while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});});
function appFor(assess:ReturnType<typeof vi.fn>){const dir=mkdtempSync(join(tmpdir(),"company-assessment-route-"));dirs.push(dir);const db=new Desk(join(dir,"desk.sqlite"));db.seedCompanies([company]);desks.push(db);
  return createApp({db,dbPath:join(dir,"desk.sqlite"),pipeline:{} as AppDeps["pipeline"],market:{} as AppDeps["market"],hub:new Hub(),health:new HealthTracker(false,false,"unconfigured"),version:"test",deliverySources:[],
    companyEvidenceAssessment:{assess,readback:()=>({snapshotId:"snapshot-1",assessment:{reservationId:"reservation-1",provider:"openai",model:"gpt-6-luna",promptVersion:"sec-company-evidence-assessment/1",selectedFactIds:["fact-1"],status:"unknown_delivery",startedAt:1,completedAt:null,result:null},usageReview:{required:true,unresolvedCount:1}})} as unknown as AppDeps["companyEvidenceAssessment"]});}
const input={cik:"0000000001",factIds:["00000000-0000-4000-8000-000000000001"],provider:"google_gemini",confirmSend:true,paidServiceAttested:true,usageReviewAcknowledged:false};
describe("local company assessment route",()=>{
  it("requires same-origin JSON and explicit Gemini paid-service consent without accepting keys",async()=>{
    const assess=vi.fn(async()=>({provider:"google_gemini",model:"gemini-3.8-flash",promptVersion:"sec-company-evidence-assessment/1",generatedAt:"2026-01-01T00:00:00.000Z",assessment:{stance:"insufficient_evidence",summary:"Selected evidence is insufficient.",summaryCitationIds:["F1"],bullishEvidence:[],bearishEvidence:[],unknowns:[]},citations:[]}));const app=appFor(assess);const path=`/api/companies/${company.id}/evidence-assessment`;
    const cross=await app.request(path,{method:"POST",headers:{"content-type":"application/json",origin:"https://attacker.example"},body:JSON.stringify(input)});
    expect(cross.status).toBe(403);
    const withKey=await app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,apiKey:"secret"})});
    expect(withKey.status).toBe(400);
    const call=await app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,paidServiceAttested:false})});
    expect(call.status).toBe(200);expect(assess).toHaveBeenCalledWith(expect.objectContaining({companyId:company.id,cik:input.cik,factIds:input.factIds,confirmSend:true,paidServiceAttested:false,usageReviewAcknowledged:false}));
    expect(JSON.stringify(assess.mock.calls)).not.toContain("secret");
  });
  it("reads back provider-scoped local assessment status without caching",async()=>{
    const assess=vi.fn();const app=appFor(assess);
    const response=await app.request(`/api/companies/${company.id}/evidence-assessment?provider=openai`);
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({snapshotId:"snapshot-1",assessment:{reservationId:"reservation-1",status:"unknown_delivery",selectedFactIds:["fact-1"]},usageReview:{required:true,unresolvedCount:1}});
  });
});
