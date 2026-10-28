import type { Mention } from "./api.js";

export type MentionFilter = "all" | "bull" | "bear" | "material" | "offtarget" | "failed" | "history" | "identity_review" | "relevance_review";

export function matchesMentionFeedFilter(mention: Mention, filter: MentionFilter): boolean {
  const category = mention.status === "classified" ? mention.classification : null;
  switch (filter) {
    case "all": return mention.status !== "off_target" && mention.status !== "excluded" && mention.companyBusinessRelevant !== false;
    case "history": return true;
    case "identity_review": return mention.issuerIdentityStrong === false;
    case "relevance_review": return mention.issuerIdentityStrong !== false && mention.companyBusinessRelevant === false;
    case "bull": return mention.companyBusinessRelevant !== false && (category?.sentiment === "positive" || (mention.status === "scored" && mention.score?.sentiment === "positive"));
    case "bear": return mention.companyBusinessRelevant !== false && (category?.sentiment === "negative" || (mention.status === "scored" && mention.score?.sentiment === "negative"));
    case "material": return mention.companyBusinessRelevant !== false && (category?.material === true || (mention.status === "scored" && (mention.score?.material ?? 0) >= 0.6));
    case "offtarget": return mention.status === "excluded" || mention.status === "off_target";
    case "failed": return mention.companyBusinessRelevant !== false && ["failed", "pending", "retrying", "scoring", "corrupt", "review_required"].includes(mention.status);
  }
}

export function filterMentionFeed(mentions: Mention[], filter: MentionFilter): Mention[] {
  return mentions.filter((mention) => matchesMentionFeedFilter(mention, filter));
}
