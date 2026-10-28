import { describe, expect, it, vi } from "vitest";
import { ChatGPTPlanAuth } from "../server/chatgpt-plan-auth.js";
import { CHATGPT_PLAN_OPT_IN_KEY, createChatGPTPlanOptIn, verifyPrivatePlanSessionAccess } from "../server/chatgpt-plan-opt-in.js";

const REDIRECT = "http://127.0.0.1:1455/auth/callback";
const savedCredential = JSON.stringify({
  hostId: "urn:uuid:legacy", clientId: "issued-client", subject: "account-123",
  accessToken: "saved-access-token", refreshToken: "saved-refresh-token", idToken: "saved-id-token",
  expiresAt: Date.now() + 60_000,
  scopes: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
});

function store(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CHATGPT_PLAN_OPT_IN_KEY, initial);
  let failWrites = false;
  return {
    setKv: vi.fn((key: string, value: string) => {
      if (failWrites) throw new Error("storage unavailable");
      values.set(key, value);
    }),
    failWrites: (value: boolean) => { failWrites = value; },
    values,
  };
}

function authFixture(callbackOk = true) {
  return {
    isConnected: vi.fn(async () => true),
    beginAuthorization: vi.fn(async () => ({ flowId: "flow", authorizationUrl: "https://auth.invalid" })),
    completeCallback: vi.fn(async () => ({ ok: callbackOk, message: callbackOk ? "connected" : "sign-in cancelled" })),
    disconnect: vi.fn(async () => ({ revoked: true })),
  };
}

