import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function writeNetworkGuard(guardPath: string): void {
  writeFileSync(guardPath, `
const fs = require("node:fs");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    const query = Object.fromEntries(["interval", "range"].flatMap((key) => {
      const value = url.searchParams.get(key);
      return value == null ? [] : [[key, value]];
    }));
    fs.appendFileSync(process.env.NETWORK_GUARD_LOG, JSON.stringify({ origin: url.origin, pathname: url.pathname, query }) + "\\n");
    throw new Error("offline-startup verifier blocked an external fetch");
  }
  return originalFetch(input, init);
};
`);
}

interface GuardedAttempt {
  origin: string;
  pathname: string;
  query: Record<string, string>;
}

const sourceCollectors = [
  "google_news_rss",
  "yahoo_finance_rss",
  "yahoo_quote",
  "yahoo_chart",
  "gdelt_doc_api",
  "sec_edgar",
  "finnhub",
  "reddit",
  "x",
] as const;

function matchesCollectorRequest(collector: typeof sourceCollectors[number], attempt: GuardedAttempt): boolean {
  switch (collector) {
    case "google_news_rss":
      return attempt.origin === "https://news.google.com" && attempt.pathname === "/rss/search";
    case "yahoo_finance_rss":
      return attempt.origin === "https://feeds.finance.yahoo.com" && attempt.pathname === "/rss/2.0/headline";
    case "yahoo_quote":
      return attempt.origin === "https://query1.finance.yahoo.com"
        && attempt.pathname.startsWith("/v8/finance/chart/")
        && attempt.query.interval === "1d" && attempt.query.range === "5d";
    case "yahoo_chart":
      return attempt.origin === "https://query1.finance.yahoo.com"
        && attempt.pathname.startsWith("/v8/finance/chart/")
        && attempt.query.interval === "5m" && attempt.query.range === "1d";
    case "gdelt_doc_api":
      return attempt.origin === "https://api.gdeltproject.org" && attempt.pathname === "/api/v2/doc/doc";
    case "sec_edgar":
      return attempt.origin === "https://www.sec.gov" && attempt.pathname === "/files/company_tickers.json";
    case "finnhub":
      return attempt.origin === "https://finnhub.io";
    case "reddit":
      return attempt.origin === "https://www.reddit.com" && attempt.pathname === "/api/v1/access_token";
    case "x":
      return attempt.origin === "https://api.x.com" && attempt.pathname === "/2/tweets/search/recent";
  }
}

