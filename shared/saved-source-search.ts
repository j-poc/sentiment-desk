import { z } from "zod";

/** Stable scope and keyset position for a read-only search of retained sources. */
export const savedSourceSearchCursorSchema = z.object({
  searchSemanticsVersion: z.literal(2),
  query: z.string().min(2).max(120),
  companyId: z.string().max(160).nullable(),
  publisher: z.string().max(120).nullable(),
  includeDismissed: z.boolean(),
  snapshotAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reviewRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceTimeUnknown: z.boolean(),
  orderAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retrievedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ingestedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1).max(300),
}).strict();

export type SavedSourceSearchCursor = z.infer<typeof savedSourceSearchCursorSchema>;

/** Short ticker-like terms must match as tokens, not inside unrelated words. */
export function savedSourceTextMatches(text: string, query: string): boolean {
  const needle = query.trim();
  if (!needle) return false;
  if (/^[\p{L}\p{N}]{2}$/u.test(needle)) {
    const normalizedNeedle = needle.toLocaleLowerCase("en-US");
    const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
    return tokens.some((token) => token.toLocaleLowerCase("en-US") === normalizedNeedle);
  }
  return text.toLocaleLowerCase("en-US").includes(needle.toLocaleLowerCase("en-US"));
}

export interface SavedSourceSearchPage<TMention> {
  query: string;
  companyId: string | null;
  publisher: string | null;
  includeDismissed: boolean;
  snapshotAt: number;
  reviewRevision: number;
  totalCount: number;
  items: TMention[];
  nextCursor: SavedSourceSearchCursor | null;
}
