import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

function isAllowedSupabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return true;
    return import.meta.env.DEV && parsed.protocol === "http:" && parsed.port.length > 0
      && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
      && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export const cloudBackendConfigured = isAllowedSupabaseUrl(url) && publishableKey.length > 0;

/** Browser client is intentionally restricted to the public key and user JWT/RLS. */
export const cloudSupabase = cloudBackendConfigured
  ? createClient(url, publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  : null;

export async function cloudFunctionErrorCode(error: unknown): Promise<string | null> {
  const context = error != null && typeof error === "object" && "context" in error
    ? (error as { context?: unknown }).context : null;
  if (!(context instanceof Response)) return null;
  try {
    const body = await context.clone().json() as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}
