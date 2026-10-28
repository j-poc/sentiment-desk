/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudEvidenceAssessment } from "../web/src/components/CloudEvidenceAssessment.js";

const client = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../web/src/lib/supabase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web/src/lib/supabase.js")>()),
  cloudSupabase: { functions: { invoke: client.invoke } },
}));

const fact = { id: "11111111-1111-4111-8111-111111111111", concept: "Revenue", unit: "USD", value_text: "123000", period_start: "2025-01-01", period_end: "2025-12-31", filed_at: "2026-02-01", form: "10-K", accession: "0000000001-26-000001", reported_decimals: "0" };
const filing = { id: "22222222-2222-4222-8222-222222222222", accession: "0000000001-26-000001", form: "10-K", filed_at: "2026-02-01", report_period: "2025-12-31", primary_document: "index.htm", source_url: "https://www.sec.gov/Archives/edgar/data/1193125/000000000126000001/index.htm" };
const canonicalFilingUrl = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/index.htm";
const response = {
  provider: "google_gemini", model: "gemini-3.8-flash", promptVersion: "sec-company-evidence-assessment/1", generatedAt: "2026-10-10T12:00:00.000Z",
  assessment: { stance: "insufficient_evidence", summary: "One reported period is insufficient to establish a trend.", summaryCitationIds: ["F1"], bullishEvidence: [], bearishEvidence: [], unknowns: ["Multi-year comparability is unknown."] },
  citations: [{ id: "F1", factId: fact.id, label: "Revenue · 10-K · filed 2026-02-01", sourceUrl: canonicalFilingUrl }],
};

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("cloud evidence assessment request flow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    client.invoke.mockReset();
    client.invoke.mockResolvedValue({ data: response, error: null });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("requires Gemini data-use consent and regional Paid Services attestation before sending, then clears the key", async () => {
    await act(async () => root.render(<CloudEvidenceAssessment
      userId="user-1" cik="0000000001" ticker="TST" companyName="Test Issuer"
      factSnapshotId="33333333-3333-4333-8333-333333333333" filingSnapshotId="44444444-4444-4444-8444-444444444444"
      facts={[fact]} filings={[filing]} selectedFactIds={[fact.id]} selectedFilingIds={[filing.id]}
    />));

    const provider = container.querySelector("select")!;
    await act(async () => setValue(provider, "google_gemini"));
    expect(container.textContent).toContain("Where free quota is permitted, Google may use unpaid-service prompts and responses to improve products and may have people review them");
    expect(container.textContent).toContain("Google's Gemini API terms limit use to professional or business purposes, not consumer use");
    expect(container.textContent).toContain("Sentiment Desk cannot determine whether your personal or retail-investing use meets that requirement");
    expect(container.textContent).toContain("the Desk cannot determine whether my personal or retail-investing use qualifies");
    expect(container.textContent).toContain("For API clients made available in the EEA, Switzerland, or UK, Google requires Paid Services through a Cloud project with active billing");
    expect(container.textContent).toContain("a free-tier-only project is not eligible there");
    expect(container.textContent).toContain("Gemini 3.8 Flash paid-tier usage is metered");
    expect(container.textContent).toContain("If you require strictly $0 use in those regions, do not send this request");
    expect(container.textContent).not.toContain("may still have free quota available");
    expect(container.textContent).toContain("This app cannot verify your region, project eligibility, billing, remaining quota, or charges");
    expect(container.textContent).toContain("filing text is not sent");
    expect(container.textContent).toContain("TypeSafe Jev remains a separate source-level sentiment workflow");
    expect(container.textContent).toContain("SEC reported decimals 0");
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);

    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const dataUseConsent = checkboxes.find((element) => element.parentElement?.textContent?.includes("I understand Google’s unpaid-service data use"))!;
    const paidServiceConsent = checkboxes.find((element) => element.parentElement?.textContent?.includes("I confirm its project uses Gemini API Paid Services with active Cloud Billing and accept that metered charges may apply"))!;
    await act(async () => { dataUseConsent.click(); });
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => setValue(keyInput, "AIzaSy-test-public-provider-key-0001"));
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Assess selected evidence once"))!;
    expect(submit.disabled).toBe(true);
    expect(client.invoke).not.toHaveBeenCalled();
    await act(async () => { paidServiceConsent.click(); });
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });

    expect(client.invoke).toHaveBeenCalledTimes(1);
    const [functionName, options] = client.invoke.mock.calls[0] as [string, { body: Record<string, unknown>; headers: Record<string, string> }];
    expect(functionName).toBe("assess-company-evidence");
    expect(options.body).toEqual({ provider: "google_gemini", cik: "0000000001",
      factSnapshotId: "33333333-3333-4333-8333-333333333333", filingSnapshotId: "44444444-4444-4444-8444-444444444444",
      factIds: [fact.id], filingIds: [filing.id], paidServiceAttested: true });
    expect(options.headers).toEqual({ "x-provider-api-key": "AIzaSy-test-public-provider-key-0001" });
    expect(keyInput.value).toBe("");
    expect(container.textContent).toContain("INSUFFICIENT EVIDENCE");
    expect(container.textContent).toContain("One reported period is insufficient to establish a trend.");
    expect(container.textContent).toContain("Citations link to selected records; they do not prove that a claim follows from its cited values.");
    expect(container.querySelector(`a[href="${canonicalFilingUrl}"]`)).not.toBeNull();
    expect(container.querySelector(`a[href="${filing.source_url}"]`)).toBeNull();
  });

  it("clears a typed key when the provider changes", async () => {
    await act(async () => root.render(<CloudEvidenceAssessment
      userId="user-1" cik="0000000001" ticker="TST" companyName="Test Issuer"
      factSnapshotId="33333333-3333-4333-8333-333333333333" filingSnapshotId="44444444-4444-4444-8444-444444444444"
      facts={[fact]} filings={[filing]} selectedFactIds={[fact.id]} selectedFilingIds={[]}
    />));
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => setValue(keyInput, "sk-test-provider-key-value-123456"));
    await act(async () => setValue(container.querySelector("select")!, "google_gemini"));
    expect(keyInput.value).toBe("");
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((item) => item.checked === false)).toBe(true);
    expect(client.invoke).not.toHaveBeenCalled();
  });

  it("previews the accession index when a related filing is not selected", async () => {
    await act(async () => root.render(<CloudEvidenceAssessment
      userId="user-1" cik="0000000001" ticker="TST" companyName="Test Issuer"
      factSnapshotId="33333333-3333-4333-8333-333333333333" filingSnapshotId="44444444-4444-4444-8444-444444444444"
      facts={[fact]} filings={[filing]} selectedFactIds={[fact.id]} selectedFilingIds={[]}
    />));
    const preview = container.querySelector("a[href='https://www.sec.gov/Archives/edgar/data/1/000000000126000001/index.json']");
    expect(preview).not.toBeNull();
    expect(container.querySelector(`a[href="${filing.source_url}"]`)).toBeNull();
  });

  it("labels unavailable precision in the exact request preview", async () => {
    await act(async () => root.render(<CloudEvidenceAssessment
      userId="user-1" cik="0000000001" ticker="TST" companyName="Test Issuer"
      factSnapshotId="33333333-3333-4333-8333-333333333333" filingSnapshotId="44444444-4444-4444-8444-444444444444"
      facts={[{ ...fact, reported_decimals: null }]} filings={[]} selectedFactIds={[fact.id]} selectedFilingIds={[]}
    />));
    expect(container.textContent).toContain("SEC reported decimals not supplied");
  });

  it("aborts an in-flight request and clears the component key on unmount", async () => {
    let signal: AbortSignal | undefined;
    client.invoke.mockImplementation((_name: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => undefined);
    });
    await act(async () => root.render(<CloudEvidenceAssessment
      userId="user-1" cik="0000000001" ticker="TST" companyName="Test Issuer"
      factSnapshotId="33333333-3333-4333-8333-333333333333" filingSnapshotId="44444444-4444-4444-8444-444444444444"
      facts={[fact]} filings={[filing]} selectedFactIds={[fact.id]} selectedFilingIds={[]}
    />));
    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => setValue(keyInput, "sk-test-provider-key-value-123456"));
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Assess selected evidence once"))!;
    await act(async () => { submit.click(); });
    expect(signal?.aborted).toBe(false);
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
  });

  it("aborts and requires fresh Gemini approvals when the selected evidence changes", async () => {
    const otherFact = { ...fact, id: "55555555-5555-4555-8555-555555555555", concept: "OperatingIncomeLoss" };
    let signal: AbortSignal | undefined;
    let resolveRequest: ((value: { data: typeof response; error: null }) => void) | undefined;
    client.invoke.mockImplementation((_name: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((resolve) => { resolveRequest = resolve; });
    });
    const props = { userId: "user-1", cik: "0000000001", ticker: "TST", companyName: "Test Issuer",
      factSnapshotId: "33333333-3333-4333-8333-333333333333", filingSnapshotId: "44444444-4444-4444-8444-444444444444",
      facts: [fact, otherFact], filings: [filing] };
    await act(async () => root.render(<CloudEvidenceAssessment {...props} selectedFactIds={[fact.id]} selectedFilingIds={[]} />));
    await act(async () => setValue(container.querySelector("select")!, "google_gemini"));
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => { checkboxes[0]!.click(); checkboxes[1]!.click(); });
    await act(async () => setValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, "sk-test-provider-key-value-123456"));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Assess selected evidence once"))!.click());

    await act(async () => root.render(<CloudEvidenceAssessment {...props} selectedFactIds={[otherFact.id]} selectedFilingIds={[]} />));
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveRequest?.({ data: response, error: null }));
    expect(container.textContent).toContain("OperatingIncomeLoss");
    expect(container.textContent).not.toContain("INSUFFICIENT EVIDENCE");
    expect(container.textContent).not.toContain("One reported period is insufficient to establish a trend.");
    expect([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((item) => item.checked === false)).toBe(true);
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Assess selected evidence once"))!.disabled).toBe(true);
    expect(client.invoke).toHaveBeenCalledTimes(1);
  });

  it("shows the recovery guidance from an HTTP function error", async () => {
    client.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ error: "source_snapshot_changed" }), { status: 409 }) } });
    await act(async () => root.render(<CloudEvidenceAssessment
      userId="user-1" cik="0000000001" ticker="TST" companyName="Test Issuer"
      factSnapshotId="33333333-3333-4333-8333-333333333333" filingSnapshotId="44444444-4444-4444-8444-444444444444"
      facts={[fact]} filings={[filing]} selectedFactIds={[fact.id]} selectedFilingIds={[]}
    />));
    await act(async () => setValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, "sk-test-provider-key-value-123456"));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Assess selected evidence once"))!.click());
    expect(container.textContent).toContain("Company data changed while you were reviewing it");
  });
});
