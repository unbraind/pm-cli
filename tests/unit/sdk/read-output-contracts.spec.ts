import { describe, expect, it } from "vitest";
import { attachReadOutputContracts } from "../../../src/sdk/context-intent-contracts.js";
import {
  PM_READ_OUTPUT_DIMENSIONS,
  PM_READ_OUTPUT_OPTION_FLAGS,
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
  applyReadOutputDimensions,
  resolveReadOutputDimensions,
  resolveReadOutputEncoding,
  resolveReadOutputSurface,
  validateReadOutputOptions,
} from "../../../src/sdk/read-output-contracts.js";

describe("read output contracts", () => {
  it("declares the same four dimensions on every read surface", () => {
    expect(PM_READ_OUTPUT_DIMENSIONS).toEqual([
      "include",
      "amount",
      "cost",
      "encoding",
    ]);
    expect(PM_READ_OUTPUT_SURFACE_CONTRACTS).toHaveLength(19);
    expect(PM_READ_OUTPUT_OPTION_FLAGS).toEqual([
      "--output-include",
      "--output-limit",
      "--output-budget",
      "--output-format",
    ]);
    for (const contract of PM_READ_OUTPUT_SURFACE_CONTRACTS) {
      expect(Object.keys(contract.dimensions).sort()).toEqual(
        [...PM_READ_OUTPUT_DIMENSIONS].sort(),
      );
      expect(
        Object.values(contract.dimensions).filter(
          (dimension) => dimension.applicable,
        ),
      ).not.toHaveLength(0);
    }
  });

  it("resolves canonical controls ahead of legacy aliases and intent defaults", () => {
    expect(
      resolveReadOutputDimensions("get", {
        outputInclude: "item,linked",
        outputLimit: "4",
        outputBudget: "1200",
        outputFormat: "json",
        fields: "id,title",
        depth: "deep",
        tokenBudget: "900",
        format: "toon",
        for: "inspect",
      }),
    ).toMatchObject({
      include: {
        source: "canonical",
        value: ["item", "linked"],
      },
      amount: { source: "canonical", value: 4 },
      cost: { source: "canonical", value: 1200 },
      encoding: { source: "canonical", value: "json" },
      precedence: ["canonical", "legacy", "intent", "default"],
    });
  });

  it("projects fields, bounds rows, and emits an exact machine-readable receipt", () => {
    const projected = applyReadOutputDimensions(
      "list",
      {
        outputInclude: "id,title",
        outputLimit: "2",
        outputBudget: "800",
      },
      {
        items: [
          { id: "pm-1", title: "One", body: "discard" },
          { id: "pm-2", title: "Two", body: "discard" },
          { id: "pm-3", title: "Three", body: "discard" },
        ],
        count: 3,
        total: 3,
        row_contract: { command: "list", row_keys: ["items"] },
      },
    );

    expect(projected).toMatchObject({
      items: [
        { id: "pm-1", title: "One" },
        { id: "pm-2", title: "Two" },
      ],
      count: 2,
      total: 3,
      has_more: true,
      truncated: true,
      read_output: {
        command: "list",
        requested_dimensions: ["include", "amount", "cost"],
        precedence: ["canonical", "legacy", "intent", "default"],
        within_budget: true,
      },
    });
    expect(projected.read_output.estimated_tokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify(projected), "utf8") / 4),
    );
  });

  it("keeps legacy flags working while publishing one-line migration hints", () => {
    const result = { checks: [{ name: "storage", status: "ok" }] };
    const resolved = resolveReadOutputDimensions("health", { summary: true });
    expect(resolved).toMatchObject({
      legacy_aliases_used: ["--summary"],
      migration_hints: [
        "--summary is a compatibility alias; prefer --output-include summary.",
      ],
    });
    expect(applyReadOutputDimensions("health", { summary: true }, result)).toBe(
      result,
    );
  });

  it("fails closed to a bounded receipt when the requested budget is infeasible", () => {
    const projected = applyReadOutputDimensions(
      "stats",
      { outputBudget: 256 },
      Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [
          `field_${index}`,
          "x".repeat(100),
        ]),
      ),
    );
    expect(projected).toMatchObject({
      output_budget_exceeded: {
        omitted_result: true,
        reason: "requested_budget_infeasible",
      },
      read_output: {
        command: "stats",
        within_budget: false,
        result_omitted: true,
      },
    });
    expect(projected.read_output.estimated_tokens).toBeLessThanOrEqual(256);
  });

  it("leaves mutations and unbounded reads byte-for-byte unchanged", () => {
    const result = { id: "pm-1", status: "open" };
    expect(applyReadOutputDimensions("create", {}, result)).toBe(result);
    expect(applyReadOutputDimensions("list", {}, result)).toBe(result);
  });

  it("rejects malformed controls and mutation-scoped output projection", () => {
    expect(() =>
      validateReadOutputOptions("list", { outputLimit: "zero" }),
    ).toThrow("positive integer or unbounded");
    expect(() =>
      validateReadOutputOptions("create", { outputBudget: "100" }),
    ).toThrow("only to read commands");
    expect(() =>
      validateReadOutputOptions("comments", {
        add: "mutation",
        outputFormat: "json",
      }),
    ).toThrow("cannot be combined with a comments mutation");
  });

  it("validates every canonical value type and its snake-case transport spelling", () => {
    expect(() => validateReadOutputOptions("list", {})).not.toThrow();
    expect(() =>
      validateReadOutputOptions("list", {
        output_include: ["id", "title"],
        output_limit: "unbounded",
        output_budget: 256,
        output_format: "toon",
      }),
    ).not.toThrow();
    for (const [options, message] of [
      [{ outputInclude: " , " }, "requires at least one"],
      [{ outputBudget: 0 }, "positive integer"],
      [{ outputFormat: "yaml" }, "toon or json"],
    ] as const) {
      expect(() => validateReadOutputOptions("list", options)).toThrow(message);
    }
    expect(() => validateReadOutputOptions("", { outputLimit: 1 })).toThrow(
      "this command is not a read surface",
    );
  });

  it("normalizes aliases and legacy dimension spellings without changing their output", () => {
    expect(resolveReadOutputSurface(" LIST-OPEN ")).toBe("list");
    expect(resolveReadOutputSurface("ctx --depth brief")).toBe("context");
    expect(resolveReadOutputSurface("create")).toBeUndefined();
    expect(
      resolveReadOutputDimensions("list", {
        no_truncate: true,
        token_budget: "600",
        format: "toon",
      }),
    ).toMatchObject({
      amount: { source: "legacy", value: "unbounded" },
      cost: { source: "legacy", value: 600 },
      encoding: { source: "legacy", value: "toon" },
    });
    expect(
      resolveReadOutputDimensions("list", { truncate: false }),
    ).toMatchObject({ amount: { source: "legacy", value: "unbounded" } });
    expect(
      resolveReadOutputDimensions("activity", { unbounded: true }),
    ).toMatchObject({ amount: { source: "legacy", value: "unbounded" } });
    expect(resolveReadOutputDimensions("list", { limit: "4" })).toMatchObject({
      amount: { source: "legacy", value: 4 },
    });
    expect(
      resolveReadOutputDimensions("list", { limit: "invalid" })?.amount,
    ).toBeUndefined();
    expect(
      resolveReadOutputDimensions("list", { for: "triage" })?.cost,
    ).toBeUndefined();
    expect(
      resolveReadOutputDimensions("list", { token_budget: "invalid" })?.cost,
    ).toBeUndefined();
    expect(
      resolveReadOutputDimensions("events", { follow: true })?.encoding,
    ).toEqual({ source: "legacy", value: "stream" });
    expect(
      resolveReadOutputDimensions("list", {
        outputInclude: ["id", "title"],
        outputLimit: "unbounded",
      }),
    ).toMatchObject({
      include: { source: "canonical", value: ["id", "title"] },
      amount: { source: "canonical", value: "unbounded" },
    });
    expect(resolveReadOutputEncoding("history", { format: "json" })).toBe(
      "json",
    );
    expect(
      resolveReadOutputEncoding("history", { format: "yaml" }),
    ).toBeUndefined();
    expect(
      resolveReadOutputEncoding("events", { follow: true }),
    ).toBeUndefined();
  });

  it("projects root fields and inferred heterogeneous row collections", () => {
    const root = applyReadOutputDimensions(
      "stats",
      { outputInclude: "alpha" },
      { alpha: 1, beta: 2 },
    );
    expect(root).toMatchObject({ alpha: 1, read_output: { command: "stats" } });
    expect(root).not.toHaveProperty("beta");

    const rows = applyReadOutputDimensions(
      "list",
      { outputInclude: "id", outputLimit: 10 },
      {
        items: [{ id: "pm-1", title: "drop" }, "literal"],
        secondary: [{ id: "pm-2", body: "drop" }],
      },
    );
    expect(rows).toMatchObject({
      items: [{ id: "pm-1" }, "literal"],
      secondary: [{ id: "pm-2" }],
      read_output: { within_budget: true },
    });

    const unbounded = applyReadOutputDimensions(
      "list",
      { outputLimit: "unbounded" },
      { items: [{ id: "pm-1" }] },
    );
    expect(unbounded.items).toHaveLength(1);
    expect(unbounded.read_output).toMatchObject({ within_budget: true });
  });

  it("compacts explanatory text and rows before omitting a budgeted result", () => {
    const textCompacted = applyReadOutputDimensions(
      "stats",
      { outputBudget: 300 },
      { detail: "x".repeat(2_000) },
    );
    expect(textCompacted).toMatchObject({
      read_output: { within_budget: true, result_omitted: false },
    });
    expect(String(textCompacted.detail).endsWith("…")).toBe(true);

    const makeRows = (prefix: string) =>
      Array.from({ length: 8 }, (_, index) => ({
        id: `${prefix}-${index}`,
        detail: "x".repeat(600),
      }));
    const rowCompacted = applyReadOutputDimensions(
      "list",
      { outputBudget: 700 },
      {
        items: makeRows("item"),
        related: makeRows("related"),
        metadata: "not-a-row-array",
        count: 16,
        row_contract: {
          command: "list",
          row_keys: ["items", "related", "metadata"],
        },
      },
    );
    expect(rowCompacted).toMatchObject({
      has_more: true,
      truncated: true,
      read_output: { within_budget: true, result_omitted: false },
    });
    expect(rowCompacted.count).toBe(
      rowCompacted.items.length + rowCompacted.related.length,
    );

    const withoutCount = applyReadOutputDimensions(
      "list",
      { outputBudget: 700 },
      {
        items: makeRows("item"),
        related: makeRows("related"),
        row_contract: { command: "list", row_keys: ["items", "related"] },
      },
    );
    expect(withoutCount).not.toHaveProperty("count");
    expect(withoutCount).toMatchObject({
      read_output: { within_budget: true, result_omitted: false },
    });
  });

  it("composes intent, relevance order, row bounds, and token budgets", () => {
    const projected = attachReadOutputContracts(
      "search",
      {
        for: "discover",
        outputInclude: "id,score",
        outputLimit: 2,
        outputBudget: 1_000,
      },
      {
        items: [
          { id: "pm-high", title: "High", score: 0.99 },
          { id: "pm-mid", title: "Mid", score: 0.75 },
          { id: "pm-low", title: "Low", score: 0.5 },
        ],
        row_contract: { command: "search", row_keys: ["items"] },
      },
    ) as Record<string, unknown>;
    expect(projected).toMatchObject({
      items: [
        { id: "pm-high", score: 0.99 },
        { id: "pm-mid", score: 0.75 },
      ],
      context_intent: { intent: "discover", within_budget: true },
      read_output: { within_budget: true },
    });
  });
});
