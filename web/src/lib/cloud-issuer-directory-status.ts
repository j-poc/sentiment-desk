export type DirectorySnapshotState = "idle" | "ready" | "stale" | "unavailable";
export type DirectoryRefreshState = "idle" | "failed" | "disabled" | "rate_limited";

function timestampLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "time unknown";
  return `${new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

export function cloudIssuerDirectoryStatus(input: {
  snapshotState: DirectorySnapshotState;
  refreshState: DirectoryRefreshState;
  retrievedAt: string | null;
  loading: boolean;
}): string {
  const retainedSnapshot = input.retrievedAt
    ? `previous list last updated ${timestampLabel(input.retrievedAt)}`
    : "no company list is available";
  if (input.refreshState === "failed" || input.refreshState === "disabled") return `company list update unavailable · ${retainedSnapshot}`;
  if (input.refreshState === "rate_limited") {
    return `try again later · ${input.retrievedAt ? `last updated ${timestampLabel(input.retrievedAt)}` : "no company list is available"}`;
  }
  if (input.snapshotState === "ready") return `updated ${timestampLabel(input.retrievedAt)}`;
  if (input.snapshotState === "stale") return `last updated ${timestampLabel(input.retrievedAt)} · check for updates`;
  if (input.loading || input.snapshotState === "idle") return "loading company list";
  return "company list unavailable";
}
