import type { Mention } from "./api.js";
import { mergeMentionPages } from "./snapshot-reconciliation.js";
import { savedSourceSearchCursorSchema, type SavedSourceSearchCursor } from "../../../shared/saved-source-search.js";

export type SavedSourcesBrowseState = {
  query: string;
  visibleCount: number;
  companyFilter: string | null;
  historyPageCounts: Record<string, number>;
  archiveSearch?: {
    query: string;
    companyId: string | null;
    publisher: string;
    includeDismissed: boolean;
    snapshotAt: number | null;
    reviewRevision: number | null;
    cursor: SavedSourceSearchCursor | null;
    previousCursors: Array<SavedSourceSearchCursor | null>;
  };
};

export const INITIAL_SAVED_SOURCES_BROWSE_STATE: SavedSourcesBrowseState = {
  query: "",
  visibleCount: 12,
  companyFilter: null,
  historyPageCounts: {},
  archiveSearch: {
    query: "",
    companyId: null,
    publisher: "",
    includeDismissed: false,
    snapshotAt: null,
    reviewRevision: null,
    cursor: null,
    previousCursors: [],
  },
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
    let parsedArchiveSearch: SavedSourcesBrowseState["archiveSearch"];
    if (candidate.archiveSearch !== undefined) {
      const rawArchiveSearch: unknown = candidate.archiveSearch;
      if (typeof rawArchiveSearch !== "object" || rawArchiveSearch === null || Array.isArray(rawArchiveSearch)) {
        return INITIAL_SAVED_SOURCES_BROWSE_STATE;
      }
      const archiveSearch = rawArchiveSearch as Partial<NonNullable<SavedSourcesBrowseState["archiveSearch"]>>;
      if (typeof archiveSearch.query !== "string" || archiveSearch.query.length > 120
        || (archiveSearch.companyId !== null && archiveSearch.companyId !== undefined
          && (typeof archiveSearch.companyId !== "string" || archiveSearch.companyId.length > 160))
        || typeof archiveSearch.publisher !== "string" || archiveSearch.publisher.length > 120
        || typeof archiveSearch.includeDismissed !== "boolean"
        || (archiveSearch.snapshotAt !== null && archiveSearch.snapshotAt !== undefined
          && (!Number.isSafeInteger(archiveSearch.snapshotAt) || Number(archiveSearch.snapshotAt) < 0))
        || (archiveSearch.reviewRevision !== null && archiveSearch.reviewRevision !== undefined
          && (!Number.isSafeInteger(archiveSearch.reviewRevision) || Number(archiveSearch.reviewRevision) < 0))) {
        return INITIAL_SAVED_SOURCES_BROWSE_STATE;
      }
      const cursorValid = (value: unknown): value is SavedSourceSearchCursor | null =>
        value === null || savedSourceSearchCursorSchema.safeParse(value).success;
      const cursors = [archiveSearch.cursor ?? null, ...(Array.isArray(archiveSearch.previousCursors) ? archiveSearch.previousCursors : [])];
      const cursorStateValid = Array.isArray(archiveSearch.previousCursors ?? [])
        && (archiveSearch.previousCursors ?? []).length <= 100
        && cursors.every(cursorValid);
      parsedArchiveSearch = {
        query: archiveSearch.query,
        companyId: archiveSearch.companyId ?? null,
        publisher: archiveSearch.publisher,
        includeDismissed: archiveSearch.includeDismissed,
        snapshotAt: cursorStateValid ? archiveSearch.snapshotAt ?? null : null,
        reviewRevision: cursorStateValid ? archiveSearch.reviewRevision ?? null : null,
        cursor: cursorStateValid ? archiveSearch.cursor ?? null : null,
        previousCursors: cursorStateValid ? archiveSearch.previousCursors ?? [] : [],
      };
    }
    return {
      query: candidate.query,
      visibleCount: candidate.visibleCount!,
      companyFilter: candidate.companyFilter,
      historyPageCounts: Object.fromEntries(pageCountEntries) as Record<string, number>,
      ...(parsedArchiveSearch ? { archiveSearch: parsedArchiveSearch } : {}),
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
