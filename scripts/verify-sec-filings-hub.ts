import { SecFilingsInbox, type SecFilingsReceiptEvidence } from "../server/sec-filings-inbox.js";
import { pathToFileURL } from "node:url";

export function isCurrentSecFilingsReceiptEvidence(evidence: SecFilingsReceiptEvidence): boolean {
  return evidence.state === "ready"
    && evidence.freshness === "current"
    && evidence.rowCount > 0
    && Boolean(evidence.receiptId)
    && Boolean(evidence.retrievedAt)
    && Boolean(evidence.feedUpdatedAt);
}

async function main(): Promise<void> {
  const evidence = await new SecFilingsInbox({ acquisitionEnabled: false }).readReceiptEvidence();
  if (!isCurrentSecFilingsReceiptEvidence(evidence)) {
    console.error(`SEC Hub receipt is not current: state=${evidence.state}; source_freshness=${evidence.freshness}; rows=${evidence.rowCount}; feed_updated_at=${evidence.feedUpdatedAt ?? "unknown"}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: exact SEC 8-K Hub receipt is current and private-display-only; rows=${evidence.rowCount}; feed_updated_at=${evidence.feedUpdatedAt}; retrieved_at=${evidence.retrievedAt}; no provider request made by this verifier.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("SEC filing feed verification failed: local Hub read was unavailable.");
    process.exitCode = 1;
  });
}
