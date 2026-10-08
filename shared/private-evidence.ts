import { z } from "zod";
import { isWellFormedUnicode } from "./well-formed-unicode.js";

export const MAX_PRIVATE_EVIDENCE_CONTENT_BYTES = 128 * 1024;
export const MAX_PRIVATE_EVIDENCE_CONTENT_CODE_POINTS = 40_000;
export const MAX_PRIVATE_EVIDENCE_ITEMS = 250;
export const MAX_PRIVATE_EVIDENCE_TOTAL_BYTES = 8 * 1024 * 1024;
// JSON may expand control characters and quotes from the maximum accepted
// 128 KiB text body. Keep the transport bounded while leaving room for that
// encoding overhead and the small metadata envelope.
export const MAX_PRIVATE_EVIDENCE_REQUEST_BYTES = 800 * 1024;

export const PRIVATE_EVIDENCE_ANALYSIS_MODEL = "gpt-6-luna" as const;

const safeLabel = z.string().trim().min(1).max(120).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
);

export const privateEvidenceInputSchema = z.object({
  title: safeLabel,
  sourceLabel: safeLabel,
  fileName: z.string().trim().min(1).max(128).nullable().optional(),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  content: z.string().min(1).refine((value) => value.trim().length > 0)
    .refine(isWellFormedUnicode)
    .refine((value) => !value.includes("\u0000"))
    .refine((value) => [...value].length <= MAX_PRIVATE_EVIDENCE_CONTENT_CODE_POINTS)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PRIVATE_EVIDENCE_CONTENT_BYTES),
}).strict().superRefine((value, context) => {
  if (value.asOfDate != null) {
    const date = new Date(`${value.asOfDate}T00:00:00.000Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value.asOfDate) {
      context.addIssue({ code: "custom", path: ["asOfDate"], message: "invalid_calendar_date" });
    }
  }
  if (value.fileName != null && /[\\/\u0000-\u001f\u007f]/u.test(value.fileName)) {
    context.addIssue({ code: "custom", path: ["fileName"], message: "file_name_must_be_a_basename" });
  }
});

export type PrivateEvidenceInput = z.infer<typeof privateEvidenceInputSchema>;

export interface PrivateEvidenceMetadata {
  id: string;
  companyId: string;
  title: string;
  sourceLabel: string;
  fileName: string | null;
  asOfDate: string | null;
  importedAt: number;
  sha256: string;
  byteLength: number;
}

export interface PrivateEvidenceItem extends PrivateEvidenceMetadata {
  content: string;
}

export const privateEvidenceAnalysisContentSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative", "unclear"]),
  summary: z.string().trim().min(1).max(1_200),
  evidence: z.array(z.object({
    quote: z.string().min(1).max(600).refine((value) => value.trim().length > 0),
    explanation: z.string().trim().min(1).max(360),
  }).strict()).max(4),
  uncertainties: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
  nextQuestion: z.string().trim().min(1).max(500),
}).strict().superRefine((value, context) => {
  if (value.sentiment !== "unclear" && value.evidence.length === 0) {
    context.addIssue({ code: "custom", message: "categorical_read_requires_evidence" });
  }
});

export const privateEvidenceAnalysisUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative(),
}).strict();

export const privateEvidenceAnalysisRecordSchema = z.object({
  companyId: z.string().min(1),
  evidenceId: z.string().uuid(),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestBytes: z.number().int().positive(),
  modelRequested: z.literal("gpt-6-luna"),
  modelReturned: z.literal("gpt-6-luna"),
  serviceTierRequested: z.literal("default"),
  serviceTier: z.literal("default"),
  promptVersion: z.string().min(1).max(100),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  schemaVersion: z.string().min(1).max(100),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
  profileVersion: z.string().min(1).max(100),
  profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  responseId: z.string().min(1).max(200),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  usage: privateEvidenceAnalysisUsageSchema,
  analysis: privateEvidenceAnalysisContentSchema,
  latencyMs: z.number().int().nonnegative(),
  httpStatus: z.literal(200),
  dataControls: z.object({
    endpoint: z.literal("https://api.openai.com/v1/responses"),
    responseObjectStorage: z.literal(false),
    promptCacheMode: z.literal("explicit_no_breakpoints"),
    promptCacheWritesRequested: z.literal(false),
    defaultAbuseMonitoringRetentionDays: z.literal(30),
    organizationRetentionPolicy: z.literal("unverified"),
    disclosure: z.string().min(1).max(2_000),
    documentationUrl: z.literal("https://developers.openai.com/api/docs/guides/your-data"),
    promptCachingDocumentationUrl: z.literal("https://developers.openai.com/api/docs/guides/prompt-caching"),
  }).strict(),
}).strict();

export type PrivateEvidenceAnalysisContent = z.infer<typeof privateEvidenceAnalysisContentSchema>;
export type PrivateEvidenceAnalysisRecord = z.infer<typeof privateEvidenceAnalysisRecordSchema>;

export interface PrivateEvidenceList {
  items: PrivateEvidenceMetadata[];
  totalCount: number;
  totalBytes: number;
  nextCursor: null;
}
