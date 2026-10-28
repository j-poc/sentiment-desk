import {fetchSec, SharedSecError} from "./dcc-sec-client.mjs";

/** Edge has no host filesystem or loopback default. Operator supplies a remote service. */
export async function sharedSecResponse(url: string, maxBytes: number, timeoutMs: number, signal: AbortSignal): Promise<Response> {
  const baseUrl = Deno.env.get("DCC_SEC_URL");
  const token = Deno.env.get("DCC_SEC_TOKEN");
  if (!baseUrl?.startsWith("https://") || !token) throw new Error("shared_sec_remote_not_configured");
  try {
    const result = await fetchSec(url, {app: "sentiment-desk-cloud", baseUrl, token, maxBytes, timeoutMs, ttlSeconds: 86400, signal});
    const headers = new Headers(result.headers);
    headers.set("x-dcc-sec-retrieved-at", result.retrievedAt);
    headers.set("x-dcc-sec-receipt-id", result.receiptId);
    return new Response(result.body, {status: 200, headers});
  } catch (error) {
    if (!(error instanceof SharedSecError)) throw error;
    const headers = new Headers();
    if (error.retryAfter != null) headers.set("retry-after", String(error.retryAfter));
    return new Response(null, {status: error.status ?? 503, headers});
  }
}
