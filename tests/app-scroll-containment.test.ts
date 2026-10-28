/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const stylesheet = document.createElement("style");
stylesheet.textContent = readFileSync(join(process.cwd(), "web/src/styles.css"), "utf8");
document.head.append(stylesheet);

afterEach(() => {
  document.documentElement.style.cssText = "";
  document.body.style.cssText = "";
});

describe("application scroll boundary", () => {
  it("keeps viewport scrolling inside the research pane", () => {
    const root = document.createElement("div");
    root.id = "root";
    const pane = document.createElement("main");
    pane.className = "research-scroll";
    root.append(pane);
    document.body.append(root);

    expect(getComputedStyle(document.documentElement).overflow).toBe("hidden");
    expect(getComputedStyle(document.body).overflow).toBe("hidden");
    expect(getComputedStyle(root).overflow).toBe("hidden");
    expect(getComputedStyle(pane).overscrollBehaviorY).toBe("contain");

    root.remove();
  });
});
