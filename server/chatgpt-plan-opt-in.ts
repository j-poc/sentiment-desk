export const CHATGPT_PLAN_OPT_IN_KEY = "chatgpt-plan:user-opt-in:v1";

type OptInStore = { setKv(key: string, value: string): void };

export type ChatGPTPlanAuthPort = {
  isConnected(): Promise<boolean>;
  beginAuthorization(redirectUri: string): Promise<{ flowId: string; authorizationUrl: string }>;
  completeCallback(query: URLSearchParams, redirectUri: string): Promise<{ ok: boolean; message: string }>;
  disconnect(): Promise<{ revoked: boolean }>;
};

/** Public classifier authority is session-only; a saved grant never resumes at startup. */
export function createChatGPTPlanOptIn(store: OptInStore) {
  let publicClassifierActive = false;
  let privateAnalysisAuthorizationKnown = false;
  let explicitConnectionSucceededThisSession = false;
  let privateAnalysisBlockedByDisconnect = false;

  const disable = (): boolean => {
    publicClassifierActive = false;
    privateAnalysisAuthorizationKnown = false;
    explicitConnectionSucceededThisSession = false;
    privateAnalysisBlockedByDisconnect = true;
    try {
      store.setKv(CHATGPT_PLAN_OPT_IN_KEY, "0");
      return true;
    } catch {
      // Runtime authority is removed even if durable storage has failed.
      return false;
    }
  };

  return {
    isEnabled: () => publicClassifierActive,
    hasSuccessfulAuthorizationThisSession: () => explicitConnectionSucceededThisSession,
    canAuthorizePrivateAnalysis: () => !privateAnalysisBlockedByDisconnect,
    /** Persist and enable only after explicit Activate has verified connection and model access. */
    enable(): boolean {
      if (!explicitConnectionSucceededThisSession || privateAnalysisBlockedByDisconnect) return false;
      try {
        store.setKv(CHATGPT_PLAN_OPT_IN_KEY, "1");
        publicClassifierActive = true;
        return true;
      } catch {
        publicClassifierActive = false;
        return false;
      }
    },
    disable,
    markPrivateAnalysisAuthorization(connected: boolean): void {
      privateAnalysisAuthorizationKnown = connected && !privateAnalysisBlockedByDisconnect;
    },
    wrapAuth(auth: ChatGPTPlanAuthPort, hooks: { onConnected?: () => void; onDisconnected?: () => void } = {}): ChatGPTPlanAuthPort {
      return {
        isConnected: () => publicClassifierActive || privateAnalysisAuthorizationKnown
          ? auth.isConnected()
          : Promise.resolve(false),
        beginAuthorization: (redirectUri) => auth.beginAuthorization(redirectUri),
        async completeCallback(query, redirectUri) {
          const result = await auth.completeCallback(query, redirectUri);
          if (result.ok) {
            explicitConnectionSucceededThisSession = true;
            privateAnalysisBlockedByDisconnect = false;
            privateAnalysisAuthorizationKnown = true;
            hooks.onConnected?.();
          } else {
            explicitConnectionSucceededThisSession = false;
            privateAnalysisAuthorizationKnown = false;
          }
          return result;
        },
        async disconnect() {
          disable();
          try {
            return await auth.disconnect();
          } finally {
            hooks.onDisconnected?.();
          }
        },
      };
    },
  };
}

export type ChatGPTPlanPrivateSessionPolicy = Pick<
  ReturnType<typeof createChatGPTPlanOptIn>,
  "canAuthorizePrivateAnalysis" | "hasSuccessfulAuthorizationThisSession" | "markPrivateAnalysisAuthorization"
>;

/** A saved credential alone is never enough to authorize selected private-note analysis. */
export async function verifyPrivatePlanSessionAccess(
  policy: ChatGPTPlanPrivateSessionPolicy,
  auth: Pick<ChatGPTPlanAuthPort, "isConnected">,
  checkModelAccess: () => Promise<boolean>,
): Promise<{ sessionAuthorized: boolean; connected: boolean; modelAvailable: boolean }> {
  if (!policy.canAuthorizePrivateAnalysis() || !policy.hasSuccessfulAuthorizationThisSession()) {
    return { sessionAuthorized: false, connected: false, modelAvailable: false };
  }
  const connected = await auth.isConnected();
  policy.markPrivateAnalysisAuthorization(connected);
  const modelAvailable = connected ? await checkModelAccess() : false;
  return { sessionAuthorized: true, connected, modelAvailable };
}
