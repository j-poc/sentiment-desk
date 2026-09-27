import { createHash } from "node:crypto";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export type RubricQuestion = ChoiceQuestion | NoulQuestion;
export type Rubric = Record<string, RubricQuestion>;

/**
 * The fixed Jev rubric. Every mention is judged by the same questions, in
 * the same shape, for every company. This is the fairness
 * contract of the product: identical rubric, identical post-rules, only the
 * mention and the company differ. The rubric ships as data and its hash is
 * stored with every score so any historical judgment can be replayed against
 * the exact wording that produced it.
 */
export const RUBRIC: Rubric = {
  sentiment: {
    type: "choice",
    instructions:
      "You judge one published item for its directional implication for one public company. Consider only what the item itself reports or argues. The target is the company's business signal, not the market-wide mood. Do not speculate about stock price moves. Output the single best direction.",
    criteria: {
      negative:
        "Reports or argues facts likely to hurt the company's revenue, costs, margins, legal position, leadership, products, or competitive standing: demand weakness, losses, recalls, regulatory probes, lawsuits, outages, security breaches, key departures, downgrades tied to company-specific facts.",
      neutral:
        "Balanced, routine, or ambiguous for the company: product upkeep, marketing, commentary with no clear company-specific benefit or harm, or genuinely mixed reporting.",
      positive:
        "Reports or argues facts likely to help the company: beat-and-raise results, major wins, successful launches, favorable rulings, notable customer adoptions, upgrades tied to company-specific facts.",
    },
  },
  about: {
    type: "noul",
    instructions:
      "The item is genuinely about the company named in the state (including its named subsidiaries or flagship products). Watch for namesakes: the same word can name a food, a river, a place, a material, an unrelated company, or a generic concept — those are NOT the company. If the item could plausibly concern something other than the company itself (for example a food product called apple sauce when the company is Apple Inc), score about near 0. Also not the sector as a whole with the company only mentioned in passing.",
  },
  investor_relevant: {
    type: "noul",
    instructions:
      "This item is relevant to an investor in the company: it bears on the investment case, such as financial results, guidance, operations, supply chain, competitive position, leadership, legal or regulatory matters, capital allocation, or products considered as business lines, rather than being consumer or entertainment coverage of the brand's output, lifestyle or celebrity news involving the brand, general commentary on the word, or background pieces with no business signal.",
  },
  material: {
    type: "noul",
    instructions:
      "The item bears on the company's revenue, costs, margins, legal exposure, leadership, product pipeline, or competitive position in a way a professional investor would weigh, as opposed to celebrity coverage, minor PR, or trivia.",
  },
  novel: {
    type: "noul",
    instructions:
      "The item adds new information: a new event, decision, number, filing, or original reporting, rather than restating known facts, aggregating prior coverage, or offering pure opinion on a known situation.",
  },
  credible: {
    type: "noul",
    instructions:
      "The publishing source demonstrates professional editorial standards and a track record of factual accuracy for business reporting, rather than anonymous aggregation, unverified accounts, or promotion.",
  },
  event_type: {
    type: "choice",
    instructions:
      "Classify the dominant event in this item for the company named in the state. Pick the single best type. If the item contains several events, classify the one with the largest potential bearing on the company.",
    criteria: {
      results: "Earnings, revenue, margins, KPIs, or guidance: reported results, pre-announcements, or changes to forward guidance and forecasts.",
      corporate_action: "Capital structure and corporate events: M&A, buybacks, dividends, splits, listings, restructurings, joint ventures, major contracts.",
      legal_regulatory: "Government or legal action touching the company: investigations, probes, lawsuits, rulings, fines, sanctions, new regulation aimed at it.",
      leadership: "People changes with governance weight: CEO/CFO or other C-suite appointments, departures, board changes, succession.",
      product: "Products and operations: launches, recalls, defects, outages, safety events, clinical or trial milestones, supply issues.",
      analyst_action: "Sell-side or rating actions naming the company: upgrades, downgrades, price-target changes, initiations, index changes.",
      macro_sector: "Industry-wide or macro forces hitting the company with its peers: tariffs, commodity swings, sector demand shifts, rates. Company-specific facts are not the driver.",
      other: "Real company news that fits none of the above cleanly.",
    },
  },
  magnitude: {
    type: "noul",
    instructions:
      "If the reported facts are as stated, the plausible effect on the company's fundamental value or near-term expectations is large, on the order of multiple percent of equity value, not marginal.",
  },
  surprise: {
    type: "noul",
    instructions:
      "This item carries genuinely new information relative to prior public knowledge and market expectations: not previously reported, not an anticipated confirmation, not a rehash of a known story.",
  },
  takeaway: {
    type: "choice",
    instructions:
      "Write the three-word investor headline for this item: pick the single option that best answers why an investor should care. Judge what the item reports, not speculation about outcomes.",
    criteria: {
      results_beat: "Reported results or metrics came in better than expectations or prior period.",
      results_miss: "Reported results or metrics came in worse than expectations or prior period.",
      guidance_raise: "Management raised or tightened-up forward guidance or forecasts.",
      guidance_cut: "Management cut, withdrew, or softened forward guidance or forecasts.",
      accounting_redo: "Financial statements are being restated, delayed, or flagged as unreliable.",
      listing_risk: "Exchange listing, delisting, or compliance status is threatened or changed.",
      mna_capital: "M&A, buyback, dividend, capital raise, debt move, or other capital-structure event.",
      leadership: "C-suite, board, or control changes at the company.",
      legal_hit: "Legal or regulatory action goes against the company: probe, suit, ruling, fine, sanctions.",
      legal_relief: "Legal or regulatory pressure eases: case dropped, won, settled favorably, approval granted.",
      product_win: "Product, operations, supply, or delivery news is a clear positive for the business.",
      product_setback: "Product, operations, supply, delivery, or safety news is a clear negative for the business.",
      analyst_shift: "Sell-side or rating view on the company shifted meaningfully.",
      routine: "Routine disclosure, context, or commentary with no standalone investor takeaway.",
    },
  },
};

export const TAKEAWAY_KEYS = [
  "results_beat",
  "results_miss",
  "guidance_raise",
  "guidance_cut",
  "accounting_redo",
  "listing_risk",
  "mna_capital",
  "leadership",
  "legal_hit",
  "legal_relief",
  "product_win",
  "product_setback",
  "analyst_shift",
  "routine",
] as const;

export type TakeawayKey = (typeof TAKEAWAY_KEYS)[number];

export const TAKEAWAY_LABEL: Record<TakeawayKey, string> = {
  results_beat: "Results beat",
  results_miss: "Results miss",
  guidance_raise: "Guidance raised",
  guidance_cut: "Guidance cut",
  accounting_redo: "Accounting redo",
  listing_risk: "Delisting risk",
  mna_capital: "M&A / capital move",
  leadership: "Leadership change",
  legal_hit: "Legal / regulatory hit",
  legal_relief: "Legal / regulatory relief",
  product_win: "Product / ops win",
  product_setback: "Product / ops setback",
  analyst_shift: "Analyst view shift",
  routine: "Routine / context",
};

export const EVENT_TYPES = [
  "results",
  "corporate_action",
  "legal_regulatory",
  "leadership",
  "product",
  "analyst_action",
  "macro_sector",
  "other",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const RUBRIC_SHA = createHash("sha256").update(JSON.stringify(RUBRIC)).digest("hex");
