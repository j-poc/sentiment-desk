export type ScoreBucketRetryState = {
  error: boolean;
  snapshotStale: boolean;
  snapshotKey: string | null;
};

export function scoreBucketRetryMode(state: ScoreBucketRetryState): "same-snapshot" | "refresh-baseline" {
  return state.error && !state.snapshotStale && state.snapshotKey != null
    ? "same-snapshot"
    : "refresh-baseline";
}
