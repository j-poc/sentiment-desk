const ACCESSION_RE = /^[0-9]{10}-[0-9]{2}-[0-9]{6}$/;
const DOCUMENT_RE = /^[A-Za-z0-9._-]{1,260}$/;

export function secFilingArchiveUrl(cik: string, accession: string, primaryDocument: string | null = null): string | null {
  if (!/^\d{10}$/.test(cik) || cik === "0000000000" || !ACCESSION_RE.test(accession)
    || (primaryDocument != null && !DOCUMENT_RE.test(primaryDocument))) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/${primaryDocument ?? "index.json"}`;
}

export function isValidSecFilingUrl(raw: string, accession: string, primaryDocument: string | null): boolean {
  if (!ACCESSION_RE.test(accession) || (primaryDocument != null && !DOCUMENT_RE.test(primaryDocument))) return false;
  try {
    const url = new URL(raw);
    const archivePrefix = "/Archives/edgar/data/";
    if (!url.pathname.startsWith(archivePrefix)) return false;
    const suffix = url.pathname.slice(archivePrefix.length);
    const [archiveCik, archivedAccession, filename, ...extra] = suffix.split("/");
    return url.protocol === "https:" && url.hostname === "www.sec.gov" && url.username === "" && url.password === ""
      && url.port === "" && url.search === "" && url.hash === "" && /^\d{1,10}$/.test(archiveCik ?? "")
      && archivedAccession === accession.replaceAll("-", "") && filename === (primaryDocument ?? "index.json") && extra.length === 0;
  } catch { return false; }
}

export function canonicalSecFilingUrl(raw: string, cik: string, accession: string, primaryDocument: string | null): string | null {
  if (!isValidSecFilingUrl(raw, accession, primaryDocument)) return null;
  return secFilingArchiveUrl(cik, accession, primaryDocument);
}
