import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthRefresher } from "../web/src/lib/health-refresh.js";

function setup(read: () => Promise<{ revision: number }>) {
  let current: { revision: number } | null = null;
  let status = "loading";
  const refresher = createHealthRefresher({
    read,
    current: () => current,
    apply: (snapshot) => { current = snapshot; status = "ready"; },
    failed: () => { status = "failed"; },
  });
  return { refresher, current: () => current, status: () => status, stream: (snapshot: { revision: number }) => { current = snapshot; status = "ready"; } };
}

afterEach(() => vi.useRealTimers());

describe("operations health refresh", () => {
  it("aborts a stalled request, exposes failure, and admits the next poll", async () => {
    vi.useFakeTimers();
    let current: { revision: number } | null = { revision: 1 };
    let status = "ready";
    let firstSignal: AbortSignal | undefined;
    const read = vi.fn<(signal: AbortSignal) => Promise<{ revision: number }>>()
      .mockImplementationOnce((signal) => { firstSignal = signal; return new Promise(() => {}); })
      .mockResolvedValueOnce({ revision: 2 });
    const refresher = createHealthRefresher({ read, current: () => current, apply: (value) => { current = value; status = "ready"; }, failed: () => { status = "failed"; } });

    const stalled = refresher.refresh();
    await vi.advanceTimersByTimeAsync(8_000);
    await stalled;
    expect(firstSignal?.aborted).toBe(true);
    expect(status).toBe("failed");
    expect(current).toEqual({ revision: 1 });
    await refresher.refresh();
    expect(status).toBe("ready");
    expect(current).toEqual({ revision: 2 });
  });

  it("retains the last response through a failed poll and recovers on the next success", async () => {
    const read = vi.fn<() => Promise<{ revision: number }>>()
      .mockResolvedValueOnce({ revision: 1 })
      .mockRejectedValueOnce(new Error("health unavailable"))
      .mockResolvedValueOnce({ revision: 2 });
    const state = setup(read);

    await state.refresher.refresh();
    expect(state.status()).toBe("ready");
    await state.refresher.refresh();
    expect(state.status()).toBe("failed");
    expect(state.current()).toEqual({ revision: 1 });
    await state.refresher.refresh();
    expect(state.status()).toBe("ready");
    expect(state.current()).toEqual({ revision: 2 });
  });

  it("ignores an older failure after a newer stream update", async () => {
    let reject!: (error: Error) => void;
    const state = setup(() => new Promise((_resolve, onReject) => { reject = onReject; }));
    const request = state.refresher.refresh();
    state.stream({ revision: 2 });
    reject(new Error("old request failed"));
    await request;

    expect(state.status()).toBe("ready");
    expect(state.current()).toEqual({ revision: 2 });
  });

  it("admits one poll at a time and ignores an older success after a stream update", async () => {
    let resolve!: (value: { revision: number }) => void;
    const read = vi.fn(() => new Promise<{ revision: number }>((onResolve) => { resolve = onResolve; }));
    const state = setup(read);
    const request = state.refresher.refresh();
    await state.refresher.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    state.stream({ revision: 2 });
    resolve({ revision: 1 });
    await request;

    expect(state.current()).toEqual({ revision: 2 });
  });

  it("does not apply a response or dispatch again after cleanup", async () => {
    let resolve!: (value: { revision: number }) => void;
    const read = vi.fn(() => new Promise<{ revision: number }>((onResolve) => { resolve = onResolve; }));
    const state = setup(read);
    const request = state.refresher.refresh();
    state.refresher.stop();
    resolve({ revision: 1 });
    await request;
    await state.refresher.refresh();

    expect(state.current()).toBeNull();
    expect(state.status()).toBe("loading");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
