import assert from "node:assert/strict";
import type { ChangeEvent, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { MobileCompanyPicker } from "../web/src/components/MobileCompanyPicker.js";

describe("mobile company picker", () => {
  it("provides a labeled, real-company selector and reflects the selected company", () => {
    const html = renderToStaticMarkup(
      <MobileCompanyPicker
        companies={[
          { id: "apple-id", ticker: "AAPL", name: "Apple" },
          { id: "adobe-id", ticker: "ADBE", name: "Adobe" },
        ]}
        selectedId="adobe-id"
        onSelect={() => undefined}
      />,
    );

    assert.match(html, /<label[^>]+for="mobile-company-picker"[^>]*>Company<\/label>/);
    assert.match(html, /<select[^>]+id="mobile-company-picker"/);
    assert.match(html, /<option value="apple-id">AAPL · Apple<\/option>/);
    assert.match(html, /<option value="adobe-id" selected="">ADBE · Adobe<\/option>/);
    assert.match(html, /lg:hidden/);
  });

  it("keeps an empty saved company universe explicit and disabled", () => {
    const html = renderToStaticMarkup(
      <MobileCompanyPicker companies={[]} selectedId={null} onSelect={() => undefined} />,
    );

    assert.match(html, /<select[^>]+disabled=""/);
    assert.match(html, /<option value="" disabled="" selected="">Choose a company<\/option>/);
  });

  it("sends the chosen configured company to the selection owner", () => {
    const selected: string[] = [];
    const picker = MobileCompanyPicker({
      companies: [
        { id: "apple-id", ticker: "AAPL", name: "Apple" },
        { id: "adobe-id", ticker: "ADBE", name: "Adobe" },
      ],
      selectedId: "apple-id",
      onSelect: (id) => selected.push(id),
    });
    const [, selector] = picker.props.children as [
      ReactNode,
      ReactElement<{ onChange: (event: ChangeEvent<HTMLSelectElement>) => void }>,
    ];

    selector.props.onChange({ currentTarget: { value: "adobe-id" } } as ChangeEvent<HTMLSelectElement>);
    selector.props.onChange({ currentTarget: { value: "" } } as ChangeEvent<HTMLSelectElement>);

    assert.deepEqual(selected, ["adobe-id"]);
  });
});
