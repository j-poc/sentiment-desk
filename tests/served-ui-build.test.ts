import { describe, expect, it } from "vitest";
import { verifyServedUiBuild } from "../scripts/served-ui-build.js";

const html = '<script type="module" src="/assets/app-a1.js"></script><link rel="stylesheet" href="/assets/app-b2.css">';
const assets = new Map<string, Uint8Array>([
  ["/assets/app-a1.js", Buffer.from("current js bundle")],
  ["/assets/app-b2.css", Buffer.from("current css bundle")],
]);
const reader = (items: Map<string, Uint8Array>) => (path: string) => items.get(path) ?? null;

describe("served UI build verification", () => {
  it("fingerprints route HTML and exact built JS/CSS assets", () => {
    const result = verifyServedUiBuild(html, html, reader(assets), reader(assets));
    expect(result.assets).toEqual(["/assets/app-a1.js", "/assets/app-b2.css"]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects an old browser bundle even when the page shell is current", () => {
    const stale = new Map(assets);
    stale.set("/assets/app-a1.js", Buffer.from("old js bundle"));
    expect(() => verifyServedUiBuild(html, html, reader(stale), reader(assets)))
      .toThrow("served_ui_asset_differs_from_build");
  });

  it("rejects stale route HTML and incomplete asset references", () => {
    expect(() => verifyServedUiBuild("<html>old</html>", html, reader(assets), reader(assets)))
      .toThrow("served_ui_html_differs_from_build");
    expect(() => verifyServedUiBuild('<script src="/assets/app-a1.js"></script>', '<script src="/assets/app-a1.js"></script>', reader(assets), reader(assets)))
      .toThrow("served_ui_js_css_assets_missing");
  });
});
