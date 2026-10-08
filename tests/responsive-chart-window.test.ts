import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

describe("narrow saved-source window controls", () => {
  it("keeps all four timeframe buttons in a full-width grid with a dedicated label row", () => {
    const mobileRules = [...styles.matchAll(/@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*?)\n\}/g)]
      .map((match) => match[1] ?? "")
      .find((rules) => rules.includes(".chart-evidence-window")) ?? "";

    expect(mobileRules).toMatch(/\.chart-evidence-window\s*\{[^}]*display:\s*grid/);
    expect(mobileRules).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(mobileRules).toMatch(/\.chart-evidence-window-label\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(mobileRules).toMatch(/\.chart-evidence-window\s+\.chart-range-control\s*\{[^}]*width:\s*100%/);
    expect(mobileRules).toMatch(/\.chart-evidence-window\s+\.chart-range-control\s*\{[^}]*min-height:\s*32px/);
    expect(styles).not.toMatch(/@media\s*\(max-width:\s*360px\)\s*\{[^}]*chart-evidence-window-label\s*\{\s*display:\s*none/s);
  });
});
