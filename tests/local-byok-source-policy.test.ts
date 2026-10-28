import {describe,expect,it} from "vitest";
import {automaticPlanClassifierCollectors,manualByokClassifierCollectors} from "../server/local-byok-source-policy.js";

describe("automatic versus manual model source policy",()=>{
  it("keeps SEC out of automatic ChatGPT Plan classification while admitting active SEC sources to explicit local BYOK",()=>{
    const configuredEligibility=new Set(["google_news_rss","sec_edgar","sec_company_facts","sec_latest_filings_8k"] as const);
    const active=new Set(["google_news_rss","sec_edgar","sec_company_facts"] as const);
    const automatic=automaticPlanClassifierCollectors(configuredEligibility);
    const manual=manualByokClassifierCollectors(automatic,active);
    expect([...automatic]).toEqual(["google_news_rss"]);
    expect([...manual].sort()).toEqual(["google_news_rss","sec_company_facts","sec_edgar"].sort());
    expect(manual.has("sec_latest_filings_8k")).toBe(false);
  });
});
