export function DeskConnectionState({
  state,
  onRetry,
}: {
  state: "loading" | "ready" | "failed";
  onRetry: () => void;
}) {
  const failed = state === "failed";
  return (
    <div className="flex flex-col items-center justify-center gap-2 text-center text-[12px] text-white/45">
      <p role={failed ? "alert" : "status"}>
        {failed
          ? "Could not connect to the desk. Check the local API and retry."
          : state === "loading"
            ? "Connecting to the desk…"
            : "No companies are configured in the saved desk."}
      </p>
      {state !== "loading" && (
        <button
          type="button"
          className="rounded-md border border-white/10 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/[0.05]"
          aria-label="Retry connecting to the desk"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
