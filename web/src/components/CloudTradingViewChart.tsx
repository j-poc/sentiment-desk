import { useState } from "react";

const EXCHANGE_PREFIX: Readonly<Record<string, string>> = {
  nasdaq: "NASDAQ",
  nyse: "NYSE",
  // TradingView's own symbol pages use the legacy AMEX prefix for NYSE
  // American listings (for example UEC). Leave NYSE Arca unsupported until
  // its exact symbol mapping is verified; exchange aliases can point at the
  // wrong security.
  "nyse mkt": "AMEX",
  "nyse american": "AMEX",
  otc: "OTC",
  "otc markets": "OTC",
};

export function tradingViewSymbol(ticker: string, exchange: string | null): string | null {
  // SEC ticker files use dashes for share classes, while TradingView uses dots
  // (e.g. BRK-B -> BRK.B). Keep other punctuation rejected by the allowlist.
  const normalizedTicker = ticker.trim().toUpperCase().replaceAll("-", ".");
  const prefix = exchange == null ? undefined : EXCHANGE_PREFIX[exchange.trim().toLowerCase()];
  if (!prefix || !/^[A-Z0-9][A-Z0-9.-]{0,13}$/.test(normalizedTicker)) return null;
  return `${prefix}:${normalizedTicker}`;
}

export function tradingViewEmbedDocument(symbol: string): string {
  if (!/^(NASDAQ|NYSE|AMEX|OTC):[A-Z0-9][A-Z0-9.-]{0,13}$/.test(symbol)) {
    throw new Error("Unsupported TradingView symbol.");
  }
  const [exchange, ticker] = symbol.split(":");
  const config = JSON.stringify({
    autosize: true,
    symbol,
    interval: "D",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "1",
    locale: "en",
    hide_side_toolbar: true,
    allow_symbol_change: false,
    calendar: false,
    save_image: false,
    range: "12M",
  }).replaceAll("<", "\\u003c");
  const symbolUrl = `https://www.tradingview.com/symbols/${exchange}-${ticker}/`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#090a0b}.tradingview-widget-container{height:100%;width:100%}.tradingview-widget-container__widget{height:calc(100% - 30px);width:100%}.tradingview-widget-copyright{height:30px;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;font:11px Arial,sans-serif;color:#8b949e}.tradingview-widget-copyright a{color:#8b949e;text-decoration:none}.trademark{margin-left:3px}</style></head><body><div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div><div class="tradingview-widget-copyright"><a href="${symbolUrl}" target="_blank" rel="noopener noreferrer">${ticker} chart</a><span class="trademark">by TradingView</span></div><script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>${config}</script></div></body></html>`;
}

export function CloudTradingViewChart({ ticker, exchange, companyName }: {
  ticker: string;
  exchange: string | null;
  companyName: string;
}) {
  const symbol = tradingViewSymbol(ticker, exchange);
  const sourceUrl = symbol ? `https://www.tradingview.com/symbols/${symbol.replace(":", "-")}/` : null;
  const [loadedSymbol, setLoadedSymbol] = useState<string | null>(null);

  return <section className="panel overflow-hidden" aria-labelledby="cloud-price-chart-heading">
    <div className="panel-head flex-wrap gap-2">
      <h2 id="cloud-price-chart-heading" className="micro m-0 p-0">SHARE-PRICE CONTEXT</h2>
      <span className="text-[10px] text-white/45">12 months · daily · exchange-delayed</span>
    </div>
    {!symbol ? <p className="p-4 text-xs leading-5 text-white/50">A stock chart is unavailable for this ticker and exchange.</p> : <>
      <p className="px-4 pt-3 text-[10px] leading-4 text-white/45">TradingView supplies this display-only chart. Stock quotes are exchange-delayed, not real time. Loading shares your IP address and the selected ticker with TradingView. TradingView says its widgets track the page URL too. The chart is isolated from this desk and cannot read your model API keys. <a className="underline underline-offset-2" href="https://www.tradingview.com/widget-docs/faq/data/" target="_blank" rel="noreferrer">Data details</a> · <a className="underline underline-offset-2" href="https://www.tradingview.com/widget-docs/faq/general/" target="_blank" rel="noreferrer">Privacy details</a></p>
      {loadedSymbol === symbol ? <iframe
        key={symbol}
        title={`${companyName} (${ticker}) delayed share-price chart by TradingView`}
        srcDoc={tradingViewEmbedDocument(symbol)}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        loading="lazy"
        className="mt-3 block h-[380px] w-full border-0 bg-[#090a0b] sm:h-[460px]"
      /> : <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <p className="m-0 text-xs text-white/60">{companyName} · {symbol}</p>
        <button type="button" onClick={() => setLoadedSymbol(symbol)} className="rounded border border-white/15 px-3 py-2 text-[10px] text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Load chart from TradingView</button>
      </div>}
      {sourceUrl && <p className="border-t border-white/[0.06] px-4 py-2 text-[10px] text-white/40">If the chart does not appear, <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-100/65 underline underline-offset-2">open {ticker} on TradingView</a>.</p>}
    </>}
  </section>;
}
