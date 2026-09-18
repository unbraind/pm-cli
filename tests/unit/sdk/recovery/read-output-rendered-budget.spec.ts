/** @module tests/unit/sdk/read-output-rendered-budget
 * Verifies complete rendered envelopes retain useful, resumable rows within budget.
 */
import { describe, expect, it } from "vitest";
import { formatBuiltInOutput } from "../../../../src/core/output/output.js";
import { applyReadOutputDimensions, decodeReadOutputContinuationCursor, stabilizeReadOutputReceiptEstimates, validateReadOutputOptions, resolveReadOutputEncoding } from "../../../../src/sdk/read-output-contracts.js";
import { attachReadOutputContracts } from "../../../../src/sdk/context-intent-contracts.js";
import { estimateReadOutputTokens } from "../../../../src/sdk/read-output-budget.js";

describe("rendered read-output accounting", () => {
  it.each((["json", "toon"] as const).flatMap((format) =>
    ["outputFormat", "output_format", "format"].map((option) => ({ format, option })),
  ))("bounds the complete $format envelope through $option including session and cursors", ({ format, option }) => {
    const items = Array.from({ length: 80 }, (_, index) => ({ id: `pm-rendered-${index}`, title: `Unicode café ${index}`, description: "Long detail ".repeat(30) }));
    const options = {
      [option]: format,
      outputBudget: 1800,
      outputSession: { version: 1, id: "rendered", token_budget: 5000, spent_tokens: 500, seen_item_ids: [] },
    };
    const result = applyReadOutputDimensions("list", options, { items, count: items.length });
    expect(result).not.toHaveProperty("output_budget_exceeded");
    const envelope = result as unknown as { items: typeof items; read_output: { estimated_tokens: number }; read_session: { spent_this_call_tokens: number }; output_budget_truncation: { continuations: Array<{ cursor: string; retained_rows: number }> } };
    const measured = Math.ceil(Buffer.byteLength(formatBuiltInOutput(result, format), "utf8") / 4);
    expect(measured).toBeLessThanOrEqual(1800);
    expect(envelope.items.length).toBeGreaterThan(0);
    expect(envelope.items.length).toBeLessThan(items.length);
    expect(envelope.read_output.estimated_tokens).toBe(measured);
    expect(envelope.read_session.spent_this_call_tokens).toBe(measured);
    const continuation = envelope.output_budget_truncation.continuations[0]!;
    expect(decodeReadOutputContinuationCursor(continuation.cursor).offset).toBe(envelope.items.length);
    expect(continuation.retained_rows).toBe(envelope.items.length);
    const finalEnvelope = stabilizeReadOutputReceiptEstimates({ ...result, transport: "SDK café" }, options);
    const finalMeasured = Math.ceil(Buffer.byteLength(formatBuiltInOutput(finalEnvelope, format), "utf8") / 4);
    expect(finalEnvelope.read_output).toMatchObject({ estimated_tokens: finalMeasured });
    expect(finalEnvelope.read_session).toMatchObject({ spent_this_call_tokens: finalMeasured });
  });

  it("preserves structured SDK measurement when no renderer is selected", () => {
    const result = { rows: [{ title: "café" }] };
    expect(estimateReadOutputTokens(result)).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(result), "utf8") / 4));
    expect(estimateReadOutputTokens(result, "json")).toBeGreaterThan(estimateReadOutputTokens(result));
  });
});


