export interface PageRead<T> {
  data: readonly T[] | null;
  error: unknown;
}

export interface BoundedPageResult<T> {
  rows: T[];
  complete: boolean;
}

export async function readBoundedPages<T>(
  readPage: (offset: number, limit: number) => PromiseLike<PageRead<T>>,
  pageSize: number,
  maxRows: number,
): Promise<BoundedPageResult<T>> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxRows) || maxRows < pageSize) {
    throw new RangeError("Invalid bounded page limits.");
  }
  const rows: T[] = [];
  while (true) {
    const limit = Math.min(pageSize, maxRows + 1 - rows.length);
    const result = await readPage(rows.length, limit);
    if (result.error) throw result.error;
    const page = result.data ?? [];
    if (page.length > limit) throw new Error("Page reader returned more rows than requested.");
    rows.push(...page);
    if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), complete: false };
    if (page.length < limit) return { rows, complete: true };
  }
}
