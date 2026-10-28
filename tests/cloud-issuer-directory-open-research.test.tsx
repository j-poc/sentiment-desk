/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudIssuerDirectory } from "../web/src/components/CloudIssuerDirectory.js";

const client = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } }));
vi.mock("../web/src/lib/supabase.js", () => ({ cloudSupabase: client }));

const savedIssuer = {
  id: "issuer-row", cik: "0000320193", ticker: "AAPL", issuer_name: "Apple Inc.", exchange: "Nasdaq",
  selected_snapshot_id: "snapshot-id", created_at: "2026-10-10T12:00:00.000Z",
};

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function directoryRow(query: string) {
  const apple = query.toUpperCase() === "AAPL";
  return [{
    cik: apple ? "0000320193" : "0000789019",
    ticker: apple ? "AAPL" : "MSFT",
    issuer_name: apple ? "Apple Inc." : "Microsoft Corporation",
    exchange: "Nasdaq",
    snapshot_id: "snapshot-id",
    retrieved_at: new Date().toISOString(),
  }];
}

describe("cloud issuer directory navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    client.from.mockReset();
    client.rpc.mockReset();
    client.functions.invoke.mockReset();
    client.functions.invoke.mockResolvedValue({ data: { state: "current" }, error: null });
    client.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.order = () => query;
      query.limit = async () => ({ data: table === "user_research_issuers" ? [savedIssuer] : [], error: null });
      query.maybeSingle = async () => table === "sec_issuer_directory_head"
        ? { data: { snapshot_id: "snapshot-id", updated_at: "2026-10-10T12:00:00.000Z" }, error: null }
        : { data: { id: "snapshot-id", retrieved_at: new Date().toISOString() }, error: null };
      return query;
    });
    client.rpc.mockImplementation((_name: string, args: { query_text: string }) => ({
      abortSignal: async () => ({ data: directoryRow(args.query_text), error: null }),
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens a saved company directly from My Research", async () => {
    const onWorkspaceChanged = vi.fn(async () => undefined);
    await act(async () => {
      root.render(<CloudIssuerDirectory userId="user-1" onWorkspaceChanged={onWorkspaceChanged} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const open = [...container.querySelectorAll("button")].find((button) => button.textContent === "Open research");
    expect(open).toBeTruthy();
    await act(async () => open!.click());
    expect(onWorkspaceChanged).toHaveBeenCalledExactlyOnceWith(savedIssuer);
  });

  it("keeps search results aligned when a refresh finishes after the user changes the query", async () => {
    const refreshResponse = deferred<{ data: { state: string }; error: null }>();
    client.functions.invoke.mockReturnValue(refreshResponse.promise);
    await act(async () => {
      root.render(<CloudIssuerDirectory userId="user-1" onWorkspaceChanged={vi.fn(async () => undefined)} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      setValue(input, "AAPL");
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(container.textContent).toContain("Apple Inc.");

    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh company list")!;
    await act(async () => refresh.click());
    await act(async () => {
      setValue(input, "MSFT");
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(container.textContent).toContain("Microsoft Corporation");

    await act(async () => {
      refreshResponse.resolve({ data: { state: "current" }, error: null });
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(input.value).toBe("MSFT");
    expect(client.rpc.mock.calls.map(([, args]) => (args as { query_text: string }).query_text)).toEqual(["AAPL", "MSFT"]);
    const search = container.querySelector<HTMLElement>('[aria-labelledby="cloud-issuer-search-heading"]')!;
    expect(search.textContent).toContain("Microsoft Corporation");
    expect(search.textContent).not.toContain("Apple Inc. AAPL");
  });

  it("shows a pending search state instead of reporting no matches", async () => {
    const searchResponse = deferred<{ data: ReturnType<typeof directoryRow>; error: null }>();
    client.rpc.mockImplementation(() => ({ abortSignal: () => searchResponse.promise }));
    await act(async () => {
      root.render(<CloudIssuerDirectory userId="user-1" onWorkspaceChanged={vi.fn(async () => undefined)} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      setValue(input, "MSFT");
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    const search = container.querySelector<HTMLElement>('[aria-labelledby="cloud-issuer-search-heading"]')!;
    expect(search.textContent).toContain("Searching the SEC company list");
    expect(search.textContent).not.toContain("No companies match this search");

    await act(async () => {
      searchResponse.resolve({ data: directoryRow("MSFT"), error: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(search.textContent).toContain("Microsoft Corporation");
  });

  it("shows a search failure instead of a false no-match result and recovers on retry", async () => {
    let failSearch = true;
    client.rpc.mockImplementation((_name: string, args: { query_text: string }) => ({
      abortSignal: async () => {
        if (args.query_text === "MSFT" && failSearch) { failSearch = false; throw new Error("search failed"); }
        return { data: directoryRow(args.query_text), error: null };
      },
    }));
    await act(async () => {
      root.render(<CloudIssuerDirectory userId="user-1" onWorkspaceChanged={vi.fn(async () => undefined)} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { setValue(input, "MSFT"); await new Promise((resolve) => setTimeout(resolve, 220)); });
    const search = container.querySelector<HTMLElement>('[aria-labelledby="cloud-issuer-search-heading"]')!;
    expect(search.textContent).toContain("Company search could not finish");
    expect(search.textContent).not.toContain("No companies match this search");

    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    expect(retry.disabled).toBe(false);
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(search.textContent).toContain("Microsoft Corporation");
    expect(search.textContent).not.toContain("Company search could not finish");
  });

  it("keeps a saved-list read failure separate from successful company search", async () => {
    let failSavedRead = true;
    client.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.order = () => query;
      query.limit = async () => {
        if (table === "user_research_issuers" && failSavedRead) {
          failSavedRead = false;
          return { data: null, error: new Error("saved read failed") };
        }
        return { data: table === "user_research_issuers" ? [savedIssuer] : [], error: null };
      };
      query.maybeSingle = async () => table === "sec_issuer_directory_head"
        ? { data: { snapshot_id: "snapshot-id", updated_at: "2026-10-10T12:00:00.000Z" }, error: null }
        : { data: { id: "snapshot-id", retrieved_at: new Date().toISOString() }, error: null };
      return query;
    });
    await act(async () => {
      root.render(<CloudIssuerDirectory userId="user-1" onWorkspaceChanged={vi.fn(async () => undefined)} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { setValue(input, "MSFT"); await new Promise((resolve) => setTimeout(resolve, 220)); });

    const savedResearch = container.querySelector<HTMLElement>('[aria-labelledby="cloud-saved-issuers-heading"]')!;
    expect(savedResearch.textContent).toContain("Saved companies could not be confirmed");
    expect(savedResearch.textContent).not.toContain("No companies in My Research yet");
    expect(container.textContent).toContain("Microsoft Corporation");

    const retry = [...savedResearch.querySelectorAll("button")].find((button) => button.textContent === "Reload My Research")!;
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(savedResearch.textContent).toContain("Apple Inc.");
    expect(savedResearch.textContent).not.toContain("Saved companies could not be confirmed");
  });

  it("shows My Research as loading until the first saved-company read completes", async () => {
    const savedRead = deferred<{ data: typeof savedIssuer[]; error: null }>();
    client.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.order = () => query;
      query.limit = () => table === "user_research_issuers" ? savedRead.promise : Promise.resolve({ data: [], error: null });
      query.maybeSingle = async () => table === "sec_issuer_directory_head"
        ? { data: { snapshot_id: "snapshot-id", updated_at: "2026-10-10T12:00:00.000Z" }, error: null }
        : { data: { id: "snapshot-id", retrieved_at: new Date().toISOString() }, error: null };
      return query;
    });
    await act(async () => {
      root.render(<CloudIssuerDirectory userId="user-1" onWorkspaceChanged={vi.fn(async () => undefined)} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const savedResearch = container.querySelector<HTMLElement>('[aria-labelledby="cloud-saved-issuers-heading"]')!;
    expect(savedResearch.textContent).toContain("Loading My Research");
    expect(savedResearch.textContent).not.toContain("No companies in My Research yet");

    await act(async () => { savedRead.resolve({ data: [savedIssuer], error: null }); await Promise.resolve(); });
    expect(savedResearch.textContent).toContain("Apple Inc.");
    expect(savedResearch.textContent).not.toContain("Loading My Research");
  });

  it("does not show an empty My Research result when the directory-head read fails first", async () => {
    const savedRead = deferred<{ data: typeof savedIssuer[]; error: null }>();
    client.from.mockImplementation((table: string) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.order = () => query;
      query.limit = () => table === "user_research_issuers" ? savedRead.promise : Promise.resolve({ data: [], error: null });
      query.maybeSingle = async () => {
        if (table === "sec_issuer_directory_head") throw new Error("directory head unavailable");
        return { data: { id: "snapshot-id", retrieved_at: new Date().toISOString() }, error: null };
      };
      return query;
    });

    await act(async () => {
      root.render(<CloudIssuerDirectory userId="user-1" onWorkspaceChanged={vi.fn(async () => undefined)} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const savedResearch = container.querySelector<HTMLElement>('[aria-labelledby="cloud-saved-issuers-heading"]')!;
    expect(savedResearch.textContent).toContain("Loading My Research");
    expect(savedResearch.textContent).not.toContain("No companies in My Research yet");

    await act(async () => {
      savedRead.resolve({ data: [], error: null });
      await Promise.resolve();
    });
    expect(savedResearch.textContent).not.toContain("Loading My Research");
    expect(savedResearch.textContent).toContain("No companies in My Research yet");
  });
});
