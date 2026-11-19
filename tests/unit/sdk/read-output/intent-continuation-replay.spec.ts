import { describe, expect, it } from "vitest";
import "../../../../src/core/output/output.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { readCompactionMarker } from "../../../../src/core/shared/text-normalization.js";
import { attachContextIntentReceipt, attachReadOutputContracts } from "../../../../src/sdk/context-intent-contracts.js";
import { registerReadOutputPassHooks, withDeliveredOutputRenderer } from "../../../../src/sdk/read-output-budget.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import {
  decodeReadOutputContinuationCursor,
  encodeReadOutputContinuationCursor,
  readOutputCollectionFingerprint,
} from "../../../../src/sdk/read-output/continuation.js";

/**
 * GH-1753: a budget-driven second triage projection advertised an output
 * cursor that the unchanged replay refused with read_output_cursor_stale.
 *
 * The read-output stage compacted rows while measuring the intent receipt's
 * earlier estimate, so the settled envelope landed one token over its budget
 * once that receipt reported the delivered estimate (989 became 1001). The
 * intent layer then projected again with the overhead charged, keeping 21 rows
 * instead of 22, and bound the cursor to those 21 rows; a replay's first
 * projection keeps 22, so its fingerprint never matched.
 */
type Row = { id: string; title: string; status: string; type: string; priority: number; parent: null; assignee: null; risk: null; blocked_by: null };
type Page = {
  items?: Row[];
  count?: number;
  next_cursor?: string;
  output_budget_exceeded?: unknown;
  output_budget_truncation?: { continuations: Array<{ cursor: string }> };
  read_output: { estimated_tokens: number; within_budget: boolean; result_omitted: boolean };
  context_intent?: { estimated_tokens: number; within_budget: boolean; token_budget: number };
};

const rows = (count: number, titleLength = 106): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `demo-${index}`,
    title: "x".repeat(titleLength),
    status: "open",
    type: "Task",
    priority: 2,
    parent: null,
    assignee: null,
    risk: null,
    blocked_by: null,
  }));

const producerCursor = Buffer.from(JSON.stringify({ version: 1, fingerprint: "fp", after_id: "demo-42", after_index: 42 })).toString("base64url");

/** The reporter's in-memory fixture: 43 rows of a 75-row result, with filter padding moving the envelope size. */
const triageSource = (padding: number, items: Row[] = rows(43)) => ({
  items,
  filters: { tag: "a".repeat(134), padding: "z".repeat(padding) },
  count: 43,
  total: 75,
  has_more: true,
  next_cursor: producerCursor,
});

const triageOptions = (format: "json" | "toon" = "toon", budget = 1000) => ({
  for: "triage",
  outputBudget: String(budget),
  limit: "30",
  outputLimit: "100",
  full: true,
  resolvedOutputFormat: format,
});

const read = (options: Record<string, unknown>, source: Record<string, unknown>): Page =>
  attachReadOutputContracts("list", options, structuredClone(source)) as Page;

const refusal = (run: () => unknown): PmCliError => {
  try {
    run();
  } catch (error) {
    return error as PmCliError;
  }
  throw new Error("expected a refusal");
};

/** Follow every advertised output cursor and return the delivered row ids, page by page. */
function followOutputCursors(options: Record<string, unknown>, source: Record<string, unknown>): string[][] {
  const pages: string[][] = [];
  let page = read(options, source);
  for (let hop = 0; hop < 50; hop += 1) {
    pages.push((page.items ?? []).map((row) => row.id));
    const cursor = page.output_budget_truncation?.continuations[0]?.cursor;
    if (cursor === undefined) return pages;
    page = read({ ...options, outputCursor: cursor }, source);
  }
  throw new Error("output cursors did not terminate");
}

