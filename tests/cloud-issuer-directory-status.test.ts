import { describe, expect, it } from "vitest";
import { cloudIssuerDirectoryStatus } from "../web/src/lib/cloud-issuer-directory-status.js";

describe("cloud issuer directory status", () => {
  it("never labels the last-good snapshot current after a failed refresh", () => {
    const status = cloudIssuerDirectoryStatus({
      snapshotState: "ready",
      refreshState: "failed",
      retrievedAt: "2026-10-09T12:00:00.000Z",
      loading: false,
    });
    expect(status).toBe("company list update unavailable · previous list last updated 2026-10-09 12:00:00 UTC");
    expect(status).not.toContain("current");
  });

  it("explains an unavailable update with and without a saved list", () => {
    expect(cloudIssuerDirectoryStatus({ snapshotState: "ready", refreshState: "disabled",
      retrievedAt: "2026-10-09T12:00:00.000Z", loading: false }))
      .toBe("company list update unavailable · previous list last updated 2026-10-09 12:00:00 UTC");
    expect(cloudIssuerDirectoryStatus({ snapshotState: "unavailable", refreshState: "disabled",
      retrievedAt: null, loading: false }))
      .toBe("company list update unavailable · no company list is available");
  });

  it("distinguishes a saved stale snapshot from a current one", () => {
    expect(cloudIssuerDirectoryStatus({ snapshotState: "stale", refreshState: "idle",
      retrievedAt: "2026-10-01T12:00:00.000Z", loading: false }))
      .toBe("last updated 2026-10-01 12:00:00 UTC · check for updates");
  });
});
