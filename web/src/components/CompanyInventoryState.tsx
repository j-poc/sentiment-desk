export function CompanyInventoryState({
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
          ? "Could not load the company inventory. Check the local API and retry."
          : state === "loading"
            ? "Loading the company inventory…"
            : "The company inventory is empty."}
      </p>
      {state !== "loading" && (
        <button
          type="button"
          className="rounded-md border border-white/10 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/[0.05]"
          aria-label="Retry loading company inventory"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
