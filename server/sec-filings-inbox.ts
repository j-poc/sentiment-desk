import { config } from "./config.js";
import { loadSecFilingsHubInstallation, type SecFilingsHubInstallation } from "./sec-filings-hub-installation.js";
import { SEC_FILINGS_FRESHNESS_BUDGET_MS, secFilingIdentity, secFilingsSourceFreshness, secIssuerDisplayName, type SecFilingInboxRow, type SecFilingsInboxView } from "../shared/sec-filings-inbox.js";

const DATASET = "sec.latest_filings_8k";
const CONSUMER = "sentiment-desk";
const MAX_HUB_BYTES = 2_000_000;
const LISTING_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const LISTING_SOURCES = [
  { url: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", kind: "nasdaq" as const },
  { url: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", kind: "other" as const },
];
const MAX_LISTING_BYTES = 1_500_000;
const MAX_LISTING_ROWS = 20_000;

interface HubConnection extends SecFilingsHubInstallation {}

type JsonRecord = Record<string, unknown>;

export interface ListedSecurity { symbol: string; exchange: string; securityName: string; normalizedName: string }
export interface ListingDirectoryEvidence { source: string; createdAt: string; retrievedAt: string }
export interface ListingSnapshot { securities: ListedSecurity[]; createdAt: string; retrievedAt: string; directories: ListingDirectoryEvidence[] }

function easternTimestamp(value: string): string | null {
  const match = value.match(/^(\d{2})(\d{2})(\d{4}) (\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, month, day, year, hour, minute] = match;
  const wallClock = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  const date = new Date(wallClock);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59) return null;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Resolve the source's Eastern wall clock without assuming a fixed DST offset.
  let candidate = wallClock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    candidate += wallClock - represented;
  }
  const check = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
  if (Number(check.month) !== Number(month) || Number(check.day) !== Number(day) || Number(check.year) !== Number(year)
    || Number(check.hour) !== Number(hour) || Number(check.minute) !== Number(minute)) return null;
  return new Date(candidate).toISOString();
}

function normalizedSecurityName(value: string): string {
  let name = value.trim().toLocaleLowerCase("en-US").replace(/\s+\([^)]*\)\s*$/, "");
  const securitySuffix = /(?:\s*[-,]\s*|\s+)(?:class\s+[a-z0-9]+\s+)?(?:common stock|ordinary shares?|common shares?|ordinary share|depositary shares?|american depositary shares?|equity shares?)$/i;
  const legalSuffix = /(?:\s+)(?:incorporated|inc\.?|corporation|corp\.?|company|co\.?|limited|ltd\.?|llc|l\.l\.c\.?|plc\.?|lp|l\.p\.?|n\.v\.?|s\.a\.?|ag|asa|ab|oyj|se)$/i;
  let changed = true;
  while (changed) {
    const before = name;
    name = name.replace(securitySuffix, "").replace(legalSuffix, "");
    changed = name !== before;
  }
  return name.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function parseListingDirectory(text: string, kind: "nasdaq" | "other", source: string, retrievedAt: string): ListingSnapshot | null {
  const creation = text.match(/^File Creation Time:[ \t]*(\d{8})[ \t]*(\d{2}:\d{2})[ \t]*\|*[ \t]*$/m);
  const createdAt = creation ? easternTimestamp(`${creation[1]} ${creation[2]}`) : null;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith(kind === "nasdaq" ? "Symbol|Security Name|" : "ACT Symbol|Security Name|"));
  if (!createdAt || headerIndex < 0 || lines.length > MAX_LISTING_ROWS + 10) return null;
  const headers = lines[headerIndex]!.split("|");
  const col = Object.fromEntries(headers.map((header, index) => [header, index]));
  const required = kind === "nasdaq" ? ["Symbol", "Security Name", "Test Issue", "ETF"] : ["ACT Symbol", "Security Name", "Exchange", "ETF", "Test Issue"];
  if (required.some((field) => col[field] === undefined)) return null;
  const securities: ListedSecurity[] = [];
  const symbols = new Set<string>();
  const eligibleExchanges = new Map([["A", "NYSE American"], ["N", "NYSE"], ["P", "NYSE Arca"], ["Z", "Cboe BZX"], ["V", "IEX"]]);
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line || line.startsWith("File Creation Time:")) continue;
    const fields = line.split("|");
    if (fields.length !== headers.length) return null;
    const symbol = fields[col[kind === "nasdaq" ? "Symbol" : "ACT Symbol"]!]!.trim();
    const securityName = fields[col["Security Name"]!]!.trim();
    const isTest = fields[col["Test Issue"]!]!.trim();
    const isEtf = fields[col["ETF"]!]!.trim();
    if (!symbol || !securityName || !/^[\x21-\x7e]{1,14}$/.test(symbol) || symbol.includes("|") || !["Y", "N"].includes(isTest) || !["Y", "N"].includes(isEtf)) return null;
    const exchangeCode = kind === "nasdaq" ? "NASDAQ" : fields[col["Exchange"]!]!.trim();
    const exchange = kind === "nasdaq" ? "Nasdaq" : eligibleExchanges.get(exchangeCode);
    const instrumentOnly = /\b(?:warrants?|rights?|units?|preferred stock|depositary receipts?)\b/i.test(securityName);
    if (isTest !== "N" || isEtf !== "N" || !exchange || instrumentOnly) continue;
    const normalizedName = normalizedSecurityName(securityName);
    if (!normalizedName || symbols.has(symbol.toUpperCase())) return null;
    symbols.add(symbol.toUpperCase());
    securities.push({ symbol, exchange, securityName, normalizedName });
  }
  return securities.length > 0 ? { securities, createdAt, retrievedAt, directories: [{ source, createdAt, retrievedAt }] } : null;
}

