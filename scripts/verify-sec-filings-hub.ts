import { SecFilingsInbox } from "../server/sec-filings-inbox.js";
import type { SecFilingsInboxView } from "../shared/sec-filings-inbox.js";
import { pathToFileURL } from "node:url";

export function isCurrentSecFilingsFeed(feed: SecFilingsInboxView): boolean {
  return feed.state === "ready"
    && feed.freshness === "current"
    && feed.rows.length > 0
    && Boolean(feed.receiptId)
    && Boolean(feed.retrievedAt)
    && Boolean(feed.feedUpdatedAt);
}

async function main(): Promise<void> {
  const feed = await new SecFilingsInbox({ acquisitionEnabled: false }).read();
  if (!isCurrentSecFilingsFeed(feed)) {
    console.error(`SEC filing feed is not current: state=${feed.state}; source_freshness=${feed.freshness}; rows=${feed.rows.length}; feed_updated_at=${feed.feedUpdatedAt ?? "unknown"}; reason=${feed.message ?? "none"}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: exact SEC 8-K Hub receipt is current and display-only; rows=${feed.rows.length}; feed_updated_at=${feed.feedUpdatedAt}; retrieved_at=${feed.retrievedAt}; no provider call made by this verifier.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("SEC filing feed verification failed: local Hub read was unavailable.");
    process.exitCode = 1;
  });
}
