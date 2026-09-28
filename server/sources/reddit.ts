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
    }>;
  };
}

export async function searchReddit(
  client: RedditClient,
  query: string,
  timeoutMs = 15_000,
): Promise<RedditPost[]> {
  const params = new URLSearchParams({
    q: query,
    limit: "25",
    sort: "new",
    t: "week",
    type: "link",
  });
  await paceProviderRequest("reddit", 1_000);
  const res = await fetch(`https://oauth.reddit.com/search?${params}`, {
    headers: {
      authorization: `Bearer ${client.token}`,
      "user-agent": "sentiment-desk/0.3 (personal research desk)",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new ProviderRateLimitError("reddit", parseRetryAfterMs(res.headers.get("retry-after")), "Reddit search HTTP 429");
  if (!res.ok) throw new Error(`reddit search HTTP ${res.status}`);
  const body = (await res.json()) as ListingResponse;
  const out: RedditPost[] = [];
  for (const child of body.data?.children ?? []) {
    const d = child.data;
    if (!d?.id || !d.title || !d.permalink) continue;
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
  return out;
}
