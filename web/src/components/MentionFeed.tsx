import type { Mention } from "../lib/api.js";
import { filterExactHeadlineGroups, groupExactHeadlineRepeats, type ExactTitleGroupFilter } from "../lib/exact-headline-groups.js";
import { MentionCard } from "./MentionCard.js";

export function MentionFeed({
  mentions,
  onOpen,
  groupFilter = null,
  hasOlderPages = false,
  loaded = true,
  loading = false,
  error = false,
  expandFirstGroup = false,
  onClearGroupFilter,
  onRetry,
  tickerOf,
  knownTickers = [],
  companyNameOf,
}: {
  mentions: Mention[];
  onOpen: (mention: Mention) => void;
  groupFilter?: ExactTitleGroupFilter;
  hasOlderPages?: boolean;
  loaded?: boolean;
  loading?: boolean;
  error?: boolean;
  expandFirstGroup?: boolean;
  onClearGroupFilter?: () => void;
  onRetry?: () => void;
  tickerOf?: (companyId: string) => string;
  knownTickers?: readonly string[];
  companyNameOf?: (companyId: string) => string;
}) {
  const allEntries = groupExactHeadlineRepeats(mentions);
  const entries = filterExactHeadlineGroups(allEntries, groupFilter);
  const groupCount = entries.length;
  const scoredRows = mentions.filter((mention) => mention.status === "scored" && mention.score != null).length;
  return (
    <>
      {groupFilter != null && (
        <div className="feed-evidence-filter" role="status">
          <span>
            {error
              ? "The saved feed could not be loaded; no group count is available."
              : loading || !loaded
                ? "Loading saved scored records for the selected window…"
                : groupCount === 0
              ? groupFilter === "mixed"
                ? "No mixed-label exact-title groups in the loaded feed pages."
                : "No repeated exact-title groups in the loaded feed pages."
              : groupFilter === "mixed"
                ? `Showing ${groupCount} exact-title group${groupCount === 1 ? "" : "s"} with mixed Jev labels among ${scoredRows} loaded scored records. Mixed means different most-likely Jev sentiment classes within one normalized-title group.`
                : `Showing ${groupCount} repeated exact-title group${groupCount === 1 ? "" : "s"} among ${scoredRows} loaded scored records. Exact title is only a duplicate cue, not proof of one story.`}
            {hasOlderPages ? " Older feed pages may contain more groups." : ""}
          </span>
          {onClearGroupFilter && (
            <button type="button" onClick={onClearGroupFilter} aria-label="Clear evidence group filter">
              Clear
            </button>
          )}
          {error && onRetry && (
            <button type="button" onClick={onRetry} aria-label="Retry loading saved feed">
              Retry
            </button>
          )}
        </div>
      )}
      {error && groupFilter == null && (
        <p className="feed-evidence-filter" role="alert">
          <span>Saved mentions could not be loaded. Retry the selected feed.</span>
          {onRetry && (
            <button type="button" onClick={onRetry} aria-label="Retry loading saved feed">
              Retry
            </button>
          )}
        </p>
      )}
      {!error && loaded && !loading && entries.map((entry, index) => entry.kind === "mention" ? (
        <MentionCard key={entry.mention.id} m={entry.mention} dense onOpen={onOpen} tickerOf={tickerOf} knownTickers={knownTickers} companyNameOf={companyNameOf} />
      ) : entry.kind === "pending-title-repeats" ? (
        <details className="exact-title-group pending-title-group" key={entry.mentions[0]!.id} open={expandFirstGroup && index === 0}>
          <summary aria-label={`Unclassified exact title group “${entry.title}”: ${entry.mentions.length} loaded pending rows`}>
            <span className="exact-title-mark" aria-hidden="true">↳</span>
            <span className="exact-title-main">
              <span className="exact-title-text">{entry.title}</span>
              <span className="exact-title-stats">
                {entry.mentions.length} loaded pending rows · {entry.publisherLabelCount} publisher labels · {entry.collectorFeedCount} collector feeds
              </span>
              <span className="exact-title-caveat">Unclassified · counts cover loaded rows · exact-title match is a duplicate cue only, not proof of independent reports or investors</span>
            </span>
            <span className="exact-title-expand">Review {entry.mentions.length} rows</span>
          </summary>
          <div className="exact-title-records">
            {entry.mentions.map((mention) => (
              <MentionCard key={mention.id} m={mention} dense onOpen={onOpen} tickerOf={tickerOf} knownTickers={knownTickers} companyNameOf={companyNameOf} />
            ))}
          </div>
        </details>
      ) : (
        <details className="exact-title-group" key={entry.mentions[0]!.id} open={expandFirstGroup && index === 0}>
          <summary aria-label={`Exact title group “${entry.title}”: ${entry.mentions.length} source records, ${entry.publisherLabelCount} publisher labels, ${entry.directions.positive} positive, ${entry.directions.neutral} neutral, ${entry.directions.negative} negative`}>
            <span className="exact-title-mark" aria-hidden="true">↳</span>
            <span className="exact-title-main">
              <span className="exact-title-text">{entry.title}</span>
              <span className="exact-title-stats">
                {entry.mentions.length} title matches · {entry.publisherLabelCount} publisher labels ·
                <span className="text-emerald-300/90"> +{entry.directions.positive}</span>
                <span className="text-slate-300"> ={entry.directions.neutral}</span>
                <span className="text-rose-300/90"> −{entry.directions.negative}</span>
                {` · impact ${entry.impactMin > 0 ? "+" : ""}${entry.impactMin.toFixed(0)} to ${entry.impactMax > 0 ? "+" : ""}${entry.impactMax.toFixed(0)}`}
              </span>
              <span className="exact-title-caveat">Normalized title match only · publisher labels may share upstream reporting</span>
            </span>
            <span className="exact-title-expand">Show {entry.mentions.length} records</span>
          </summary>
          <div className="exact-title-records">
            {entry.mentions.map((mention) => (
              <MentionCard key={mention.id} m={mention} dense onOpen={onOpen} tickerOf={tickerOf} knownTickers={knownTickers} companyNameOf={companyNameOf} />
            ))}
          </div>
        </details>
      ))}
    </>
  );
}
