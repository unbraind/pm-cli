/** @module tests/unit/sdk/recovery/read-output-item-depth
 * Exercises useful single-item fallback without shortening the retained facts.
 */
import { describe, expect, it } from "vitest";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import {
  estimateReadOutputTokens,
  projectReadOutputItemToBrief,
} from "../../../../src/sdk/read-output-budget.js";

describe("single-item budget depth", () => {
  it("retains complete metadata before compacting strings or omitting an oversized standard read", () => {
    const item = {
      id: "pm-depth",
      title: "Rich project context",
      description: "d".repeat(2700),
      dependencies: Array.from({ length: 26 }, (_, index) => ({
        id: `pm-${index}`,
        kind: "implements",
      })),
      body: "b".repeat(1111),
    };
    const result = applyReadOutputDimensions(
      "get",
      { outputFormat: "json" },
      {
        item,
        linked: {
          files: Array.from({ length: 100 }, (_, index) => ({
            path: `source/${index}.ts`,
            note: "evidence".repeat(50),
          })),
        },
        claim_state: { claimed: false },
      },
    );
    expect(result).not.toHaveProperty("output_budget_exceeded");
    expect(result).toHaveProperty("item.description", item.description);
    expect(result).toHaveProperty("item.dependencies", item.dependencies);
    expect(result).not.toHaveProperty("item.body");
    expect(result).not.toHaveProperty("linked");
    expect(result.read_output).toMatchObject({
      applied_depth: "brief",
      degradation_reason: "output_budget_reached",
      strings_compacted: false,
      rows_compacted: false,
    });
    expect(estimateReadOutputTokens(result, "json")).toBeLessThanOrEqual(6000);
    expect(item.body).toHaveLength(1111);
  });

  it.each([
    { fields: "body" },
    { outputInclude: "item.body" },
    { output_include: "item.body" },
    { outputCursor: "cursor" },
    { output_cursor: "cursor" },
    { full: true },
    { tree: true },
    { depth: "brief" },
    { depth: "deep" },
  ])("preserves explicit projection semantics %j", (options) => {
    expect(
      projectReadOutputItemToBrief("get", options, {
        item: { id: "pm-a", body: "detail" },
      }),
    ).toBeUndefined();
  });

  it("retains inherited omission evidence and leaves other read shapes alone", () => {
    expect(
      projectReadOutputItemToBrief("list", {}, { item: {} }),
    ).toBeUndefined();
    expect(
      projectReadOutputItemToBrief("get", {}, { item: null }),
    ).toBeUndefined();
    expect(
      projectReadOutputItemToBrief(
        "get",
        { depth: "standard" },
        { item: { id: "pm-a" } },
      ),
    ).toMatchObject({ omission_receipt: { has_omissions: false } });
    expect(
      projectReadOutputItemToBrief(
        "get",
        {},
        {
          item: { id: "pm-a" },
          omission_receipt: {},
        },
      ),
    ).toMatchObject({ omission_receipt: { omitted_field_groups: [] } });
    const inherited = { name: "notes", restore_with: "--fields notes" };
    expect(
      projectReadOutputItemToBrief(
        "get",
        {},
        {
          item: { id: "pm-a" },
          omission_receipt: { omitted_field_groups: [inherited] },
        },
      ),
    ).toMatchObject({
      omission_receipt: { omitted_field_groups: [inherited] },
    });
  });

  it("reports the useful-result estimate when even brief cannot fit", () => {
    const result = applyReadOutputDimensions(
      "get",
      { outputBudget: 256 },
      {
        item: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`field_${index}`, index]),
        ),
      },
    );
    expect(result).toHaveProperty(
      "output_budget_exceeded.omitted_result",
      true,
    );
    expect(result.read_output?.omitted_result_estimated_tokens).toBeGreaterThan(
      256,
    );
  });

  it("charges only the emitted brief projection to an output session", () => {
    const result = applyReadOutputDimensions(
      "get",
      {
        outputFormat: "json",
        outputSession: {
          version: 1,
          id: "inspect",
          token_budget: 2000,
          spent_tokens: 0,
          seen_item_ids: [],
        },
      },
      {
        item: {
          id: "pm-session",
          title: "Retained",
          body: "detail".repeat(2000),
        },
      },
    );
    expect(result).not.toHaveProperty("output_budget_exceeded");
    expect(result.read_output).toMatchObject({
      applied_depth: "brief",
      within_budget: true,
    });
    expect(result).toHaveProperty(
      "read_session.spent_this_call_tokens",
      estimateReadOutputTokens(result, "json"),
    );
  });
});
