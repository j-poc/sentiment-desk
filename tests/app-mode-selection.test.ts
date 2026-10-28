import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("app surface selection", () => {
  it("keeps local production builds on the sentiment desk and makes cloud deployment explicit", () => {
    const entry = readFileSync("web/src/main.tsx", "utf8");
    const deployment = JSON.parse(readFileSync("vercel.json", "utf8")) as { buildCommand: string };
    expect(entry).toContain('import.meta.env.VITE_APP_MODE ?? "local"');
    expect(deployment.buildCommand).toContain("VITE_APP_MODE=cloud");
  });
});