describe("output budget utilization and no-op controls", () => {
  it.each(["json", "toon"] as const)("retains a maximal prefix in the complete %s envelope", (format) => {
    const items = Array.from({ length: 130 }, (_, index) => ({ id: `pm-${index}`, title: `Task ${index} ${"context ".repeat(28)}`, status: "open" }));
    let previous = 0;
    for (const limit of [20, 30, 40, 50, 60, 80, 100, 130]) {
      const result = applyReadOutputDimensions("list", { outputFormat: format, outputBudget: 1000 }, { items: items.slice(0, limit), count: limit, total: 130 });
      expect(result).not.toHaveProperty("output_budget_exceeded");
      if (!("items" in result)) throw new Error("Expected retained rows");
      expect(result.items.length).toBeGreaterThanOrEqual(previous);
      previous = result.items.length;
      expect(estimateReadOutputTokens(result, format)).toBeLessThanOrEqual(1000);
      if (result.items.length < limit) {
        // Adding even the cheapest omitted row must exceed the ceiling before
        // accounting for the larger continuation offsets and receipt counts.
        const expanded = { ...result, items: items.slice(0, result.items.length + 1) };
        expect(estimateReadOutputTokens(expanded, format)).toBeGreaterThan(1000);
        expect((result as Record<string, unknown>).applied_limit).toBe(result.items.length);
      }
    }
  });

  it("does not charge receipts for no-op canonical amount, cost or encoding controls", () => {
    const result = { items: [{ id: "pm-1", title: "One" }], count: 1 };
    for (const options of [{ outputLimit: 20 }, { output_limit: "unbounded" }, { outputFormat: "json" }, { outputBudget: 2000 }, { outputLimit: 20, outputBudget: 2000, outputFormat: "toon" }]) {
      expect(applyReadOutputDimensions("list", options, result)).toBe(result);
    }
    expect(applyReadOutputDimensions("list", { outputLimit: 20, outputRowContract: true }, result)).toHaveProperty("read_output");
    const contracts = { commands: [{ name: "list" }] };
    expect(applyReadOutputDimensions("contracts", { full: true, outputBudget: "unbounded" }, contracts)).toBe(contracts);
  });

  it("elides non-binding object-map limits and enforces smaller amounts without mutating the input", () => {
    const result = {
      graph: { nodes: { one: { id: "pm-one" }, two: { id: "pm-two" }, three: { id: "pm-three" } } },
      row_contract: { row_keys: ["graph.nodes"] },
    };
    expect(applyReadOutputDimensions("graph", { outputLimit: 4, outputBudget: "unbounded" }, result)).toBe(result);
    const bounded = applyReadOutputDimensions("graph", { outputLimit: 1, outputBudget: "unbounded" }, result);
    expect(bounded).toMatchObject({ graph: { nodes: { one: { id: "pm-one" } } }, has_more: true, read_output: { within_budget: true } });
    if (!("graph" in bounded)) throw new Error("Expected the bounded graph");
    expect(Object.keys(bounded.graph.nodes)).toEqual(["one"]);
    expect(Object.keys(result.graph.nodes)).toEqual(["one", "two", "three"]);
  });

  it("accepts encoding on writes while refusing read-only controls before execution", () => {
    for (const command of ["create", "update", "close", "comments", "notes", "files", "docs"]) {
      const options = { outputFormat: "json", add: "content" };
      expect(() => validateReadOutputOptions(command, options)).not.toThrow();
      expect(resolveReadOutputEncoding(command, options)).toBe("json");
      expect(() => validateReadOutputOptions(command, { ...options, outputLimit: 1 })).toThrow(/read|mutation/u);
      expect(() => validateReadOutputOptions(command, { outputFormat: "csv" })).toThrow("--output-format must be toon or json");
    }
  });
});


it.each([false, true].flatMap((session) => [1000, 1010, 1600].map((budget) => ({ session, budget }))))("budgets nested rows against emitted metadata with session=$session and budget=$budget", ({ session, budget }) => {
  const nodes = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`node-${index}`, { id: `pm-${index}`, detail: "context ".repeat(20) }]));
  const result = attachReadOutputContracts("graph", {
    outputBudget: budget, outputFormat: "json",
    ...(session ? { outputSession: { version: 1, id: "nested", token_budget: 4000, spent_tokens: 0, seen_item_ids: [] } } : {}),
  }, { graph: { nodes }, activity: Array.from({ length: 5 }, (_, index) => ({ id: `pm-activity-${index}` })), row_contract: { command: "graph", row_kind: "collection", row_keys: ["graph.nodes"], jq_selector: ".graph.nodes[]", fields: "unsupported", toon_encoding: "tabular_when_uniform" } }) as {
    graph: { nodes: typeof nodes }; activity: Array<{ id: string }>; read_output: { estimated_tokens: number }; read_session?: { new_item_count: number }; next_cursor: string;
  };
  expect(result).not.toHaveProperty("row_contract");
  const retained = Object.keys(result.graph.nodes).length;
  expect(retained).toBeGreaterThan(0);
  expect(retained).toBeLessThan(40);
  expect(estimateReadOutputTokens(result, "json")).toBeLessThanOrEqual(budget);
  expect(result.read_output.estimated_tokens).toBe(estimateReadOutputTokens(result, "json"));
  if (session) expect(result.read_session?.new_item_count).toBe(retained + result.activity.length);
  expect(decodeReadOutputContinuationCursor(result.next_cursor).offset).toBe(retained);
  const expanded = { ...result, graph: { nodes: Object.fromEntries(Object.entries(nodes).slice(0, retained + 1)) } };
  expect(estimateReadOutputTokens(expanded, "json")).toBeGreaterThan(budget);
});
