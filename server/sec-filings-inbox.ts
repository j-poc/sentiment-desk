import { config } from "./config.js";
import { loadSecFilingsHubInstallation, type SecFilingsHubInstallation } from "./sec-filings-hub-installation.js";
import { secFilingIdentity, secIssuerDisplayName, type SecFilingInboxRow, type SecFilingsInboxView } from "../shared/sec-filings-inbox.js";

const DATASET = "sec.latest_filings_8k";
const CONSUMER = "sentiment-desk";
const MAX_HUB_BYTES = 2_000_000;
const STALE_AFTER_MS = 30 * 60 * 1000;

interface HubConnection extends SecFilingsHubInstallation {}

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value ? value : null;
}

function validateFilingUrl(value: unknown, accession: string, filingCikPath: unknown): { url: string; filingCikPath: string } | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    const accessionDigits = accession.replaceAll("-", "");
    const path = url.pathname.match(/^\/Archives\/edgar\/data\/([0-9]{1,10})\/([0-9]{18})\/([0-9]{10}-[0-9]{2}-[0-9]{6})-index\.htm$/);
    if (url.protocol !== "https:" || url.hostname !== "www.sec.gov" || url.port || url.username || url.password || url.search || url.hash
      || !path || path[2] !== accessionDigits || path[3] !== accession
      || (typeof filingCikPath === "string" && (!/^\d{1,10}$/.test(filingCikPath) || String(Number(path[1])) !== String(Number(filingCikPath))))) return null;
    const filingCikPathValue = path[1];
    if (!filingCikPathValue) return null;
    return { url: url.toString(), filingCikPath: filingCikPathValue };
  } catch {
    return null;
  }
}

function normalizeRows(value: unknown): SecFilingInboxRow[] | null {
  if (!Array.isArray(value) || value.length > 40) return null;
  const rows: SecFilingInboxRow[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const row = object(raw);
    const attributes = object(row?.attributes);
    const accession = typeof attributes?.accession === "string" ? attributes.accession : "";
    const cik = typeof row?.entity === "string" ? row.entity : "";
    if (attributes?.accession_cik != null && typeof attributes.accession_cik !== "string") return null;
    if (attributes?.filing_cik_path != null && typeof attributes.filing_cik_path !== "string") return null;
    const declaredAccessionCik = typeof attributes?.accession_cik === "string" ? attributes.accession_cik : accession.slice(0, 10);
    const declaredFilingCikPath = typeof attributes?.filing_cik_path === "string" ? attributes.filing_cik_path : null;
    const form = attributes?.form;
    const issuer = typeof attributes?.issuer_label === "string" ? secIssuerDisplayName(attributes.issuer_label.trim()) : "";
    if (!/^[0-9]{10}-[0-9]{2}-[0-9]{6}$/.test(accession) || !/^\d{10}$/.test(cik)
      || !/^\d{10}$/.test(declaredAccessionCik) || accession.slice(0, 10) !== declaredAccessionCik
      || form !== "8-K"
      || issuer.length < 1 || issuer.length > 200 || seen.has(secFilingIdentity({ cik, accession }))) return null;
    const filing = validateFilingUrl(row?.source_address, accession, declaredFilingCikPath);
    if (!filing || attributes?.filing_url !== filing.url) return null;
    const filedOn = validDate(attributes?.filed_at);
    if (attributes?.filed_at != null && !filedOn) return null;
    const acceptedAt = validTimestamp(attributes?.accepted_at);
    if (attributes?.accepted_at != null && !acceptedAt) return null;
    const publishedValue = attributes?.published_source_timestamp;
    const feedPublishedAt = publishedValue === "" || publishedValue == null ? null : validTimestamp(publishedValue);
    if (publishedValue != null && publishedValue !== "" && !feedPublishedAt) return null;
    const feedUpdatedAt = validTimestamp(attributes?.feed_updated_at);
    if (attributes?.feed_updated_at != null && !feedUpdatedAt) return null;
    rows.push({ accession, cik, accessionCik: declaredAccessionCik, filingCikPath: filing.filingCikPath,
      issuer, form, filedOn, acceptedAt, feedPublishedAt, feedUpdatedAt, filingUrl: filing.url });
    seen.add(secFilingIdentity({ cik, accession }));
  }
  return rows;
}

export class SecFilingsInbox {
  constructor(private readonly options: {
    acquisitionEnabled: boolean;
    fetcher?: typeof fetch;
    now?: () => number;
    connectionProvider?: () => HubConnection;
  }) {}

