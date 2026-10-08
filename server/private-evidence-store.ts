import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_PRIVATE_EVIDENCE_ITEMS,
  MAX_PRIVATE_EVIDENCE_TOTAL_BYTES,
  privateEvidenceInputSchema,
  privateEvidenceAnalysisRecordSchema,
  type PrivateEvidenceInput,
  type PrivateEvidenceAnalysisRecord,
  type PrivateEvidenceItem,
  type PrivateEvidenceList,
  type PrivateEvidenceMetadata,
} from "../shared/private-evidence.js";

const MAX_STORE_FILE_BYTES = 16 * 1024 * 1024;
const MIN_FREE_BYTES_AFTER_WRITE = 16 * 1024 * 1024;

export class PrivateEvidenceLimitError extends Error {
  constructor(readonly reason: "item_limit" | "byte_limit" | "disk_headroom" | "store_file_limit") {
    super(reason);
  }
}

interface EvidenceRow {
  id: string;
  company_id: string;
  title: string;
  source_label: string;
  file_name: string | null;
  as_of_date: string | null;
  imported_at: number;
  content_sha256: string;
  byte_length: number;
  content?: string;
}

function metadata(row: EvidenceRow): PrivateEvidenceMetadata {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    sourceLabel: row.source_label,
    fileName: row.file_name,
    asOfDate: row.as_of_date,
    importedAt: Number(row.imported_at),
    sha256: row.content_sha256,
    byteLength: Number(row.byte_length),
  };
}

function restrictStorePath(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("private_evidence_directory_must_not_be_a_symlink");
  }
  chmodSync(directory, 0o700);
  if (!existsSync(path)) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  } else if (lstatSync(path).isSymbolicLink()) {
    throw new Error("private_evidence_database_must_not_be_a_symlink");
  }
  chmodSync(path, 0o600);
}

