import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isNearDuplicateTitle, mentionDigest, normalizeTitle } from "./scoring.js";
import type {
  Company,
  MentionDTO,
  MentionScore,
  MentionStatus,
  RawMention,
  SourceKind,
  SourceTier,
} from "./types.js";

/**
 * SQLite via node:sqlite (built into Node 22+). WAL mode, single writer, one
 * process. Every scored mention keeps full provenance columns so the dashboard
 * can always answer: which source, when published vs when fetched, which
 * rubric hash, what the model said, what it cost.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  sector TEXT NOT NULL,
  aliases TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_tier TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  retrieved_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sentiment TEXT,
  confidence REAL,
  p_pos REAL,
  p_neu REAL,
  p_neg REAL,
  about REAL,
  material REAL,
  novel REAL,
  credible REAL,
  investor_relevant REAL,
  event_type TEXT,
  takeaway TEXT,
  magnitude REAL,
  surprise REAL,
  event_score REAL,
  impact REAL,
  weight REAL,
  exclude INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  rubric_sha TEXT,
  score_error TEXT,
  scored_at INTEGER
);
CREATE INDEX IF NOT EXISTS mentions_company_published ON mentions(company_id, published_at);
CREATE INDEX IF NOT EXISTS mentions_status ON mentions(status);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_points (
  ticker TEXT NOT NULL,
  t INTEGER NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (ticker, t)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL
);
`;

interface MentionRow {
  id: string;
  company_id: string;
  source_name: string;
  source_url: string;
  source_kind: string;
  source_tier: string;
  title: string;
  snippet: string;
  published_at: number;
  retrieved_at: number;
  status: string;
  sentiment: string | null;
  confidence: number | null;
  p_pos: number | null;
  p_neu: number | null;
  p_neg: number | null;
  about: number | null;
  material: number | null;
  novel: number | null;
  credible: number | null;
  investor_relevant: number | null;
  event_type: string | null;
  takeaway: string | null;
  magnitude: number | null;
  surprise: number | null;
  event_score: number | null;
  impact: number | null;
  weight: number | null;
  exclude: number;
  engine: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  rubric_sha: string | null;
  score_error: string | null;
  scored_at: number | null;
}

export class Desk {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for databases created before the current schema. */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(mentions)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const additions: Array<[string, string]> = [
      ["event_type", "TEXT"],
      ["magnitude", "REAL"],
      ["surprise", "REAL"],
      ["event_score", "REAL"],
      ["investor_relevant", "REAL"],
      ["takeaway", "TEXT"],
    ];
    for (const [name, ddl] of additions) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE mentions ADD COLUMN ${name} ${ddl}`);
    }
  }

  seedCompanies(companies: Company[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO companies (id, name, ticker, sector, aliases, color)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, ticker=excluded.ticker,
         sector=excluded.sector, aliases=excluded.aliases, color=excluded.color`,
    );
    for (const c of companies) {
      upsert.run(c.id, c.name, c.ticker, c.sector, JSON.stringify(c.aliases), c.color);
    }
  }

  companies(): Company[] {
    const rows = this.db.prepare("SELECT * FROM companies ORDER BY ticker").all() as Array<{
      id: string; name: string; ticker: string; sector: string; aliases: string; color: string;
    }>;
    return rows.map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[] }));
  }

  /** Returns false when the digest already exists; inserts are otherwise idempotent. */
  insertMention(m: RawMentionInput): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO mentions
         (id, company_id, source_name, source_url, source_kind, source_tier,
          title, snippet, published_at, retrieved_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        m.companyId + ":" + m.digest,
        m.companyId,
        m.sourceName,
        m.sourceUrl,
        m.kind,
        m.tier,
        m.title,
        m.snippet,
        m.publishedAt,
        m.retrievedAt,
      );
    return Number(res.changes) > 0;
  }

  mentionRow(id: string): MentionRow | undefined {
    return this.db.prepare("SELECT * FROM mentions WHERE id = ?").get(id) as MentionRow | undefined;
  }

  markScored(id: string, s: MentionScore, exclude: boolean): void {
    this.db
      .prepare(
        `UPDATE mentions SET
           status = ?, sentiment = ?, confidence = ?, p_pos = ?, p_neu = ?, p_neg = ?,
           about = ?, material = ?, novel = ?, credible = ?, investor_relevant = ?, event_type = ?, takeaway = ?, magnitude = ?,
           surprise = ?, event_score = ?, impact = ?, weight = ?,
           exclude = ?, engine = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?,
           latency_ms = ?, rubric_sha = ?, score_error = NULL, scored_at = ?
         WHERE id = ?`,
      )
      .run(
        exclude ? "off_target" : "scored",
        s.sentiment,
        s.confidence,
        s.pPos,
        s.pNeu,
        s.pNeg,
        s.about,
        s.material,
        s.novel,
        s.credible,
        s.investorRelevant,
        s.eventType,
        s.takeaway,
        s.magnitude,
        s.surprise,
        s.eventScore,
        s.impact,
        s.weight,
        exclude ? 1 : 0,
        s.engine,
        s.inputTokens,
        s.outputTokens,
        s.costUsd,
        s.latencyMs,
        s.rubricSha,
        s.scoredAt,
        id,
      );
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare("UPDATE mentions SET status = 'failed', score_error = ? WHERE id = ?")
      .run(error.slice(0, 500), id);
  }

  mentionsForCompany(companyId: string, sinceMs: number, limit: number): MentionDTO[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mentions WHERE company_id = ? AND published_at >= ?
         ORDER BY published_at DESC LIMIT ?`,
      )
      .all(companyId, sinceMs, limit) as unknown as MentionRow[];
    return rows.map(rowToDTO);
  }

  /**
   * Tape: scored mentions first-class, but pending ones stay visible so the
   * live flow is observable even before scoring is configured. Failed items
   * are health-panel material, not tape material.
   */
  recentVisible(limit: number): MentionDTO[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mentions WHERE status IN ('scored', 'pending')
         ORDER BY published_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as MentionRow[];
    return rows.map(rowToDTO);
  }

  /** Scored, non-excluded mentions for index math over a window. */
  scoredMentions(sinceMs: number): Array<{
    companyId: string; publishedAt: number; impact: number; weight: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT company_id, published_at, impact, weight FROM mentions
         WHERE status = 'scored' AND published_at >= ? AND impact IS NOT NULL`,
      )
      .all(sinceMs) as Array<{ company_id: string; published_at: number; impact: number; weight: number }>;
    return rows.map((r) => ({
      companyId: r.company_id,
      publishedAt: r.published_at,
      impact: r.impact,
      weight: r.weight,
    }));
  }

  upsertPricePoint(ticker: string, t: number, price: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO price_points (ticker, t, price) VALUES (?, ?, ?)")
      .run(ticker, Math.floor(t / 1000) * 1000, price);
  }

  priceWindow(ticker: string, sinceMs: number): Array<{ t: number; price: number }> {
    return this.db
      .prepare("SELECT t, price FROM price_points WHERE ticker = ? AND t >= ? ORDER BY t")
      .all(ticker, sinceMs) as unknown as Array<{ t: number; price: number }>;
  }

  /**
   * Rubric migration: re-queue scored mentions judged by an older rubric so
   * they are re-judged under the current wording (and its new questions).
   * Returns how many were requeued.
   */
  resetOutdatedRubric(currentSha: string): number {
    const res = this.db
      .prepare(
        `UPDATE mentions SET status = 'pending'
         WHERE status IN ('scored', 'off_target') AND rubric_sha IS NOT NULL AND rubric_sha != ?`,
      )
      .run(currentSha);
    return Number(res.changes);
  }

  pendingIds(limit: number): string[] {
    return (
      this.db.prepare("SELECT id FROM mentions WHERE status = 'pending' ORDER BY published_at DESC LIMIT ?")
        .all(limit) as unknown as Array<{ id: string }>
    ).map((r) => r.id);
  }

  recentTitles(companyId: string, sinceMs: number, limit = 40): Array<{ title: string }> {
    return this.db
      .prepare(
        "SELECT title FROM mentions WHERE company_id = ? AND retrieved_at >= ? ORDER BY retrieved_at DESC LIMIT ?",
      )
      .all(companyId, sinceMs, limit) as unknown as Array<{ title: string }>;
  }

  /**
   * One-time cleanup of syndication duplicates already in the database: per
   * company, later near-duplicates of a kept story (same title family within
   * the window) are removed, keeping the earliest copy. Returns delete count.
   */
  dedupeNearDuplicates(windowMs = 45 * 60_000, threshold = 0.55): number {
    const rows = this.db
      .prepare("SELECT id, company_id, title, published_at FROM mentions ORDER BY company_id, published_at")
      .all() as unknown as Array<{ id: string; company_id: string; title: string; published_at: number }>;
    const del = this.db.prepare("DELETE FROM mentions WHERE id = ?");
    let deleted = 0;
    let companyId: string | null = null;
    let kept: Array<{ title: string; published_at: number; norm: string }> = [];
    const seenNormByCompany = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.company_id !== companyId) {
        companyId = r.company_id;
        kept = [];
      }
      const norm = normalizeTitle(r.title);
      const seen = seenNormByCompany.get(r.company_id) ?? new Set<string>();
      // Exact normalized-title repeats are the same story at any distance in
      // time (re-syndication, updates); near-duplicates only within the window.
      const exactDup = seen.has(norm);
      const nearDup = kept.some(
        (k) => r.published_at - k.published_at <= windowMs && isNearDuplicateTitle(r.title, k.title, threshold),
      );
      if (exactDup || nearDup) {
        del.run(r.id);
        deleted += 1;
      } else {
        kept.push({ title: r.title, published_at: r.published_at, norm });
      }
      seen.add(norm);
      seenNormByCompany.set(r.company_id, seen);
    }

    // Complete the digest migration: re-key surviving rows to content digests
    // so INSERT OR IGNORE blocks re-syndication from any feed, forever.
    const survivors = this.db
      .prepare("SELECT id, company_id, title FROM mentions")
      .all() as unknown as Array<{ id: string; company_id: string; title: string }>;
    const exists = this.db.prepare("SELECT 1 FROM mentions WHERE id = ?");
    const rekey = this.db.prepare("UPDATE mentions SET id = ? WHERE id = ?");
    let rekeyed = 0;
    for (const r of survivors) {
      const target = `${r.company_id}:${mentionDigest("", "", r.title)}`;
      if (target === r.id) continue;
      if (!exists.get(target)) {
        rekey.run(target, r.id);
        rekeyed += 1;
      }
    }
    if (rekeyed > 0) this.logEvent("info", "dedupe", `re-keyed ${rekeyed} mentions to content digests`);
    return deleted;
  }

  /** Scored, non-excluded events across the watchlist with ticker identity. */
  scoredMentionEvents(
    sinceMs: number,
  ): Array<{ companyId: string; ticker: string; publishedAt: number; sentiment: string; eventScore: number; title: string }> {
    return this.db
      .prepare(
        `SELECT m.company_id AS companyId, c.ticker AS ticker, m.published_at AS publishedAt,
                m.sentiment AS sentiment, m.event_score AS eventScore, m.title AS title
         FROM mentions m JOIN companies c ON c.id = m.company_id
         WHERE m.status = 'scored' AND m.published_at >= ? AND m.impact IS NOT NULL
         ORDER BY m.published_at`,
      )
      .all(sinceMs) as unknown as Array<{
        companyId: string;
        ticker: string;
        publishedAt: number;
        sentiment: string;
        eventScore: number;
        title: string;
      }>;
  }

  counts24h(sinceMs: number): Map<string, { count: number; lastAt: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT company_id, COUNT(*) AS n, MAX(published_at) AS last_at
         FROM mentions WHERE published_at >= ? GROUP BY company_id`,
      )
      .all(sinceMs) as Array<{ company_id: string; n: number; last_at: number | null }>;
    return new Map(rows.map((r) => [r.company_id, { count: r.n, lastAt: r.last_at }]));
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  logEvent(level: "info" | "warn" | "error", source: string, message: string): void {
    this.db.prepare("INSERT INTO events (at, level, source, message) VALUES (?, ?, ?, ?)").run(
      Date.now(),
      level,
      source,
      message.slice(0, 500),
    );
  }

  recentEvents(limit: number): Array<{ at: number; level: string; source: string; message: string }> {
    return this.db
      .prepare("SELECT at, level, source, message FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ at: number; level: string; source: string; message: string }>;
  }

  usageSince(sinceMs: number): { calls: number; inputTokens: number; outputTokens: number; costUsd: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS in_tok,
                COALESCE(SUM(output_tokens), 0) AS out_tok,
                COALESCE(SUM(cost_usd), 0) AS cost
         FROM mentions WHERE scored_at >= ? AND status IN ('scored', 'off_target')`,
      )
      .get(sinceMs) as { calls: number; in_tok: number; out_tok: number; cost: number };
    return {
      calls: row.calls,
      inputTokens: row.in_tok,
      outputTokens: row.out_tok,
      costUsd: row.cost,
    };
  }

  close(): void {
    this.db.close();
  }
}

