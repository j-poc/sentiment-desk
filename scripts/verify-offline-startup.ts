import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(path.join(tmpdir(), "sentiment-desk-offline-startup-"));
const dbPath = path.join(directory, "desk.db");
const guardLog = path.join(directory, "external-fetch-attempts.log");
const guardPath = path.join(directory, "network-guard.cjs");
const companiesPath = path.join(repo, "config", "companies.json");
const entrypoint = path.join(repo, "dist", "server", "index.js");

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

function writeNetworkGuard(): void {
  writeFileSync(guardPath, `
const fs = require("node:fs");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    fs.appendFileSync(process.env.NETWORK_GUARD_LOG, url.origin + "\\n");
    throw new Error("offline-startup verifier blocked an external fetch");
  }
  return originalFetch(input, init);
};
`);
}

async function main(): Promise<void> {
  writeNetworkGuard();
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
    SEC_USER_AGENT: "Offline verifier offline@example.invalid",
    FINNHUB_API_KEY: "unused-offline-verification-key",
    REDDIT_CLIENT_ID: "unused-offline-verification-id",
    REDDIT_CLIENT_SECRET: "unused-offline-verification-secret",
    X_BEARER_TOKEN: "unused-offline-verification-token",
  });

  const child = spawn(process.execPath, ["--require", guardPath, entrypoint], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let exitResult: string | null = null;
  const childExit = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitResult = `code=${code} signal=${signal}`;
      resolve();
    });
  });

  try {
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
    for (const source of ["rss", "x", "quotes", "sec", "finnhub", "reddit", "jev"]) {
      assert.equal(counters[source]?.enabled, false, `${source} must remain disabled without explicit opt-in`);
      assert.equal(counters[source]?.ok, 0, `${source} must not report startup traffic`);
      assert.equal(counters[source]?.fail, 0, `${source} must not attempt startup traffic`);
    }

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
    console.log(`PASS: fresh default startup served ${companies.length} configured companies; sources and Jev stayed paused, retry returned 503, and the network guard observed zero external fetch attempts.`);
  } finally {
    if (exitResult == null) child.kill("SIGTERM");
    if (exitResult == null) {
      await Promise.race([
        childExit,
        delay(5_000).then(() => { throw new Error(`offline server did not stop cleanly; stderr: ${stderr.slice(-2_000)}`); }),
      ]);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
