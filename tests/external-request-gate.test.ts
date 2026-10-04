import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalRequestPausedError, installExternalRequestGate } from "../server/external-request-gate.js";

const uninstall: Array<() => void> = [];

afterEach(() => {
  for (const stop of uninstall.splice(0)) stop();
  vi.unstubAllGlobals();
});

describe("external request admission", () => {
  it("blocks at the final fetch boundary without dispatching", async () => {
    const transport = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", transport as typeof fetch);
    uninstall.push(installExternalRequestGate(() => false));

    const error = await fetch("https://provider.example/v1").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ExternalRequestPausedError);
    expect(error).toMatchObject({ dispatchedRequests: 0, lastHttpStatus: null });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rechecks capacity between same-origin redirect hops", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://provider.example/next" } }));
    vi.stubGlobal("fetch", transport as typeof fetch);
    let admissionChecks = 0;
    uninstall.push(installExternalRequestGate(() => ++admissionChecks === 1));

    const error = await fetch("https://provider.example/start").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ExternalRequestPausedError);
    expect(error).toMatchObject({ dispatchedRequests: 1, lastHttpStatus: 302 });
    expect(String(error)).toContain("1 request hop(s) were sent");
    expect(admissionChecks).toBe(2);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect to a different origin", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example/collect" } }));
    vi.stubGlobal("fetch", transport as typeof fetch);
    uninstall.push(installExternalRequestGate(() => true));

    const response = await fetch("https://provider.example/start");
    expect(response.status).toBe(302);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