export function rowToDTO(r: MentionRow): MentionDTO {
  const status: MentionStatus =
    r.status === "off_target" ? "off_target" : (r.status as MentionStatus);
  const score: MentionScore | null =
    r.status === "scored" || r.status === "off_target"
      ? {
          sentiment: (r.sentiment ?? "neutral") as MentionScore["sentiment"],
          pPos: r.p_pos ?? 0,
          pNeu: r.p_neu ?? 0,
          pNeg: r.p_neg ?? 0,
          confidence: r.confidence ?? 0,
          about: r.about ?? 0,
          material: r.material ?? 0,
          novel: r.novel ?? 0,
          credible: r.credible ?? 0,
          // Legacy rows judged before this question existed pass through.
          investorRelevant: r.investor_relevant ?? 1,
          eventType: r.event_type ?? "other",
          takeaway: r.takeaway ?? "routine",
          magnitude: r.magnitude ?? 0,
          surprise: r.surprise ?? 0,
          eventScore: r.event_score ?? 0,
          impact: r.impact ?? 0,
          weight: r.weight ?? 0,
          engine: r.engine ?? "",
          inputTokens: r.input_tokens ?? 0,
          outputTokens: r.output_tokens ?? 0,
          costUsd: r.cost_usd ?? 0,
          latencyMs: r.latency_ms ?? 0,
          rubricSha: r.rubric_sha ?? "",
          scoredAt: r.scored_at ?? 0,
        }
      : null;
  return {
    id: r.id,
    companyId: r.company_id,
    source: {
      name: r.source_name,
      url: r.source_url,
      kind: r.source_kind as SourceKind,
      tier: r.source_tier as SourceTier,
    },
    title: r.title,
    snippet: r.snippet,
    publishedAt: r.published_at,
    retrievedAt: r.retrieved_at,
    status,
    score,
    error: r.score_error,
  };
}

export interface RawMentionInput extends RawMention {
  digest: string;
}
