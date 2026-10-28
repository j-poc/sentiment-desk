import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalRequestPausedError, installExternalRequestGate } from "../server/external-request-gate.js";

afterEach(() => vi.unstubAllGlobals());

describe("external request admission", () => {
  it("allows only authenticated-client loopback Hub reads while source requests are paused", async () => {
    const network = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", network);
    const uninstall = installExternalRequestGate(() => false);
    try {
      for (const route of [
        "http://127.0.0.1:18765/api/v1/sources",
        "http://localhost:18765/api/v1/state?include_results=false",
        "http://127.0.0.1:18765/api/v1/receipts/123e4567-e89b-12d3-a456-426614174000?purpose=private_display",
      ]) {
        expect((await fetch(route)).ok).toBe(true);
      }
      await expect(fetch("http://127.0.0.1:18765/api/v1/receipts/123e4567-e89b-12d3-a456-426614174000?purpose=private_export"))
        .rejects.toBeInstanceOf(ExternalRequestPausedError);
      await expect(fetch("https://www.sec.gov/"))
        .rejects.toBeInstanceOf(ExternalRequestPausedError);
      await expect(fetch("http://127.0.0.1:18765/api/v1/profiles", { method: "POST" }))
        .rejects.toBeInstanceOf(ExternalRequestPausedError);
      expect(network).toHaveBeenCalledTimes(3);
    } finally {
      uninstall();
    }
  });

  it("blocks provider requests at the network boundary while external requests are paused", async () => {
    const network = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", network);
    const uninstall = installExternalRequestGate(() => false);
    try {
      for (const [url, method] of [
        ["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", "POST"],
        ["https://api.openai.com/v1/responses", "POST"],
        ["https://api.typesafe.ai/v1/models", "GET"],
      ] as const) {
        await expect(fetch(url, { method })).rejects.toBeInstanceOf(ExternalRequestPausedError);
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});
