import { createHash } from "node:crypto";

export type AssetReader = (path: string) => Uint8Array | null;

export function uiAssetReferences(html: string): string[] {
  const assets = [...html.matchAll(/(?:src|href)\s*=\s*(["'])([^"']+\.(?:js|css))\1/gu)]
    .map((match) => match[2]!);
  if (!assets.some((asset) => asset.endsWith(".js")) || !assets.some((asset) => asset.endsWith(".css"))) {
    throw new Error("served_ui_js_css_assets_missing");
  }
  if (new Set(assets).size !== assets.length || assets.some((asset) => !/^\/assets\/[A-Za-z0-9._-]+\.(?:js|css)$/u.test(asset))) {
    throw new Error("served_ui_asset_reference_invalid");
  }
  return assets;
}

/** Verify that a route serves the exact HTML and JS/CSS bundle produced locally. */
export function verifyServedUiBuild(
  servedHtml: string,
  builtHtml: string,
  readServedAsset: AssetReader,
  readBuiltAsset: AssetReader,
): { fingerprint: string; assets: string[] } {
  if (servedHtml !== builtHtml) throw new Error("served_ui_html_differs_from_build");
  const assets = uiAssetReferences(servedHtml);

  const digests = assets.sort().map((asset) => {
    const served = readServedAsset(asset);
    const built = readBuiltAsset(asset);
    if (!served || !built) throw new Error("served_ui_asset_missing");
    const servedDigest = createHash("sha256").update(served).digest("hex");
    const builtDigest = createHash("sha256").update(built).digest("hex");
    if (servedDigest !== builtDigest) throw new Error("served_ui_asset_differs_from_build");
    return { asset, sha256: servedDigest };
  });
  return { fingerprint: createHash("sha256").update(JSON.stringify({ html: builtHtml, assets: digests })).digest("hex"), assets };
}
