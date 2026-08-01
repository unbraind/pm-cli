import { describe, expect, it } from "vitest";
import { attachOutputTokenAccounting } from "../../../src/sdk/output-token-accounting.js";

const renderJson = (value: unknown): string => JSON.stringify(value, null, 2);

describe("output token accounting", () => {
  it("attributes the exact pre-receipt bytes and measures its excluded overhead", () => {
    const result = {
      items: [{ id: "pm-one", title: "Implement accounting" }],
      count: 1,
      warnings: ["bounded diagnostic"],
      next_steps: ["continue"],
    };
    const accounted = attachOutputTokenAccounting(result, renderJson);
    const receipt = accounted.token_accounting;
    const independentlyCountedBytes = Buffer.byteLength(
      renderJson(result),
      "utf8",
    );

    expect(receipt.total_bytes).toBe(independentlyCountedBytes);
    expect(receipt.total_estimated_tokens).toBe(
      Math.ceil(independentlyCountedBytes / 4),
    );
    expect(
      Object.values(receipt.sections).reduce(
        (total, section) => total + section.bytes,
        0,
      ),
    ).toBe(independentlyCountedBytes);
    expect(receipt.sections.result_rows.bytes).toBeGreaterThan(0);
    expect(receipt.sections.diagnostics.bytes).toBeGreaterThan(0);
    expect(receipt.sections.hints.bytes).toBeGreaterThan(0);
    expect(receipt.accounting_receipt_bytes).toBe(
      Buffer.byteLength(renderJson(accounted), "utf8") -
        independentlyCountedBytes,
    );
    expect(receipt.excluded_fields).toEqual(["token_accounting"]);
    expect(receipt.accounting_receipt_bytes).toBeLessThan(1_024);
  });

  it.each([
    ["scalar", "value"],
    ["array", [{ id: "pm-one" }]],
    ["empty object", {}],
  ])("wraps %s results without losing their value", (_label, result) => {
    const accounted = attachOutputTokenAccounting(result, renderJson);
    if (
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result)
    ) {
      expect(accounted).toMatchObject(result);
    } else {
      expect(accounted).toMatchObject({ result });
    }
  });

  it("accounts for an undefined result through a transport's null projection", () => {
    const accounted = attachOutputTokenAccounting(
      undefined,
      (value) => JSON.stringify(value) ?? "null",
    );

    expect(accounted).toMatchObject({
      result: undefined,
      token_accounting: { total_bytes: 4 },
    });
  });

  it("returns the last bounded receipt when a transport renderer changes between passes", () => {
    let renderCount = 0;
    const accounted = attachOutputTokenAccounting({ value: true }, (value) => {
      renderCount += 1;
      return `${JSON.stringify(value)}${" ".repeat(renderCount)}`;
    });

    expect(accounted.token_accounting.accounting_receipt_bytes).toBeGreaterThan(
      0,
    );
    expect(renderCount).toBe(9);
  });
});
