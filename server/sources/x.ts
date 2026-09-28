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
  rateLimited: boolean;
  resetAt?: number;
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

  await paceProviderRequest("x", 1_000);
  const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { authorization: `Bearer ${opts.bearer}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  if (res.status === 429) {
    const reset = Number(res.headers.get("x-rate-limit-reset") ?? "0") * 1000;
    return { posts: [], rateLimited: true, resetAt: Number.isFinite(reset) && reset > 0 ? reset : undefined };
  }
  if (!res.ok) throw new Error(`X API HTTP ${res.status}`);

  const body = (await res.json()) as {
    data?: Array<{ id: string; text: string; created_at: string; author_id: string }>;
    includes?: { users?: Array<{ id: string; name: string; username: string }> };
    meta?: { newest_id?: string };
  };

  const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]));
  const posts = (body.data ?? []).map((t) => {
    const u = users.get(t.author_id);
    return {
      id: t.id,
      text: t.text,
      createdAt: Date.parse(t.created_at),
      authorName: u?.name ?? t.author_id,
      handle: u?.username ?? "unknown",
    } satisfies XPost;
  });

  return { posts, newestId: body.meta?.newest_id, rateLimited: false };
}
