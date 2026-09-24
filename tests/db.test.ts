import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Desk } from "../server/db.js";
import type { Company, MentionScore } from "../server/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desk.scoredMentionEvents", () => {
  it("returns the stored event type for each scored event", () => {
    const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-db-"));
    directories.push(directory);
    const db = new Desk(join(directory, "desk.db"));
    try {
      const company: Company = {
        id: "acme",
        name: "Acme",
        ticker: "ACME",
        sector: "Technology",
        aliases: ["Acme"],
        color: "#123456",
      };
      db.seedCompanies([company]);

      const publishedAt = Date.now() - 60_000;
      const insert = (digest: string, title: string) =>
        db.insertMention({
          companyId: company.id,
          kind: "rss",
          sourceName: "Example News",
          sourceUrl: `https://example.com/${digest}`,
          tier: "wire",
          title,
          snippet: "Example snippet",
          publishedAt,
          retrievedAt: Date.now(),
          digest,
        });

      const score = (eventType: string): MentionScore => ({
        sentiment: "positive",
        pPos: 0.8,
        pNeu: 0.1,
        pNeg: 0.1,
        confidence: 0.8,
        about: 1,
        material: 0.8,
        novel: 0.8,
        credible: 0.9,
        investorRelevant: 0.9,
        eventType,
        takeaway: "positive update",
        magnitude: 0.5,
        surprise: 0.2,
        eventScore: 70,
        impact: 56,
        weight: 0.8,
        engine: "test",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 1,
        rubricSha: "test",
        scoredAt: Date.now(),
      });

      expect(insert("results", "Results announced")).toBe(true);
      db.markScored(`${company.id}:results`, score("results"), false);
      expect(insert("leadership", "Leadership change")).toBe(true);
      db.markScored(`${company.id}:leadership`, score("leadership"), false);

      const events = db.scoredMentionEvents(publishedAt - 1);
      expect(events.map((event) => event.eventType)).toEqual(["results", "leadership"]);
      expect(events.every((event) => event.ticker === "ACME")).toBe(true);
    } finally {
      db.close();
    }
  });
});
