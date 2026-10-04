export const MATERIAL_FILTER_DESCRIPTION =
  "Includes a historical Jev material score of 0.60 or higher or a Luna classification marked material. Neither is independently validated as a materiality finding.";

export function MaterialFilterDisclosure() {
  return (
    <p
      id="material-filter-disclosure"
      role="note"
      className="mx-2 mt-2 rounded border border-indigo-300/15 bg-indigo-200/[0.025] px-3 py-2 text-[10.5px] leading-relaxed text-indigo-100/70"
    >
      <span className="font-semibold text-indigo-100/85">Model-flagged material.</span>{" "}
      {MATERIAL_FILTER_DESCRIPTION}
    </p>
  );
}
