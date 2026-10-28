import {afterEach, expect, it, vi} from "vitest";
import {createServer} from "node:http";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {requestSecResponse, secRetrievedAt} from "../server/sec-acquisition.js";

afterEach(() => vi.unstubAllEnvs());
it("uses the shared HTTP boundary and preserves original retrieval time, bytes, and provider cooldown", async () => {
  const body = Buffer.from("<p>Retained filing body</p>");
  const retrievedAt = "2026-10-01T12:00:00.000Z";
  let rateLimited = false;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    expect(request.url).toBe("/v1/fetch");
    const chunks: Buffer[] = [];for await (const chunk of request) chunks.push(chunk);
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString());requests.push(input);
    response.setHeader("content-type", "application/json");
    if (rateLimited) {response.statusCode = 429;response.end(JSON.stringify({error: {code: "rate_limited", http_status: 429, retry_after: "120"}}));return;}
    response.end(JSON.stringify({schema_version: "dcc-sec.response.v1", url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.htm", sha256: createHash("sha256").update(body).digest("hex"), receipt_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", retrieved_at: retrievedAt, requested_at: retrievedAt, completed_at: retrievedAt, status: 200, delivery: "cache", headers: {"content-type": "text/html"}, body_base64: body.toString("base64")}));
  });
  server.listen(0, "127.0.0.1");await once(server, "listening");const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture service did not bind");
  vi.stubEnv("DCC_SEC_URL", `http://127.0.0.1:${address.port}`);vi.stubEnv("DCC_SEC_TOKEN", "fixture_secret_token_01234567890123456789");
  try {
    const url = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.htm";
    const response = await requestSecResponse(url, {refresh: true, maxBytes: 1000});
    expect(await response.text()).toBe(body.toString());expect(secRetrievedAt(response)).toBe(retrievedAt);
    expect(requests).toEqual([expect.objectContaining({url, refresh: true, max_bytes: 1000})]);
    rateLimited = true;const limited = await requestSecResponse(url);expect(limited.status).toBe(429);expect(limited.headers.get("retry-after")).toBe("120");
  } finally {server.closeAllConnections();await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}
});
