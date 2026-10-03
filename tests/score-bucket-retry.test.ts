import { describe, expect, it } from "vitest";
import { scoreBucketRetryMode } from "../web/src/lib/score-bucket-retry.js";

describe("score bucket retry recovery", () => {
  it("refreshes the chart baseline after the initial bucket request failed before a snapshot was returned", () => {
    expect(scoreBucketRetryMode({ error: true, snapshotStale: false, snapshotKey: null }))
      .toBe("refresh-baseline");
  });

  it("retries a failed filtered page against its retained snapshot", () => {
    expect(scoreBucketRetryMode({ error: true, snapshotStale: false, snapshotKey: "bucket-snapshot" }))
      .toBe("same-snapshot");
  });

  it("refreshes a chart baseline after a stale snapshot, regardless of the old key", () => {
    expect(scoreBucketRetryMode({ error: false, snapshotStale: true, snapshotKey: "old-snapshot" }))
      .toBe("refresh-baseline");
  });
});
