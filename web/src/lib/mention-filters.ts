import type { Mention } from "./api.js";

export type MentionFilter = "all" | "bull" | "bear" | "material" | "offtarget" | "failed" | "history";

export function matchesMentionFeedFilter(mention: Mention, filter: MentionFilter): boolean {
  const category = mention.status === "classified" ? mention.classification : null;
  switch (filter) {
    case "all": return mention.status !== "off_target" && mention.status !== "excluded";
    case "history": return true;
    case "bull": return category?.sentiment === "positive" || (mention.status === "scored" && mention.score?.sentiment === "positive");
    case "bear": return category?.sentiment === "negative" || (mention.status === "scored" && mention.score?.sentiment === "negative");
    case "material": return category?.material === true || (mention.status === "scored" && (mention.score?.material ?? 0) >= 0.6);
    case "offtarget": return mention.status === "excluded" || mention.status === "off_target";
    case "failed": return ["failed", "pending", "retrying", "scoring", "corrupt", "review_required"].includes(mention.status);
  }
}

export function filterMentionFeed(mentions: Mention[], filter: MentionFilter): Mention[] {
  return mentions.filter((mention) => matchesMentionFeedFilter(mention, filter));
}
