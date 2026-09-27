import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleTask } from "../server/scheduler.js";

afterEach(() => vi.useRealTimers());

describe("scheduled task shutdown", () => {
  it("skips overlapping intervals and waits for the active task on stop", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const control = scheduleTask(() => {
      calls += 1;
      return active;
    }, 100);

    await Promise.resolve();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(calls).toBe(1);

    let stopped = false;
    const stopping = control.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);
  });
});
