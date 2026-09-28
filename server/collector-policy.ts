import type { CollectorId } from "./types.js";

/** A source must be enabled for both collection and Jev forwarding. */
export function intersectJevSourceAllowlist(
  jevCollectors: ReadonlySet<CollectorId>,
  externalCollectors: ReadonlySet<CollectorId>,
): Set<CollectorId> {
  return new Set([...jevCollectors].filter((collector) => externalCollectors.has(collector)));
}
