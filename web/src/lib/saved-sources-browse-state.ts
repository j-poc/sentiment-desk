import type { Mention } from "./api.js";
import { mergeMentionPages } from "./snapshot-reconciliation.js";

export type SavedSourcesBrowseState = {
  query: string;
  visibleCount: number;
  companyFilter: string | null;
  historyPageCounts: Record<string, number>;
};

export const INITIAL_SAVED_SOURCES_BROWSE_STATE: SavedSourcesBrowseState = {
  query: "",
  visibleCount: 12,
  companyFilter: null,
  historyPageCounts: {},
};

export const SAVED_SOURCES_BROWSE_STORAGE_KEY = "sentiment-desk-saved-sources-browse";
const MAX_VISIBLE_SAVED_SOURCE_ROWS = 1_000_000;
const MAX_SAVED_HISTORY_PAGES = 10_000;

type SessionStore = Pick<Storage, "getItem" | "setItem">;

export function shouldRestoreSavedHistoryPage(input: {
  loadedPageCount: number;
  requestedPageCount: number;
  hasNextPage: boolean;
  loading: boolean;
  failed: boolean;
}): boolean {
  return input.loadedPageCount < input.requestedPageCount
    && input.hasNextPage
    && !input.loading
    && !input.failed;
}

/** Keep an already-open saved-history page in step with real streamed updates. */
export function mergeSavedHistoryStreamEvent<T extends { companyId: string; items: Mention[] }>(
  history: T | undefined,
  mention: Mention,
): T | undefined {
  if (!history || history.companyId !== mention.companyId) return history;
  return { ...history, items: mergeMentionPages(history.items, [mention]) };
}

export function readSavedSourcesBrowseState(storage: Pick<SessionStore, "getItem"> | null): SavedSourcesBrowseState {
  if (!storage) return INITIAL_SAVED_SOURCES_BROWSE_STATE;
  try {
    const raw = storage.getItem(SAVED_SOURCES_BROWSE_STORAGE_KEY);
    if (!raw) return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    const candidate = value as Partial<SavedSourcesBrowseState>;
    if (typeof candidate.query !== "string" || candidate.query.length > 120) return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    if (!Number.isSafeInteger(candidate.visibleCount) || candidate.visibleCount! < 12 || candidate.visibleCount! > MAX_VISIBLE_SAVED_SOURCE_ROWS) return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    if (candidate.companyFilter !== null && (typeof candidate.companyFilter !== "string" || candidate.companyFilter.length > 160)) {
      return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    }
    const rawPageCounts: unknown = candidate.historyPageCounts ?? {};
    if (typeof rawPageCounts !== "object" || rawPageCounts === null || Array.isArray(rawPageCounts)) {
      return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    }
    const pageCountEntries = Object.entries(rawPageCounts);
    if (pageCountEntries.length > 64 || pageCountEntries.some(([companyId, count]) =>
      companyId.length === 0 || companyId.length > 160 || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > MAX_SAVED_HISTORY_PAGES,
    )) return INITIAL_SAVED_SOURCES_BROWSE_STATE;
    return {
      query: candidate.query,
      visibleCount: candidate.visibleCount!,
      companyFilter: candidate.companyFilter,
      historyPageCounts: Object.fromEntries(pageCountEntries) as Record<string, number>,
    };
  } catch {
    return INITIAL_SAVED_SOURCES_BROWSE_STATE;
  }
}

export function writeSavedSourcesBrowseState(
  storage: Pick<SessionStore, "setItem"> | null,
  state: SavedSourcesBrowseState,
): void {
  if (!storage) return;
  try {
    storage.setItem(SAVED_SOURCES_BROWSE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browsing remains usable if the browser blocks session storage.
  }
}
