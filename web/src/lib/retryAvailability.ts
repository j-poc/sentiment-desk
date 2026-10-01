import type { HealthDTO } from "./api.js";

export type RetryAvailability =
  | { kind: "available"; providerLabel?: string; providerName?: string }
  | { kind: "unavailable"; reason: string };

type RetryHealthState = Pick<HealthDTO, "externalRequestsEnabled"> & {
  health: { jev: Pick<HealthDTO["health"]["jev"], "enabled">; classifier?: HealthDTO["health"]["classifier"] };
};

export function retryAvailabilityFor(health: RetryHealthState | null): RetryAvailability {
  if (health === null) {
    return { kind: "unavailable", reason: "Retry unavailable until the desk confirms Jev and external-request status." };
  }
  if (!health.externalRequestsEnabled) {
    return { kind: "unavailable", reason: "Retry unavailable while external requests are paused." };
  }
  if (health.health.classifier) {
    return health.health.classifier.enabled
      ? { kind: "available", providerLabel: health.health.classifier.provider === "openai_luna" ? "Luna" : "Jev", providerName: health.health.classifier.provider === "openai_luna" ? "OpenAI" : "TypeSafe" }
      : { kind: "unavailable", reason: `Retry unavailable: ${health.health.classifier.blockedReason ?? "the selected classifier is blocked"}.` };
  }
  if (!health.health.jev.enabled) {
    return { kind: "unavailable", reason: "Retry unavailable because Jev is not configured." };
  }
  return { kind: "available" };
}