describe("intent read output cursors replay against unchanged rows (GH-1753)", () => {
  it("resumes after the last delivered row at the reported paddings 134, 136 and 138", () => {
    for (const padding of [134, 136, 138]) {
      const source = triageSource(padding);
      const first = read(triageOptions(), source);
      const delivered = first.items!.map((row) => row.id);
      const cursor = first.output_budget_truncation!.continuations[0]!.cursor;
      const second = read({ ...triageOptions(), outputCursor: cursor }, source);
      expect({ padding, resumed: second.items![0]!.id }).toEqual({ padding, resumed: `demo-${delivered.length}` });
      // Both receipts describe the delivered envelope, and it fits the budget it was compacted to.
      expect(first.read_output.estimated_tokens).toBeLessThanOrEqual(1000);
      expect(first.context_intent).toMatchObject({ estimated_tokens: first.read_output.estimated_tokens, within_budget: true });
    }
  });

  it("pages every advertised cursor contiguously across envelope sizes, budgets and encodings", () => {
    let followed = 0;
    let omitted = 0;
    for (const format of ["toon", "json"] as const) {
      for (const budget of [1000, 1400]) {
        for (let padding = 100; padding <= 180; padding += 8) {
          const source = triageSource(padding);
          const first = read(triageOptions(format, budget), source);
          // Every first page delivers rows: an omitted page would make the comparison vacuous.
          if (first.items === undefined) {
            omitted += 1;
            continue;
          }
          const pages = followOutputCursors(triageOptions(format, budget), source);
          const ids = pages.flat();
          // The output cursors page the intent's bounded producer page from its first row without a gap or repeat.
          expect({ format, budget, padding, ids }).toEqual({ format, budget, padding, ids: ids.map((_, index) => `demo-${index}`) });
          if (pages.length > 1) followed += 1;
        }
      }
    }
    // An omitted or single-page result proves nothing about replay, so most configurations must page.
    expect({ followed: followed >= 20, omitted }).toEqual({ followed: true, omitted: 0 });
    // A property sweep over 44 configurations: bounded, but slower under coverage instrumentation.
  }, 120_000);

  it("still refuses the cursor when the source rows changed", () => {
    const source = triageSource(136);
    const cursor = read(triageOptions(), source).output_budget_truncation!.continuations[0]!.cursor;
    const changed = triageSource(136, rows(43).map((row, index) => (index === 3 ? { ...row, title: "changed" } : row)));
    expect(refusal(() => read({ ...triageOptions(), outputCursor: cursor }, changed)).context).toMatchObject({ code: "read_output_cursor_stale" });
  });

  it("refuses a same-length edit that string compaction hides from the delivered rows", () => {
    const longRows = (edited: number | undefined, key: "title" | "sync_cursor") =>
      rows(43).map((row, index) => ({ ...row, [key]: `${"t".repeat(1999)}${index === edited ? "B" : "A"}` }));
    for (const key of ["title", "sync_cursor"] as const) {
      const options = { ...triageOptions("toon", 1000) };
      const first = read(options, triageSource(120, longRows(undefined, key)));
      // The intent compacts the long field, so the delivered rows cannot show the last character.
      expect(readCompactionMarker(String(first.items![0]![key as keyof Row]))).toBe(2000 - 240);
      const cursor = first.output_budget_truncation!.continuations[0]!.cursor;
      const delivered = first.items!.length;
      expect(read({ ...options, outputCursor: cursor }, triageSource(120, longRows(undefined, key))).items![0]!.id).toBe(`demo-${delivered}`);
      expect(refusal(() => read({ ...options, outputCursor: cursor }, triageSource(120, longRows(delivered + 1, key)))).context)
        .toMatchObject({ code: "read_output_cursor_stale" });
    }
  });

  it("resolves include selectors against the delivered envelope, including intent-only sections", () => {
    const source = triageSource(136);
    const sections = read({ ...triageOptions(), outputInclude: "context_intent" }, source);
    expect(sections.context_intent).toMatchObject({ intent: "triage" });
    // A row-field projection binds the projected raw rows and replays after its last delivered row.
    const projected = { ...triageOptions(), outputInclude: "items.id,items.title" };
    const first = read(projected, source);
    const cursor = first.output_budget_truncation!.continuations[0]!.cursor;
    expect(read({ ...projected, outputCursor: cursor }, source).items![0]!.id).toBe(`demo-${first.items!.length}`);
  });

  it("decides a page the read-output stage refused again with the receipts' overhead charged to the intent", () => {
    const now = "2026-11-19T07:00:00.000Z";
    const long = ["description", "acceptance_criteria", "expected_result", "actual_result", "resolution", "close_reason", "manual_estimate_reason", "body", "custom1"];
    const page = (count: number, characters: number) => {
      const items: Array<Record<string, unknown>> = Array.from({ length: count }, (_, index) => ({
        id: `demo-${index}`, title: `Example item ${index}`, type: "Issue", status: "open", priority: 2, tags: [], created_at: now, updated_at: now,
      }));
      for (let index = 0; index * 240 < characters; index += 1) items[0]![long[index]!] = "z".repeat(Math.min(characters - index * 240, 240));
      const producer = Buffer.from(JSON.stringify({ version: 1, fingerprint: "Z".repeat(16), after_id: `demo-${count - 1}`, after_index: count - 1 })).toString("base64url");
      return { items, count, total: 25, has_more: true, next_cursor: producer, filters: { limit: String(count) }, now };
    };
    const options = (count: number) => ({ for: "triage", full: true, limit: String(count), resolvedOutputFormat: "toon", outputRowContract: true, outputBudget: 1000 });
    // The receipts push two rows over; universal compaction's continuation metadata leaves no room even for one.
    const charged = read(options(2), page(2, 1862));
    expect(charged.items!.map((row) => row.id)).toEqual(["demo-0"]);
    expect(charged.read_output.result_omitted).toBe(false);
    expect(charged.read_output.estimated_tokens).toBeLessThanOrEqual(1000);
    expect(JSON.parse(Buffer.from(charged.next_cursor!, "base64url").toString("utf8"))).toMatchObject({ after_id: "demo-0", after_index: 0 });
    // A single row that cannot fit once its receipts are charged keeps the refusal.
    const refused = read(options(1), page(1, 2076));
    expect(refused.output_budget_exceeded).toBeDefined();
    expect(refused.items).toBeUndefined();
    // An include selection keeps the refusal: the selector matches only the later row, which a charged prefix drops.
    const optional = {
      items: [
        { id: "demo-0", title: "x".repeat(60), status: "open", type: "Task", priority: 2 },
        { id: "demo-1", title: "y", status: "open", type: "Task", priority: 2, opt: "o".repeat(20) },
      ],
      count: 2,
      total: 9,
      has_more: true,
      next_cursor: producerCursor,
    };
    // Retrying would revalidate the selector against the shorter prefix and throw for a valid selector.
    const selected = read({ for: "triage", full: true, limit: "2", resolvedOutputFormat: "json", outputBudget: 400, outputInclude: "items.opt" }, optional);
    expect(selected.output_budget_exceeded).toBeDefined();
  });

  it("replays a cursor through the charged retry without a stale refusal or an empty success", () => {
    // Small rows before a large one: the replayed page cannot fit its remaining rows within the budget.
    const mixed = Array.from({ length: 5 }, (_, index) => ({ id: `demo-${index}`, title: "x".repeat(index >= 1 ? 600 : 40), status: "open", type: "Task", priority: 2 }));
    const source = { items: mixed, count: 5, total: 15, has_more: true, next_cursor: producerCursor };
    const options = { for: "triage", limit: "5", full: true, resolvedOutputFormat: "json", outputBudget: "700" };
    let page = read(options, source);
    for (let hop = 0; page.output_budget_truncation !== undefined && hop < 10; hop += 1) {
      // The measuring pass validates the cursor against the same uncompacted binding as the bounded pass.
      page = read({ ...options, outputCursor: page.output_budget_truncation.continuations[0]!.cursor }, source);
      expect(page.output_budget_exceeded !== undefined || page.items!.length > 0).toBe(true);
    }
    // A charged prefix that ends before the cursor's offset keeps the refusal instead of an empty page.
    const now = "2026-11-19T07:00:00.000Z";
    const pair: Array<Record<string, unknown>> = [0, 1].map((index) => ({
      id: `demo-${index}`, title: index === 0 ? "short" : "x".repeat(180), type: "Issue", status: "open", priority: 2, tags: [], created_at: now, updated_at: now,
    }));
    for (const [index, field] of ["description", "acceptance_criteria", "expected_result", "actual_result"].entries()) {
      pair[1]![field] = "z".repeat(Math.min(820 - index * 240, 240));
    }
    const pairCursor = Buffer.from(JSON.stringify({ version: 1, fingerprint: "Z".repeat(16), after_id: "demo-1", after_index: 1 })).toString("base64url");
    const pairSource = { items: pair, count: 2, total: 25, has_more: true, next_cursor: pairCursor, filters: { limit: "2" }, now };
    const pairOptions = { for: "triage", full: true, limit: "2", resolvedOutputFormat: "toon", outputRowContract: true, outputBudget: 700 };
    const first = read(pairOptions, pairSource);
    expect(first.items!.map((row) => row.id)).toEqual(["demo-0"]);
    const replay = read({ ...pairOptions, outputCursor: first.output_budget_truncation!.continuations[0]!.cursor }, pairSource);
    expect(replay.output_budget_exceeded).toBeDefined();
    expect(replay.items).toBeUndefined();
  });

  it("settles a compacted page on the smaller estimate across a digit boundary", () => {
    // The page measures 999 with two three-digit receipt estimates and 1000 with two four-digit ones.
    const fields = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`custom_${index}`, "y".repeat(220)]));
    const page = read({ for: "triage", outputBudget: 999, outputFormat: "toon", outputRowContract: true, full: true }, {
      items: [{ id: "pm-0", title: "x".repeat(500), status: "open", type: "Task", priority: 2, ...fields, label: "z".repeat(21) }],
      count: 1,
      total: 1,
      has_more: false,
    });
    expect(page.items).toHaveLength(1);
    expect(page.read_output).toMatchObject({ estimated_tokens: 999, result_omitted: false });
    expect(page.context_intent).toMatchObject({ estimated_tokens: 999, within_budget: true });
    // Two more label characters: the retry from zero misses too, so the first estimate is restored and the page is omitted.
    const over = read({ for: "triage", outputBudget: 999, outputFormat: "toon", outputRowContract: true, full: true }, {
      items: [{ id: "pm-0", title: "x".repeat(500), status: "open", type: "Task", priority: 2, ...fields, label: "z".repeat(23) }],
      count: 1,
      total: 1,
      has_more: false,
    });
    expect(over.output_budget_exceeded).toBeDefined();
    expect(over.read_output).toMatchObject({ result_omitted: true });
  });

  it("keeps a fitting estimate for a renderer whose layout depends on it, retrying from zero only at a digit boundary", () => {
    // A delivered renderer may print a guide for some estimates; a page that fits as measured keeps that estimate.
    const render = (result: unknown): string => {
      const estimate = Number((result as { read_output?: { estimated_tokens?: unknown } }).read_output?.estimated_tokens);
      const guide = estimate === 0 || (estimate >= 650 && estimate <= 900) ? "g".repeat(1600) : "";
      return `${JSON.stringify(result)}${guide}`;
    };
    const page = withDeliveredOutputRenderer("json", render, () =>
      read({ outputBudget: 600, resolvedOutputFormat: "json" }, {
        items: Array.from({ length: 8 }, (_, index) => ({ id: `pm-${index}`, title: "x".repeat(300) })),
        count: 8,
        total: 8,
        has_more: false,
      }),
    );
    // Settling every candidate from zero lands inside the guide range and omits the page.
    expect(page.read_output).toMatchObject({ result_omitted: false, estimated_tokens: 538 });
    expect(page.items).toHaveLength(3);
  });

  it("fingerprints rows only when a continuation needs them", () => {
    // An SDK row may hold a value the fingerprint cannot serialize; a read that issues no cursor never hashes it.
    const page = read({ for: "triage", outputBudget: "600", outputInclude: "items.id,items.title,items.when", resolvedOutputFormat: "json" }, {
      items: [{ id: "pm-a", title: "x".repeat(3000), when: new Date(Number.NaN) }],
      count: 1,
      total: 1,
      has_more: false,
    });
    expect(page.items).toHaveLength(1);
    expect(page.output_budget_truncation).toBeUndefined();
    expect(readCompactionMarker(page.items![0]!.title)).toBe(3000 - 240);
  });

  it("fails closed on a cursor an earlier release issued over a string-compacted page, and on an edit that compacts to the same text", () => {
    const longRows = rows(43).map((row, index) => ({ ...row, title: `${"t".repeat(1999)}${index}` }));
    const source = triageSource(120, longRows);
    const options = triageOptions();
    // The previous release fingerprinted the rows the intent pass delivered, after string compaction.
    const intent = attachContextIntentReceipt("list", options, structuredClone(source)) as { items: Row[] };
    const legacy = encodeReadOutputContinuationCursor({
      command: "list",
      path: "items",
      offset: 5,
      total_rows: intent.items.length,
      fingerprint: readOutputCollectionFingerprint("items", intent.items, "list"),
    });
    expect(refusal(() => read({ ...options, outputCursor: legacy }, source)).context).toMatchObject({ code: "read_output_cursor_stale" });
    // A field that already ends in a literal compaction marker, replaced by full text that compacts to the same value.
    const marked = (full: boolean) =>
      rows(43).map((row) => ({ ...row, sync_cursor: full ? `${"s".repeat(240)}${"z".repeat(1760)}` : `${"s".repeat(240)}\u2026[+1760 chars]` }));
    const first = read(options, triageSource(120, marked(false)));
    const cursor = first.output_budget_truncation!.continuations[0]!.cursor;
    expect(refusal(() => read({ ...options, outputCursor: cursor }, triageSource(120, marked(true)))).context).toMatchObject({ code: "read_output_cursor_stale" });
  });

  it("issues and replays a cursor over compacted SDK rows that hold a non-JSON value", () => {
    const dated = rows(43).map((row) => ({ ...row, title: "x".repeat(2000), when: new Date(Number.NaN), tags: ["a", "b"] }));
    const source = triageSource(120, dated);
    const first = read(triageOptions(), source);
    const cursor = first.output_budget_truncation!.continuations[0]!.cursor;
    expect(read({ ...triageOptions(), outputCursor: cursor }, source).items![0]!.id).toBe(`demo-${first.items!.length}`);
  });

  it("delivers a compacted page that fits its budget exactly instead of settling it one token over", () => {
    // Measured from an oversized start, a mirrored fit flag reads "false", one byte longer than "true".
    const page = read({ for: "triage", outputBudget: 490, outputFormat: "json", outputRowContract: true }, {
      items: [{ id: "pm-a", title: "x".repeat(300), label: "ppp" }],
      count: 1,
      total: 1,
      has_more: false,
    });
    expect(page.items).toHaveLength(1);
    expect(page.read_output).toMatchObject({ estimated_tokens: 490, result_omitted: false });
    expect(page.context_intent).toMatchObject({ estimated_tokens: 490, within_budget: true });
  });

  it("settles a projection that drops the intent receipt within its budget", () => {
    const page = read({ ...triageOptions("json"), outputInclude: "items" }, triageSource(136));
    expect(page.context_intent).toBeUndefined();
    expect(page.read_output.result_omitted).toBe(false);
    expect(page.read_output.estimated_tokens).toBeLessThanOrEqual(1000);
  });
});

