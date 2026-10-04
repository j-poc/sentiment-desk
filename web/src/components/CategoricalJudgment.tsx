import type { CategoricalClassification } from "../lib/api.js";
import { dayTime, sentimentColor } from "../lib/format.js";

export function CategoricalJudgment({ judgment, detail = false }: { judgment: CategoricalClassification; detail?: boolean }) {
  const state = judgment.disposition === "excluded" ? "Excluded from company research"
    : judgment.disposition === "review_required" || judgment.sentiment == null ? "Needs evidence review"
      : judgment.sentiment;
  return (
    <section className="mt-2 text-[12px] leading-relaxed" aria-label="Luna categorical judgment">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-sky-300/20 px-1.5 text-[10px] text-sky-200">LUNA</span>
        <span className="font-medium" style={{ color: judgment.disposition === "classified" && judgment.sentiment ? sentimentColor(judgment.sentiment) : "#fbbf24" }}>{state}</span>
        {judgment.eventType && <span className="text-white/55">{judgment.eventType.replaceAll("_", " ")}</span>}
        {judgment.material === true && <span className="text-white/55" title="Luna model label; not independently validated.">Model-marked material</span>}
      </div>
      {judgment.summary && <p className="mt-1 text-white/80">{judgment.summary}</p>}
      {detail && (
        <>
          {judgment.supportingExcerpt && <blockquote className="mt-3 border-l-2 border-sky-300/30 pl-3 text-white/65">{judgment.supportingExcerpt}</blockquote>}
          <p className="mt-3 text-[11px] text-white/55">Categorical model judgment · independently unvalidated. No probability, confidence percentage or Jev impact value is assigned.</p>
          <dl className="mt-3 grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] text-white/55">
            <dt>Saved attempt</dt><dd className="break-all">{judgment.attemptId ?? "Legacy classification without attempt binding"}</dd>
            <dt>About company</dt><dd>{judgment.about == null ? "Uncertain" : judgment.about ? "Yes" : "No"}</dd>
            <dt>Investor relevance</dt><dd>{judgment.investorRelevant == null ? "Uncertain" : judgment.investorRelevant ? "Yes" : "No"}</dd>
            <dt>Evidence sufficient</dt><dd>{judgment.evidenceSufficient ? "Model says yes" : "No — needs review"}</dd>
            <dt>Model returned</dt><dd className="break-all">{judgment.modelReturned ?? "Not recorded"}</dd>
            <dt>Service tier</dt><dd>{judgment.serviceTier ?? "Not recorded"} · requested {judgment.serviceTierRequested}</dd>
            <dt>Completed</dt><dd>{dayTime(judgment.classifiedAt)}</dd>
            <dt>Estimated total</dt><dd>{judgment.estimatedCostUsd == null ? "Unknown" : `$${judgment.estimatedCostUsd.toFixed(6)}`} · not an invoice</dd>
            <dt>Input / output</dt><dd>{judgment.inputTokens ?? "Unknown"} / {judgment.outputTokens ?? "Unknown"} tokens</dd>
            <dt>Cache read / write</dt><dd>{judgment.cachedInputTokens ?? "Unknown"} / {judgment.cacheWriteInputTokens ?? "Unknown"} tokens</dd>
            <dt>Reasoning</dt><dd>{judgment.reasoningTokens ?? "Unknown"} tokens · included in output</dd>
            <dt>Response ID</dt><dd className="break-all">{judgment.responseId ?? "Not recorded"}</dd>
            <dt>Prompt digest</dt><dd className="break-all">{judgment.promptSha256}</dd>
            <dt>Profile digest</dt><dd className="break-all">{judgment.profileSha256 ?? "Not bound to a saved model attempt"}</dd>
            <dt>Response digest</dt><dd className="break-all">{judgment.responseSha256}</dd>
          </dl>
        </>
      )}
    </section>
  );
}
