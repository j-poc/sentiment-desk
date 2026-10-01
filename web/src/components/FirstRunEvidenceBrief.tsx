import type { ArchivedRun } from "../lib/api.js";

type Props = (
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; eligibleObservationCount: number; secCollectorEnabled: boolean; jevSecScoringEnabled: boolean; archivedRun: ArchivedRun | null }
) & { localObservationArrived?: boolean };

function timestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value) + " UTC";
}

function date(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(value);
}

export function FirstRunEvidenceBrief(props: Props) {
  if (props.localObservationArrived) return null;
  if (props.state === "loading") return <p className="first-run-status" role="status">Checking saved source history…</p>;
  if (props.state === "error") return <p className="first-run-status" role="status">Saved source history is unavailable. The Desk cannot determine whether this is a first run.</p>;
  if (props.eligibleObservationCount !== 0 || !props.archivedRun) return null;

  const run = props.archivedRun;
  return (
    <article className="first-run-brief" aria-labelledby="first-run-title">
      <div className="first-run-copy">
        <p className="micro">No eligible saved observations · archived run from {date(run.scoredAt)}</p>
        <h2 id="first-run-title">Archived SEC-to-Jev run</h2>
        <p className="first-run-summary">
          This real filing was scored in a separate historical run. Its original delivery and scoring records are not included in this Desk installation, so the identifiers below are recorded references rather than locally resolvable evidence. The example is excluded from Desk statistics. Its single classification has not been independently reviewed; quality and confidence calibration are unverified.
        </p>
        <p className="first-run-source"><a href={run.sourceUrl} target="_blank" rel="noreferrer">{run.company} ({run.ticker}) · {run.sourceTitle}</a> · filed {date(run.filedAt)}</p>
        <p className="first-run-result">
          <strong>Jev reported:</strong> {run.sentiment} · {run.eventType.replaceAll("_", " ")} · confidence {Math.round(run.confidence * 100)}% (not calibrated)
        </p>
      </div>
      <details className="first-run-provenance">
        <summary>Recorded run references · not locally verifiable</summary>
        <dl>
          <dt>Filing</dt><dd><a href={run.sourceUrl} target="_blank" rel="noreferrer">{run.sourceTitle}</a></dd>
          <dt>Filed</dt><dd>{date(run.filedAt)} UTC</dd>
          <dt>Source time</dt><dd>{timestamp(run.sourcePublishedAt)}</dd>
          <dt>Collected</dt><dd>{timestamp(run.collectedAt)}</dd>
          <dt>Scored</dt><dd>{timestamp(run.scoredAt)}</dd>
          <dt>Recorded source receipt</dt><dd><span className="tabnum">{run.receiptId}</span></dd>
          <dt>Recorded receipt digest</dt><dd><span className="tabnum">{run.receiptDigest}</span></dd>
          <dt>Scoring</dt><dd>{run.model} · {run.sourceAdapter}</dd>
          <dt>Model confidence</dt><dd>{Math.round(run.confidence * 100)}% · calibration not assessed</dd>
          <dt>Recorded request digest</dt><dd><span className="tabnum">{run.requestDigest}</span></dd>
          <dt>Recorded rubric digest</dt><dd><span className="tabnum">{run.rubricDigest}</span></dd>
        </dl>
      </details>
    </article>
  );
}

export function FirstRunNoLocalData({
  company,
  ticker,
  state,
  secCollectorEnabled,
  jevSecScoringEnabled,
}: {
  company: string;
  ticker: string;
  state: "empty" | "checking" | "unavailable";
  secCollectorEnabled: boolean;
  jevSecScoringEnabled: boolean;
}) {
  const description = state === "empty"
    ? "No eligible source-attributed observations are available for this installation, so there is no company trend to chart. The archived Tesla filing above belongs to a separate historical run and does not supply this company’s data."
    : state === "checking"
      ? "The Desk is checking local history before deciding whether a company chart is available."
      : "The Desk cannot verify whether this company has saved chart data right now. It will retry automatically; an empty chart is hidden until history can be checked.";
  const nextStep = secCollectorEnabled && jevSecScoringEnabled
    ? "Check the latest SEC delivery and ingestion state; enabled collectors do not guarantee that a filing has been saved."
    : !secCollectorEnabled && !jevSecScoringEnabled
      ? "An operator needs to enable external requests, approve SEC collection, and configure its contact, then enable Jev for SEC with account approval and finite request limits. This page does not change settings or start provider requests."
      : !secCollectorEnabled
        ? "An operator needs to configure and approve the SEC source. Jev is enabled for SEC filings, but cannot score until an eligible filing is saved."
        : "An operator needs to enable Jev for SEC filings with account approval, a key, and finite request limits. New SEC filings remain unscored until then.";

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
          <p><strong>SEC scoring:</strong> {jevSecScoringEnabled
            ? "Jev scoring is enabled for SEC filings; new eligible evidence can be scored as it arrives."
            : "Configure Jev credentials, account-use approval, a finite request budget, and an SEC source allowlist to score evidence."}</p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
