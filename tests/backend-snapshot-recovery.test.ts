import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupMentionsByIds, readBackendSnapshot } from "../web/src/lib/api.js";
import { withReadDeadline } from "../web/src/lib/bounded-read.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Desk snapshot recovery", () => {
  it.each(["/api/quotes", "/api/tape?limit=60", "/api/health", "/api/companies"])("settles when %s never responds, retaining the other sections", async (stalledUrl) => {
    vi.useFakeTimers();
    const sections: Record<string, unknown> = {
      "/api/companies": [{ id: "test-issuer" }],
      "/api/tape?limit=60": [{ id: "test-observation" }],
      "/api/quotes": { revision: 1 },
      "/api/health": { runtimeId: "test-runtime" },
    };
    let stalledSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      if (url === stalledUrl) {
        stalledSignal = options.signal as AbortSignal;
        return new Promise(() => {});
      }
      return Promise.resolve(Response.json(sections[url]));
    }));
    const pending = readBackendSnapshot();
    await vi.advanceTimersByTimeAsync(8_000);
    const snapshot = await pending;
    expect(stalledSignal?.aborted).toBe(true);
    expect(snapshot).toEqual({
      companies: stalledUrl === "/api/companies" ? null : sections["/api/companies"],
      tape: stalledUrl === "/api/tape?limit=60" ? null : sections["/api/tape?limit=60"],
      quotes: stalledUrl === "/api/quotes" ? null : sections["/api/quotes"],
      health: stalledUrl === "/api/health" ? null : sections["/api/health"],
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(Response.json(sections[url]))));
    expect((await readBackendSnapshot()).companies).toEqual(sections["/api/companies"]);
  });

  it("bounds a stalled mention response body and allows a later lookup", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementationOnce((_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
    }).mockResolvedValueOnce(Response.json({ items: [{ id: "test-observation" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const failure = lookupMentionsByIds("test-issuer", ["test-observation"]).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await failure).toEqual(new Error("desk read timed out"));
    expect(signal?.aborted).toBe(true);
    expect(await lookupMentionsByIds("test-issuer", ["test-observation"])).toEqual([{ id: "test-observation" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards caller cancellation and refuses dispatch after cancellation", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let child: AbortSignal | undefined;
    const read = vi.fn((signal: AbortSignal) => { child = signal; return new Promise(() => {}); });
    const pending = withReadDeadline(read, parent.signal).catch((error: Error) => error);
    const reason = new Error("read canceled");
    parent.abort(reason);
    expect(await pending).toBe(reason);
    expect(child?.aborted).toBe(true);
    await expect(withReadDeadline(read, parent.signal)).rejects.toBe(reason);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
