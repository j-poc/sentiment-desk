/**
 * Reddit as the social tier: search results across public subreddits per
 * company, via the free OAuth script-app flow (client_credentials is enough
 * for read-only public search). Tokens are cached in memory and refreshed on
 * 401. Posts are tiered "social" and weighted accordingly by the rubric.
 */

import { paceProviderRequest, parseRetryAfterMs, ProviderRateLimitError } from "../provider-cooldown.js";

export interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  subreddit: string;
  author: string;
  permalink: string;
  createdAt: number | null;
  score: number;
  numComments: number;
}

export interface RedditClient {
  token: string;
  expiresAt: number;
}

export interface RedditSearchResult {
  posts: RedditPost[];
  nextAfter: string | null;
  /** Listing children returned by Reddit before unusable rows are discarded. */
  providerChildCount: number;
  malformedChildCount: number;
}

export class RedditPaginationRestartError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "RedditPaginationRestartError";
  }
}

export async function getRedditToken(
  creds: { clientId: string; clientSecret: string },
  existing?: RedditClient,
  timeoutMs = 10_000,
): Promise<RedditClient> {
  if (existing && existing.expiresAt > Date.now() + 60_000) return existing;
  await paceProviderRequest("reddit", 1_000);
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "sentiment-desk/0.3 (personal research desk)",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new ProviderRateLimitError("reddit", parseRetryAfterMs(res.headers.get("retry-after")), "Reddit OAuth HTTP 429");
  if (!res.ok) throw new Error(`reddit auth HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("reddit auth returned no token");
  return {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

interface ListingResponse {
  data?: {
    after?: unknown;
    children?: Array<{
      data?: {
        id?: string;
        title?: string;
        selftext?: string;
        subreddit?: string;
        author?: string;
        permalink?: string;
        created_utc?: number;
        score?: number;
        num_comments?: number;
      };
    } | null>;
  };
}

export async function searchReddit(
  client: RedditClient,
  query: string,
  opts: { after?: string; limit?: number; timeoutMs?: number } = {},
): Promise<RedditSearchResult> {
  const limit = opts.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Reddit listing limit must be an integer from 1 to 100");
  }
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    sort: "new",
    t: "week",
    type: "link",
  });
  if (opts.after) params.set("after", opts.after);
  await paceProviderRequest("reddit", 1_000);
  const res = await fetch(`https://oauth.reddit.com/search?${params}`, {
    headers: {
      authorization: `Bearer ${client.token}`,
      "user-agent": "sentiment-desk/0.3 (personal research desk)",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (res.status === 429) throw new ProviderRateLimitError("reddit", parseRetryAfterMs(res.headers.get("retry-after")), "Reddit search HTTP 429");
  if (!res.ok) {
    if (opts.after && [400, 404].includes(res.status)) {
      throw new RedditPaginationRestartError(`Reddit pagination cursor was rejected with HTTP ${res.status}`, res.status);
    }
    throw new Error(`reddit search HTTP ${res.status}`);
  }
  const body = (await res.json()) as ListingResponse;
  if (!body || typeof body !== "object" || !body.data || typeof body.data !== "object" || Array.isArray(body.data)
    || !Array.isArray(body.data.children) || !Object.hasOwn(body.data, "after")) {
    throw new Error("Reddit returned invalid listing pagination metadata");
  }
  const rawAfter = body.data.after;
  if (rawAfter !== null && (typeof rawAfter !== "string" || rawAfter.trim() === "")) {
    throw new Error("Reddit returned an invalid listing continuation cursor");
  }
  if (typeof rawAfter === "string" && rawAfter === opts.after) {
    throw new RedditPaginationRestartError("Reddit listing continuation did not advance");
  }
  const children = body.data.children;
  const out: RedditPost[] = [];
  let malformedChildCount = 0;
  for (const child of children) {
    const d = child?.data;
    if (typeof d?.id !== "string" || d.id.trim() === ""
      || typeof d.title !== "string" || d.title.trim() === ""
      || typeof d.permalink !== "string" || d.permalink.trim() === "") {
      malformedChildCount += 1;
      continue;
    }
    out.push({
      id: d.id,
      title: d.title,
      selftext: (d.selftext ?? "").slice(0, 600),
      subreddit: d.subreddit ?? "unknown",
      author: d.author ?? "unknown",
      permalink: `https://www.reddit.com${d.permalink}`,
      createdAt: typeof d.created_utc === "number" && Number.isFinite(d.created_utc) && d.created_utc > 0
        && Number.isFinite(d.created_utc * 1000)
        ? d.created_utc * 1000
        : null,
      score: d.score ?? 0,
      numComments: d.num_comments ?? 0,
    });
  }
  return {
    posts: out,
    nextAfter: typeof rawAfter === "string" ? rawAfter : null,
    providerChildCount: children.length,
    malformedChildCount,
  };
}
