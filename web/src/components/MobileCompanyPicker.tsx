import type { CompanySnapshot } from "../lib/api.js";

export function MobileCompanyPicker({
  companies,
  selectedId,
  onSelect,
}: {
  companies: readonly Pick<CompanySnapshot, "id" | "name" | "ticker">[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-desk-line bg-[#0a0c11] px-3 py-2 lg:hidden">
      <label htmlFor="mobile-company-picker" className="micro shrink-0">Company</label>
      <select
        id="mobile-company-picker"
        value={selectedId ?? ""}
        disabled={companies.length === 0}
        onChange={(event) => {
          if (event.currentTarget.value) onSelect(event.currentTarget.value);
        }}
        className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.045] px-2.5 py-2 text-[12px] text-white/85 outline-none focus-visible:border-emerald-300/70 focus-visible:ring-2 focus-visible:ring-emerald-300/30 disabled:opacity-45"
      >
        <option value="" disabled>Choose a company</option>
        {companies.map((company) => (
          <option key={company.id} value={company.id}>
            {company.ticker} · {company.name}
          </option>
        ))}
      </select>
    </div>
  );
}
