import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { ChatGPTPlanCredentialVault, type CredentialVault } from "./chatgpt-plan-credential-vault";

const AUTH_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const JWKS_ENDPOINT = "https://auth.openai.com/.well-known/jwks.json";
const OIDC_CONFIGURATION = "https://auth.openai.com/.well-known/openid-configuration";
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const REQUIRED_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const REQUIRED_GRANT_SCOPES = ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 5;
const REFRESH_EARLY_MS = 60_000;

type CredentialRecord = {
  hostId: string;
  clientId: string | null;
  subject: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number | null;
  scopes: string[];
};
type Flow = { state: string; nonce: string; verifier: string; redirectUri: string; clientId: string; expectedSubject: string | null; createdAt: number; generation: number };
type TokenResponse = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown; error?: unknown };
type Options = { fetch?: typeof fetch; now?: () => number; path: string; randomId?: () => string; vault?: CredentialVault };

function b64url(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
function scopes(value: unknown): string[] { return typeof value === "string" ? [...new Set(value.split(/\s+/).filter(Boolean))] : Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))] : []; }
function safeMessage(error: unknown): string {
  if (error instanceof Error && /cancel|denied/i.test(error.message)) return "Sign-in was cancelled. You can try again when ready.";
  return "ChatGPT sign-in could not be completed. Try again; no credentials were enabled.";
}

