import { useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  requestJSON,
  type FollowedBaselineCaptureResult,
  type FollowedEvidenceItem,
  type FollowedEvidencePage,
} from "../lib/api.js";

const PAGE_SIZE = 25;
const UTC_CLOCK = new Intl.DateTimeFormat("en-GB", {
  year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  timeZone: "UTC", timeZoneName: "short",
});

function clockLabel(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "Not reported" : UTC_CLOCK.format(value);
}

function safeSourceHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function statusLabel(item: FollowedEvidenceItem): string {
  if (item.classification) return `Luna · ${item.classification.disposition.replaceAll("_", " ")}`;
  if (item.score) return `Historical Jev · ${item.status === "off_target" ? "off-target" : "scored"}`;
  return item.status.replaceAll("_", " ");
}

function pageUrl(companyId: string, cursor?: FollowedEvidencePage["nextCursor"]): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", JSON.stringify(cursor));
  return `/api/companies/${encodeURIComponent(companyId)}/followed-evidence?${params}`;
}

export function FollowedEvidenceBaseline({
  companyId,
  companyName,
  refreshKey,
  onOpenEvidence,
}: {
  companyId: string;
  companyName: string;
  refreshKey: number;
  onOpenEvidence: (item: FollowedEvidenceItem) => void;
}) {
  const [page, setPage] = useState<FollowedEvidencePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const captureKeyRef = useRef<{ companyId: string; key: string } | null>(null);
  const pageRef = useRef<FollowedEvidencePage | null>(page);
  pageRef.current = page;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const hadCurrentPage = pageRef.current?.companyId === companyId;
    setLoading(!hadCurrentPage);
    setLoadError(false);
    setRefreshError(false);
    setLoadMoreError(false);
    setResetArmed(false);
    setCaptureError(null);
    if (!hadCurrentPage) setPage(null);
    requestJSON<FollowedEvidencePage>(pageUrl(companyId), { signal: controller.signal })
      .then((result) => {
        if (!alive) return;
        setPage(result);
        setLoadError(false);
        setRefreshError(false);
      })
      .catch(() => {
        if (!alive || controller.signal.aborted) return;
        if (hadCurrentPage) setRefreshError(true);
        else setLoadError(true);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [companyId, refreshKey, refreshNonce]);

  const loadMore = async () => {
    if (!page?.nextCursor || loadingMore) return;
    const baselineId = page.baseline?.id;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const next = await requestJSON<FollowedEvidencePage>(pageUrl(companyId, page.nextCursor));
      setPage((current) => {
        if (!current || current.baseline?.id !== baselineId || current.asOfAt !== next.asOfAt) return current;
        const byId = new Map(current.items.map((item) => [item.id, item]));
        for (const item of next.items) byId.set(item.id, item);
        return { ...current, ...next, items: [...byId.values()], nextCursor: next.nextCursor };
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) setRefreshNonce((value) => value + 1);
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const captureBaseline = async () => {
    if (!page || page.companyId !== companyId || captureBusy) return;
    if (page.baseline && !resetArmed) {
      setResetArmed(true);
      setCaptureError(null);
      return;
    }
    if (captureKeyRef.current?.companyId !== companyId) {
      captureKeyRef.current = { companyId, key: crypto.randomUUID() };
    }
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      await requestJSON<FollowedBaselineCaptureResult>(
        `/api/companies/${encodeURIComponent(companyId)}/followed-evidence/baseline`,
        {
          method: "POST",
          body: JSON.stringify({
            captureKey: captureKeyRef.current.key,
            expectedBaselineId: page.baseline?.id ?? null,
          }),
        },
      );
      captureKeyRef.current = null;
      setResetArmed(false);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "followed_baseline_observation_limit_exceeded") {
        setCaptureError("This company exceeds the 50,000-record snapshot limit. No baseline was saved.");
      } else if (error instanceof ApiRequestError && error.status === 409) {
        setCaptureError("The baseline changed in another view. Refreshing the saved comparison.");
        setRefreshNonce((value) => value + 1);
      } else {
        setCaptureError("The baseline was not confirmed. Retry to safely check the same capture request.");
      }
    } finally {
      setCaptureBusy(false);
    }
  };

  const readyPage = page?.companyId === companyId ? page : null;
  return (
    <FollowedEvidenceBaselineView
      companyId={companyId}
      companyName={companyName}
      page={readyPage}
      loading={loading}
      loadError={loadError}
      refreshError={refreshError}
      loadingMore={loadingMore}
      loadMoreError={loadMoreError}
      captureBusy={captureBusy}
      captureError={captureError}
      resetArmed={resetArmed}
      onRetry={() => setRefreshNonce((value) => value + 1)}
      onRetryPage={() => void loadMore()}
      onLoadMore={() => void loadMore()}
      onCapture={() => void captureBaseline()}
      onCancelReset={() => setResetArmed(false)}
      onOpenEvidence={onOpenEvidence}
    />
  );
}

export function FollowedEvidenceBaselineView({
  companyId,
  companyName,
  page,
  loading,
  loadError,
  refreshError,
  loadingMore,
  loadMoreError,
  captureBusy,
  captureError,
  resetArmed,
  onRetry,
  onRetryPage,
  onLoadMore,
  onCapture,
  onCancelReset,
  onOpenEvidence,
}: {
  companyId: string;
  companyName: string;
  page: FollowedEvidencePage | null;
  loading: boolean;
  loadError: boolean;
  refreshError: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
  captureBusy: boolean;
  captureError: string | null;
  resetArmed: boolean;
  onRetry: () => void;
  onRetryPage: () => void;
  onLoadMore: () => void;
  onCapture: () => void;
  onCancelReset: () => void;
  onOpenEvidence: (item: FollowedEvidenceItem) => void;
}) {
  const headingId = `followed-evidence-${companyId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <section className="panel followed-evidence-panel" aria-labelledby={headingId} aria-busy={loading || captureBusy}>
      <div className="followed-evidence-heading">
        <div className="min-w-0">
          <p className="micro m-0">FOLLOWED COMPANY</p>
          <h2 id={headingId} className="followed-evidence-title">New source evidence · {companyName}</h2>
        </div>
        {page?.baseline && (
          <span className="followed-evidence-count" aria-label={`${page.newEvidenceCount} new saved source records`}>
            {page.newEvidenceCount} new
          </span>
        )}
      </div>

      {loading && !page && <p className="followed-evidence-message" role="status">Loading the saved comparison…</p>}
      {loadError && !page && (
        <div className="followed-evidence-message" role="alert">
          The saved comparison could not be confirmed. <button type="button" onClick={onRetry}>Retry</button>
        </div>
      )}
      {page && (
        <>
          <div className="followed-evidence-meta">
            {!page.baseline ? (
              <>
                <span>No baseline saved. Choose a starting point to follow later saved evidence.</span>
                <span>{page.eligibleObservationsNow.toLocaleString()} receipt-verified records eligible · {page.withheldFromBaseline.toLocaleString()} real-history rows withheld by provenance or ingestion checks</span>
              </>
            ) : (
              <>
                <span>Baseline v{page.baseline.version} · captured {clockLabel(page.baseline.capturedAt)} · {page.baseline.eligibleObservationCount.toLocaleString()} receipt-verified records</span>
                <span>Comparison read at {clockLabel(page.asOfAt)} · {page.withheldFromBaseline.toLocaleString()} real-history rows remain outside the verified comparison</span>
              </>
            )}
          </div>

          {refreshError && (
            <div className="followed-evidence-warning" role="alert">
              Refresh failed. Showing the last saved comparison as of {clockLabel(page.asOfAt)}. <button type="button" onClick={onRetry}>Retry</button>
            </div>
          )}

          {!page.baseline && (
            <p className="followed-evidence-explainer">
              A baseline stores exact, receipt-backed observation IDs already saved for this company. Unscored items remain visible later as pending; this comparison does not judge importance or price impact.
            </p>
          )}
          {page.baseline && (
            <>
              <p className="followed-evidence-explainer">
                Items below became eligible after this saved baseline. Some may have been retrieved earlier but were still being ingested at capture; those are labeled separately. This is not a materiality or trading signal.
              </p>
              {page.newEvidenceCount === 0 && (
                <p className="followed-evidence-message" role="status">
                  No newly eligible, receipt-verified source evidence is saved after this baseline. Older or unverified history is not treated as a new change.
                </p>
              )}
              {page.items.length > 0 && (
                <ol className="followed-evidence-list" aria-label="New saved source evidence">
                  {page.items.map((item) => {
                    const href = safeSourceHref(item.source.url);
                    return (
                      <li className="followed-evidence-item" key={item.id}>
                        <div className="followed-evidence-record">
                          <div className="followed-evidence-record-title">
                            {href ? <a href={href} target="_blank" rel="noreferrer">{item.title}</a> : <span>{item.title}</span>}
                            <span className="followed-evidence-status">{statusLabel(item)}</span>
                          </div>
                          <div className="followed-evidence-times">
                            <span>Publisher: {clockLabel(item.publishedAt)}</span>
                            <span>Provider observed: {clockLabel(item.providerObservedAt)}</span>
                            <span>Retrieved: {clockLabel(item.retrievedAt)}</span>
                            <span>Saved: {clockLabel(item.ingestedAt)}</span>
                          </div>
                          {item.publishedBeforeBaseline && (
                            <span className="followed-evidence-late">Published before baseline · retrieved after</span>
                          )}
                          {item.ingestionFinalizedAfterBaseline && (
                            <span className="followed-evidence-late">
                              Ingestion completed after baseline · source was already retrieved ({clockLabel(item.ingestionCompletedAt)})
                            </span>
                          )}
                          <span className="followed-evidence-source">{item.publisherName} · {item.collector.replaceAll("_", " ")} · receipt linked</span>
                        </div>
                        <button type="button" className="followed-evidence-open" onClick={() => onOpenEvidence(item)}>
                          Review record
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
              {loadMoreError && (
                <div className="followed-evidence-warning" role="alert">
                  The next page could not be loaded. <button type="button" onClick={onRetryPage}>Retry page</button>
                </div>
              )}
              {page.nextCursor && (
                <button type="button" className="followed-evidence-more" onClick={onLoadMore} disabled={loadingMore || loading}>
                  {loadingMore ? "Loading more saved evidence…" : "Load more saved evidence"}
                </button>
              )}
            </>
          )}

          <div className="followed-evidence-actions">
            <div className="min-w-0">
              {captureError && <p className="followed-evidence-warning" role="alert">{captureError}</p>}
              {resetArmed && (
                <p className="followed-evidence-confirm" role="status">
                  Save a new comparison point? The current version is retained, but this view compares only the latest baseline.
                </p>
              )}
            </div>
            <div className="followed-evidence-buttons">
              {resetArmed && <button type="button" onClick={onCancelReset}>Cancel</button>}
              <button
                type="button"
                className="followed-evidence-primary"
                onClick={onCapture}
                disabled={captureBusy || loading || loadError || refreshError}
              >
                {captureBusy ? "Saving baseline…" : resetArmed ? "Confirm new baseline" : page.baseline ? "Set new baseline" : "Start following from saved evidence"}
              </button>
            </div>
          </div>
          <p className="followed-evidence-footnote">Baseline changes are local and append-only. Capturing a baseline makes no source or model request.</p>
        </>
      )}
    </section>
  );
}
