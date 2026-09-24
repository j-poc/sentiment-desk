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
 * The fixed sentiment rubric. Every mention is judged by the same five
 * questions, in the same shape, for every company. This is the fairness
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
      "The item is genuinely about the company named in the state (including its named subsidiaries or flagship products), not a different entity with a similar name, and not the sector as a whole with the company only mentioned in passing.",
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
};

export const RUBRIC_SHA = createHash("sha256").update(JSON.stringify(RUBRIC)).digest("hex");