describe("a charged second pass binds its output cursors to the first pass's rows (GH-1753)", () => {
  const firstPass = () => ({ items: rows(22, 400), count: 22, total: 22, has_more: false });
  const chargedPass = () => ({ items: rows(21, 400), count: 21, total: 21, has_more: false });
  const options = () => ({ outputFormat: "json", outputBudget: 2000 }) as Record<string, unknown>;
  const cursorOf = (page: { output_budget_truncation?: { continuations: Array<{ cursor: string }> } }) =>
    page.output_budget_truncation!.continuations[0]!.cursor;

  it("issues the first pass's row count and fingerprint, so the uncharged replay accepts the cursor", () => {
    const reference = decodeReadOutputContinuationCursor(cursorOf(applyReadOutputDimensions("list", options(), firstPass())));
    const bound = options();
    registerReadOutputPassHooks(bound, { continuationBinding: firstPass() });
    const charged = applyReadOutputDimensions("list", bound, chargedPass());
    const issued = decodeReadOutputContinuationCursor(cursorOf(charged));
    expect(issued).toMatchObject({ total_rows: 22, fingerprint: reference.fingerprint, offset: charged.items.length });
    expect(charged.output_budget_truncation!.continuations[0]).toMatchObject({ total_rows: 22, remaining_rows: 22 - charged.items.length });
    // The replay's first pass sees all 22 rows and resumes right after the charged page.
    const replay = applyReadOutputDimensions("list", { ...options(), outputCursor: cursorOf(charged) }, firstPass());
    expect(replay.items[0]!.id).toBe(`demo-${charged.items.length}`);
    // A charged replay validates against the bound rows too, and slices its own shorter collection.
    const chargedReplayOptions = { ...options(), outputCursor: cursorOf(charged) };
    registerReadOutputPassHooks(chargedReplayOptions, { continuationBinding: firstPass() });
    expect(applyReadOutputDimensions("list", chargedReplayOptions, chargedPass()).items[0]!.id).toBe(`demo-${charged.items.length}`);
    // Without the binding, the charged rows are a different snapshot: the cursor bound to them was the defect.
    const unbound = decodeReadOutputContinuationCursor(cursorOf(applyReadOutputDimensions("list", options(), chargedPass())));
    expect(unbound.total_rows).toBe(21);
    expect(refusal(() => applyReadOutputDimensions("list", { ...options(), outputCursor: cursorOf(applyReadOutputDimensions("list", options(), chargedPass())) }, firstPass())).context)
      .toMatchObject({ code: "read_output_cursor_stale" });
  });

  it("keeps a backward collection bound to its own rows", () => {
    const notes = (count: number) => ({
      id: "pm-tail",
      notes: Array.from({ length: count }, (_, index) => ({ index, created_at: "2026-11-01T00:00:00.000Z", text: `${"n".repeat(300)}${index}` })),
      count,
    });
    const bound = { outputBudget: 1500 } as Record<string, unknown>;
    registerReadOutputPassHooks(bound, { continuationBinding: notes(60) });
    const page = applyReadOutputDimensions("notes", bound, notes(50));
    expect(decodeReadOutputContinuationCursor(cursorOf(page))).toMatchObject({ total_rows: 50, direction: "backward" });
  });
});
