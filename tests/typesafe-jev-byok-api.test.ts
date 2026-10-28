import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../server/app.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { ModelProviderCredentialVault, type KeyringSecret } from "../server/model-provider-credential-vault.js";
import { TypeSafeJevByokService } from "../server/typesafe-jev-byok.js";
import type { Company } from "../server/types.js";
import { TestDesk } from "./test-desk.js";

const directories: string[] = [];
const company: Company = { id: "acme", name: "Acme Corporation", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456" };
const choice = (key: string, keys: readonly string[]) => ({ type: "choice", choice: key,
  probabilities: Object.fromEntries(keys.map(value => [value, value === key ? 1 : 0])), confidence: 0.86 });
const answers = {
  sentiment: choice("positive", ["negative", "neutral", "positive"]), about: { type: "noul", noul: 0.95 },
  investor_relevant: { type: "noul", noul: 0.9 }, material: { type: "noul", noul: 0.8 }, novel: { type: "noul", noul: 0.75 },
  credible: { type: "noul", noul: 0.85 }, event_type: choice("corporate_action", ["results", "corporate_action", "legal_regulatory", "leadership", "product", "analyst_action", "macro_sector", "other"]),
  magnitude: { type: "noul", noul: 0.65 }, surprise: { type: "noul", noul: 0.6 }, takeaway: choice("product_win", ["results_beat", "results_miss", "guidance_raise", "guidance_cut", "accounting_redo", "listing_risk", "mna_capital", "leadership", "legal_hit", "legal_relief", "product_win", "product_setback", "analyst_shift", "routine"]),
};

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("TypeSafe Jev BYOK local routes", () => {
  it("keeps keys private and saves only a user-confirmed result in the separate Jev history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "typesafe-jev-byok-api-")); directories.push(directory);
    const dbPath = join(directory, "desk.db");
    const db = new TestDesk(dbPath);
    try {
      db.seedCompanies([company]);
      const observationId = db.insertObservation({ companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: "https://example.com/acme",
        tier: "major", title: "Acme wins a major manufacturing contract", snippet: "Acme Corporation said the contract adds capacity.",
        publishedAt: Date.now(), retrievedAt: Date.now(), collector: "google_news_rss", sourceItemId: "api-test" }).observationId;
      const secrets = new Map<string, Uint8Array>();
      const keyring: KeyringSecret = { getSecret: async () => secrets.get("key"), setSecret: async value => { secrets.set("key", Uint8Array.from(value)); } };
      const vault = new ModelProviderCredentialVault(join(directory, "credentials"), keyring);
      const requests: string[] = [];
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        requests.push(String(input));
        const value = String(input).endsWith("/v1/models")
          ? { models: [{ name: "jev-latest" }] }
          : { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 0 } };
        return new Response(JSON.stringify(value), { status: 200 });
      }) as typeof fetch;
      const typesafeJevByok = new TypeSafeJevByokService({ loopbackBound: true, externalRequestsEnabled: true, db, vault,
        storageAllowsProviderRequests: () => true, allowedCollectors: new Set(["google_news_rss"]), fetchImpl });
      const app = createApp({ db, dbPath, pipeline: {} as AppDeps["pipeline"], market: {} as AppDeps["market"], hub: new Hub(),
        health: new HealthTracker(false, false, "unconfigured"), version: "test", deliverySources: [], typesafeJevByok });
      const origin = "http://127.0.0.1:5174";
      const request = (method: string, path: string, body?: unknown) => app.request(`${origin}${path}`, {
        method, headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const saved = await request("PUT", "/api/model-providers/typesafe_jev/credential", { apiKey: "test-typesafe-secret" });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ configured: true });
      const status = await (await request("GET", "/api/model-providers/status")).json() as { providers: Array<Record<string, unknown>> };
      expect(status.providers).toEqual([expect.objectContaining({ provider: "typesafe_jev", configured: true, model: "jev-latest" })]);
      expect(JSON.stringify(status)).not.toContain("test-typesafe-secret");
      expect((await request("POST", "/api/model-providers/typesafe_jev/verify", {})).status).toBe(200);
      expect(requests).toEqual(["https://api.typesafe.ai/v1/models"]);

      const unconfirmed = await request("POST", `/api/mentions/${observationId}/jev-assessment`, { confirmDataSend: false, confirmProviderUsageReview: false });
      expect(unconfirmed.status).toBe(400);
      expect(requests).toHaveLength(1);
      const assessed = await request("POST", `/api/mentions/${observationId}/jev-assessment`, { confirmDataSend: true, confirmProviderUsageReview: false });
      expect(assessed.status).toBe(200);
      expect(await assessed.json()).toMatchObject({ result: { sentiment: "positive", modelReturned: "jev-1.13.0" } });
      expect(requests).toHaveLength(2);
      const savedResult = await request("GET", `/api/mentions/${observationId}/model-classification?provider=typesafe_jev`);
      expect(await savedResult.json()).toMatchObject({ result: { provider: "typesafe_jev", sentiment: "positive", disposition: "classified" } });
      expect(db.mentionRow(observationId)).toMatchObject({ status: "pending", scored_at: null, engine: null });
    } finally { db.close(); }
  });
});
