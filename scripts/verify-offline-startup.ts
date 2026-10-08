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
  "nasdaq_symbol_directories",
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
    case "nasdaq_symbol_directories":
      return attempt.origin === "https://www.nasdaqtrader.com"
        && ["/dynamic/symdir/nasdaqlisted.txt", "/dynamic/symdir/otherlisted.txt"].includes(attempt.pathname);
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
  options: {
    sourceRightsApproved?: boolean;
    luna?: { apiKey: string; allowedCollectors: string; accountApproved: boolean; maxDailyCostUsd: string; expectedEnabled: boolean };
  } = {},
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
      DESK_HUB_INSTALLATION_FILE: path.join(directory, "disabled-hub-installation.json"),
      HOST: "127.0.0.1",
      PORT: String(port),
      NETWORK_GUARD_LOG: guardLog,
      EXTERNAL_REQUESTS_ENABLED: "true",
      EXTERNAL_SOURCE_COLLECTORS: collector === "nasdaq_symbol_directories"
        ? "sec_latest_filings_8k,nasdaq_symbol_directories" : collector,
      SOURCE_RIGHTS_APPROVED_COLLECTORS: options.sourceRightsApproved === false ? ""
        : collector === "nasdaq_symbol_directories" ? "sec_latest_filings_8k,nasdaq_symbol_directories" : collector,
      CLASSIFICATION_PROVIDER: "openai_luna",
      OPENAI_API_KEY: options.luna?.apiKey ?? "",
      OPENAI_ACCOUNT_USE_APPROVED: options.luna?.accountApproved ? "true" : "false",
      OPENAI_ALLOWED_COLLECTORS: options.luna?.allowedCollectors ?? "",
      OPENAI_MAX_REQUESTS_PER_DAY: options.luna ? "1" : "0",
      OPENAI_MAX_REQUEST_BYTES_PER_DAY: options.luna ? "40000" : "0",
      OPENAI_MAX_DAILY_COST_USD: options.luna?.maxDailyCostUsd ?? "0",
      TYPESAFE_ACCOUNT_USE_APPROVED: "false",
      TYPESAFE_API_KEY: "offline-verifier-unused",
      TYPESAFE_ALLOWED_COLLECTORS: collector,
      TYPESAFE_MAX_REQUESTS_PER_DAY: "10",
      TYPESAFE_MAX_REQUEST_BYTES_PER_DAY: "100000",
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
      if (exitResult != null) {
        throw new Error(`${collector} server exited before health check (${exitResult}); stderr: ${stderr.slice(-2_000)}`);
      }
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
    const sourceIsApproved = options.sourceRightsApproved !== false;
    const deliveryCollectors = sourceCollectors.filter((source) => source !== "nasdaq_symbol_directories");
    assert.equal(deliveryHealth.length, deliveryCollectors.length, "health should disclose each scheduled real collector");
    for (const source of deliveryCollectors) {
      const delivery = deliveryHealth.find((row) => row.collector === source);
      assert.ok(delivery, `${source} must appear in delivery health`);
      assert.equal(delivery.enabled, source === collector && sourceIsApproved,
        `${source} delivery gate must match the request and source-use approval allowlists`);
    }
    const counters = (health.health ?? {}) as Record<string, { enabled?: boolean; sourceApproval?: {
      blockedRequestedCollectors?: string[];
      typesafeAccountUseApproved?: boolean;
      jevAllowedCollectors?: string[];
    } }>;
    const sourceApproval = counters.sourceApproval;
    assert.ok(sourceApproval, "health should disclose source-use and account-approval gates");
    assert.deepEqual(sourceApproval.blockedRequestedCollectors, sourceIsApproved ? []
      : collector === "nasdaq_symbol_directories" ? ["nasdaq_symbol_directories", "sec_latest_filings_8k"] : [collector]);
    assert.equal(sourceApproval.typesafeAccountUseApproved, false,
      "retired Jev account use must stay disabled while Luna is the selected classifier");
    const expectedCounter: Record<string, string> = {
      google_news_rss: "rss", yahoo_finance_rss: "rss", gdelt_doc_api: "gdelt", yahoo_quote: "quotes",
      sec_edgar: "sec", finnhub: "finnhub", reddit: "reddit", x: "x",
    };
    for (const [source, counter] of Object.entries(expectedCounter)) {
      const enabled = counter === "rss"
        ? sourceIsApproved && (collector === "google_news_rss" || collector === "yahoo_finance_rss")
        : sourceIsApproved && source === collector;
      assert.equal(counters[counter]?.enabled, enabled, `${counter} health counter must reflect ${source} allowlist state`);
    }
    assert.equal(counters.jev?.enabled, false,
      "retired Jev dispatch must remain disabled while Luna is the selected classifier");

    const selectedClassifier = (health.health as { classifier?: { provider: string; enabled: boolean } }).classifier;
    assert.ok(selectedClassifier, "the selected classifier must be disclosed");
    assert.equal(selectedClassifier.provider, "openai_luna");
    assert.equal(selectedClassifier.enabled, options.luna?.expectedEnabled ?? false);
    if (options.luna) assert.equal(counters.jev?.enabled, false, "Luna selection must never enable a TypeSafe fallback");

    if (collector === "nasdaq_symbol_directories") {
      const response = await fetch(`http://127.0.0.1:${port}/api/sec-filings-inbox/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmUse: true }),
      });
      assert.equal(response.status, 200, "the guarded Recent Filings activation should reach the on-demand listing request path");
      if (!sourceIsApproved) {
        const view = await response.json() as { state?: string };
        assert.equal(view.state, "unavailable", "the on-demand listing source must remain paused when either source rights approval is missing");
      }
    }
    if (sourceIsApproved && collector === "yahoo_chart") {
      const response = await fetch(`http://127.0.0.1:${port}/api/companies/apple/price?ticker=AAPL&hours=24`);
      assert.equal(response.status, 502, "the guarded chart request should fail visibly at the fetch boundary");
    }

    const requestDeadline = Date.now() + (sourceIsApproved ? 5_000 : 750);
    let attempts: GuardedAttempt[] = [];
    while (Date.now() < requestDeadline) {
      attempts = existsSync(guardLog)
        ? readFileSync(guardLog, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as GuardedAttempt)
        : [];
      if (sourceIsApproved && (collector === "nasdaq_symbol_directories"
        ? attempts.filter((attempt) => matchesCollectorRequest(collector, attempt)).length === 2
        : attempts.some((attempt) => matchesCollectorRequest(collector, attempt)))) break;
      await delay(100);
    }
    if (sourceIsApproved) {
      assert.ok(attempts.some((attempt) => matchesCollectorRequest(collector, attempt)), `${collector} never reached its guarded request path`);
      assert.ok(attempts.every((attempt) => matchesCollectorRequest(collector, attempt)), `${collector} allowlist leaked requests to another source: ${JSON.stringify(attempts)}`);
    } else {
    assert.equal(attempts.length, 0, `${collector} attempted a request without explicit source-use approval`);
    }
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
      DESK_HUB_INSTALLATION_FILE: path.join(directory, "disabled-hub-installation.json"),
      HOST: "127.0.0.1",
      PORT: String(port),
      NETWORK_GUARD_LOG: guardLog,
      CLASSIFICATION_PROVIDER: "openai_luna",
      OPENAI_API_KEY: "unused-offline-verification-key",
      OPENAI_ACCOUNT_USE_APPROVED: "true",
      OPENAI_ALLOWED_COLLECTORS: "sec_edgar",
      OPENAI_MAX_REQUESTS_PER_DAY: "1",
      OPENAI_MAX_REQUEST_BYTES_PER_DAY: "40000",
      OPENAI_MAX_DAILY_COST_USD: "1",
      TYPESAFE_API_KEY: "unused-offline-verification-key",
      TYPESAFE_ALLOWED_COLLECTORS: "sec_edgar",
      TYPESAFE_MAX_REQUESTS_PER_DAY: "10",
      TYPESAFE_MAX_REQUEST_BYTES_PER_DAY: "100000",
      EXTERNAL_SOURCE_COLLECTORS: "google_news_rss,yahoo_finance_rss,yahoo_quote,yahoo_chart,gdelt_doc_api,sec_edgar,sec_latest_filings_8k,nasdaq_symbol_directories,finnhub,reddit,x",
      SOURCE_RIGHTS_APPROVED_COLLECTORS: "google_news_rss,yahoo_finance_rss,yahoo_quote,yahoo_chart,gdelt_doc_api,sec_edgar,sec_latest_filings_8k,nasdaq_symbol_directories,finnhub,reddit,x",
      TYPESAFE_ACCOUNT_USE_APPROVED: "true",
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
      if (exitResult != null) {
        throw new Error(
          `server exited before health check (${exitResult}); stdout: ${stdout.slice(-2_000)}; stderr: ${stderr.slice(-2_000)}`,
        );
      }
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
    for (const source of ["rss", "gdelt", "x", "quotes", "sec", "finnhub", "reddit", "jev", "classifier"]) {
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
    assert.equal(retryResponse.status, 503, "Classifier retry must stay unavailable while external requests are paused");

    const attempts = existsSync(guardLog) ? readFileSync(guardLog, "utf8") : "";
    assert.equal(attempts, "", `server attempted external fetches while paused: ${attempts}`);
    assert.match(stdout, /OFFLINE \(saved data only\)/);
    const singleCompanyPath = path.join(directory, "one-real-company.json");
    writeFileSync(singleCompanyPath, JSON.stringify({ companies: [apple] }));
    for (const collector of sourceCollectors) await verifyCollectorGate(repo, singleCompanyPath, collector);
    await verifyCollectorGate(repo, singleCompanyPath, "finnhub", { sourceRightsApproved: false });
    await verifyCollectorGate(repo, singleCompanyPath, "nasdaq_symbol_directories", { sourceRightsApproved: false });
    await verifyCollectorGate(repo, singleCompanyPath, "sec_edgar");
    const lunaGate = { apiKey: "unused-offline-verification-key", allowedCollectors: "sec_edgar", accountApproved: true, maxDailyCostUsd: "1", expectedEnabled: true };
    await verifyCollectorGate(repo, singleCompanyPath, "sec_edgar", { luna: { ...lunaGate, apiKey: "", expectedEnabled: false } });
    await verifyCollectorGate(repo, singleCompanyPath, "sec_edgar", { luna: { ...lunaGate, accountApproved: false, expectedEnabled: false } });
    await verifyCollectorGate(repo, singleCompanyPath, "sec_edgar", { luna: { ...lunaGate, allowedCollectors: "google_news_rss", expectedEnabled: false } });
    await verifyCollectorGate(repo, singleCompanyPath, "sec_edgar", { luna: { ...lunaGate, maxDailyCostUsd: "0", expectedEnabled: false } });
    await verifyCollectorGate(repo, singleCompanyPath, "sec_edgar", { luna: lunaGate });
    console.log(`PASS: fresh default startup served ${companies.length} configured companies; the global-off default made zero fetch attempts. Separate guarded processes proved all ${sourceCollectors.length} source request paths need matching source-use approval, including both on-demand Nasdaq directories behind the joint SEC/Nasdaq gate; a missing source approval made zero fetches, and the selected classifier stays GPT-6 Luna even when the retired Jev adapter is separately configured. Luna gates required a key, account approval, approved source overlap and a nonzero dollar cap, with no TypeSafe fallback. All outbound fetches were intercepted before network access.`);
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
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
