import type { CollectorId } from "./types.js";

/** A requested source is active only when each independent allowlist admits it. */
export function intersectCollectorAllowlists(
  ...allowlists: readonly ReadonlySet<CollectorId>[]
): Set<CollectorId> {
  const [first, ...rest] = allowlists;
  if (!first) return new Set();
  return new Set([...first].filter((collector) => rest.every((allowlist) => allowlist.has(collector))));
}

/** A source must be enabled for both collection and Jev forwarding. */
export function intersectJevSourceAllowlist(
  jevCollectors: ReadonlySet<CollectorId>,
  externalCollectors: ReadonlySet<CollectorId>,
  sourceRightsApprovedCollectors: ReadonlySet<CollectorId>,
): Set<CollectorId> {
  return intersectCollectorAllowlists(jevCollectors, externalCollectors, sourceRightsApprovedCollectors);
}