describe("ChatGPT plan public-classifier activation", () => {
  it("ignores a persisted grant at startup and does not inspect the saved credential or provider", async () => {
    const persisted = store("1");
    const policy = createChatGPTPlanOptIn(persisted);
    const auth = authFixture();
    const guardedAuth = policy.wrapAuth(auth);
    const modelCheck = vi.fn(async () => true);
    const classify = vi.fn(async () => "positive");

    expect(policy.isEnabled()).toBe(false);
    if (await guardedAuth.isConnected()) {
      if (await modelCheck()) await classify();
    }

    expect(auth.isConnected).not.toHaveBeenCalled();
    expect(modelCheck).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(persisted.values.get(CHATGPT_PLAN_OPT_IN_KEY)).toBe("1");
  });

  it("does not turn a canceled Connect attempt or an older saved credential into classifier authority", async () => {
    const persisted = store("1");
    const policy = createChatGPTPlanOptIn(persisted);
    const auth = authFixture(false);
    const guardedAuth = policy.wrapAuth(auth);
    const activate = vi.fn();
    const modelCheck = vi.fn();

    await guardedAuth.beginAuthorization("http://127.0.0.1:8794/auth/callback");
    const callback = await guardedAuth.completeCallback(new URLSearchParams("error=access_denied"), "http://127.0.0.1:8794/auth/callback");
    if (callback.ok) { await modelCheck(); activate(); }

    expect(callback.ok).toBe(false);
    expect(policy.isEnabled()).toBe(false);
    expect(policy.hasSuccessfulAuthorizationThisSession()).toBe(false);
    expect(policy.enable()).toBe(false);
    expect(await guardedAuth.isConnected()).toBe(false);
    expect(auth.isConnected).not.toHaveBeenCalled();
    expect(modelCheck).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(persisted.values.get(CHATGPT_PLAN_OPT_IN_KEY)).toBe("1");
    expect(persisted.setKv).not.toHaveBeenCalled();
  });

  it("never uses an older saved credential for private analysis after Connect is canceled", async () => {
    const vault = { load: vi.fn(async () => savedCredential), save: vi.fn(async () => {}) };
    const auth = new ChatGPTPlanAuth({ path: "/unused/chatgpt-plan.json", vault });
    const isConnected = vi.spyOn(auth, "isConnected");
    const policy = createChatGPTPlanOptIn(store("1"));
    const guardedAuth = policy.wrapAuth({
      isConnected: () => auth.isConnected(),
      beginAuthorization: uri => auth.beginAuthorization(uri),
      completeCallback: (query, uri) => auth.completeCallback(query, uri),
      disconnect: () => auth.disconnect(),
    });
    const begun = await guardedAuth.beginAuthorization(REDIRECT);
    const state = new URL(begun.authorizationUrl).searchParams.get("state")!;
    const callback = await guardedAuth.completeCallback(new URLSearchParams({ state, error: "access_denied" }), REDIRECT);
    isConnected.mockClear();
    const modelAccess = vi.fn(async () => true);
    const inference = vi.fn();

    const access = await verifyPrivatePlanSessionAccess(policy, auth, modelAccess);
    if (access.connected && access.modelAvailable) inference();

    expect(callback.ok).toBe(false);
    expect(access).toEqual({ sessionAuthorized: false, connected: false, modelAvailable: false });
    expect(isConnected).not.toHaveBeenCalled();
    expect(modelAccess).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
    expect(vault.load).toHaveBeenCalledOnce();
  });

  it("persists authority only after successful auth and an explicit Activate verification", async () => {
    const persisted = store();
    const policy = createChatGPTPlanOptIn(persisted);
    const auth = authFixture(true);
    const guardedAuth = policy.wrapAuth(auth);
    await guardedAuth.beginAuthorization("http://127.0.0.1:8794/auth/callback");
    expect(persisted.setKv).not.toHaveBeenCalled();

    const callback = await guardedAuth.completeCallback(new URLSearchParams("code=opaque"), "http://127.0.0.1:8794/auth/callback");
    expect(callback.ok).toBe(true);
    expect(policy.isEnabled()).toBe(false);
    expect(policy.hasSuccessfulAuthorizationThisSession()).toBe(true);
    expect(persisted.setKv).not.toHaveBeenCalled();

    expect(await guardedAuth.isConnected()).toBe(true);
    const modelCheck = vi.fn(async () => true);
    expect(await modelCheck()).toBe(true);
    expect(policy.enable()).toBe(true);
    expect(persisted.values.get(CHATGPT_PLAN_OPT_IN_KEY)).toBe("1");
    expect(policy.isEnabled()).toBe(true);
  });

  it("fails closed when activation cannot persist and when disconnect cannot clear a previous grant", async () => {
    const activationStore = store();
    const activationPolicy = createChatGPTPlanOptIn(activationStore);
    const activationAuth = activationPolicy.wrapAuth(authFixture(true));
    await activationAuth.completeCallback(new URLSearchParams("code=opaque"), "http://127.0.0.1:8794/auth/callback");
    activationStore.failWrites(true);
    expect(activationPolicy.enable()).toBe(false);
    expect(activationPolicy.isEnabled()).toBe(false);
    expect(activationPolicy.hasSuccessfulAuthorizationThisSession()).toBe(true);

    const persisted = store("1");
    const policy = createChatGPTPlanOptIn(persisted);
    const auth = authFixture();
    const guardedAuth = policy.wrapAuth(auth);
    persisted.failWrites(true);
    await guardedAuth.disconnect();

    expect(policy.isEnabled()).toBe(false);
    expect(policy.canAuthorizePrivateAnalysis()).toBe(false);
    expect(await guardedAuth.isConnected()).toBe(false);
    expect(auth.isConnected).not.toHaveBeenCalled();
    expect(auth.disconnect).toHaveBeenCalledOnce();

    const restarted = createChatGPTPlanOptIn(persisted);
    expect(restarted.isEnabled()).toBe(false);
    expect(await restarted.wrapAuth(auth).isConnected()).toBe(false);
    expect(restarted.canAuthorizePrivateAnalysis()).toBe(true);
  });

  it("blocks a credential left on disk after disconnect persistence fails, including after restart", async () => {
    let diskCredential: string | null = savedCredential;
    const vault = {
      load: vi.fn(async () => diskCredential),
      save: vi.fn(async (_value: string) => { throw new Error("credential store unavailable"); }),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("openid-configuration")
      ? Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" })
      : new Response(null, { status: 200 }));
    const auth = new ChatGPTPlanAuth({ path: "/unused/chatgpt-plan.json", vault, fetch: fetcher });
    const policy = createChatGPTPlanOptIn(store("1"));
    const guardedAuth = policy.wrapAuth({
      isConnected: () => auth.isConnected(),
      beginAuthorization: uri => auth.beginAuthorization(uri),
      completeCallback: (query, uri) => auth.completeCallback(query, uri),
      disconnect: () => auth.disconnect(),
    });

    await expect(guardedAuth.disconnect()).rejects.toThrow("ChatGPT credentials could not be saved securely.");
    expect(policy.canAuthorizePrivateAnalysis()).toBe(false);
    expect(diskCredential).toBe(savedCredential);

    const restartedAuth = new ChatGPTPlanAuth({ path: "/unused/chatgpt-plan.json", vault, fetch: fetcher });
    expect(await restartedAuth.isConnected()).toBe(true);
    const isConnected = vi.spyOn(restartedAuth, "isConnected");
    isConnected.mockClear();
    const restartedPolicy = createChatGPTPlanOptIn(store("1"));
    const modelAccess = vi.fn(async () => true);
    const inference = vi.fn();

    const access = await verifyPrivatePlanSessionAccess(restartedPolicy, restartedAuth, modelAccess);
    if (access.connected && access.modelAvailable) inference();

    expect(access).toEqual({ sessionAuthorized: false, connected: false, modelAvailable: false });
    expect(isConnected).not.toHaveBeenCalled();
    expect(modelAccess).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
  });

  it("allows private analysis after current-session authorization without activating public classification", async () => {
    const policy = createChatGPTPlanOptIn(store());
    const auth = authFixture();
    const guardedAuth = policy.wrapAuth(auth);
    await guardedAuth.completeCallback(new URLSearchParams("code=opaque"), REDIRECT);
    const modelAccess = vi.fn(async () => true);

    const access = await verifyPrivatePlanSessionAccess(policy, auth, modelAccess);

    expect(access).toEqual({ sessionAuthorized: true, connected: true, modelAvailable: true });
    expect(modelAccess).toHaveBeenCalledOnce();
    expect(policy.isEnabled()).toBe(false);
    expect(await guardedAuth.isConnected()).toBe(true);
  });
});
