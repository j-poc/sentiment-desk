import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGPTPlanAuth } from "../server/chatgpt-plan-auth";
import type { CredentialVault } from "../server/chatgpt-plan-credential-vault";

const ISSUER = "https://auth.openai.com";
const ALL_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REDIRECT = "http://127.0.0.1:1455/auth/callback";
const directoryPaths: string[] = [];
let now = Date.now();

async function setup(overrides: { issuer?: string; audience?: string; nonce?: string; scope?: string; status?: number; refreshStatus?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "chatgpt-plan-auth-")); directoryPaths.push(dir);
  const path = join(dir, "config", "chatgpt-auth.json");
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey); jwk.kid = "test-key"; jwk.alg = "RS256"; jwk.use = "sig";
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let refreshCount = 0;
  let codeData: Record<string, unknown> = {};
  let stored: string | null = null;
  let storedAtAuthorizationExchange: string | null = null;
  const vault: CredentialVault = { load: async () => stored, save: async value => { stored = value; } };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("jwks.json")) return Response.json({ keys: [jwk] });
    if (url.includes("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
    if (url.includes("oauth/revoke")) return new Response(null, { status: 200 });
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("grant_type") === "authorization_code") {
      storedAtAuthorizationExchange = stored;
      return new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", id_token: await idToken(keys.privateKey, { ...codeData, audience: codeData.audience ?? "issued-client" }), expires_in: 3600, token_type: "Bearer", scope: codeData.scope ?? ALL_SCOPES }), { status: overrides.status ?? 200 });
    }
    refreshCount++;
    if ((overrides.refreshStatus ?? 200) !== 200) return new Response(JSON.stringify({ error: "invalid_grant", detail: "refresh-secret" }), { status: overrides.refreshStatus });
    await new Promise(resolve => setTimeout(resolve, 3));
    return Response.json({ access_token: `access-next-${refreshCount}`, refresh_token: `refresh-next-${refreshCount}`, expires_in: 3600 });
  });
  const auth = new ChatGPTPlanAuth({ path, fetch, now: () => now, vault });
  return { auth, path, dir, keys, calls, fetch, vault, stored: () => stored, storedAtAuthorizationExchange: () => storedAtAuthorizationExchange, setCode: (v: Record<string, unknown>) => { codeData = v; }, refreshCount: () => refreshCount };
}

async function idToken(privateKey: CryptoKey, values: Record<string, unknown> = {}) {
  const nonce = typeof values.nonce === "string" ? values.nonce : lastNonce;
  const subject = typeof values.subject === "string" ? values.subject : undefined;
  const token = await new SignJWT({ nonce, ...(subject ? { sub: subject } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer((values.issuer as string | undefined) ?? ISSUER)
    .setAudience((values.audience as string | undefined) ?? "issued-client")
    .setSubject((values.subject as string | undefined) ?? "account-123")
    .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 3600).sign(privateKey);
  return token;
}
let lastNonce = "";

async function authorize(ctx: Awaited<ReturnType<typeof setup>>, mutate: (q: URLSearchParams) => void = () => {}) {
  const begun = await ctx.auth.beginAuthorization(REDIRECT);
  const authUrl = new URL(begun.authorizationUrl);
  lastNonce = authUrl.searchParams.get("nonce")!;
  const callback = new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "opaque-auth-code", client_id: "issued-client" }); mutate(callback);
  const result = await ctx.auth.completeAuthorization(begun.flowId, callback, REDIRECT);
  return { result, authUrl, callback };
}