  private connection(): HubConnection {
    return this.options.connectionProvider?.() ?? loadSecFilingsHubInstallation(config.publicDataHubInstallationFile);
  }

  private async request(url: URL, token: string, method = "GET", body?: unknown): Promise<unknown> {
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(response.status === 404 ? "hub_contract_missing" : "hub_unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("hub_unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_HUB_BYTES) {
        await reader.cancel();
        throw new Error("hub_response_too_large");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("hub_invalid_response"); }
  }

  private async get(url: URL, token: string): Promise<unknown> { return this.request(url, token); }

  async read(): Promise<SecFilingsInboxView> {
    let connection: HubConnection;
    try { connection = this.connection(); }
    catch { return this.unavailable(); }
    try {
      const sources = object(await this.get(new URL("/api/v1/sources", connection.baseUrl), connection.token));
      const implemented = Array.isArray(sources?.implemented) ? sources.implemented : [];
      const source = implemented.map(object).find((entry) => entry?.id === DATASET);
      if (!source) return this.empty("unsupported", "The connected Hub does not yet provide the SEC 8-K feed.");
      const state = object(await this.get(new URL("/api/v1/state?include_results=false", connection.baseUrl), connection.token));
      const profiles = Array.isArray(state?.profiles) ? state.profiles : [];
      const view = profiles.map(object).find((entry) => {
        const profile = object(entry?.profile);
        const params = object(profile?.params);
        return profile?.dataset === DATASET && profile?.consumer === CONSUMER && params?.form === "8-K"
          && Object.keys(params).length === 1;
      });
      if (!view) return this.empty("not_configured", null, this.options.acquisitionEnabled);
      const profile = object(view.profile)!;
      const job = object(view.latest_job);
      const accepted = object(view.last_accepted_job);
      if (view.result_matches_current_revision !== true || typeof accepted?.receipt_id !== "string") {
        const stateName = job?.status === "failed" || job?.status === "interrupted" ? "failed" : "pending";
        const updatedAt = typeof job?.updated_at === "string" ? Date.parse(job.updated_at) : NaN;
        return {
          ...this.empty(stateName, stateName === "failed" ? "The Hub could not refresh this filing feed. Retry after checking its source status." : "The Hub is acquiring the first SEC filing snapshot."),
          jobStatus: typeof job?.status === "string" ? job.status : null,
          nextRefreshAt: Number.isFinite(updatedAt) ? new Date(updatedAt + 15 * 60 * 1000).toISOString() : null,
        };
      }
      const receiptId = accepted.receipt_id;
      const receipt = object(await this.get(new URL(`/api/v1/receipts/${encodeURIComponent(receiptId)}?purpose=private_display`, connection.baseUrl), connection.token));
      if (!receipt || receipt.dataset !== DATASET || object(receipt.params)?.form !== "8-K"
        || object(receipt.rights)?.private_display !== true || object(receipt.rights)?.export !== false
        || object(receipt.rights)?.redistribution !== false || receipt.receipt_id !== receiptId) {
        return this.empty("unsupported", "The saved Hub receipt does not permit this display.");
      }
      const rows = normalizeRows(receipt.records);
      const retrievedAt = validTimestamp(receipt.retrieved_at);
      if (!rows || !retrievedAt || accepted.revision !== profile.revision) return this.empty("unsupported", "The saved Hub receipt did not match the current SEC feed profile.");
      const current = this.options.now?.() ?? Date.now();
      const feedUpdatedAt = rows.reduce<string | null>((latest, row) =>
        row.feedUpdatedAt && (!latest || Date.parse(row.feedUpdatedAt) > Date.parse(latest)) ? row.feedUpdatedAt : latest, null);
      const observedAtMs = feedUpdatedAt ? Date.parse(feedUpdatedAt) : NaN;
      const freshness: SecFilingsInboxView["freshness"] = !Number.isFinite(observedAtMs) ? "unknown"
        : current >= observedAtMs && current - observedAtMs <= STALE_AFTER_MS ? "current" : "stale";
      const stale = current - Date.parse(retrievedAt) > STALE_AFTER_MS;
      const jobFailed = job?.status === "failed" || job?.status === "interrupted" || job?.status === "cancelled";
      const jobRunning = ["queued", "running", "cancelling"].includes(String(job?.status ?? ""));
      const latestUpdatedMs = typeof job?.updated_at === "string" ? Date.parse(job.updated_at) : NaN;
      return {
        state: jobFailed ? "failed" : jobRunning ? "pending" : rows.length === 0 ? "empty" : stale ? "stale" : "ready",
        freshness,
        rows,
        receiptId,
        retrievedAt,
        feedUpdatedAt,
        jobStatus: typeof job?.status === "string" ? job.status : null,
        nextRefreshAt: Number.isFinite(latestUpdatedMs) ? new Date(latestUpdatedMs + 15 * 60 * 1000).toISOString() : null,
        canActivate: this.options.acquisitionEnabled,
        message: jobFailed ? "Refresh failed; the last accepted snapshot is retained below." : jobRunning ? "Refresh in progress; showing the last accepted snapshot below."
          : rows.length === 0 ? "The accepted SEC feed returned no filings in its bounded recent window." : null,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "hub_contract_missing") return this.empty("unsupported", "The connected Hub does not yet provide the SEC 8-K feed.");
      return this.unavailable();
    }
  }

