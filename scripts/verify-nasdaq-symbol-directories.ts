import { parseListingDirectory } from "../server/sec-filings-inbox.js";

const SOURCES = [
  { url: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", kind: "nasdaq" as const },
  { url: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", kind: "other" as const },
];
const MAX_BYTES = 1_500_000;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("body_unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("directory_over_limit");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function main(): Promise<void> {
  if (process.env.ALLOW_LIVE_NASDAQ_REPLAY !== "true") {
    throw new Error("live Nasdaq replay is opt-in; set ALLOW_LIVE_NASDAQ_REPLAY=true for this bounded verification");
  }
  const evidence = await Promise.all(SOURCES.map(async ({ url, kind }) => {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || response.url !== url) throw new Error(`${kind}_directory_http_${response.status}`);
    const retrievedAt = new Date().toISOString();
    const parsed = parseListingDirectory(await readBoundedText(response), kind, url, retrievedAt);
    if (!parsed) throw new Error(`${kind}_directory_invalid`);
    const createdAt = Date.parse(parsed.createdAt);
    const now = Date.parse(retrievedAt);
    if (!Number.isFinite(createdAt) || createdAt > now || now - createdAt > FRESHNESS_MS) {
      throw new Error(`${kind}_directory_stale_or_future`);
    }
    return { kind, rows: parsed.securities.length, createdAt: parsed.createdAt, retrievedAt };
  }));
  if (evidence.some((entry) => entry.rows < 1) || evidence.length !== 2) {
    throw new Error("both current directory files must contain eligible listed securities");
  }
  for (const entry of evidence) {
    console.log(`NASDAQ_DIRECTORY_REPLAY=PASS source=${entry.kind} eligible_rows=${entry.rows} created_at=${entry.createdAt} retrieved_at=${entry.retrievedAt}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`NASDAQ_DIRECTORY_REPLAY=FAIL reason=${message}`);
  process.exitCode = 1;
});
