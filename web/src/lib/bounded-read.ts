export async function withReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  if (parentSignal?.aborted) throw parentSignal.reason;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error("desk read timed out")), 8_000);
  try {
    return await Promise.race([read(controller.signal), aborted]);
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener("abort", rejectAbort);
    parentSignal?.removeEventListener("abort", forwardAbort);
  }
}
