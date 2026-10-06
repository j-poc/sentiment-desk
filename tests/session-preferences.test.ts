import { describe, expect, it } from "vitest";
import { readSessionPreference, writeSessionPreference } from "../web/src/lib/session-preferences.js";

describe("session preference fallbacks", () => {
  it("uses defaults when the browser denies session storage access", () => {
    expect(readSessionPreference("view", () => { throw new DOMException("blocked", "SecurityError"); })).toBeNull();
  });

  it("keeps navigation usable when storing a preference is denied", () => {
    expect(() => writeSessionPreference("view", "sources", () => { throw new DOMException("blocked", "SecurityError"); })).not.toThrow();
  });

  it("reads and writes preferences when storage is available", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    writeSessionPreference("view", "sources", () => storage);

    expect(readSessionPreference("view", () => storage)).toBe("sources");
  });
});
