import type { FirstRunEvidenceDTO } from "../lib/api.js";

type Props = (
  | { state: "loading" }
  | { state: "error" }
  | ({ state: "ready" } & FirstRunEvidenceDTO)
) & { localObservationArrived?: boolean; onOpenOperations?: () => void; onOpenDisclosures?: () => void };

export function FirstRunEvidenceBrief(props: Props) {
  if (props.localObservationArrived) return null;
  if (props.state === "loading") return <p className="first-run-status" role="status">Checking saved source history…</p>;
  if (props.state === "error") return <p className="first-run-status" role="status">Saved source history is unavailable. The Desk cannot determine whether this is a first run.</p>;
  if (props.eligibleObservationCount !== 0) return null;
  return (
    <article className="first-run-brief" aria-labelledby="first-run-title">
      <div className="first-run-copy">
        <p className="micro">No eligible saved observations</p>
        <h2 id="first-run-title">Start with real saved evidence</h2>
        <p className="first-run-summary">
          This installation has no eligible saved source observations to chart or classify. The Desk shows no archived samples or demonstration results in place of saved evidence.
        </p>
        <p className="first-run-source">Check collection and classifier readiness. External requests remain under explicit operator controls.</p>
        {props.onOpenDisclosures && (
          <button type="button" className="first-run-open-operations" onClick={props.onOpenDisclosures}>
            Browse recent SEC filings
          </button>
        )}
        {props.onOpenOperations && (
          <button type="button" className="first-run-open-operations" onClick={props.onOpenOperations}>
            Open Sources &amp; operations
          </button>
        )}
      </div>
    </article>
  );
}

export function FirstRunNoLocalData({
  company,
  ticker,
  state,
  secCollectorEnabled,
  classifierSecClassificationEnabled,
  classifierBlockedReason,
}: {
  company: string;
  ticker: string;
  state: "empty" | "checking" | "unavailable";
  secCollectorEnabled: boolean;
  classifierSecClassificationEnabled?: boolean;
  classifierBlockedReason?: string | null;
}) {
  const description = state === "empty"
    ? "No eligible saved source observations are available for this company, so there is no company trend to chart. The Desk does not substitute archived samples or demonstration data."
    : state === "checking"
      ? "The Desk is checking local history before deciding whether a company chart is available."
      : "The Desk cannot verify whether this company has saved chart data right now. It will retry automatically; an empty chart is hidden until history can be checked.";
  const engine = "Luna";
  const classifierEnabled = classifierSecClassificationEnabled === true;
  const nextStep = secCollectorEnabled && classifierEnabled
    ? "Check the latest SEC delivery and ingestion state; enabled collectors do not guarantee that a filing has been saved."
    : !secCollectorEnabled && !classifierEnabled
      ? "An operator needs to enable external requests, approve SEC collection and configure its contact, then enable Luna for SEC with account approval, a key and finite request, byte and dollar limits. This page does not change settings or start provider requests."
      : !secCollectorEnabled
        ? `An operator needs to configure and approve the SEC source. ${engine} is enabled for SEC filings, but cannot classify until an eligible filing is saved.`
        : "An operator needs to enable Luna for SEC filings with account approval, a key, and finite request, byte, and dollar limits. New SEC filings remain unscored until then.";

  return (
    <section className="first-run-company-empty" role="status" aria-labelledby="first-run-company-title">
      <p className="micro">{state === "empty" ? "No local chart data" : state === "checking" ? "History check in progress" : "Chart availability is unknown"}</p>
      <h2 id="first-run-company-title">{company} · {ticker}</h2>
      <p>{description}</p>
      {state === "empty" && (
        <>
          <p className="first-run-next-step"><strong>Next step:</strong> {nextStep}</p>
          <details className="first-run-requirements">
            <summary>Collection and scoring requirements</summary>
            <div className="first-run-blockers" aria-label="Operator setup requirements">
          <p><strong>SEC source:</strong> {secCollectorEnabled
            ? "SEC collection is enabled; check the latest SEC delivery and ingestion state if filings do not appear."
            : "Enable external requests, approve the SEC collector, and configure its contact in the SEC User-Agent to collect filings."}</p>
          <p><strong>SEC classification:</strong> {classifierEnabled
            ? `${engine} classification is enabled for SEC filings; new eligible evidence can be classified as it arrives.`
            : "Configure an OpenAI API key, account-use approval, finite request, byte and daily-dollar budgets, and an SEC source allowlist to classify evidence."}</p>
          {classifierBlockedReason && <p><strong>Current classifier gate:</strong> {classifierBlockedReason}</p>}
          <p>Luna categories stay separate from historical Jev probabilities and do not create a numeric sentiment index.</p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