  async activate(): Promise<SecFilingsInboxView> {
    if (!this.options.acquisitionEnabled) return this.empty("unavailable", "SEC acquisition is paused. Enable external requests and approve only the SEC 8-K source in both source lists.");
    let connection: HubConnection;
    try { connection = this.connection(); }
    catch { return this.unavailable(); }
    try {
      const sources = object(await this.get(new URL("/api/v1/sources", connection.baseUrl), connection.token));
      const source = (Array.isArray(sources?.implemented) ? sources.implemented : []).map(object).find((entry) => entry?.id === DATASET);
      if (!source) return this.empty("unsupported", "The connected Hub does not yet provide the SEC 8-K feed.");
      if (source.configured !== true) return this.empty("unavailable", "The Hub needs its SEC contact User-Agent configured before collection can start.");
      const state = object(await this.get(new URL("/api/v1/state?include_results=false", connection.baseUrl), connection.token));
      const profiles = Array.isArray(state?.profiles) ? state.profiles : [];
      const existing = profiles.map(object).find((entry) => {
        const profile = object(entry?.profile), params = object(profile?.params);
        return profile?.dataset === DATASET && profile?.consumer === CONSUMER && params?.form === "8-K" && Object.keys(params).length === 1;
      });
      let result: unknown;
      if (!existing) {
        result = await this.request(new URL("/api/v1/profiles", connection.baseUrl), connection.token, "POST", {
          name: "Sentiment Desk SEC Recent 8-Ks", dataset: DATASET, params: { form: "8-K" }, consumer: CONSUMER, cadence_seconds: 900,
        });
      } else {
        const profile = object(existing.profile)!;
        const latestJob = object(existing.latest_job);
        if (["queued", "running", "cancelling"].includes(String(latestJob?.status ?? ""))) {
          return { ...this.empty("pending", "The SEC feed is already being collected."), jobStatus: String(latestJob?.status), nextRefreshAt: null };
        }
        const lastAttemptMs = typeof latestJob?.updated_at === "string" ? Date.parse(latestJob.updated_at) : NaN;
        if (Number.isFinite(lastAttemptMs) && (this.options.now?.() ?? Date.now()) - lastAttemptMs < 15 * 60 * 1000) {
          const nextRefreshAt = new Date(lastAttemptMs + 15 * 60 * 1000).toISOString();
          return { ...this.empty("rate_limited", "The SEC request cadence is limited to one attempt every 15 minutes to protect source capacity."), jobStatus: typeof latestJob?.status === "string" ? latestJob.status : null, nextRefreshAt };
        }
        if (profile.enabled !== true) await this.request(new URL(`/api/v1/profiles/${encodeURIComponent(String(profile.id))}/schedule?enabled=true`, connection.baseUrl), connection.token, "POST", {});
        result = await this.request(new URL(`/api/v1/profiles/${encodeURIComponent(String(profile.id))}/refresh`, connection.baseUrl), connection.token, "POST", {});
      }
      const output = object(result);
      return { ...this.empty("pending", "SEC filing collection started. This feed refreshes at most every 15 minutes."), jobStatus: typeof object(output?.job)?.status === "string" ? String(object(output?.job)?.status) : "queued", nextRefreshAt: null };
    } catch {
      return this.unavailable();
    }
  }

  private empty(state: SecFilingsInboxView["state"], message: string | null, canActivate = this.options.acquisitionEnabled): SecFilingsInboxView {
    return { state, freshness: "unknown", rows: [], receiptId: null, retrievedAt: null, feedUpdatedAt: null, jobStatus: null, canActivate, nextRefreshAt: null, message };
  }

  private unavailable(): SecFilingsInboxView {
    return this.empty("unavailable", "The Desk-specific Public Data Hub connection is unavailable or its private installation descriptor is invalid. Configure DESK_HUB_INSTALLATION_FILE, start that local Hub, then check again.", false);
  }
}
