import { buildCloudCompanyUpdates, type CloudCompanyFact, type CloudCompanyFiling, type CloudCompanyUpdate } from "../../../shared/cloud-company-updates.js";

function amount(value: string, unit: string): string {
  const negative = value.startsWith("-");
  const positive = negative ? value.slice(1) : value;
  const [integer, fraction] = positive.split(".");
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const number = `${negative ? "−" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
  return unit === "USD" ? `${negative ? "−" : ""}$${grouped}${fraction ? `.${fraction}` : ""}` : `${number} ${unit}`;
}

function period(update: CloudCompanyUpdate): string {
  return `${update.current.periodStart} to ${update.current.periodEnd} vs ${update.prior.periodStart} to ${update.prior.periodEnd}`;
}

function changeText(update: CloudCompanyUpdate): string {
  if (update.precision === "within_reported_precision") return "The reported values differ within the SEC precision range; direction is unresolved.";
  if (update.precision === "reported_values_only") return "The reported values differ, but SEC precision is unavailable; direction is unresolved.";
  return `Reported ${update.direction} beyond the SEC precision range. This does not establish whether the change is favorable or material.`;
}

function EvidenceLink({ factId, accession, sourceUrl, filedAt }: {
  factId: string; accession: string; sourceUrl: string | null; filedAt: string;
}) {
  return sourceUrl
    ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2">SEC filing · filed {filedAt} · accession {accession}</a>
    : <span>SEC record {factId.slice(0, 8)} · accession {accession} · filing link unavailable</span>;
}

export function CloudCompanyUpdates({ cik, facts, filings, retrievedAt, coverageComplete }: {
  cik: string;
  facts: readonly CloudCompanyFact[];
  filings: readonly CloudCompanyFiling[];
  retrievedAt: string | null | undefined;
  coverageComplete: boolean;
}) {
  const result = buildCloudCompanyUpdates({ cik, facts, filings });
  return <section className="panel" aria-labelledby="cloud-company-updates-heading">
    <div className="panel-head flex-wrap gap-2">
      <div><h2 id="cloud-company-updates-heading" className="micro m-0 p-0">COMPANY UPDATES</h2>
        <p className="mt-1 text-[10px] font-normal normal-case tracking-normal text-white/45">SEC-reported financial changes · same metric and fiscal period year over year</p></div>
      <span className="text-[10px] text-white/40">SEC data retrieved {retrievedAt ? `${retrievedAt.replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC` : "time unavailable"}</span>
    </div>
    {!coverageComplete && <p className="border-b border-amber-200/10 bg-amber-200/[0.03] px-4 py-2 text-[10px] leading-4 text-amber-100/60">Recent comparison rows reached the display limit. Some older updates may be missing.</p>}
    {result.state === "no_comparable_change" ? <p className="px-4 py-4 text-xs leading-5 text-white/55">{coverageComplete ? result.reason : "No validated same-period comparison was found within the loaded recent records. Older comparisons may be missing."}</p> : <ul className="divide-y divide-white/[0.06]">
      {result.updates.map((update) => <li key={`${update.metric}:${update.current.factId}`} className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="m-0 text-xs font-semibold text-white/80">{update.metric}</h3>
          <span className={`text-[10px] ${update.direction ? "text-white/65" : "text-amber-100/65"}`}>
            {update.direction ? `Reported ${update.direction}` : "Direction unresolved"}
          </span>
        </div>
        <p className="m-0 text-[11px] text-white/70">{amount(update.prior.value, update.unit)} → {amount(update.current.value, update.unit)}
          <span className="ml-2 text-white/45">change {update.delta.startsWith("-") ? "−" : "+"}{amount(update.delta.replace(/^-/, ""), update.unit)}
            {update.percentChange == null ? " · percentage withheld" : ` · ${update.percentChange.startsWith("-") ? "" : "+"}${update.percentChange}%`}</span></p>
        <p className="m-0 text-[10px] leading-4 text-white/45">{changeText(update)} Periods: {period(update)}. Values use the SEC-reported unit without scaling.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-emerald-100/55">
          <EvidenceLink {...update.prior} />
          <EvidenceLink {...update.current} />
        </div>
      </li>)}
    </ul>}
  </section>;
}
