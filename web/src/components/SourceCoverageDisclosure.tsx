export function SourceCoverageDisclosure({ externalRequestsEnabled = null }: { externalRequestsEnabled?: boolean | null }) {
  return (
    <div className="mb-1.5 shrink-0 px-1 text-[10.5px] leading-relaxed text-white/55">
      <p role="note">Configured feeds only. This desk does not cover the entire public web or all investor activity.</p>
      {externalRequestsEnabled === false && <p role="status" className="text-amber-200/80">External requests are paused. This view uses only data and price history already saved locally.</p>}
      <details className="mt-0.5 max-w-4xl text-[10px] text-white/40">
        <summary className="w-fit cursor-pointer select-none hover:text-white/65 focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/70">
          Collection scope and gaps
        </summary>
        <div className="mt-1 space-y-1 pl-3">
          <p><span className="text-white/60">Configured feed families:</span> Google News and Yahoo Finance RSS, GDELT news, SEC EDGAR filings, and optional Finnhub, Reddit, and X. Yahoo quotes and charts provide price context, not sentiment observations.</p>
          <p><span className="text-white/60">Known bounds:</span> RSS reads one response per company with no pagination or provider completeness signal, so its coverage is unknown and may be incomplete; GDELT searches two days and flags its 250-row cap as partial; SEC polls 8-K and 8-K/A filings accepted in the recent three-day window; Finnhub company news uses a three-day window; Reddit searches one week in 25-item pages; X recent search is bounded to seven days. Reddit and X save pagination progress across polls.</p>
          <p><span className="text-white/60">Not directly collected:</span> company websites, product pages, press releases, investor presentations, job postings, app-store reviews, search trends, YouTube or podcast transcripts, and broad customer-support discussions. Reddit and X are the only direct social collectors. Syndicated news may mention these subjects, but does not provide systematic coverage.</p>
          <p>Feed access does not by itself establish rights to retain, display, or send content to a classifier. Check each source's rights and delivery state before relying on it.</p>
          <p>Collectors require both <code>SOURCE_RIGHTS_APPROVED_COLLECTORS</code> and <code>EXTERNAL_SOURCE_COLLECTORS</code>. Luna requires <code>OPENAI_ACCOUNT_USE_APPROVED=true</code>, an OpenAI API key, a separate source allowlist and finite daily request, byte and dollar limits. The historical Jev path retains its own TypeSafe authorization. These settings record operator attestations; they do not verify agreements or account authority.</p>
        </div>
      </details>
    </div>
  );
}
