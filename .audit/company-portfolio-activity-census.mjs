const origin = process.argv[2] ?? "http://127.0.0.1:5175";
const query = new URLSearchParams({ hours: "168", limit: "100" });
const filters = ["all", "relevance_review"];
const pages = await Promise.all(filters.map(async (filter) => {
  const response = await fetch(`${origin}/api/companies/apple/mentions-page?${query}&filter=${filter}`);
  if (!response.ok) throw new Error(`mentions page ${filter} failed: HTTP ${response.status}`);
  return response.json();
}));
const unique = new Map(pages.flatMap((page) => page.items).map((item) => [item.id, item]));
const action = /\b(?:boosts?|increases?|raises?|adds?|cuts?|reduces?|trims?|slashes?|lowers?|buys?|bought|purchases?|purchased|acquires?|acquired|sells?|sold)\b/i;
const portfolio = /\b(?:shares?|stock|holdings?|position|stake)\b/i;
const candidates = [...unique.values()].filter((item) => action.test(item.title) && portfolio.test(item.title));
const actorFor = (title) => {
  const passive = title.match(/\bby\s+(.+)$/i)?.[1]?.trim();
  if (passive) return passive;
  const active = title.match(/^(.*?)\s+\b(?:boosts?|increases?|raises?|adds?|cuts?|reduces?|trims?|slashes?|lowers?|buys?|bought|purchases?|purchased|acquires?|acquired|sells?|sold)\b/i)?.[1]?.trim();
  return active || "unresolved actor";
};
const counts = new Map();
for (const item of candidates) {
  const actor = actorFor(item.title);
  const bucket = counts.get(actor) ?? [];
  bucket.push({ id: item.id, status: item.status, title: item.title });
  counts.set(actor, bucket);
}
console.log(JSON.stringify({ fetchedRows: unique.size, portfolioActivityRows: candidates.length,
  actors: [...counts].map(([actor, rows]) => ({ actor, count: rows.length, rows })) }, null, 2));
