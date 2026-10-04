export interface SchedulerControl {
  stop(): Promise<void>;
}

/**
 * Runs one scheduled task at a time and lets shutdown wait for the active run.
 * An interval that fires while the task is busy is skipped, never queued.
 */
export function scheduleTask(
  task: () => void | Promise<void>,
  intervalMs: number,
  options: { immediate?: boolean; onError?: (error: unknown) => void; beforeRun?: () => boolean } = {},
): SchedulerControl {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const run = (): void => {
    if (stopped || inFlight) return;
    const pending = Promise.resolve()
      .then(() => options.beforeRun && !options.beforeRun() ? undefined : task())
      .catch((error: unknown) => {
        try {
          if (options.onError) options.onError(error);
          else console.error("[desk] scheduled task failed:", error);
        } catch (reportError) {
          console.error("[desk] scheduled task error reporter failed:", reportError);
        }
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
  };

  const timer = setInterval(run, intervalMs);
  if (options.immediate ?? true) run();

  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await inFlight;
    },
  };
}
