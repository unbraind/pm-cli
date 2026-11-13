/**
 * Delivered-output budget contract (GH-1678, GH-1662, pm-sj66lm): every
 * receipt estimate, compaction step and omission decision measures the bytes
 * the host actually writes, whichever renderer produces them.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveExtensionHooks,
  setActiveExtensionRenderers,
  setActiveExtensionServices,
} from "../../../../src/core/extensions/index.js";
import { formatBuiltInOutput, formatOutput } from "../../../../src/core/output/output.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import {
  attachContextIntentReceipt,
  attachReadOutputContracts,
  applyContextIntentProjection,
} from "../../../../src/sdk/context-intent-contracts.js";
import {
  estimateReadOutputTokens,
  withDeliveredOutputRenderer,
} from "../../../../src/sdk/read-output-budget.js";
import { isReadResultOmittedForBudget } from "../../../../src/sdk/read-output-contracts.js";

const ROWS = { items: [{ id: "pm-a", title: "Alpha" }], count: 1, total: 1 };
const EXPANSION = `detail: ${"x".repeat(10_000)}`;
const tokensOf = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

/** An expanding renderer that prints the structured result (and so its receipts) after a constant 10 KB prefix. */
function useExpandingRenderer(format: "json" | "toon"): void {
  setActiveExtensionRenderers({
    overrides: [
      {
        layer: "project",
        name: "expanding-renderer",
        format,
        run: (context) => `${EXPANSION}\n${JSON.stringify(context.result)}`,
      },
    ],
  });
}

afterEach(() => {
  clearActiveExtensionHooks();
  process.exitCode = undefined;
});