afterEach(async () => { now = Date.now(); await Promise.all(directoryPaths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("ChatGPTPlanAuth", () => {
  it("uses S256 PKCE, validates a first-registration identity, and rotates credentials on refresh", async () => {
    const ctx = await setup();
    const { result, authUrl } = await authorize(ctx);
    expect(result.ok).toBe(true);
    expect(authUrl.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    const exchangeBody = new URLSearchParams(String(ctx.calls.find(c => c.url.includes("oauth/token"))?.init?.body));
    expect(exchangeBody.get("code_verifier")).toBeTruthy();
    expect(JSON.parse(ctx.stored()!).clientId).toBe("issued-client");
    now += 3_600_000;
    const [a, b, c] = await Promise.all([ctx.auth.getAccessToken(), ctx.auth.getAccessToken(), ctx.auth.getAccessToken()]);
    expect(a).toBe(b); expect(b).toBe(c); expect(ctx.refreshCount()).toBe(1);
    expect(await ctx.auth.getStatus()).toMatchObject({ connected: true, subject: "account-123" });
  });

  it("retries loading after a temporary OS credential-store failure", async () => {
    const ctx = await setup();
    const originalLoad = ctx.vault.load;
    let unavailableOnce = true;
    ctx.vault.load = async () => {
      if (unavailableOnce) { unavailableOnce = false; throw new Error("credential store locked"); }
      return originalLoad();
    };

    await expect(ctx.auth.beginAuthorization(REDIRECT)).rejects.toThrow("Saved ChatGPT connection could not be read safely.");
    const retry = await ctx.auth.beginAuthorization(REDIRECT);
    expect(new URL(retry.authorizationUrl).origin).toBe("https://auth.openai.com");
  });

  it("does not mix a stale first-registration client ID with the active account credentials", async () => {
    const ctx = await setup();
    const first = await ctx.auth.beginAuthorization(REDIRECT);
    const firstUrl = new URL(first.authorizationUrl);
    const stale = await ctx.auth.beginAuthorization(REDIRECT);
    const staleUrl = new URL(stale.authorizationUrl);
    lastNonce = firstUrl.searchParams.get("nonce")!;
    const firstCallback = new URLSearchParams({ state: firstUrl.searchParams.get("state")!, code: "first-code", client_id: "issued-client" });
    expect((await ctx.auth.completeAuthorization(first.flowId, firstCallback, REDIRECT)).ok).toBe(true);

    const staleCallback = new URLSearchParams({ state: staleUrl.searchParams.get("state")!, code: "stale-code", client_id: "other-issued-client" });
    expect((await ctx.auth.completeAuthorization(stale.flowId, staleCallback, REDIRECT)).ok).toBe(false);
    expect(JSON.parse(ctx.stored()!)).toMatchObject({ clientId: "issued-client", subject: "account-123", accessToken: "access-secret" });
    expect(ctx.calls.filter(call => call.url.includes("oauth/token") && new URLSearchParams(String(call.init?.body)).get("grant_type") === "authorization_code")).toHaveLength(1);
    expect(await ctx.auth.isConnected()).toBe(true);
  });

  it("rejects state, redirect, callback client ID, and unissued registration IDs", async () => {
    const ctx = await setup();
    const begun = await ctx.auth.beginAuthorization(REDIRECT);
    const url = new URL(begun.authorizationUrl);
    expect((await ctx.auth.completeAuthorization(begun.flowId, new URLSearchParams({ state: "wrong", code: "secret", client_id: "issued-client" }), REDIRECT)).ok).toBe(false);
    const second = await ctx.auth.beginAuthorization(REDIRECT); const u2 = new URL(second.authorizationUrl);
    expect((await ctx.auth.completeAuthorization(second.flowId, new URLSearchParams({ state: u2.searchParams.get("state")!, code: "x", client_id: "issued-client" }), "http://localhost:1455/auth/callback")).ok).toBe(false);
    const third = await ctx.auth.beginAuthorization(REDIRECT); const u3 = new URL(third.authorizationUrl);
    expect((await ctx.auth.completeAuthorization(third.flowId, new URLSearchParams({ state: u3.searchParams.get("state")!, code: "x", client_id: "dynamic_agent_client" }), REDIRECT)).ok).toBe(false);
    await authorize(ctx);
    const returning = await ctx.auth.beginAuthorization(REDIRECT); const u4 = new URL(returning.authorizationUrl);
    expect(u4.searchParams.get("client_id")).toBe("issued-client");
    const bad = new URLSearchParams({ state: u4.searchParams.get("state")!, code: "x", client_id: "different-client" });
    expect((await ctx.auth.completeAuthorization(returning.flowId, bad, REDIRECT)).ok).toBe(false);
  });

  it.each([
    ["nonce", { nonce: "wrong-nonce" }],
    ["audience", { audience: "wrong-client" }],
    ["issuer", { issuer: "https://evil.example" }],
    ["scope", { scope: "openid profile email offline_access resource.invoke" }],
  ])("does not enable auth on %s failure", async (_label, override) => {
    const ctx = await setup(); ctx.setCode(override as Record<string, unknown>);
    const { result } = await authorize(ctx);
    expect(result.ok).toBe(false);
    expect(await ctx.auth.getAccessToken()).toBeNull();
  });

  it("accepts a valid direct-plan grant when optional profile and email scopes are absent", async () => {
    const ctx = await setup();
    ctx.setCode({ scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct" });
    expect((await authorize(ctx)).result.ok).toBe(true);
    expect(await ctx.auth.isConnected()).toBe(true);
  });

  it("handles cancellation and revoked refresh, clears disconnected credentials, and never returns secrets in failures", async () => {
    const ctx = await setup({ refreshStatus: 400 });
    const begun = await ctx.auth.beginAuthorization(REDIRECT); const url = new URL(begun.authorizationUrl);
    const denied = await ctx.auth.completeAuthorization(begun.flowId, new URLSearchParams({ state: url.searchParams.get("state")!, error: "access_denied", error_description: "refresh-secret" }), REDIRECT);
    expect(denied).toEqual({ ok: false, message: "Sign-in was cancelled. You can try again when ready." });
    await authorize(ctx); now += 3_600_000;
    expect(await ctx.auth.getAccessToken()).toBeNull();
    expect(JSON.parse(ctx.stored()!).refreshToken).toBeNull();
    await ctx.auth.disconnect();
    expect(await ctx.auth.getAccessToken()).toBeNull();
    expect(await ctx.auth.getStatus()).toMatchObject({ connected: false, subject: "account-123" });
    expect(ctx.stored()).not.toContain("access-secret");
    expect(ctx.stored()).not.toContain("refresh-secret");
  });

  it("persists valid grants for restart and does not expose token material in callback failures", async () => {
    const ctx = await setup({ status: 500 });
    const outcome = await authorize(ctx);
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.message).not.toMatch(/secret|opaque-auth-code/);
    expect(await ctx.auth.getAccessToken()).toBeNull();
    expect(JSON.parse(ctx.stored()!)).toMatchObject({ clientId: "issued-client", refreshToken: null, accessToken: null });
    expect(JSON.parse(ctx.storedAtAuthorizationExchange()!).clientId).toBe("issued-client");
    expect(new URL((await ctx.auth.beginAuthorization(REDIRECT)).authorizationUrl).searchParams.get("client_id")).toBe("issued-client");
  });

  it("resolves callback by state, consumes it once, and revokes before local disconnect", async () => {
    const ctx = await setup();
    const begun = await ctx.auth.beginAuthorization(REDIRECT); const authUrl = new URL(begun.authorizationUrl);
    lastNonce = authUrl.searchParams.get("nonce")!;
    const callback = new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "opaque-auth-code", client_id: "issued-client" });
    expect((await ctx.auth.completeCallback(callback, REDIRECT)).ok).toBe(true);
    expect((await ctx.auth.completeCallback(callback, REDIRECT)).ok).toBe(false);
    expect(await ctx.auth.disconnect()).toEqual({ revoked: true });
    const revoke = ctx.calls.find(call => call.url.endsWith("oauth/revoke"));
    expect(revoke).toBeDefined();
    expect(new URLSearchParams(String(revoke!.init?.body)).get("token")).toBe("refresh-secret");
    expect(await ctx.auth.getAccessToken()).toBeNull();
  });

  it("serializes refresh-token rotation across auth instances sharing the local credential store", async () => {
    const ctx = await setup();
    await authorize(ctx);
    const second = new ChatGPTPlanAuth({ path: ctx.path, fetch: ctx.fetch, now: () => now, vault: ctx.vault });
    now += 3_600_000;
    const [firstToken, secondToken] = await Promise.all([ctx.auth.getAccessToken(), second.getAccessToken()]);
    expect(firstToken).toBe(secondToken);
    expect(ctx.refreshCount()).toBe(1);
  });

  it("exposes only a stable hashed cache partition for an authorized account", async () => {
    const ctx = await setup();
    await authorize(ctx);
    const firstId = await ctx.auth.getAccountId();
    const restored = new ChatGPTPlanAuth({ path: ctx.path, fetch: ctx.fetch, now: () => now, vault: ctx.vault });
    expect(firstId).toMatch(/^[a-f0-9]{64}$/);
    expect(firstId).not.toContain("account-123");
    expect(await restored.getAccountId()).toBe(firstId);
    expect(await restored.isConnected()).toBe(true);
  });

  it("does not let an in-flight callback reconnect after disconnect", async () => {
    const ctx = await setup();
    const begun = await ctx.auth.beginAuthorization(REDIRECT); const authUrl = new URL(begun.authorizationUrl);
    lastNonce = authUrl.searchParams.get("nonce")!;
    const callback = new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "opaque-auth-code", client_id: "issued-client" });
    const original = ctx.fetch.getMockImplementation()!;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    ctx.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (String(input).includes("oauth/token") && body.get("grant_type") === "authorization_code") await barrier;
      return original(input, init);
    });
    const pending = ctx.auth.completeCallback(callback, REDIRECT);
    await new Promise(resolve => setTimeout(resolve, 1));
    await ctx.auth.disconnect();
    release();
    expect((await pending).ok).toBe(false);
    expect(await ctx.auth.getAccessToken()).toBeNull();
    expect(await ctx.auth.isConnected()).toBe(false);
    expect(await ctx.auth.getStatus()).toMatchObject({ connected: false });
  });

  it("clears locally but reports unconfirmed remote revocation when provider revoke fails", async () => {
    const ctx = await setup();
    await authorize(ctx);
    ctx.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); ctx.calls.push({ url, init });
      if (url.includes("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
      if (url.includes("oauth/revoke")) return new Response(null, { status: 503 });
      return Response.json({});
    });
    expect(await ctx.auth.disconnect()).toEqual({ revoked: false });
    expect(ctx.calls.filter(call => call.url.endsWith("oauth/revoke"))).toHaveLength(3);
    expect(await ctx.auth.getAccessToken()).toBeNull();
  });
});
