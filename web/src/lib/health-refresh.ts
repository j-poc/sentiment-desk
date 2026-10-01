import { withReadDeadline } from "./bounded-read.js";

export function createHealthRefresher<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  current: () => T | null;
  apply: (snapshot: T) => void;
  failed: () => void;
}) {
  let active = true;
  let inFlight = false;
  let controller: AbortController | null = null;
  return {
    async refresh(): Promise<void> {
      if (!active || inFlight) return;
      inFlight = true;
      const previous = options.current();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const snapshot = await withReadDeadline(options.read, requestController.signal);
        if (active && options.current() === previous) options.apply(snapshot);
      } catch {
        if (active && options.current() === previous) options.failed();
      } finally {
        controller = null;
        inFlight = false;
      }
    },
    stop(): void {
      active = false;
      controller?.abort(new Error("operations health refresh stopped"));
    },
  };
}
