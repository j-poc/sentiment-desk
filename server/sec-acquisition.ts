import {fetchSec, SharedSecError} from "@dcc/sec-client";

/** SEC transport only; application parsers and accepted snapshot stores retain ownership. */
export async function requestSecResponse(url: string, options: {maxBytes?: number; timeoutMs?: number; ttlSeconds?: number; refresh?: boolean; signal?: AbortSignal} = {}): Promise<Response> {
  let acquired;
  try { acquired = await fetchSec(url, {app: "sentiment-desk", ...options}); }
  catch (error) {
    if (!(error instanceof SharedSecError)) throw error;
    const headers = new Headers(error.headers);
    if (error.retryAfter) headers.set("retry-after", String(error.retryAfter));
    return new Response(null, {status: error.status ?? 503, headers});
  }
  const headers = new Headers(acquired.headers);
  headers.set("x-dcc-sec-retrieved-at", acquired.retrievedAt);
  headers.set("x-dcc-sec-receipt-id", acquired.receiptId);
  return new Response(Buffer.from(acquired.body), {status: acquired.status === 304 ? 200 : acquired.status, headers});
}
export function secRetrievedAt(response: Response): string {
  const retained = response.headers.get("x-dcc-sec-retrieved-at");
  return retained && Number.isFinite(Date.parse(retained)) ? retained : new Date().toISOString();
}