/** Local public-client OAuth for the official Sign in with ChatGPT open-source flow. */
export class ChatGPTPlanAuth {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly vault: CredentialVault;
  private readonly flows = new Map<string, Flow>();
  private record: CredentialRecord | null = null;
  private loaded: Promise<void> | null = null;
  private refreshInFlight: Promise<string | null> | null = null;
  private generation = 0;
  private disconnecting = false;
  private jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: Options) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.vault = options.vault ?? new ChatGPTPlanCredentialVault(options.path);
    this.jwks = createRemoteJWKSet(new URL(JWKS_ENDPOINT), { [customFetch]: this.fetcher as never });
  }

  private async ensureLoaded(): Promise<void> {
    let pending = this.loaded;
    if (!pending) {
      pending = (async () => {
      try {
        const raw = await this.vault.load();
        if (raw === null) {
          this.record = { hostId: `urn:uuid:${this.randomId()}`, clientId: null, subject: null, accessToken: null, refreshToken: null, idToken: null, expiresAt: null, scopes: [] };
          await this.persist();
          return;
        }
        const parsed = JSON.parse(raw) as Partial<CredentialRecord>;
        if (typeof parsed.hostId !== "string" || !parsed.hostId) throw new Error("invalid record");
        this.record = {
          hostId: parsed.hostId, clientId: typeof parsed.clientId === "string" ? parsed.clientId : null,
          subject: typeof parsed.subject === "string" ? parsed.subject : null,
          accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : null,
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
          idToken: typeof parsed.idToken === "string" ? parsed.idToken : null,
          expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
          scopes: scopes(parsed.scopes),
        };
      } catch { throw new Error("Saved ChatGPT connection could not be read safely."); }
      })();
      this.loaded = pending;
    }
    try { await pending; }
    catch (error) {
      // The OS keychain may be temporarily locked or unavailable at startup.
      // Do not memoize that failure for the lifetime of the server; a later
      // explicit connection attempt must be able to retry after it is unlocked.
      if (this.loaded === pending) this.loaded = null;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    if (!this.record) throw new Error("Auth record unavailable.");
    try { await this.vault.save(JSON.stringify(this.record)); }
    catch { throw new Error("ChatGPT credentials could not be saved securely."); }
  }

  async beginAuthorization(redirectUri: string): Promise<{ flowId: string; authorizationUrl: string }> {
    await this.ensureLoaded();
    if (this.disconnecting) throw new Error("ChatGPT sign-in is temporarily unavailable while disconnect completes.");
    const uri = new URL(redirectUri);
    if (uri.protocol !== "http:" || uri.hostname !== "127.0.0.1" || uri.pathname !== "/auth/callback" || uri.username || uri.password || uri.search || uri.hash || !uri.port) {
      throw new Error("Use an exact http://127.0.0.1:<port>/auth/callback redirect URI.");
    }
    const now = this.now();
    for (const [key, flow] of this.flows) if (now - flow.createdAt > FLOW_TTL_MS) this.flows.delete(key);
    while (this.flows.size >= MAX_FLOWS) this.flows.delete(this.flows.keys().next().value!);
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(32));
    const clientId = this.record!.clientId ?? "dynamic_agent_client";
    const flowId = this.randomId();
    this.flows.set(flowId, { state, nonce, verifier, redirectUri, clientId, expectedSubject: this.record!.subject, createdAt: now, generation: this.generation });
    const url = new URL(AUTH_ENDPOINT);
    const query = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: REQUIRED_SCOPES.join(" "), resource: RESOURCE, state, nonce, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", ext_agent_host_id: this.record!.hostId });
    if (clientId === "dynamic_agent_client") query.set("agent_name_hint", "Sentiment Desk");
    url.search = query.toString();
    return { flowId, authorizationUrl: url.toString() };
  }

  async completeAuthorization(flowId: string, query: URLSearchParams, redirectUri: string): Promise<{ ok: boolean; message: string }> {
    await this.ensureLoaded();
    const flow = this.flows.get(flowId);
    if (!flow) return { ok: false, message: "This sign-in attempt expired or was already used. Start again." };
    this.flows.delete(flowId);
    let priorRecord: CredentialRecord | null = null;
    try {
      if (this.now() - flow.createdAt > FLOW_TTL_MS || redirectUri !== flow.redirectUri) throw new Error("invalid flow");
      if (query.getAll("state").length !== 1 || query.get("state") !== flow.state || (query.get("state")?.length ?? 0) > 128) throw new Error("invalid state");
      if (query.has("error")) {
        if (query.getAll("error").length !== 1) throw new Error("OAuth error");
        if (query.get("error") === "access_denied") return { ok: false, message: "Sign-in was cancelled. You can try again when ready." };
        throw new Error("OAuth error");
      }
      const code = query.get("code");
      if (query.getAll("code").length !== 1 || !code || code.length > 4096) throw new Error("missing code");
      const callbackClientId = query.get("client_id");
      if (query.getAll("client_id").length > 1) throw new Error("client mismatch");
      let clientId = flow.clientId;
      if (flow.clientId === "dynamic_agent_client") {
        if (!callbackClientId || callbackClientId === "dynamic_agent_client") throw new Error("missing registration");
        if (this.record!.clientId) throw new Error("registration already selected");
        clientId = callbackClientId;
      } else if (callbackClientId && callbackClientId !== flow.clientId) throw new Error("client mismatch");
      if (this.disconnecting || flow.generation !== this.generation) throw new Error("sign-in was cancelled");
      if (this.record!.clientId !== clientId) {
        const previous = this.record!;
        this.record = { ...previous, clientId };
        try { await this.persist(); }
        catch (error) { this.record = previous; throw error; }
      }
      priorRecord = this.record!;
      const response = await this.fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, resource: RESOURCE }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("token exchange failed");
      const data = await response.json() as TokenResponse;
      if (typeof data.id_token !== "string" || typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number" || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") throw new Error("incomplete token response");
      const verified = await jwtVerify(data.id_token, this.jwks, { issuer: ISSUER, audience: clientId, clockTolerance: 0, currentDate: new Date(this.now()) });
      if (verified.payload.nonce !== flow.nonce || typeof verified.payload.sub !== "string" || !verified.payload.sub) throw new Error("identity mismatch");
      if (this.disconnecting || flow.generation !== this.generation) throw new Error("sign-in was cancelled");
      if (flow.expectedSubject && verified.payload.sub !== flow.expectedSubject) throw new Error("account mismatch");
      const granted = scopes(data.scope);
      if (!REQUIRED_GRANT_SCOPES.every(scope => granted.includes(scope))) {
        priorRecord = this.record!;
        this.record!.clientId = clientId;
        this.record!.subject = verified.payload.sub;
        this.record!.accessToken = null; this.record!.refreshToken = null; this.record!.idToken = data.id_token;
        this.record!.expiresAt = null; this.record!.scopes = granted;
        await this.persist();
        return { ok: false, message: "ChatGPT plan permission was not granted. Reconnect and approve all requested permissions to enable inference." };
      }
      priorRecord = this.record!;
      this.record = { ...this.record!, clientId, subject: verified.payload.sub, accessToken: data.access_token, refreshToken: data.refresh_token, idToken: data.id_token, expiresAt: this.now() + data.expires_in * 1000, scopes: granted };
      await this.persist();
      return { ok: true, message: "ChatGPT plan connection is ready." };
    } catch (error) {
      if (priorRecord && !this.disconnecting && this.generation === flow.generation) this.record = priorRecord;
      return { ok: false, message: safeMessage(error) };
    }
  }

  /** Resolve a callback using only state; flow IDs and PKCE verifiers never cross the callback boundary. */
  async completeCallback(query: URLSearchParams, redirectUri: string): Promise<{ ok: boolean; message: string }> {
    await this.ensureLoaded();
    const state = query.get("state");
    if (!state) return { ok: false, message: "This sign-in attempt expired or was already used. Start again." };
    const match = [...this.flows.entries()].find(([, flow]) => flow.state === state);
    if (!match) return { ok: false, message: "This sign-in attempt expired or was already used. Start again." };
    return this.completeAuthorization(match[0], query, redirectUri);
  }

  async getAccessToken(): Promise<string | null> {
    await this.ensureLoaded();
    if (!this.record || !this.record.refreshToken || !this.record.clientId || !this.record.scopes.includes("chatgpt.tokens.use.direct")) return null;
    if (this.record.accessToken && this.record.expiresAt && this.record.expiresAt - this.now() > REFRESH_EARLY_MS) return this.record.accessToken;
    if (!this.refreshInFlight) this.refreshInFlight = this.refresh().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async refresh(): Promise<string | null> {
    const lockPath = `${this.options.path}.refresh.lock`;
    let lock;
    let rotationMayHaveOccurred = false;
    try {
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      const started = Date.now();
      while (!lock) {
        try { lock = await open(lockPath, "wx", 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try { if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await unlink(lockPath); }
          catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
          if (Date.now() - started > 12_000) return null;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      await lock.writeFile(`${process.pid}\n${this.now()}`);
      const saved = await this.vault.load();
      if (saved === null) return null;
      const latest = JSON.parse(saved) as CredentialRecord;
      this.record = latest;
      if (latest.accessToken && latest.expiresAt && latest.expiresAt - this.now() > REFRESH_EARLY_MS) return latest.accessToken;
      if (!latest.refreshToken || !latest.clientId) return null;
      const current = latest;
      const response = await this.fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: current.clientId!, refresh_token: current.refreshToken!, resource: RESOURCE }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          this.record = { ...current, accessToken: null, refreshToken: null, expiresAt: null };
          await this.persist();
        }
        return null;
      }
      rotationMayHaveOccurred = true;
      const data = await response.json() as TokenResponse;
      if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") throw new Error("incomplete refresh");
      const nextScopes = data.scope === undefined ? current.scopes : scopes(data.scope);
      if (!nextScopes.includes("chatgpt.tokens.use.direct")) {
        this.record = { ...current, accessToken: null, refreshToken: null, expiresAt: null, scopes: nextScopes };
        await this.persist();
        return null;
      }
      this.record = { ...current, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: this.now() + data.expires_in * 1000, scopes: nextScopes };
      await this.persist();
      return this.record.accessToken;
    } catch {
      if (rotationMayHaveOccurred && this.record) this.record = { ...this.record, accessToken: null, refreshToken: null, expiresAt: null };
      return null;
    }
    finally {
      if (lock) {
        await lock.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
    }
  }

  async getStatus(): Promise<{ connected: boolean; subject: string | null; expiresAt: number | null; scopes: string[] }> {
    await this.ensureLoaded();
    const record = this.record!;
    return { connected: this.isConnectedRecord(record), subject: record.subject, expiresAt: record.expiresAt, scopes: [...record.scopes] };
  }

  private isConnectedRecord(record: CredentialRecord): boolean {
    return Boolean(record.clientId && record.subject && record.refreshToken && record.scopes.includes("chatgpt.tokens.use.direct"));
  }

  /** Stable cache partition that reveals neither the provider token nor raw subject. */
  async getAccountId(): Promise<string | null> {
    await this.ensureLoaded();
    const record = this.record!;
    if (!this.isConnectedRecord(record)) return null;
    return createHash("sha256").update(`${ISSUER}\0${record.clientId}\0${record.subject}`).digest("hex");
  }

  async isConnected(): Promise<boolean> {
    await this.ensureLoaded();
    return this.isConnectedRecord(this.record!);
  }

  async disconnect(): Promise<{ revoked: boolean }> {
    await this.ensureLoaded();
    this.disconnecting = true;
    this.generation++;
    this.flows.clear();
    try {
      if (this.refreshInFlight) await this.refreshInFlight;
      const current = this.record!;
      let revoked = false;
      if (current.refreshToken && current.clientId) {
      try {
        const discovery = await this.fetcher(OIDC_CONFIGURATION, { signal: AbortSignal.timeout(5000) });
        if (!discovery.ok) throw new Error("metadata unavailable");
        const metadata = await discovery.json() as { revocation_endpoint?: unknown };
        const endpoint = typeof metadata.revocation_endpoint === "string" ? new URL(metadata.revocation_endpoint) : null;
        if (!endpoint || endpoint.protocol !== "https:" || endpoint.hostname !== "auth.openai.com" || endpoint.port || endpoint.username || endpoint.password || endpoint.hash) throw new Error("invalid endpoint");
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await this.fetcher(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: current.refreshToken, token_type_hint: "refresh_token", client_id: current.clientId }), signal: AbortSignal.timeout(5000) });
            if (response.status === 200) { revoked = true; break; }
            if (response.status < 500 && response.status !== 429) break;
          } catch { /* bounded retry while the refresh token remains available */ }
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      } catch { /* locally clear regardless; caller receives the unconfirmed status */ }
      } else revoked = true;
      this.record = { ...current, accessToken: null, refreshToken: null, idToken: null, expiresAt: null, scopes: [] };
      await this.persist();
      return { revoked };
    } finally { this.disconnecting = false; }
  }
}
