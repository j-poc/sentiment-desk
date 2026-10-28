import { type FormEvent, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { cloudBackendConfigured, cloudSupabase } from "../lib/supabase.js";
import { CloudResearchDesk } from "./CloudResearchDesk.js";

export function CloudCoreApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!cloudSupabase) return;
    let active = true;
    const { data: { subscription } } = cloudSupabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession);
    });
    void cloudSupabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setMessage("Your cloud session could not be restored. Sign in again.");
      setSession(data.session);
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  const sendSignInLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!cloudSupabase || busy) return;
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    setBusy(true);
    setMessage(null);
    const { error } = await cloudSupabase.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: window.location.origin },
    });
    setMessage(error
      ? "The sign-in link could not be sent. Try again later."
      : "Check your email for the secure sign-in link.");
    setBusy(false);
  };

  const signOut = async () => {
    if (!cloudSupabase || busy) return;
    setBusy(true);
    const { error } = await cloudSupabase.auth.signOut();
    setMessage(error ? "Sign out could not be completed. Retry." : null);
    setBusy(false);
  };

  return <main className="min-h-screen bg-[#090a0b] px-3 py-4 text-white/80 sm:px-5 sm:py-6">
    <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
      <div>
        <p className="micro">SENTIMENT DESK</p>
        <p className="mt-1 text-[10px] text-white/40">Company research</p>
      </div>
      {session ? <div className="flex items-center gap-2">
        <span className="hidden max-w-52 truncate text-[10px] text-white/45 sm:inline">{session.user.email}</span>
        <button type="button" disabled={busy} onClick={() => void signOut()} className="rounded border border-white/15 px-2.5 py-1.5 text-[10px] text-white/65 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-50">Sign out</button>
      </div> : null}
    </div>

    {!cloudBackendConfigured || !cloudSupabase ? <section className="panel mx-auto mt-8 max-w-2xl p-5">
      <p className="micro">RESEARCH DESK</p>
      <h1 className="mt-2 text-lg font-semibold text-white/85">We can’t open your research desk right now</h1>
      <p className="mt-2 text-sm leading-6 text-white/55">Your saved work has not been changed. Please try again later.</p>
    </section> : !session ? <section className="panel mx-auto mt-8 max-w-md p-5">
      <p className="micro">SECURE SIGN IN</p>
      <h1 className="mt-2 text-lg font-semibold text-white/85">Open your cloud research desk</h1>
      <p className="mt-2 text-xs leading-5 text-white/50">Your saved issuers, decisions, and follow baselines are scoped to your authenticated account.</p>
      <form className="mt-4 space-y-3" onSubmit={(event) => void sendSignInLink(event)}>
        <label className="block text-[11px] text-white/55">Email address
          <input autoComplete="email" inputMode="email" type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/85 outline-none focus-visible:border-emerald-300/50 focus-visible:ring-2 focus-visible:ring-emerald-300/25" />
        </label>
        <button type="submit" disabled={busy || !email.trim()} className="w-full rounded-md border border-emerald-300/25 bg-emerald-300/[0.08] px-3 py-2 text-xs text-emerald-100/85 hover:bg-emerald-300/[0.14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-45">{busy ? "Sending link…" : "Email me a sign-in link"}</button>
      </form>
      {message && <p className="mt-3 text-xs text-amber-100/75" role="status">{message}</p>}
    </section> : <>
      {message && <p className="mx-auto mt-3 max-w-6xl text-xs text-amber-100/75" role="status">{message}</p>}
      <CloudResearchDesk key={session.user.id} userId={session.user.id} />
    </>}
  </main>;
}
