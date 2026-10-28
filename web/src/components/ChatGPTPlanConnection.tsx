import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, getJSON, requestJSON } from "../lib/api.js";

type ConnectionStatus = {
  configured: boolean;
  connected: boolean;
  modelAvailable: boolean | null;
  ready: boolean;
  blockedReason: string | null;
  sources: string[];
  dailyRequestLimit: number;
  dailyByteLimit: number;
  usage: { requests: number; reservedRequests: number; requestBytes: number; unknownOutcomes: number };
};

export function chatGPTPlanHeading(
  status: Pick<ConnectionStatus, "configured" | "connected" | "modelAvailable" | "ready"> | null,
  loading = false,
): string {
  if (loading) return "Checking account connection…";
  if (status == null) return "Luna access status unavailable";
  if (!status.configured) return "Luna access is unavailable right now";
  if (!status.connected) return "Connect your ChatGPT plan";
  if (status.modelAvailable === false) return "GPT-6 Luna is unavailable on this ChatGPT plan";
  if (status.modelAvailable === null) return "Checking GPT-6 Luna access";
  if (!status.ready) return "GPT-6 Luna is paused";
  return "GPT-6 Luna is ready";
}

function connectionCopy(status: ConnectionStatus | null): string {
  if (status == null) return "Access could not be confirmed. No source record was sent to GPT-6 Luna. Refresh status to try again.";
  if (!status.configured) return "Luna access is unavailable in this version of the Desk. No source record was sent.";
  if (!status.connected) {
    return `Connect your ChatGPT account to classify eligible public source items with GPT-6 Luna. You will review the access request before anything is sent. The Desk allows at most ${status.dailyRequestLimit} classification${status.dailyRequestLimit === 1 ? "" : "s"} per UTC day; ChatGPT plan limits are separate.`;
  }
  if (status.modelAvailable === false) {
    return "This ChatGPT account does not currently provide GPT-6 Luna. No source record was classified.";
  }
  if (status.modelAvailable === null) {
    return "Your ChatGPT connection is saved, but GPT-6 Luna access has not been verified. No source record will be sent until access is confirmed.";
  }
  if (!status.ready) {
    return "Access is connected but not ready. Verify GPT-6 Luna access to resume. This check does not send source text.";
  }
  return `GPT-6 Luna can classify eligible public source items. The Desk allows at most ${status.dailyRequestLimit} classification${status.dailyRequestLimit === 1 ? "" : "s"} per UTC day. ChatGPT plan limits are separate.`;
}

export function ChatGPTPlanConnection() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getJSON<ConnectionStatus>("/api/chatgpt-plan/status");
      setStatus(next);
      setError(null);
    } catch {
      setError("Luna access status is unavailable. No source record was sent.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const update = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const result = await requestJSON<{ authorizationUrl: string }>("/api/chatgpt-plan/connect", { method: "POST" });
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof ApiRequestError && cause.code === "external_requests_disabled"
        ? "Live classification is paused. No source record was sent."
        : cause instanceof ApiRequestError && cause.code === "loopback_only"
          ? "Luna access is unavailable in this version of the Desk."
          : cause instanceof ApiRequestError && cause.code === "chatgpt_sign_in_unavailable"
            ? "This device could not safely open ChatGPT sign-in. Unlock it and try again."
          : "ChatGPT sign-in could not be started. No source record was sent; retry in a moment.");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setError(null);
    try {
      const result = await requestJSON<{ revoked: boolean }>("/api/chatgpt-plan/disconnect", { method: "POST" });
      await refresh();
      if (!result.revoked) setError("The app cleared its local connection, but OpenAI did not confirm remote token revocation.");
    } catch {
      setError("The local ChatGPT connection could not be cleared. Classification remains paused until its status is confirmed.");
    } finally { setBusy(false); }
  };

  const resume = async () => {
    setBusy(true); setError(null);
    try {
      const result = await requestJSON<{ ready: boolean; blockedReason: string | null }>("/api/chatgpt-plan/activate", { method: "POST" });
      await refresh();
      if (!result.ready) setError("GPT-6 Luna access could not be verified. No source record was sent.");
    } catch (cause) {
      setError(cause instanceof ApiRequestError && cause.code === "external_requests_disabled"
        ? "Live classification is paused. No source record was sent."
        : "GPT-6 Luna access could not be verified. No source record was sent.");
    } finally { setBusy(false); }
  };

  return (
    <section className="chatgpt-plan-connection" aria-labelledby="chatgpt-plan-heading">
      <div className="chatgpt-plan-connection-main">
        <div className="min-w-0">
          <p className="micro">GPT-6 LUNA · CHATGPT PLAN</p>
          <h3 id="chatgpt-plan-heading">{chatGPTPlanHeading(status, loading)}</h3>
          <p className="chatgpt-plan-connection-copy">
            {connectionCopy(status)}
          </p>
          {status && <p className="chatgpt-plan-connection-usage" role="status">
            {status.usage.requests} of {status.dailyRequestLimit} classification requests used today
            {status.usage.unknownOutcomes > 0 ? ` · ${status.usage.unknownOutcomes} result${status.usage.unknownOutcomes === 1 ? "" : "s"} still being checked` : ""}
          </p>}
          <p className="chatgpt-plan-connection-disclosure">
            ChatGPT sign-in shares your name, email, and profile picture (if set) with the Desk. Allowing plan usage is a separate choice on OpenAI’s consent screen. The Desk cannot see your remaining plan allowance. Review your plan and purchase settings in ChatGPT Settings → Usage. Only public source text is eligible for this chart; private notes require a separate item-specific confirmation.
          </p>
          <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Check ChatGPT plan usage</a>
        </div>
        <div className="chatgpt-plan-connection-actions">
            {status?.connected
            ? <>
              {!status.ready && <button type="button" disabled={busy || !status.configured || loading} onClick={() => void resume()}>{busy ? "Verifying…" : "Verify access and resume"}</button>}
              <button type="button" disabled={busy || !status.configured} onClick={() => void disconnect()}>{busy ? "Working…" : "Disconnect"}</button>
            </>
            : <button type="button" disabled={busy || loading || !status?.configured} onClick={() => void connect()}>{busy ? "Opening sign-in…" : "Continue with ChatGPT"}</button>}
          <button type="button" className="chatgpt-plan-refresh" disabled={loading || busy} onClick={() => void refresh()}>Refresh status</button>
        </div>
      </div>
      {error && <p className="chatgpt-plan-connection-error" role="alert">{error}</p>}
    </section>
  );
}