export class PrivateEvidenceStore {
  private readonly db: DatabaseSync;

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    restrictStorePath(path);
    this.db = new DatabaseSync(path, { timeout: 2_500 });
    try {
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 2500");
      this.db.exec("PRAGMA journal_mode = DELETE");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA secure_delete = ON");
      let version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
      if (version > 2) throw new Error(`unsupported_private_evidence_schema_${version}`);
      if (version === 0) {
        this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        this.db.exec(`
          CREATE TABLE private_evidence (
            id TEXT PRIMARY KEY,
            company_id TEXT NOT NULL,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
            source_label TEXT NOT NULL CHECK(length(source_label) BETWEEN 1 AND 120),
            file_name TEXT CHECK(file_name IS NULL OR length(file_name) BETWEEN 1 AND 128),
            as_of_date TEXT CHECK(as_of_date IS NULL OR as_of_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
            imported_at INTEGER NOT NULL CHECK(imported_at >= 0),
            content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
            byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND ${128 * 1024}),
            content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 40000 AND instr(content, char(0)) = 0),
            UNIQUE(company_id, content_sha256)
          );
          CREATE INDEX private_evidence_company_imported ON private_evidence(company_id, imported_at DESC, id DESC);
          CREATE TRIGGER private_evidence_immutable BEFORE UPDATE ON private_evidence
          BEGIN SELECT RAISE(ABORT, 'private evidence is immutable'); END;
          PRAGMA user_version = 1;
        `);
        version = 1;
      }
      if (version === 1) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(`
            CREATE TABLE private_evidence_analysis (
              company_id TEXT NOT NULL,
              evidence_id TEXT PRIMARY KEY REFERENCES private_evidence(id) ON DELETE CASCADE,
              evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
              payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
              request_bytes INTEGER NOT NULL CHECK(request_bytes BETWEEN 1 AND 260000),
              status TEXT NOT NULL CHECK(status IN ('in_progress', 'complete', 'failed', 'outcome_unknown')),
              response_sha256 TEXT CHECK(response_sha256 IS NULL OR length(response_sha256) = 64),
              analysis_json TEXT CHECK(analysis_json IS NULL OR length(analysis_json) BETWEEN 2 AND 20000),
              error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
              started_at INTEGER NOT NULL CHECK(started_at >= 0),
              saved_at INTEGER CHECK(saved_at IS NULL OR saved_at >= 0),
              CHECK((status = 'complete' AND response_sha256 IS NOT NULL AND analysis_json IS NOT NULL AND saved_at IS NOT NULL AND error_code IS NULL) OR
                (status = 'in_progress' AND response_sha256 IS NULL AND analysis_json IS NULL AND error_code IS NULL AND saved_at IS NULL) OR
                (status IN ('failed', 'outcome_unknown') AND analysis_json IS NULL AND error_code IS NOT NULL AND saved_at IS NOT NULL))
            );
            CREATE TRIGGER private_evidence_analysis_transition BEFORE UPDATE ON private_evidence_analysis
            WHEN OLD.status != 'in_progress' OR NEW.status NOT IN ('complete', 'failed', 'outcome_unknown') OR
              NEW.company_id != OLD.company_id OR NEW.evidence_id != OLD.evidence_id OR
              NEW.evidence_sha256 != OLD.evidence_sha256 OR NEW.payload_sha256 != OLD.payload_sha256 OR
              NEW.request_bytes != OLD.request_bytes OR NEW.started_at != OLD.started_at
            BEGIN SELECT RAISE(ABORT, 'invalid private evidence analysis state transition'); END;
            PRAGMA user_version = 2;
          `);
          this.db.exec("COMMIT");
          version = 2;
        } catch (error) {
          if (this.db.isTransaction) this.db.exec("ROLLBACK");
          throw error;
        }
      }
      const objects = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
      if (!objects.has("private_evidence") || !objects.has("private_evidence_analysis")) throw new Error("private_evidence_store_schema_invalid");
      const capacity = this.db.prepare("PRAGMA max_page_count").get() as { max_page_count?: number } | undefined;
      const pageSize = Number((this.db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined)?.page_size ?? 4096);
      const maxPages = Math.floor(MAX_STORE_FILE_BYTES / pageSize);
      if (Number(capacity?.max_page_count ?? 0) > maxPages) this.db.exec(`PRAGMA max_page_count = ${maxPages}`);
      chmodSync(path, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  list(companyId: string): PrivateEvidenceList {
    const items = this.db.prepare(`
      SELECT id, company_id, title, source_label, file_name, as_of_date, imported_at,
        content_sha256, byte_length
      FROM private_evidence WHERE company_id = ? ORDER BY imported_at DESC, id DESC
    `).all(companyId) as unknown as EvidenceRow[];
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS total_count, COALESCE(SUM(byte_length), 0) AS total_bytes
      FROM private_evidence WHERE company_id = ?
    `).get(companyId) as { total_count: number; total_bytes: number };
    return {
      items: items.map(metadata),
      totalCount: Number(totals.total_count),
      totalBytes: Number(totals.total_bytes),
      nextCursor: null,
    };
  }

  get(companyId: string, id: string): PrivateEvidenceItem | null {
    const row = this.db.prepare(`
      SELECT id, company_id, title, source_label, file_name, as_of_date, imported_at,
        content_sha256, byte_length, content
      FROM private_evidence WHERE company_id = ? AND id = ?
    `).get(companyId, id) as EvidenceRow | undefined;
    if (!row || typeof row.content !== "string") return null;
    const actualDigest = createHash("sha256").update(row.content, "utf8").digest("hex");
    if (actualDigest !== row.content_sha256 || Buffer.byteLength(row.content, "utf8") !== Number(row.byte_length)) {
      throw new Error("private_evidence_integrity_check_failed");
    }
    return { ...metadata(row), content: row.content };
  }

  getAnalysis(companyId: string, evidenceId: string): {
    status: "in_progress" | "complete" | "failed" | "outcome_unknown";
    payloadSha256: string; requestBytes: number; startedAt: number; savedAt: number | null;
    errorCode: string | null; record: PrivateEvidenceAnalysisRecord | null;
  } | null {
    const row = this.db.prepare(`
      SELECT a.company_id, a.evidence_id, a.evidence_sha256, a.payload_sha256, a.request_bytes,
        a.status, a.response_sha256, a.analysis_json, a.error_code, a.started_at, a.saved_at,
        e.content_sha256 AS current_evidence_sha256
      FROM private_evidence_analysis a
      JOIN private_evidence e ON e.id = a.evidence_id AND e.company_id = a.company_id
      WHERE a.company_id = ? AND a.evidence_id = ?
    `).get(companyId, evidenceId) as {
      company_id: string; evidence_id: string; evidence_sha256: string; payload_sha256: string; request_bytes: number;
      status: "in_progress" | "complete" | "failed" | "outcome_unknown"; response_sha256: string | null;
      analysis_json: string | null; error_code: string | null; started_at: number; saved_at: number | null;
      current_evidence_sha256: string;
    } | undefined;
    if (!row) return null;
    if (row.company_id !== companyId || row.evidence_id !== evidenceId || row.current_evidence_sha256 !== row.evidence_sha256 ||
      !/^[a-f0-9]{64}$/.test(row.payload_sha256)) {
      throw new Error("private_evidence_analysis_integrity_check_failed");
    }
    let record: PrivateEvidenceAnalysisRecord | null = null;
    if (row.status === "complete") {
      let parsed: unknown;
      try { parsed = JSON.parse(row.analysis_json ?? "") as unknown; } catch { throw new Error("private_evidence_analysis_json_invalid"); }
      const result = privateEvidenceAnalysisRecordSchema.safeParse(parsed);
      if (!result.success || result.data.companyId !== companyId || result.data.evidenceId !== evidenceId ||
        result.data.evidenceSha256 !== row.evidence_sha256 || result.data.payloadSha256 !== row.payload_sha256 ||
        result.data.responseSha256 !== row.response_sha256) throw new Error("private_evidence_analysis_integrity_check_failed");
      record = result.data;
    }
    return { status: row.status, payloadSha256: row.payload_sha256, requestBytes: Number(row.request_bytes),
      startedAt: Number(row.started_at), savedAt: row.saved_at == null ? null : Number(row.saved_at), errorCode: row.error_code, record };
  }

  beginAnalysis(companyId: string, evidenceId: string, evidenceSha256: string, payloadSha256: string, requestBytes: number): boolean {
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256) || !/^[a-f0-9]{64}$/.test(payloadSha256) ||
      !Number.isSafeInteger(requestBytes) || requestBytes < 1 || requestBytes > 260_000) throw new Error("invalid_private_evidence_analysis_attempt");
    const current = this.get(companyId, evidenceId);
    if (!current || current.sha256 !== evidenceSha256) throw new Error("private_evidence_analysis_source_changed");
    if (this.availableBytes() < MIN_FREE_BYTES_AFTER_WRITE + 64 * 1024) throw new PrivateEvidenceLimitError("disk_headroom");
    const pageSize = Number((this.db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined)?.page_size ?? 4096);
    const pageCount = Number((this.db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined)?.page_count ?? 0);
    if (pageSize * pageCount + 64 * 1024 > MAX_STORE_FILE_BYTES) throw new PrivateEvidenceLimitError("store_file_limit");
    const now = this.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO private_evidence_analysis(company_id, evidence_id, evidence_sha256, payload_sha256,
        request_bytes, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'in_progress', ?)
    `).run(companyId, evidenceId, evidenceSha256, payloadSha256, requestBytes, now);
    if (Number(result.changes) === 1) {
      chmodSync(this.path, 0o600);
      return true;
    }
    return false;
  }

  cancelAnalysisBeforeDispatch(companyId: string, evidenceId: string, payloadSha256: string): void {
    this.db.prepare("DELETE FROM private_evidence_analysis WHERE company_id = ? AND evidence_id = ? AND payload_sha256 = ? AND status = 'in_progress'")
      .run(companyId, evidenceId, payloadSha256);
  }

  failAnalysis(companyId: string, evidenceId: string, payloadSha256: string, errorCode: string, outcomeUnknown: boolean): void {
    const safeCode = /^[a-z0-9_:-]{1,80}$/i.test(errorCode) ? errorCode : "private_evidence_analysis_failed";
    this.db.prepare(`UPDATE private_evidence_analysis SET status = ?, error_code = ?, saved_at = ?
      WHERE company_id = ? AND evidence_id = ? AND payload_sha256 = ? AND status = 'in_progress'`)
      .run(outcomeUnknown ? "outcome_unknown" : "failed", safeCode, this.now(), companyId, evidenceId, payloadSha256);
    chmodSync(this.path, 0o600);
  }

  completeAnalysis(companyId: string, evidenceId: string, record: PrivateEvidenceAnalysisRecord): { record: PrivateEvidenceAnalysisRecord; savedAt: number } {
    const accepted = privateEvidenceAnalysisRecordSchema.parse(record);
    if (accepted.companyId !== companyId || accepted.evidenceId !== evidenceId) throw new Error("private_evidence_analysis_issuer_mismatch");
    const current = this.get(companyId, evidenceId);
    if (!current || current.sha256 !== accepted.evidenceSha256) throw new Error("private_evidence_analysis_source_changed");
    const encoded = JSON.stringify(accepted);
    if (Buffer.byteLength(encoded, "utf8") > 20_000) throw new Error("private_evidence_analysis_too_large");
    const savedAt = this.now();
    const update = this.db.prepare(`UPDATE private_evidence_analysis SET status = 'complete', response_sha256 = ?, analysis_json = ?, saved_at = ?
      WHERE company_id = ? AND evidence_id = ? AND evidence_sha256 = ? AND payload_sha256 = ? AND status = 'in_progress'`)
      .run(accepted.responseSha256, encoded, savedAt, companyId, evidenceId, accepted.evidenceSha256, accepted.payloadSha256);
    if (Number(update.changes) !== 1) throw new Error("private_evidence_analysis_attempt_not_pending");
    chmodSync(this.path, 0o600);
    return { record: accepted, savedAt };
  }

  save(companyId: string, input: PrivateEvidenceInput): PrivateEvidenceMetadata {
    const accepted = privateEvidenceInputSchema.parse(input);
    const contentBytes = Buffer.byteLength(accepted.content, "utf8");
    if (this.availableBytes() < contentBytes + MIN_FREE_BYTES_AFTER_WRITE) {
      throw new PrivateEvidenceLimitError("disk_headroom");
    }
    const digest = createHash("sha256").update(accepted.content, "utf8").digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.db.prepare(`
        SELECT id, company_id, title, source_label, file_name, as_of_date, imported_at,
          content_sha256, byte_length
        FROM private_evidence WHERE company_id = ? AND content_sha256 = ?
      `).get(companyId, digest) as EvidenceRow | undefined;
      if (duplicate) {
        this.db.exec("COMMIT");
        return metadata(duplicate);
      }
      const totals = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM private_evidence")
        .get() as { count: number; bytes: number };
      if (Number(totals.count) >= MAX_PRIVATE_EVIDENCE_ITEMS) throw new PrivateEvidenceLimitError("item_limit");
      if (Number(totals.bytes) + contentBytes > MAX_PRIVATE_EVIDENCE_TOTAL_BYTES) throw new PrivateEvidenceLimitError("byte_limit");
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO private_evidence(id, company_id, title, source_label, file_name, as_of_date,
          imported_at, content_sha256, byte_length, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, companyId, accepted.title, accepted.sourceLabel, accepted.fileName ?? null,
        accepted.asOfDate ?? null, this.now(), digest, contentBytes, accepted.content);
      const pageSize = Number((this.db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined)?.page_size ?? 4096);
      const pageCount = Number((this.db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined)?.page_count ?? 0);
      if (pageSize * pageCount > MAX_STORE_FILE_BYTES) throw new PrivateEvidenceLimitError("store_file_limit");
      this.db.exec("COMMIT");
      chmodSync(this.path, 0o600);
      const saved = this.db.prepare(`
        SELECT id, company_id, title, source_label, file_name, as_of_date, imported_at,
          content_sha256, byte_length
        FROM private_evidence WHERE id = ?
      `).get(id) as EvidenceRow | undefined;
      if (!saved) throw new Error("private_evidence_readback_failed");
      return metadata(saved);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof PrivateEvidenceLimitError) throw error;
      const sqlite = error as { code?: string; errcode?: number };
      if (sqlite.code === "ERR_SQLITE_FULL" || ((sqlite.errcode ?? -1) & 0xff) === 13) {
        throw new PrivateEvidenceLimitError("store_file_limit");
      }
      throw error;
    }
  }

  delete(companyId: string, id: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("DELETE FROM private_evidence WHERE company_id = ? AND id = ?").run(companyId, id);
      this.db.exec("COMMIT");
      this.db.exec("PRAGMA incremental_vacuum(64)");
      chmodSync(this.path, 0o600);
      return Number(result.changes) > 0;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private availableBytes(): number {
    try {
      const stats = statfsSync(dirname(this.path));
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return 0;
    }
  }
}