describe("GH-1678 a custom renderer's delivered string answers to the output budget", () => {
  it("refuses natively, with exit 2, when the rendered string cannot fit", () => {
    useExpandingRenderer("toon");
    for (const outputBudget of ["400", "1"]) {
      process.exitCode = undefined;
      const rendered = formatOutput(ROWS, { command: "list", outputBudget, outputRowContract: true });
      expect(rendered).not.toContain("detail: ");
      expect(rendered).toContain("output_budget_exceeded:");
      expect(process.exitCode).toBe(EXIT_CODE.USAGE);
    }
  });

  it("reports the delivered bytes in a fitting custom rendering's receipt", () => {
    useExpandingRenderer("toon");
    const rendered = formatOutput(ROWS, { command: "list", outputBudget: "3000", outputRowContract: true });
    expect(rendered.startsWith("detail: ")).toBe(true);
    const receipt = (JSON.parse(rendered.trim().split("\n").at(-1)!) as { read_output: Record<string, unknown> }).read_output;
    // Negative control: a receipt measured on the native payload would report about 50 tokens here.
    expect(receipt).toMatchObject({ estimated_tokens: tokensOf(rendered), within_budget: true, result_omitted: false });
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps explicitly unbounded custom rendering and leaves other encodings native", () => {
    useExpandingRenderer("toon");
    expect(formatOutput(ROWS, { command: "list", outputBudget: "unbounded" }).startsWith("detail: ")).toBe(true);
    const json = formatOutput(ROWS, { command: "list", outputBudget: "400", outputRowContract: true, json: true });
    expect(JSON.parse(json)).toMatchObject({ items: ROWS.items, read_output: { estimated_tokens: tokensOf(json) } });
  });

  it("applies the delivered-bytes budget to a JSON renderer in JSON mode", () => {
    useExpandingRenderer("json");
    const refused = formatOutput(ROWS, { command: "list", outputBudget: "400", outputRowContract: true, json: true });
    expect(refused).not.toContain("detail: ");
    expect(JSON.parse(refused)).toMatchObject({ output_budget_exceeded: { omitted_result: true } });
    expect(process.exitCode).toBe(EXIT_CODE.USAGE);
    process.exitCode = undefined;
    const fitting = formatOutput(ROWS, { command: "list", outputBudget: "3000", outputRowContract: true, json: true });
    expect(fitting.startsWith("detail: ")).toBe(true);
    const receipt = (JSON.parse(fitting.trim().split("\n").at(-1)!) as { read_output: Record<string, unknown> }).read_output;
    // Negative control: the native JSON estimate would report about 50 tokens.
    expect(receipt).toMatchObject({ estimated_tokens: tokensOf(fitting), within_budget: true });
    expect(formatOutput(ROWS, { command: "list", outputBudget: "unbounded", json: true }).startsWith("detail: ")).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("applies the same ceiling to an output_format service's string", () => {
    setActiveExtensionServices({
      overrides: [
        {
          layer: "project",
          name: "expanding-service",
          service: "output_format",
          run: () => ({ handled: true, result: EXPANSION }),
        },
      ],
    });
    const refused = formatOutput(ROWS, { command: "list", outputBudget: "400" });
    expect(refused).toContain("output_budget_exceeded:");
    expect(refused).not.toContain("detail: ");
    expect(process.exitCode).toBe(EXIT_CODE.USAGE);
    process.exitCode = undefined;
    expect(formatOutput(ROWS, { command: "list", outputBudget: "unbounded" })).toBe(`${EXPANSION}\n`);
    // The refusal a service string triggers is delivered natively, so its receipt measures the native refusal.
    for (const json of [true, false]) {
      process.exitCode = undefined;
      const delivered = formatOutput(ROWS, { command: "list", outputBudget: "150", json });
      const estimated = Number(/estimated_tokens"?: ?(\d+)/u.exec(delivered)?.[1]);
      // Negative control: measuring the 10 KB service string instead reports 2,503 tokens for a 183-token refusal.
      expect(estimated, `json=${json}`).toBe(tokensOf(delivered));
    }
    process.exitCode = undefined;
    // A command without a read-output contract keeps the service's string unbounded.
    expect(formatOutput({ ok: true }, { command: "close" })).toBe(`${EXPANSION}\n`);
    expect(process.exitCode).toBeUndefined();
  });

  it("terminates an intent estimate that a renderer makes oscillate, without understating the delivery", () => {
    // The rendering prints a remainder derived from the estimate, so the estimate alternates between two values.
    setActiveExtensionRenderers({
      overrides: [{
        layer: "project",
        name: "oscillating-renderer",
        format: "toon",
        run: (context) => {
          const intent = (context.result as { context_intent?: { estimated_tokens?: number } }).context_intent;
          return `${JSON.stringify(context.result)}\nremaining: ${300 - (intent?.estimated_tokens ?? 0)}`;
        },
      }],
    });
    // Negative control: the unbounded fixpoint never returned for this input.
    const delivered = formatOutput({ items: [{ id: "a", title: "A".repeat(218) }] }, { command: "list", commandOptions: { for: "triage", tokenBudget: "300" } });
    const intent = (JSON.parse(delivered.slice(0, delivered.lastIndexOf("\nremaining: "))) as { context_intent: { estimated_tokens: number } }).context_intent;
    expect(intent.estimated_tokens).toBeGreaterThanOrEqual(tokensOf(delivered));
  });

  it("lets a renderer's own nested contract calls measure their own representation", () => {
    // The renderer embeds an independent SDK read; auxiliary inputs are serialized directly.
    setActiveExtensionRenderers({
      overrides: [{
        layer: "project",
        name: "nested-contract-renderer",
        format: "json",
        run: (context) => {
          const result = context.result as Record<string, unknown>;
          if (result.auxiliary === true) return JSON.stringify(result);
          const auxiliary = attachReadOutputContracts("list", { outputBudget: "200", outputFormat: "json", outputRowContract: true }, { auxiliary: true, items: [{ id: "b", title: "B" }] });
          return JSON.stringify({ ...result, auxiliary }, null, 2);
        },
      }],
    });
    const read = (outputBudget: string): string => formatOutput({ items: [{ id: "a", title: "A" }] }, { command: "list", json: true, outputBudget, outputRowContract: true });
    const fitting = read("3000");
    const receipt = (JSON.parse(fitting) as { read_output: { estimated_tokens: number } }).read_output;
    // Negative control: inheriting the outer renderer scope reported 503 tokens for 446 delivered.
    expect(receipt.estimated_tokens).toBe(tokensOf(fitting));
    // The outer read fits just above its delivered size; the embedded read keeps its own (refused) 200-token result.
    const justFits = JSON.parse(read(String(tokensOf(fitting) + 20))) as Record<string, unknown>;
    expect(justFits).toMatchObject({ items: [{ id: "a" }], read_output: { within_budget: true } });
    expect(justFits).not.toHaveProperty("output_budget_exceeded");
    expect(process.exitCode).toBeUndefined();
  });

  it("never delivers custom bytes its receipts understate: the read falls back to native measurement", () => {
    const useRenderer = (format: "json" | "toon", run: (result: Record<string, unknown>) => string): void => {
      setActiveExtensionRenderers({ overrides: [{ layer: "project", name: "self-referential-renderer", format, run: (context) => run(context.result as Record<string, unknown>) }] });
    };
    // The first estimated_tokens after the receipt's key, in TOON or JSON.
    const estimateIn = (text: string, receipt: string): number => Number(new RegExp(`${receipt}"?:[\\s\\S]*?estimated_tokens"?: ?(\\d+)`, "u").exec(text)?.[1]);
    // read_output oscillates: a small estimate selects a large rendering and vice versa.
    useRenderer("toon", (result) => "x".repeat(((result.read_output as { estimated_tokens?: number } | undefined)?.estimated_tokens ?? 0) < 500 ? 4000 : 400));
    const oscillating = formatOutput({ items: [{ id: "a", title: "A" }] }, { command: "list", outputBudget: "400", outputRowContract: true });
    // Negative control: the bounded fixpoint published 101 tokens for a 1,001-token delivery.
    expect(oscillating.startsWith("x")).toBe(false);
    expect(estimateIn(oscillating, "read_output")).toBe(tokensOf(oscillating));
    expect(process.exitCode).toBeUndefined();
    // The intent estimate converges only after more than the bounded number of passes; the rendering prints its intent receipt.
    useRenderer("toon", (result) => `${JSON.stringify({ context_intent: result.context_intent })}\n${"x".repeat(4 * Math.min(1000, ((result.context_intent as { estimated_tokens?: number } | undefined)?.estimated_tokens ?? 0) + 100))}`);
    process.exitCode = undefined;
    const slow = formatOutput({ item: { id: "a", title: "A" } }, { command: "get", commandOptions: { for: "inspect", tokenBudget: "850" } });
    // Negative control: the receipt claimed a fit at 850 for a 1,000-token delivery. Whatever is delivered, its intent
    // receipt covers it, and a delivery over the budget is an omission that exits 2.
    expect(estimateIn(slow, "context_intent")).toBeGreaterThanOrEqual(tokensOf(slow));
    expect(tokensOf(slow) <= 850 || process.exitCode === EXIT_CODE.USAGE).toBe(true);
    process.exitCode = undefined;
    // A session charge that understates its rendering would let two calls overrun the session ceiling.
    useRenderer("json", (result) => JSON.stringify(result).padEnd(4 * Math.min(2000, Math.max(500, ((result.read_session as { spent_this_call_tokens?: number } | undefined)?.spent_this_call_tokens ?? 0) + 100)) - 1, " "));
    let state: unknown = { version: 1, id: "probe", token_budget: 2500, spent_tokens: 0, seen_item_ids: [] };
    for (const call of [1, 2]) {
      const delivered = formatOutput({ items: [{ id: `a${call}`, title: "A" }] }, { command: "list", json: true, outputBudget: "unbounded", outputSession: JSON.stringify(state) });
      const session = (JSON.parse(delivered) as { read_session: { spent_this_call_tokens: number; next_state: unknown } }).read_session;
      expect(session.spent_this_call_tokens, `call ${call}`).toBeGreaterThanOrEqual(tokensOf(delivered));
      state = session.next_state;
    }
  });

  it("settles intent receipts over the delivered envelope when row contracts are requested", () => {
    const options = { command: "list", json: true, outputRowContract: true, commandOptions: { for: "triage", tokenBudget: "5000" } } as const;
    // Native delivery: the intent estimate covers the read-output receipt and the requested row contract.
    const native = formatOutput({ items: [{ id: "a", title: "A" }] }, options);
    // Negative control: the unsettled intent estimate reported 278 tokens for a 412-token delivery.
    expect((JSON.parse(native) as { context_intent: { estimated_tokens: number } }).context_intent.estimated_tokens).toBeGreaterThanOrEqual(tokensOf(native));
    // A stable custom renderer is delivered, not replaced by a needless native fallback.
    setActiveExtensionRenderers({ overrides: [{ layer: "project", name: "stable-json", format: "json", run: (context) => `CUSTOM${JSON.stringify(context.result)}` }] });
    const custom = formatOutput({ items: [{ id: "a", title: "A" }] }, options);
    expect(custom.startsWith("CUSTOM")).toBe(true);
    const intent = (JSON.parse(custom.slice("CUSTOM".length)) as { context_intent: { estimated_tokens: number; within_budget: boolean } }).context_intent;
    expect(intent).toMatchObject({ within_budget: true });
    expect(intent.estimated_tokens).toBeGreaterThanOrEqual(tokensOf(custom));
    expect(process.exitCode).toBeUndefined();
  });

  it("decides an intent read again when its settled envelope exceeds the intent budget, under both spellings", () => {
    // The intent rows fit 400 tokens, but the read-output receipt and the requested row contract push the envelope past it.
    const rows = { items: [{ id: "pm-1", title: "t".repeat(40) }, { id: "pm-2", title: "t".repeat(40) }] };
    const read = (budget: Record<string, string>, outputBudget?: string): Record<string, unknown> => {
      process.exitCode = undefined;
      return JSON.parse(formatOutput(rows, { command: "list", json: true, outputRowContract: true, ...(outputBudget === undefined ? {} : { outputBudget }), commandOptions: { for: "triage", ...budget } })) as Record<string, unknown>;
    };
    // Negative control: the legacy spelling delivered 445 tokens with exit 0 against a 400-token budget.
    const legacy = read({ tokenBudget: "400" });
    expect(process.exitCode).toBe(EXIT_CODE.USAGE);
    expect(legacy).toMatchObject({ budget_exceeded: { omitted_result: true }, context_intent: { result_omitted: true, within_budget: false }, read_output: { result_omitted: true } });
    read({ outputBudget: "400" }, "400");
    expect(process.exitCode).toBe(EXIT_CODE.USAGE);
    // The named retry budget returns the result.
    const retryBudget = /--token-budget (\d+)/u.exec(String((legacy.budget_exceeded as { restore_with: string }).restore_with))![1]!;
    const retried = read({ tokenBudget: retryBudget });
    expect(process.exitCode).toBeUndefined();
    expect(retried).toMatchObject({ items: [{ id: "pm-1" }, { id: "pm-2" }], context_intent: { within_budget: true, result_omitted: false } });
    // An explicitly unbounded read keeps its result and reports the declared ceiling it exceeds.
    const unbounded = attachReadOutputContracts("list", { for: "triage", tokenBudget: "256", outputBudget: "unbounded", outputRowContract: true, resolvedOutputFormat: "json" }, rows) as { context_intent: { estimated_tokens: number; token_budget: number; within_budget: boolean; result_omitted: boolean } };
    expect(unbounded.context_intent).toMatchObject({ within_budget: false, result_omitted: false });
  });

  it("rechecks the re-settled envelope: a read either fits its budget or is omitted with exit 2", () => {
    // A structured service result whose settled second pass can still land one token over the budget.
    setActiveExtensionServices({ overrides: [{ layer: "project", name: "structured-next", service: "output_format", run: () => ({ handled: true, result: { ready: Array.from({ length: 5 }, (_, index) => ({ id: `pm-${index}`, title: "a".repeat(60) })) } }) }] });
    for (let budget = 300; budget <= 460; budget += 4) {
      process.exitCode = undefined;
      const delivered = formatOutput({ ready: [] }, { command: "next", json: true, outputRowContract: true, commandOptions: { for: "execute", tokenBudget: String(budget) } });
      const omitted = isReadResultOmittedForBudget(JSON.parse(delivered));
      // Negative control: at 344 the unchecked second pass delivered 345 tokens with exit 0.
      if (omitted) expect(process.exitCode, `budget ${budget}`).toBe(EXIT_CODE.USAGE);
      else expect(tokensOf(delivered), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
    process.exitCode = undefined;
  });

  it("keeps a stable custom rendering for intent reads and token accounting", () => {
    useExpandingRenderer("toon");
    const intent = formatOutput({ items: [{ id: "a", title: "A" }] }, { command: "list", commandOptions: { for: "triage", tokenBudget: "5000" } });
    expect(intent.startsWith("detail: ")).toBe(true);
    // An explicitly unbounded intent read over its declared ceiling reports within_budget: false and keeps the custom rendering.
    const unbounded = formatOutput({ items: [{ id: "a", title: "A" }] }, { command: "list", commandOptions: { for: "triage", outputBudget: "unbounded", tokenBudget: "300" } });
    expect(unbounded.startsWith("detail: ")).toBe(true);
    expect(unbounded).toContain('"within_budget":false');
    const accounted = formatOutput(ROWS, { command: "list", outputBudget: "3000", outputRowContract: true, tokenAccounting: true });
    expect(accounted.startsWith("detail: ")).toBe(true);
    expect(accounted).toContain("token_accounting");
    expect(process.exitCode).toBeUndefined();
  });

  it("measures inside the delivered-renderer scope only for the delivered encoding", () => {
    const measured = withDeliveredOutputRenderer("toon", () => "x".repeat(400), () => [
      estimateReadOutputTokens(ROWS, "toon"),
      estimateReadOutputTokens(ROWS, "json"),
      estimateReadOutputTokens(ROWS),
    ]);
    expect(measured).toEqual([100, tokensOf(formatBuiltInOutput(ROWS, "json")), tokensOf(JSON.stringify(ROWS))]);
    expect(estimateReadOutputTokens(ROWS, "toon")).toBe(tokensOf(formatBuiltInOutput(ROWS, "toon")));
  });
});

describe("GH-1662 an omitted intent result is unsuccessful and both budget spellings bind the intent", () => {
  it("exits 2 for an omitted intent result", () => {
    const omitted = { budget_exceeded: { omitted_result: true }, context_intent: { result_omitted: true } };
    expect(isReadResultOmittedForBudget(omitted)).toBe(true);
    expect(isReadResultOmittedForBudget({ context_intent: { result_omitted: false } })).toBe(false);
    expect(isReadResultOmittedForBudget("text")).toBe(false);
    formatOutput(omitted, {});
    expect(process.exitCode).toBe(EXIT_CODE.USAGE);
  });

  it("binds the intent budget from a numeric canonical --output-budget", () => {
    const legacy = applyContextIntentProjection("list", { for: "triage", tokenBudget: "600" });
    const canonical = applyContextIntentProjection("list", { for: "triage", outputBudget: "600" });
    expect(canonical).toMatchObject({ limit: legacy.limit, tokenBudget: "600" });
    // An unbounded canonical budget leaves the declared intent ceiling for row derivation.
    expect(applyContextIntentProjection("list", { for: "triage", outputBudget: "unbounded" }).limit)
      .toBe(applyContextIntentProjection("list", { for: "triage" }).limit);
  });

  it("keeps the shared refusal for a canonical spelling and keeps an unbounded result", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: `pm-${index}`, title: "t".repeat(200) }));
    const canonical = attachContextIntentReceipt("list", { for: "triage", outputBudget: "300" }, { items: rows });
    expect(canonical).toMatchObject({
      output_budget_exceeded: { omitted_result: true, reason: "requested_budget_infeasible", recovery: { outputBudget: "unbounded" } },
      context_intent: { token_budget: 300, result_omitted: true, within_budget: false },
    });
    const legacy = attachContextIntentReceipt("list", { for: "triage", tokenBudget: "300" }, { items: rows });
    expect(legacy).toMatchObject({ budget_exceeded: { omitted_result: true }, context_intent: { result_omitted: true } });
    const unbounded = attachContextIntentReceipt("list", { for: "triage", outputBudget: "unbounded" }, { items: Array.from({ length: 400 }, (_, index) => ({ id: `pm-${index}`, title: "t".repeat(200) })) });
    expect(unbounded).toMatchObject({ context_intent: { result_omitted: false, within_budget: false } });
    expect((unbounded as { items: unknown[] }).items).toHaveLength(400);
  });

  it("names the caller's own spelling when a budget reduces an explicit limit", () => {
    const canonical = attachContextIntentReceipt("list", { for: "triage", outputBudget: "600", limit: "50" }, { items: [] });
    expect(canonical.context_intent?.limit_override?.restore_with).toBe("--output-budget 1320");
    const legacy = attachContextIntentReceipt("list", { for: "triage", tokenBudget: "600", limit: "50" }, { items: [] });
    expect(legacy.context_intent?.limit_override?.restore_with).toBe("--token-budget 1320");
  });

  it("measures the delivered envelope, without a row contract the caller did not request", () => {
    const withContract = { items: ROWS.items, row_contract: { row_kind: "items", columns: Array.from({ length: 300 }, (_, index) => `column-${index}`) } };
    const suppressed = attachContextIntentReceipt("list", { for: "triage", tokenBudget: "900", resolvedOutputFormat: "json" }, withContract);
    expect(suppressed.context_intent).toMatchObject({ within_budget: true });
    const requested = attachContextIntentReceipt("list", { for: "triage", tokenBudget: "900", resolvedOutputFormat: "json", outputRowContract: true }, withContract);
    expect(requested).toMatchObject({ context_intent: { result_omitted: true } });
  });
});

describe("GH-1703 TOON names derivable omission receipts with one restore template", () => {
  const section = (name: string) => ({ name, restore_with: `--section ${name}` });
  const receipt = (groups: unknown[], extra: Record<string, unknown> = {}) => ({
    omission_receipt: { has_omissions: true, omitted_field_group_count: groups.length, omitted_field_groups: groups, ...extra },
  });

  it("renders the names inline with one <name> template when every hint is the shared prefix plus the name", () => {
    expect(formatBuiltInOutput(receipt([section("progress"), section("tests")], { summary_scope: "matching_items" }), "toon")).toBe(
      "omission_receipt:\n  has_omissions: true\n  omitted_field_group_count: 2\n" +
        '  omitted_field_groups[2]: progress,tests\n  restore_with: "--section <name>"\n  summary_scope: "matching_items"\n',
    );
    // JSON stays the typed per-row contract.
    expect(JSON.parse(formatBuiltInOutput(receipt([section("progress")]), "json"))).toEqual(receipt([section("progress")]));
  });

  it("keeps the per-row table when any hint is not derivable from its name", () => {
    const rows = "{name,restore_with}:";
    for (const groups of [
      [section("progress"), { name: "tests", restore_with: "--fields tests" }],
      [section("progress"), { ...section("tests"), reason: "budget" }],
      [section("progress"), { name: 7, restore_with: "--section 7" }],
      [section("progress"), { name: "", restore_with: "--section " }],
      [section("progress"), { name: "tests", restore_with: 7 }],
    ]) {
      const rendered = formatBuiltInOutput(receipt(groups), "toon");
      expect(rendered).not.toContain("<name>");
      expect(rendered).toContain("\"--section progress\"");
    }
    expect(formatBuiltInOutput(receipt([section("progress"), "tests"]), "toon")).not.toContain("<name>");
    expect(formatBuiltInOutput(receipt([section("progress"), section("tests")], { restore_with: "--all" }), "toon")).toContain(rows);
    expect(formatBuiltInOutput(receipt([{ name: "children", restore_with: "--fields children" }, { name: "dependency_provenance", restore_with: "--fields dependencies" }]), "toon")).toContain(rows);
    expect(formatBuiltInOutput(receipt([]), "toon")).toContain("omitted_field_groups: []");
    expect(formatBuiltInOutput({ omission_receipt: { has_omissions: true, omitted_field_groups: "progress" } }, "toon")).toContain('omitted_field_groups: "progress"');
    // The named form is chosen only when it is smaller than the rows it replaces.
    expect(formatBuiltInOutput(receipt([{ name: "a", restore_with: "a" }]), "toon")).toContain(rows);
  });
});

describe("pm-sj66lm TOON explicit selection keeps requested empties and a one-line complete receipt", () => {
  const complete = { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] };

  it("renders a complete receipt as one line and leaves receipts that report omissions intact", () => {
    expect(formatBuiltInOutput({ item: { id: "pm-a" }, omission_receipt: complete }, "toon")).toBe('item:\n  id: "pm-a"\nomission_receipt: complete\n');
    const partial = { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: [{ name: "children", restore_with: "--fields children" }] };
    expect(formatBuiltInOutput({ item: { id: "pm-a" }, omission_receipt: partial }, "toon")).toContain("has_omissions: true");
    expect(JSON.parse(formatBuiltInOutput({ omission_receipt: complete }, "json"))).toEqual({ omission_receipt: complete });
    // Field order does not matter; a receipt with an extra field is not complete.
    expect(formatBuiltInOutput({ omission_receipt: { omitted_field_groups: [], has_omissions: false, omitted_field_group_count: 0 } }, "toon")).toBe("omission_receipt: complete\n");
    expect(formatBuiltInOutput({ omission_receipt: { ...complete, extra: 1 } }, "toon")).toContain("has_omissions: false");
  });

  it("restores only the empty collections an explicit selection kept, in order", () => {
    const selection = { item: { id: "pm-a", tags: [], meta: {}, gone: null, files: [{ path: "a.ts" }] }, omission_receipt: complete };
    const toon = formatBuiltInOutput(selection, "toon", false, { preserveEmptyItemCollections: true });
    expect(toon).toBe('item:\n  id: "pm-a"\n  tags: []\n  meta: {}\n  files[1]{path}:\n    a.ts\nomission_receipt: complete\n');
    expect(formatBuiltInOutput(selection, "toon")).not.toContain("tags");
    // An item whose every requested value is empty still renders each requested key.
    expect(formatBuiltInOutput({ item: { comments: [] } }, "toon", false, { preserveEmptyItemCollections: true })).toBe("item:\n  comments: []\n");
    // Nothing to restore: no item or a scalar result; an empty selection stays visible.
    expect(formatBuiltInOutput({ ok: true }, "toon", false, { preserveEmptyItemCollections: true })).toBe("ok: true\n");
    expect(formatBuiltInOutput({ item: {} }, "toon", false, { preserveEmptyItemCollections: true })).toBe("item: {}\n");
    // A dropped item is restored ahead of the envelope keys that survived.
    expect(formatBuiltInOutput({ item: { comments: [] }, omission_receipt: complete }, "toon", false, { preserveEmptyItemCollections: true })).toBe("item:\n  comments: []\nomission_receipt: complete\n");
    expect(formatBuiltInOutput("value", "toon", false, { preserveEmptyItemCollections: true })).toBe('"value"\n');
  });

  it("drops a two-field read's receipt share below a third", () => {
    // The shape the report measured: pm get <id> --fields id,title,comments on a fresh tracker.
    const before = 'item:\n  id: "lab-mtug"\n  title: "Sample task for budget repro"\nomission_receipt:\n  has_omissions: false\n  omitted_field_group_count: 0\n  omitted_field_groups: []\n';
    const after = formatBuiltInOutput({ item: { id: "lab-mtug", title: "Sample task for budget repro", comments: [] }, omission_receipt: complete }, "toon", false, { preserveEmptyItemCollections: true });
    const receiptShare = (text: string): number => Buffer.byteLength(text.slice(text.indexOf("omission_receipt"))) / Buffer.byteLength(text);
    expect(receiptShare(before)).toBeGreaterThan(1 / 3);
    expect(after).toContain("  comments: []\n");
    expect(receiptShare(after)).toBeLessThan(1 / 3);
  });
});