function currentListingMatch(issuer: string, snapshot: ListingSnapshot, now: number): ListedSecurity | null {
  const age = now - Date.parse(snapshot.createdAt);
  if (!Number.isFinite(age) || age < 0 || age > LISTING_FRESHNESS_MS) return null;
  const normalized = normalizedSecurityName(issuer);
  if (!normalized) return null;
  const matches = snapshot.securities.filter((security) => security.normalizedName === normalized);
  return matches.length === 1 ? matches[0]! : null;
}

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
  private listingSnapshot: ListingSnapshot | null = null;

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
      const freshness = secFilingsSourceFreshness(feedUpdatedAt, current);
      const stale = current - Date.parse(retrievedAt) > SEC_FILINGS_FRESHNESS_BUDGET_MS;
      const jobFailed = job?.status === "failed" || job?.status === "interrupted" || job?.status === "cancelled";
      const jobRunning = ["queued", "running", "cancelling"].includes(String(job?.status ?? ""));
      const latestUpdatedMs = typeof job?.updated_at === "string" ? Date.parse(job.updated_at) : NaN;
      return this.applyListingGate({
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
      });
    } catch (error) {
      if (error instanceof Error && error.message === "hub_contract_missing") return this.empty("unsupported", "The connected Hub does not yet provide the SEC 8-K feed.");
      return this.unavailable();
    }
  }

  async activate(): Promise<SecFilingsInboxView> {
    if (!this.options.acquisitionEnabled) return this.empty("unavailable", "Recent Filings is paused. Enable external requests and approve both SEC 8-K and Nasdaq symbol-directory sources in both source lists.");
    try { this.listingSnapshot = await this.fetchListingSnapshot(); }
    catch { this.listingSnapshot = null; }
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
    const listingDirectoryCreatedAt = this.listingSnapshot?.createdAt ?? null;
    const listingDirectoryRetrievedAt = this.listingSnapshot?.retrievedAt ?? null;
    return { state, freshness: "unknown", rows: [], receiptId: null, retrievedAt: null, feedUpdatedAt: null, jobStatus: null, canActivate, nextRefreshAt: null, message,
      withheldCount: 0, listingVerificationGap: listingDirectoryCreatedAt ? null : "Current exchange-listing directories have not been verified in this app session.", listingDirectoryCreatedAt, listingDirectoryRetrievedAt, listingDirectories: this.listingSnapshot?.directories ?? [] };
  }

  private async fetchListingSnapshot(): Promise<ListingSnapshot> {
    const fetcher = this.options.fetcher ?? fetch;
    const responses = await Promise.all(LISTING_SOURCES.map(async ({ url, kind }) => {
      const response = await fetcher(url, { method: "GET", headers: { accept: "text/plain" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok || (response.url && response.url !== url)) throw new Error("listing_directory_unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("listing_directory_unavailable");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_LISTING_BYTES) { await reader.cancel(); throw new Error("listing_directory_too_large"); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const retrievedAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
      const parsed = parseListingDirectory(text, kind, url, retrievedAt);
      if (!parsed) throw new Error("listing_directory_invalid");
      return parsed;
    }));
    const createdAt = responses.map((response) => response.createdAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
    const retrievedAt = responses.map((response) => response.retrievedAt).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
    const securities = responses.flatMap((response) => response.securities);
    return { securities, createdAt, retrievedAt, directories: responses.flatMap((response) => response.directories) };
  }

  private applyListingGate(view: SecFilingsInboxView): SecFilingsInboxView {
    const snapshot = this.listingSnapshot;
    if (!snapshot) return { ...view, state: view.rows.length ? "listing_unverified" : view.state, rows: [], withheldCount: view.rows.length,
      listingVerificationGap: view.rows.length ? `${view.rows.length} SEC filing${view.rows.length === 1 ? " was" : "s were"} withheld because current Nasdaq Trader listing files could not be verified; the local app session has no directory snapshot. ${view.canActivate ? "Activate Recent Filings to check both official directories." : "The listing check is paused. Enable external requests and approve both sec_latest_filings_8k and nasdaq_symbol_directories in both source lists."}` : "Current exchange-listing directories have not been verified in this app session.",
      listingDirectoryCreatedAt: null, listingDirectoryRetrievedAt: null, listingDirectories: [] };
    const now = this.options.now?.() ?? Date.now();
    const age = now - Date.parse(snapshot.createdAt);
    const fresh = Number.isFinite(age) && age >= 0 && age <= LISTING_FRESHNESS_MS;
    const verified = fresh ? view.rows.flatMap((row) => {
      const listing = currentListingMatch(row.issuer, snapshot, now);
      return listing ? [{ ...row, listing: { symbol: listing.symbol, exchange: listing.exchange, securityName: listing.securityName,
        directoryCreatedAt: snapshot.createdAt, directoryRetrievedAt: snapshot.retrievedAt, directories: snapshot.directories } }] : [];
    }) : [];
    const withheldCount = view.rows.length - verified.length;
    const listingVerificationGap = !fresh
      ? `${withheldCount} SEC filing${withheldCount === 1 ? " was" : "s were"} withheld because Nasdaq Trader listing files are stale or have an invalid clock; ${view.canActivate ? "refresh is available only by explicit activation." : "the source check is paused; enable external requests and approve both required sources to retry."}`
      : withheldCount > 0
        ? `${withheldCount} SEC filing${withheldCount === 1 ? " was" : "s were"} withheld because the SEC issuer name had no unique exact match to an active, non-test, non-ETF Nasdaq Trader security name. OTC-only, ambiguous, and unknown issuers remain out of scope; repeating the current directory check will not resolve this match.`
        : null;
    return { ...view, state: verified.length === 0 && withheldCount > 0 ? "listing_unverified" : view.state, rows: verified, withheldCount, listingVerificationGap,
      listingDirectoryCreatedAt: snapshot.createdAt, listingDirectoryRetrievedAt: snapshot.retrievedAt, listingDirectories: snapshot.directories };
  }

  private unavailable(): SecFilingsInboxView {
    return this.empty("unavailable", "The Desk-specific Public Data Hub connection is unavailable or its private installation descriptor is invalid. Configure DESK_HUB_INSTALLATION_FILE, start that local Hub, then check again.", false);
  }
}
