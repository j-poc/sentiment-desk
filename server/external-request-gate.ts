export class ExternalRequestPausedError extends Error {
  constructor(readonly dispatchedRequests = 0, readonly lastHttpStatus: number | null = null) {
    super(dispatchedRequests === 0
      ? "External request was not sent because storage admission is paused."
      : `Storage admission paused before a redirect hop; ${dispatchedRequests} request hop(s) were sent and the last response was HTTP ${lastHttpStatus ?? "unknown"}.`);
    this.name = "ExternalRequestPausedError";
  }
}

/** Install one final, synchronous admission check at the actual fetch boundary. */
export function installExternalRequestGate(admit: () => boolean): () => void {
  const previousFetch = globalThis.fetch;
  const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requested = new Request(input, init);
    const redirectMode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    const firstOrigin = new URL(requested.url).origin;
    let request = requested;

    let dispatchedRequests = 0;
    let lastHttpStatus: number | null = null;
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (!admit()) throw new ExternalRequestPausedError(dispatchedRequests, lastHttpStatus);
      const response = await previousFetch(request, { redirect: "manual" });
      dispatchedRequests += 1;
      lastHttpStatus = response.status;
      const location = response.headers.get("location");
      const redirect = [301, 302, 303, 307, 308].includes(response.status) && location != null;
      if (!redirect || redirectMode === "manual") return response;
      if (redirectMode === "error") throw new TypeError("fetch redirect rejected by request policy");

      const target = new URL(location!, request.url);
      const safeSameOrigin = target.protocol === "https:" && target.origin === firstOrigin
        && !target.username && !target.password && ["GET", "HEAD"].includes(request.method.toUpperCase());
      if (!safeSameOrigin || redirectCount >= 5) return response;

      try { await response.body?.cancel(); } catch { /* release the redirect response before the next hop */ }
      request = new Request(target, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        credentials: request.credentials,
        cache: request.cache,
        mode: request.mode,
        redirect: redirectMode,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity,
        keepalive: request.keepalive,
      });
    }
  }) as typeof fetch;

  globalThis.fetch = guardedFetch;
  return () => {
    if (globalThis.fetch === guardedFetch) globalThis.fetch = previousFetch;
  };
}
