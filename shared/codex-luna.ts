import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const codexLunaSavedSchema = z.object({
  provider: z.literal("codex_luna"), attemptId: z.string().uuid(), observationId: z.string().min(1),
  companyId: z.string().min(1), sourceSha256: digest, requestSha256: digest,
  promptSha256: digest, schemaSha256: digest,
  modelRequested: z.literal("gpt-6-luna"), modelConfigured: z.literal("gpt-6-luna"), modelReturned: z.null(),
  threadId: z.string().min(1), turnId: z.string().min(1), cliVersion: z.string().min(1), outputSha256: digest,
  tokenUsage: z.object({ inputTokens: count, outputTokens: count, totalTokens: count,
    cachedInputTokens: count, reasoningOutputTokens: count }).strict(),
  sourceTimeAt: count.nullable(), retrievedAt: count, createdAt: count,
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  eventType: z.string().nullable(), takeaway: z.string().nullable(), about: z.boolean().nullable(),
  material: z.boolean().nullable(), investorRelevant: z.boolean().nullable(), evidenceSufficient: z.boolean(),
  summary: z.string().max(1500).nullable(), supportingExcerpt: z.string().max(1500).nullable(),
  disposition: z.enum(["classified", "excluded", "review_required"]),
}).strict().superRefine((value, context) => {
  if (value.tokenUsage.totalTokens !== value.tokenUsage.inputTokens + value.tokenUsage.outputTokens
    || value.tokenUsage.cachedInputTokens > value.tokenUsage.inputTokens
    || value.tokenUsage.reasoningOutputTokens > value.tokenUsage.outputTokens
    || value.createdAt < value.retrievedAt) context.addIssue({ code: "custom", message: "Invalid Codex receipt clocks or usage" });
});
export type CodexLunaSaved = z.infer<typeof codexLunaSavedSchema>;
export type CodexLunaAttempt = {
  id: string; observationId: string; companyId: string; sourceSha256: string; requestBytes: number;
  reservedAt: number; completedAt: number | null;
  status: "reserved" | "dispatched" | "completed" | "not_sent" | "unknown";
  error: string | null; result: unknown;
};
