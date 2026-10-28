import { useEffect, useRef, useState } from "react";
import type { CompanyFundamentalsView } from "../../../shared/company-fundamentals.js";
import type { SecIssuerDirectoryEntry } from "../../../shared/sec-issuer-directory.js";
import { getSecIssuerDirectory, refreshSecIssuerDirectory } from "../lib/api.js";
import { tradingViewEmbedDocument, tradingViewSymbol } from "./CloudTradingViewChart.js";

function normalizedCik(value: string | null): string | null {
  const candidate = value?.trim() ?? "";
  if (!/^\d{1,10}$/.test(candidate) || Number(candidate) === 0) return null;
  return candidate.padStart(10, "0");
}

export function exactSecIssuerMatch(
  entries: readonly SecIssuerDirectoryEntry[],
  ticker: string,
  cik: string,
): SecIssuerDirectoryEntry | null {
  const matches = entries.filter((entry) => entry.ticker.toUpperCase() === ticker.toUpperCase() && entry.cik === cik);
  return matches.length === 1 ? matches[0]! : null;
}

export function SecVerifiedTradingViewChart({
  companyId,
  companyName,
  ticker,
  cik,
  onRefreshFacts,
}: {
  companyId: string;
  companyName: string;
  ticker: string;
  cik: string | null;
  onRefreshFacts: () => Promise<CompanyFundamentalsView | null>;
}) {
  const [exchange, setExchange] = useState<string | null>(null);
  const [identityCik, setIdentityCik] = useState<string | null>(null);
  const [verifiedCompanyId, setVerifiedCompanyId] = useState<string | null>(null);
  const [verifiedTicker, setVerifiedTicker] = useState<string | null>(null);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);
  const [loadedSymbol, setLoadedSymbol] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const verificationSequence = useRef(0);
  const currentCompanyKey = `${companyId}:${ticker.toUpperCase()}`;
  const currentCompanyKeyRef = useRef(currentCompanyKey);
  currentCompanyKeyRef.current = currentCompanyKey;
  const currentCikRef = useRef(normalizedCik(cik));
  currentCikRef.current = normalizedCik(cik);
  const verifiedContextIsCurrent = verifiedCompanyId === companyId && verifiedTicker === ticker.toUpperCase()
    && (!normalizedCik(cik) || normalizedCik(cik) === identityCik);
  const symbol = verifiedContextIsCurrent && exchange ? tradingViewSymbol(ticker, exchange) : null;

  useEffect(() => {
    verificationSequence.current += 1;
    setExchange(null);
    setIdentityCik(null);
    setVerifiedCompanyId(null);
    setVerifiedTicker(null);
    setRetrievedAt(null);
    setLoadedSymbol(null);
    setChecking(false);
    setMessage(null);
  }, [companyId, ticker]);

  const verifyListing = async () => {
    if (checking) return;
    const requestCompanyKey = currentCompanyKey;
    const requestSequence = ++verificationSequence.current;
    const isCurrentRequest = () => verificationSequence.current === requestSequence
      && currentCompanyKeyRef.current === requestCompanyKey;
    setChecking(true);
    setMessage(null);
    setExchange(null);
    setIdentityCik(null);
    setRetrievedAt(null);
    setLoadedSymbol(null);
    try {
      const facts = normalizedCik(cik) ? null : await onRefreshFacts();
      const selectedCik = normalizedCik(cik) ?? normalizedCik(facts?.facts[0]?.cik ?? null);
      if (!isCurrentRequest()) return;
      const latestCik = currentCikRef.current;
      if (latestCik && selectedCik !== latestCik) {
        setMessage("The selected SEC facts changed while the chart identity was being checked. Verify the company again.");
        return;
      }
      if (!selectedCik || facts?.facts.some((fact) => normalizedCik(fact.cik) !== selectedCik)) {
        setMessage("SEC company facts did not confirm one company identity, so the chart was not opened.");
        return;
      }

      let directory = await getSecIssuerDirectory(ticker);
      if (!isCurrentRequest()) return;
      if (directory.freshness !== "current" || !directory.receipt) {
        await refreshSecIssuerDirectory();
        if (!isCurrentRequest()) return;
        directory = await getSecIssuerDirectory(ticker);
      }
      if (!isCurrentRequest()) return;
      if (directory.freshness !== "current" || !directory.receipt) {
        setMessage("The SEC company list is temporarily unavailable. Previously saved research is unchanged.");
        return;
      }

      const match = exactSecIssuerMatch(directory.rows, ticker, selectedCik);
      if (!match?.exchange) {
        setMessage("The current SEC company list did not confirm this ticker and CIK together with a supported exchange.");
        return;
      }
      if (!tradingViewSymbol(ticker, match.exchange)) {
        setMessage(`The SEC lists ${match.exchange}, but this chart does not support that exchange mapping.`);
        return;
      }
      setExchange(match.exchange);
      setIdentityCik(selectedCik);
      setVerifiedCompanyId(companyId);
      setVerifiedTicker(ticker.toUpperCase());
      setRetrievedAt(directory.receipt.retrievedAt);
    } catch {
      if (isCurrentRequest()) setMessage("SEC identity could not be verified. Saved company research is unchanged.");
    } finally {
      if (isCurrentRequest()) setChecking(false);
    }
  };

  return <section className="panel overflow-hidden" aria-labelledby={`sec-verified-chart-${companyId}`}>
    <div className="panel-head flex-wrap gap-2">
      <h2 id={`sec-verified-chart-${companyId}`} className="micro m-0 p-0">SHARE-PRICE CHART</h2>
      <span className="text-[10px] text-white/45">12 months · daily · delayed quotes</span>
    </div>
    {!symbol ? <div className="space-y-3 p-4">
      <p className="m-0 text-xs leading-5 text-white/60">The chart opens only after the saved SEC company facts and current SEC ticker list confirm the same CIK, ticker, and exchange.</p>
      <button type="button" onClick={() => void verifyListing()} disabled={checking} className="rounded border border-emerald-300/25 bg-emerald-300/[0.07] px-3 py-2 text-[11px] text-emerald-100/85 hover:bg-emerald-300/[0.12] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-45">
        {checking ? "Verifying with the SEC…" : "Verify issuer and prepare chart"}
      </button>
      {message && <p className="m-0 text-xs leading-5 text-amber-100/75" role="status">{message}</p>}
    </div> : <>
      <p className="px-4 pt-3 text-[10px] leading-4 text-white/45">SEC identity verified: CIK {identityCik} · {exchange} · list checked {retrievedAt ? new Date(retrievedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "time unavailable"}. TradingView supplies this display-only chart. Quotes are exchange-delayed, not real time. Loading shares your IP address and selected ticker with TradingView; TradingView says its widgets also track the page URL. This chart cannot read your model API keys. <a className="underline underline-offset-2" href="https://www.tradingview.com/widget-docs/faq/data/" target="_blank" rel="noreferrer">Data details</a> · <a className="underline underline-offset-2" href="https://www.tradingview.com/widget-docs/faq/general/" target="_blank" rel="noreferrer">Privacy details</a></p>
      {symbol && <div className="px-4 pb-3">
        <button type="button" onClick={() => setLoadedSymbol(symbol)} className="rounded border border-white/15 px-3 py-2 text-[10px] text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
          {loadedSymbol === symbol ? "Reload chart" : "Load chart from TradingView"}
        </button>
        {loadedSymbol === symbol && <iframe
          key={symbol}
          title={`${companyName} (${ticker}) delayed share-price chart by TradingView`}
          srcDoc={tradingViewEmbedDocument(symbol)}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="mt-3 block h-[380px] w-full border-0 bg-[#090a0b] sm:h-[460px]"
        />}
        <p className="mt-3 text-[10px] text-white/40">If the chart does not appear, <a href={`https://www.tradingview.com/symbols/${symbol.replace(":", "-")}/`} target="_blank" rel="noreferrer" className="text-emerald-100/65 underline underline-offset-2">open {ticker} on TradingView</a>.</p>
      </div>}
      <button type="button" onClick={() => void verifyListing()} disabled={checking} className="border-t border-white/[0.06] px-4 py-2 text-[10px] text-white/45 underline underline-offset-2 hover:text-white/70 disabled:opacity-45">
        {checking ? "Rechecking SEC identity…" : "Recheck SEC identity"}
      </button>
      {message && <p className="px-4 pb-3 text-xs leading-5 text-amber-100/75" role="status">{message}</p>}
    </>}
  </section>;
}