async function verifyCollectorGate(
  repo: string,
  companiesPath: string,
  collector: typeof sourceCollectors[number],
  jevConfig?: { apiKey: string; allowedCollectors: string; expectedEnabled: boolean },
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), `sentiment-desk-allowlist-${collector}-`));
  const dbPath = path.join(directory, "desk.db");
  const guardLog = path.join(directory, "external-fetch-attempts.jsonl");
  const guardPath = path.join(directory, "network-guard.cjs");
  const entrypoint = path.join(repo, "dist", "server", "index.js");
  let child: ChildProcessWithoutNullStreams | null = null;
  let childExit: Promise<void> | null = null;
  let exitResult: string | null = null;
  let stderr = "";

  try {
    writeNetworkGuard(guardPath);
    const port = await availablePort();
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    Object.assign(env, {
      DB_PATH: dbPath,
      COMPANIES_PATH: companiesPath,
      HOST: "127.0.0.1",
      PORT: String(port),
      NETWORK_GUARD_LOG: guardLog,
      EXTERNAL_REQUESTS_ENABLED: "true",
      EXTERNAL_SOURCE_COLLECTORS: collector,
      TYPESAFE_API_KEY: jevConfig?.apiKey ?? "",
      TYPESAFE_ALLOWED_COLLECTORS: jevConfig?.allowedCollectors ?? "",
      TYPESAFE_MAX_REQUESTS_PER_DAY: jevConfig ? "10" : "0",
      TYPESAFE_MAX_REQUEST_BYTES_PER_DAY: jevConfig ? "100000" : "0",
      SEC_USER_AGENT: "Offline verifier verifier@example.invalid",
      FINNHUB_API_KEY: "offline-verifier-unused",
      REDDIT_CLIENT_ID: "offline-verifier-unused",
      REDDIT_CLIENT_SECRET: "offline-verifier-unused",
      X_BEARER_TOKEN: "offline-verifier-unused",
      ALERT_WEBHOOK_URL: "",
    });

    child = spawn(process.execPath, ["--require", guardPath, entrypoint], {
      cwd: directory,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const runningChild = child;
    runningChild.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    childExit = new Promise<void>((resolve) => {
      runningChild.once("exit", (code, signal) => {
        exitResult = `code=${code} signal=${signal}`;
        resolve();
      });
      runningChild.once("error", (error) => {
        exitResult = `spawn error=${error.message}`;
        resolve();
      });
    });

    let health: Record<string, unknown> | null = null;
    const healthDeadline = Date.now() + 10_000;
    while (Date.now() < healthDeadline && health == null) {
      if (exitResult != null) throw new Error(`${collector} server exited before health check (${exitResult})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) health = await response.json() as Record<string, unknown>;
      } catch {
        await delay(100);
      }
    }
    assert.ok(health, `${collector} server did not become healthy; stderr: ${stderr.slice(-2_000)}`);
    assert.equal(health.externalRequestsEnabled, true);
    const deliveryHealth = health.deliveryHealth as Array<{ collector: string; enabled: boolean }>;
    assert.equal(deliveryHealth.length, sourceCollectors.length, "health should disclose each real collector");
    for (const source of sourceCollectors) {
      const delivery = deliveryHealth.find((row) => row.collector === source);
      assert.ok(delivery, `${source} must appear in delivery health`);
      assert.equal(delivery.enabled, source === collector, `${source} delivery gate must match the one-source allowlist`);
    }
    const counters = (health.health ?? {}) as Record<string, { enabled?: boolean }>;
    const expectedCounter: Record<string, string> = {
      google_news_rss: "rss", yahoo_finance_rss: "rss", gdelt_doc_api: "gdelt", yahoo_quote: "quotes",
      sec_edgar: "sec", finnhub: "finnhub", reddit: "reddit", x: "x",
    };
    for (const [source, counter] of Object.entries(expectedCounter)) {
      const enabled = counter === "rss"
        ? collector === "google_news_rss" || collector === "yahoo_finance_rss"
        : source === collector;
      assert.equal(counters[counter]?.enabled, enabled, `${counter} health counter must reflect ${source} allowlist state`);
    }
    assert.equal(counters.jev?.enabled, jevConfig?.expectedEnabled ?? false,
      "Jev dispatch must match key, budget, and intersection of source allowlists");

    if (collector === "yahoo_chart") {
      const response = await fetch(`http://127.0.0.1:${port}/api/companies/apple/price?ticker=AAPL&hours=24`);
      assert.equal(response.status, 502, "the guarded chart request should fail visibly at the fetch boundary");
    }

    const requestDeadline = Date.now() + 5_000;
    let attempts: GuardedAttempt[] = [];
    while (Date.now() < requestDeadline) {
      attempts = existsSync(guardLog)
        ? readFileSync(guardLog, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line) as GuardedAttempt)
        : [];
      if (attempts.some((attempt) => matchesCollectorRequest(collector, attempt))) break;
      await delay(100);
    }
    assert.ok(attempts.some((attempt) => matchesCollectorRequest(collector, attempt)), `${collector} never reached its guarded request path`);
    assert.ok(attempts.every((attempt) => matchesCollectorRequest(collector, attempt)), `${collector} allowlist leaked requests to another source: ${JSON.stringify(attempts)}`);
  } finally {
    try {
      if (child && exitResult == null) {
        child.kill("SIGTERM");
        const stopping = childExit ?? Promise.resolve();
        try {
          await Promise.race([
            stopping,
            delay(5_000).then(() => { throw new Error(`${collector} verifier server did not stop cleanly; stderr: ${stderr.slice(-2_000)}`); }),
          ]);
        } catch (error) {
          child.kill("SIGKILL");
          await Promise.race([stopping, delay(1_000)]);
          throw error;
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = mkdtempSync(path.join(tmpdir(), "sentiment-desk-offline-startup-"));
  const dbPath = path.join(directory, "desk.db");
  const guardLog = path.join(directory, "external-fetch-attempts.log");
  const guardPath = path.join(directory, "network-guard.cjs");
  const companiesPath = path.join(repo, "config", "companies.json");
  const configuredCompanies = JSON.parse(readFileSync(companiesPath, "utf8")) as { companies: Array<{ ticker: string }> };
  const apple = configuredCompanies.companies.find(({ ticker }) => ticker === "AAPL");
  assert.ok(apple, "the configured real company universe must contain AAPL for collector probes");
  const entrypoint = path.join(repo, "dist", "server", "index.js");
  let child: ChildProcessWithoutNullStreams | null = null;
  let childExit: Promise<void> | null = null;
  let exitResult: string | null = null;
  let stdout = "";
  let stderr = "";

  try {
    writeNetworkGuard(guardPath);
    const port = await availablePort();
    const env = { ...process.env };
    delete env.EXTERNAL_REQUESTS_ENABLED;
    delete env.NODE_OPTIONS;
    Object.assign(env, {
      DB_PATH: dbPath,
      COMPANIES_PATH: companiesPath,
      HOST: "127.0.0.1",
      PORT: String(port),
      NETWORK_GUARD_LOG: guardLog,
      TYPESAFE_API_KEY: "unused-offline-verification-key",
      TYPESAFE_ALLOWED_COLLECTORS: "sec_edgar",
      TYPESAFE_MAX_REQUESTS_PER_DAY: "10",
      TYPESAFE_MAX_REQUEST_BYTES_PER_DAY: "100000",
      EXTERNAL_SOURCE_COLLECTORS: "google_news_rss,yahoo_finance_rss,yahoo_quote,yahoo_chart,gdelt_doc_api,sec_edgar,finnhub,reddit,x",
      SEC_USER_AGENT: "Offline verifier offline@example.invalid",
      FINNHUB_API_KEY: "unused-offline-verification-key",
      REDDIT_CLIENT_ID: "unused-offline-verification-id",
      REDDIT_CLIENT_SECRET: "unused-offline-verification-secret",
      X_BEARER_TOKEN: "unused-offline-verification-token",
    });

    child = spawn(process.execPath, ["--require", guardPath, entrypoint], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runningChild = child;
    runningChild.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    runningChild.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    childExit = new Promise<void>((resolve) => {
      runningChild.once("exit", (code, signal) => {
        exitResult = `code=${code} signal=${signal}`;
        resolve();
      });
      runningChild.once("error", (error) => {
        exitResult = `spawn error=${error.message}`;
        resolve();
      });
    });

    let health: Record<string, unknown> | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && health == null) {
      if (exitResult != null) throw new Error(`server exited before health check (${exitResult})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) health = await response.json() as Record<string, unknown>;
      } catch {
        await delay(100);
      }
    }
    assert.ok(health, `offline server did not become healthy; stderr: ${stderr.slice(-2_000)}`);
    assert.equal(health.externalRequestsEnabled, false);

    const counters = (health.health ?? {}) as Record<string, { enabled?: boolean; ok?: number; fail?: number }>;
    for (const source of ["rss", "gdelt", "x", "quotes", "sec", "finnhub", "reddit", "jev"]) {
      assert.equal(counters[source]?.enabled, false, `${source} must remain disabled without explicit opt-in`);
      assert.equal(counters[source]?.ok, 0, `${source} must not report startup traffic`);
      assert.equal(counters[source]?.fail, 0, `${source} must not attempt startup traffic`);
    }
    const deliveryHealth = health.deliveryHealth as Array<{ state?: string }>;
    assert.ok(deliveryHealth.length > 0, "health must disclose configured collector states");
    assert.ok(deliveryHealth.every(({ state }) => state === "disabled"), "all collectors must remain disabled while global requests are paused");

    const companiesResponse = await fetch(`http://127.0.0.1:${port}/api/companies`);
    assert.equal(companiesResponse.status, 200);
    const companies = await companiesResponse.json() as unknown[];
    assert.ok(companies.length > 0, "the saved-data app should load its configured real company universe");

    const retryResponse = await fetch(`http://127.0.0.1:${port}/api/mentions/offline-verification/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmNewCharge: true, reviewedProviderUsage: true }),
    });
    assert.equal(retryResponse.status, 503, "Jev retry must stay unavailable while external requests are paused");

    const attempts = existsSync(guardLog) ? readFileSync(guardLog, "utf8") : "";
    assert.equal(attempts, "", `server attempted external fetches while paused: ${attempts}`);
    assert.match(stdout, /OFFLINE \(saved data only\)/);
    const singleCompanyPath = path.join(directory, "one-real-company.json");
    writeFileSync(singleCompanyPath, JSON.stringify({ companies: [apple] }));
    for (const collector of sourceCollectors) await verifyCollectorGate(repo, singleCompanyPath, collector);
    await verifyCollectorGate(repo, singleCompanyPath, "sec_edgar", {
      apiKey: "unused-offline-verification-key",
      allowedCollectors: "google_news_rss",
      expectedEnabled: false,
    });
    console.log(`PASS: fresh default startup served ${companies.length} configured companies; sources and Jev stayed paused, retry returned 503, and zero fetches were attempted. Separate fresh processes proved all ${sourceCollectors.length} source allowlists activate only their own guarded request path and health state. A mismatched Jev/source allowlist stayed disabled with an API key present. All outbound fetches were intercepted before network access.`);
  } finally {
    try {
      if (child && exitResult == null) {
        child.kill("SIGTERM");
        const stopping = childExit ?? Promise.resolve();
        try {
          await Promise.race([
            stopping,
            delay(5_000).then(() => { throw new Error(`offline server did not stop cleanly; stderr: ${stderr.slice(-2_000)}`); }),
          ]);
        } catch (error) {
          child.kill("SIGKILL");
          await Promise.race([stopping, delay(1_000)]);
          throw error;
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
