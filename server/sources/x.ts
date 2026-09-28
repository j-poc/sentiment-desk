import type { Company } from "../types.js";
import { paceProviderRequest } from "../provider-cooldown.js";

/**
 * X (Twitter) recent-search ingestion via API v2. Optional: without a bearer
 * token this source stays disabled and the desk runs on RSS. Rate limits are
 * surfaced as degraded health, never swallowed.
 */

export interface XPost {
  id: string;
  text: string;
  createdAt: number;
  authorName: string;
  handle: string;
}

export interface XSearchResult {
  posts: XPost[];
  newestId?: string;
  nextToken?: string;
  rateLimited: boolean;
  resetAt?: number;
}

export class XPaginationTokenRejectedError extends Error {
  constructor(readonly status: number) {
    super(`X pagination token was rejected with HTTP ${status}`);
    this.name = "XPaginationTokenRejectedError";
  }
}

export class XNonAdvancingPaginationTokenError extends Error {
  constructor() {
    super("X API returned a non-advancing pagination token");
    this.name = "XNonAdvancingPaginationTokenError";
  }
}

export function xQuery(company: Company): string {
  const terms = [...company.aliases, `$${company.ticker}`]
    .map((t) => `"${t}"`)
    .join(" OR ");
  return `(${terms}) lang:en -is:retweet -is:reply`;
}

export async function searchRecent(opts: {
  bearer: string;
  company: Company;
  sinceId?: string;
  paginationToken?: string;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<XSearchResult> {
  const params = new URLSearchParams({
    query: xQuery(opts.company),
    max_results: String(opts.maxResults ?? 25),
    "tweet.fields": "created_at",
    expansions: "author_id",
    "user.fields": "name,username",
  });
  if (opts.sinceId) params.set("since_id", opts.sinceId);
  if (opts.paginationToken) params.set("next_token", opts.paginationToken);

  await paceProviderRequest("x", 1_000);
  const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { authorization: `Bearer ${opts.bearer}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset") ?? "0") * 1000;
    return { posts: [], rateLimited: true, resetAt: Number.isFinite(reset) && reset > 0 ? reset : undefined };
  }
  if (!res.ok) {
    // A continuation request differs from its known-good first page only by
    // the opaque cursor. Restart from the last committed since_id after a
    // cursor-specific client rejection; never advance past undrained results.
    if (opts.paginationToken && [400, 410, 422].includes(res.status)) {
      throw new XPaginationTokenRejectedError(res.status);
    }
    throw new Error(`X API HTTP ${res.status}`);
  }

  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("X API returned an invalid response shape");
  }
  const response = body as Record<string, unknown>;
  if (response.meta == null || typeof response.meta !== "object" || Array.isArray(response.meta)) {
    throw new Error("X API returned invalid pagination metadata");
  }
  const meta = response.meta as Record<string, unknown>;
  const resultCount = meta.result_count;
  if (typeof resultCount !== "number" || !Number.isSafeInteger(resultCount) || resultCount < 0) {
    throw new Error("X API returned an invalid result count");
  }
  const rawNextToken = meta.next_token;
  if (rawNextToken !== undefined && (typeof rawNextToken !== "string" || rawNextToken.trim() === "")) {
    throw new Error("X API returned an invalid pagination token");
  }
  if (typeof rawNextToken === "string" && rawNextToken === opts.paginationToken) {
    throw new XNonAdvancingPaginationTokenError();
  }
  const rawNewestId = meta.newest_id;
  if (rawNewestId !== undefined && (typeof rawNewestId !== "string" || !/^\d+$/.test(rawNewestId))) {
    throw new Error("X API returned an invalid newest post ID");
  }
  const responseNewestId = typeof rawNewestId === "string" ? rawNewestId : undefined;
  const rawData = response.data;
  if (rawData == null && resultCount !== 0) {
    throw new Error("X API returned an invalid response: posts were omitted despite a nonzero result count");
  }
  if (rawData != null && !Array.isArray(rawData)) {
    throw new Error("X API returned an invalid posts list");
  }
  const data = (rawData ?? []) as unknown[];
  if (data.length !== resultCount) {
    throw new Error("X API post count does not match its result count");
  }

  const rawUsers = typeof response.includes === "object" && response.includes !== null && !Array.isArray(response.includes)
    ? (response.includes as Record<string, unknown>).users
    : undefined;
  if (rawUsers != null && !Array.isArray(rawUsers)) throw new Error("X API returned an invalid author list");
  const users = new Map<string, { name?: string; username?: string }>();
  for (const row of (rawUsers ?? []) as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const user = row as Record<string, unknown>;
    if (typeof user.id === "string") {
      users.set(user.id, {
        name: typeof user.name === "string" ? user.name : undefined,
        username: typeof user.username === "string" ? user.username : undefined,
      });
    }
  }
  const posts = data.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("X API returned a malformed post row");
    }
    const t = value as Record<string, unknown>;
    if (typeof t.id !== "string" || !/^\d+$/.test(t.id)
      || typeof t.text !== "string" || t.text.trim() === ""
      || typeof t.created_at !== "string" || !Number.isFinite(Date.parse(t.created_at))
      || typeof t.author_id !== "string" || t.author_id.trim() === "") {
      throw new Error("X API post row is missing required identity or timestamp fields");
    }
    const u = users.get(t.author_id);
    return {
      id: t.id,
      text: t.text,
      createdAt: Date.parse(t.created_at),
      authorName: u?.name ?? t.author_id,
      handle: u?.username ?? "unknown",
    } satisfies XPost;
  });

  return {
    posts,
    newestId: responseNewestId,
    nextToken: typeof rawNextToken === "string" ? rawNextToken : undefined,
    rateLimited: false,
  };
}
