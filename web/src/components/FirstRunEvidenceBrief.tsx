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
        <h2 id="first-run-title">No saved evidence to start from</h2>
        <p className="first-run-summary">
          No eligible saved source records are available to chart or classify. An empty result is not neutral sentiment, and no demo records fill the gap.
        </p>
        <p className="first-run-source">
          This Desk covers a fixed company list; tickerless small-cap discovery is not available yet. Recent SEC filings are for browsing, not research leads or evidence of investment merit.
        </p>
        <p className="first-run-source">Start by browsing filings or checking which source updates are available.</p>
        {props.onOpenDisclosures && (
          <button type="button" className="first-run-open-operations" onClick={props.onOpenDisclosures}>
            Browse recent SEC filings
          </button>
        )}
        {props.onOpenOperations && (
          <button type="button" className="first-run-open-operations" onClick={props.onOpenOperations}>
            Review update availability
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
}: {
  company: string;
  ticker: string;
  state: "empty" | "checking" | "unavailable";
}) {
  const description = state === "empty"
    ? "No eligible saved source observations are available for this company, so there is no company trend to chart. The Desk does not substitute archived samples or demonstration data."
    : state === "checking"
      ? "The Desk is checking this company’s recent source history."
      : "The Desk cannot verify this company’s chart availability right now. It will retry automatically.";
  return (
    <section className="first-run-company-empty" role="status" aria-labelledby="first-run-company-title">
      <p className="micro">{state === "empty" ? "No chart data yet" : state === "checking" ? "Checking recent history" : "Chart temporarily unavailable"}</p>
      <h2 id="first-run-company-title">{company} · {ticker}</h2>
      <p>{description}</p>
      {state === "empty" && <p className="first-run-next-step">The Desk will show source links, publication times and collection times with each update. It does not substitute sample results for missing evidence.</p>}
    </section>
  );
}
