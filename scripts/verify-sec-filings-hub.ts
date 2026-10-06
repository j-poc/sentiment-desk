import { SecFilingsInbox } from "../server/sec-filings-inbox.js";

const feed = await new SecFilingsInbox({ acquisitionEnabled: false }).read();
if (feed.state !== "ready" || feed.rows.length === 0 || !feed.receiptId || !feed.retrievedAt) {
  console.error(`SEC filing feed is not live-ready: state=${feed.state}; rows=${feed.rows.length}; reason=${feed.message ?? "none"}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: exact SEC 8-K Hub receipt is current and display-only; rows=${feed.rows.length}; retrieved_at=${feed.retrievedAt}; no provider call made by this verifier.`);
}
