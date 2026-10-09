/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateEvidencePanel, privateEvidenceTextError } from "../web/src/components/PrivateEvidencePanel.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const note: {
  id: string; companyId: string; title: string; sourceLabel: string; fileName: string | null;
  asOfDate: string | null; importedAt: number; sha256: string;
} = {
  id: "note-1", companyId: "issuer-1", title: "Order backlog memo", sourceLabel: "Owner research", fileName: null,
  asOfDate: null, importedAt: 1_791_441_000_000, sha256: "a".repeat(64),
};

const noteList = (items = [note], analysisEnabled = false) => ({
  items, totalCount: items.length, totalBytes: items.length ? 19 : 0,
  analysis: { enabled: analysisEnabled, blockedReason: analysisEnabled ? null : "external_requests_disabled", model: "gpt-6-luna",
    dataControls: { disclosure: "API retention is unverified.", documentationUrl: "https://openai.com/policies", promptCachingDocumentationUrl: "https://openai.com/policies" } },
});

async function openPanel(): Promise<void> {
  await act(async () => {
    root.render(<PrivateEvidencePanel companyId="issuer-1" companyName="Public Issuer" ticker="PUB" />);
    await Promise.resolve();
  });
  await act(async () => {
    container.querySelector("summary")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("private evidence panel", () => {
  it("shows issuer scope and privacy/retention terms before note entry without demo content", () => {
    const html = renderToStaticMarkup(createElement(PrivateEvidencePanel, { companyId: "issuer-1", companyName: "Public Issuer", ticker: "PUB" }));
    expect(html).toContain("<details id=\"private-evidence-issuer-1\" class=\"private-evidence-panel\">");
    expect(html).toContain("Saved locally · optional external analysis");
    expect(html).toContain("For Public Issuer (PUB) only");
    expect(html).toContain("separate from public mentions, sentiment charts, alerts, and automatic Luna classifications");
    expect(html).toContain("the selected note&#x27;s text, title, source label, optional user-asserted date, note ID, content hash and byte count, plus its issuer identity, are sent to OpenAI GPT-6 Luna only after a separate item-specific confirmation");
    expect(html).toContain("Its filename and local import time are not sent.");
    expect(html).toContain("The app does not encrypt them or authenticate users");
    expect(html).not.toContain("never sent to a model");
    expect(html).toContain("Import UTF-8 text file (.txt, .md, or .csv; optional)");
    expect(html).toContain("Private note content <textarea");
    expect(html).toContain("Save locally");
    expect(html).toContain("Before saving a note");
    expect(html).toContain("The app does not encrypt them or authenticate users");
    expect(html).toContain("may retain prompts, responses, and derived metadata for up to 30 days");
    expect(html).toContain("account retention controls are unverified");
    expect(html).not.toContain("No private note has been sent");
    expect(html).not.toContain("demo");
    expect(html).not.toContain("localStorage");
  });

  it("checks both UTF-8 bytes and Unicode code points before upload", () => {
    expect(privateEvidenceTextError("A private note 🧭")).toBeNull();
    expect(privateEvidenceTextError("\ud800")).toBe("The note contains invalid Unicode text. Replace the affected characters before saving.");
    expect(privateEvidenceTextError("\udc00")).toBe("The note contains invalid Unicode text. Replace the affected characters before saving.");
    expect(privateEvidenceTextError("🧭".repeat(32_769))).toBe("The note exceeds the 128 KiB limit.");
    expect(privateEvidenceTextError("a".repeat(40_001))).toBe("The note exceeds the 40,000 character limit.");
    expect(privateEvidenceTextError("a".repeat(40_000))).toBeNull();
  });

  it("gives each issuer its own component identity so draft and file state cannot cross companies", () => {
    const firstIssuer = PrivateEvidencePanel({ companyId: "issuer-1", companyName: "Public Issuer", ticker: "PUB" });
    const secondIssuer = PrivateEvidencePanel({ companyId: "issuer-2", companyName: "Another Public Issuer", ticker: "OTHER" });
    expect(firstIssuer.key).toBe("issuer-1");
    expect(secondIssuer.key).toBe("issuer-2");
    expect(firstIssuer.key).not.toBe(secondIssuer.key);
  });

  it("describes a failed read without claiming that previously saved notes do not exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "read_failed" }, 503)));
    await openPanel();

    const alert = container.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Could not load saved private notes");
    expect(alert?.textContent).toContain("Nothing was changed");
    expect(alert?.textContent).not.toContain("No content was saved");
  });

  it("names the exact note and issuer before deletion, and cancellation makes no delete request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(noteList()))
      .mockResolvedValueOnce(response({ ...note, content: "Saved private research text.", savedAnalysis: null }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openPanel();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("li button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-label='Delete private note: Order backlog memo']")!.click();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(confirmMock.mock.calls[0]?.[0]).toContain("Order backlog memo");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("Public Issuer (PUB)");
    expect(confirmMock.mock.calls[0]?.[0]).toContain("This cannot be undone");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("deletes only after the selected-note confirmation and then reloads the local list", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(noteList()))
      .mockResolvedValueOnce(response({ ...note, content: "Saved private research text.", savedAnalysis: null }))
      .mockResolvedValueOnce(response({ deleted: true }))
      .mockResolvedValueOnce(response(noteList([])));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await openPanel();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("li button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-label='Delete private note: Order backlog memo']")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const deletion = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "DELETE");
    expect(deletion?.[0]).toBe("/api/companies/issuer-1/private-evidence/note-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("0 saved notes for this issuer");
  });

  it("keeps selected private text local when item-specific Luna confirmation is canceled", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(noteList([note], true)))
      .mockResolvedValueOnce(response({ ...note, content: "Saved private research text.", savedAnalysis: null }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openPanel();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("li button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const analyzeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Analyze this selected note"));
    expect(analyzeButton).toBeDefined();
    await act(async () => {
      analyzeButton!.click();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledOnce();
    const disclosure = confirmMock.mock.calls[0]?.[0] ?? "";
    expect(disclosure).toContain("Order backlog memo");
    expect(disclosure).toContain("Public Issuer (PUB)");
    expect(disclosure).toContain("OpenAI gpt-6-luna");
    expect(disclosure).toContain("Source: Owner research");
    expect(disclosure).toContain("User-asserted date: not provided");
    expect(disclosure).toContain("Note ID: note-1");
    expect(disclosure).toContain(`Content SHA-256 prefix: ${"a".repeat(12)}`);
    expect(disclosure).toContain("Text preview: “Saved private research text.”");
    expect(disclosure).toContain("API retention is unverified.");
    expect(disclosure).toContain("Continue with this item only?");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/analyze"))).toBe(false);
  });

  it("sends only the explicitly selected note after the issuer-specific Luna confirmation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(noteList([note], true)))
      .mockResolvedValueOnce(response({ ...note, content: "Saved private research text.", savedAnalysis: null }))
      .mockResolvedValueOnce(response({ status: "outcome_unknown", payloadSha256: "b".repeat(64), requestBytes: 512,
        startedAt: 1_791_441_000_000, savedAt: null, errorCode: "transport_unknown", record: null }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openPanel();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("li button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const analyzeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Analyze this selected note"));
    expect(analyzeButton).toBeDefined();
    await act(async () => {
      analyzeButton!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledOnce();
    const dispatch = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/note-1/analyze"));
    expect(dispatch?.[0]).toBe("/api/companies/issuer-1/private-evidence/note-1/analyze");
    expect((dispatch?.[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((dispatch?.[1] as RequestInit).body))).toEqual({ confirmExternalProcessing: true });
    expect(container.textContent).toContain("OpenAI may have processed the request");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("distinguishes same-title notes and confirms the exact item selected for Luna", async () => {
    const duplicate = { ...note, id: "note-2", sourceLabel: "Supplier call", asOfDate: "2026-10-06" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(noteList([note, duplicate], true)))
      .mockResolvedValueOnce(response({ ...duplicate, content: "Supplier confirmed\n\u202ecomponent backlog eased this week.", savedAnalysis: null }))
      .mockResolvedValueOnce(response({ status: "outcome_unknown", payloadSha256: "c".repeat(64), requestBytes: 512,
        startedAt: 1_791_441_000_000, savedAt: null, errorCode: "transport_unknown", record: null }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openPanel();

    const noteButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("li button"));
    expect(noteButtons).toHaveLength(2);
    expect(noteButtons[0]?.getAttribute("aria-label")).toContain("Owner research");
    expect(noteButtons[1]?.getAttribute("aria-label")).toContain("Supplier call");
    expect(noteButtons[1]?.getAttribute("aria-label")).toContain("as of 2026-10-06");
    expect(noteButtons[1]?.getAttribute("aria-label")).toContain("ID note-2");

    await act(async () => {
      noteButtons[1]!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Analyze this selected note"))!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const consent = confirmMock.mock.calls[0]?.[0] ?? "";
    expect(consent).toContain("Title: “Order backlog memo”");
    expect(consent).toContain("Source: Supplier call");
    expect(consent).toContain("User-asserted date: 2026-10-06");
    expect(consent).toContain("Note ID: note-2");
    expect(consent).toContain("Text preview: “Supplier confirmed �component backlog eased this week.”");
    expect(consent).not.toContain("Supplier confirmed\n");
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/note-2/analyze"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/note-1/analyze"))).toBe(false);
  });
});
