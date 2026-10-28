import type {CollectorId} from "./types.js";

const SEC_COLLECTORS=new Set<CollectorId>(["sec_company_facts","sec_latest_filings_8k","sec_edgar"]);

/** Automatic ChatGPT Plan work is restricted to approved non-SEC source observations. */
export function automaticPlanClassifierCollectors(eligible:ReadonlySet<CollectorId>):Set<CollectorId>{
  return new Set([...eligible].filter(collector=>!SEC_COLLECTORS.has(collector)));
}

/** Manual per-item requests may additionally use SEC rows only when both source lists approved them. */
export function manualByokClassifierCollectors(automatic:ReadonlySet<CollectorId>,activeSources:ReadonlySet<CollectorId>):Set<CollectorId>{
  return new Set([...automatic,...[...SEC_COLLECTORS].filter(collector=>activeSources.has(collector))]);
}
