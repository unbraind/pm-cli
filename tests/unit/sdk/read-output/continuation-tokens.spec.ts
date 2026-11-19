import { afterEach, describe, expect, it } from "vitest";
import { setActiveExtensionRegistrations } from "../../../../src/core/extensions/index.js";
import { isTrackerItemDocumentKey, readCompactionMarker } from "../../../../src/core/shared/text-normalization.js";
import { activateSyntheticExtensions } from "../../../helpers/extensions.js";
import { applyReadOutputDimensions } from "../../../../src/sdk/read-output-contracts.js";
import { attachContextIntentReceipt, attachReadOutputContracts } from "../../../../src/sdk/context-intent-contracts.js";
import { decodeQueryCursorEnvelope } from "../../../../src/sdk/pagination.js";
import { decodeReadOutputContinuationCursor } from "../../../../src/sdk/read-output/continuation.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

/**
 * GH-1710: string compaction shortened next_cursor like any other long string,
 * so --after rejected the cursor the page emitted. A continuation token is
 * machine input for the next call and is never compacted, in either walker.
 */
describe("continuation tokens survive string compaction (GH-1710)", () => {
  const cursor = `eyJ2${"QUJD".repeat(120)}`;
  const page = () => ({
    items: [1, 2, 3].map((index) => ({ id: `pm-${index}`, title: `${"T".repeat(2000)}${index}`, status: "open" })),
    count: 3,
    total: 8,
    has_more: true,
    next_cursor: cursor,
    nested: { section: { next_cursor: cursor, output_cursor: cursor, source_cursor: cursor, cursor, note: "N".repeat(600) } },
  });

  it("keeps every cursor whole while explanatory strings carry the compaction marker", () => {
    for (const format of ["json", "toon"] as const) {
      const bounded = applyReadOutputDimensions("list", { outputFormat: format, outputBudget: 2000 }, page());
      expect(bounded.read_output).toMatchObject({ strings_compacted: true, rows_compacted: false });
      expect(bounded.next_cursor).toBe(cursor);
      expect(bounded.nested.section).toMatchObject({ next_cursor: cursor, output_cursor: cursor, source_cursor: cursor, cursor });
      expect(readCompactionMarker(bounded.items[0]!.title)).toBe(1761);
      expect(readCompactionMarker(bounded.nested.section.note)).toBe(360);
    }
  });

  it("keeps every cursor whole on the context-intent compaction path", () => {
    const intent = attachContextIntentReceipt("list", { for: "triage", tokenBudget: 2000 }, page());
    expect(intent.context_intent).toMatchObject({ degradation: "recursive_budget_compaction" });
    expect(intent.next_cursor).toBe(cursor);
    expect(intent.nested.section).toMatchObject({ next_cursor: cursor, output_cursor: cursor, source_cursor: cursor, cursor });
    expect(readCompactionMarker(intent.items[0]!.title)).toBe(1761);
  });

  it("keeps the omitted count when a second budget stage compacts an intent-compacted page", () => {
    const rows = {
      items: Array.from({ length: 8 }, (_, index) => ({ id: `pm-${index}`, title: `${"T".repeat(2000)}${index}`, status: "open" })),
      count: 8,
      total: 20,
      has_more: true,
      next_cursor: cursor,
    };
    const intent = attachContextIntentReceipt("list", { for: "triage", tokenBudget: 4000 }, rows);
    expect(readCompactionMarker(intent.items[0]!.title)).toBe(1761);
    for (const format of ["json", "toon"] as const) {
      const bounded = applyReadOutputDimensions("list", { outputFormat: format, outputBudget: 800 }, intent);
      expect(bounded.read_output).toMatchObject({ strings_compacted: true, rows_compacted: true, result_omitted: false });
      expect(bounded.items.length).toBeLessThan(8);
      expect(bounded.items.map((item) => readCompactionMarker(item.title))).toEqual(bounded.items.map(() => 1761));
    }
  });

  it("still compacts a non-string value stored under a cursor key", () => {
    const bounded = applyReadOutputDimensions("list", { outputBudget: 2000 }, { ...page(), cursor: { label: "L".repeat(600) } });
    expect(readCompactionMarker(bounded.cursor.label)).toBe(360);
  });

  it("diagnoses a cursor argument a compacted read shortened, on both cursor kinds", () => {
    const capture = (run: () => unknown): PmCliError => {
      try {
        run();
      } catch (error) {
        return error as PmCliError;
      }
      throw new Error("expected a refusal");
    };
    for (const flag of ["--after", "--cursor"] as const) {
      const query = capture(() => decodeQueryCursorEnvelope(`${cursor.slice(0, 240)}…`, flag));
      expect(query.message).toContain("shortened by output compaction");
      expect(query.context).toMatchObject({ code: "invalid_query_cursor", reason: "cursor_compacted" });
      expect(query.context.nextSteps).toEqual([
        expect.stringContaining(`pass its whole next_cursor to ${flag}`),
        `Or repeat the original query without ${flag} to obtain a fresh cursor.`,
      ]);
    }
    const output = capture(() => decodeReadOutputContinuationCursor(`${cursor.slice(0, 240)}…[+111 chars]`));
    expect(output.context).toMatchObject({ code: "read_output_cursor_invalid", reason: "cursor_compacted" });
    expect(output.context.nextSteps).toEqual([expect.stringContaining("--output-cursor")]);
    // A cursor without an ellipsis keeps the generic refusal.
    expect(capture(() => decodeQueryCursorEnvelope("not-a-cursor")).message).toBe("Query cursor is malformed.");
  });
});

/**
 * GH-1754: the GH-1710 exemption keyed on the field name alone, so a tracker
 * item's own field named like a continuation key (a custom next_cursor,
 * output_cursor or sync_cursor) was never compacted and a budgeted list
 * omitted its only row. Only the envelope's tokens are exempt.
 */
describe("tracker item fields named like continuation keys compact like content (GH-1754)", () => {
  const oversized = "x".repeat(30_000);
  const singleRow = (key: string) => ({
    items: [{ id: "demo-one", [key]: oversized }],
    count: 1,
    total: 1,
    has_more: false,
  });

  it("returns the compacted row for every cursor-named item field, with and without an intent, in JSON and TOON", () => {
    for (const format of ["json", "toon"] as const) {
      for (const intent of [{}, { for: "triage" }]) {
        for (const key of ["next_cursor", "output_cursor", "source_cursor", "cursor", "sync_cursor", "ordinary_text"]) {
          const outcome = attachReadOutputContracts("list", { full: true, outputBudget: "2000", resolvedOutputFormat: format, ...intent }, singleRow(key)) as {
            count?: number;
            items?: Array<Record<string, string>>;
            read_output: { result_omitted: boolean };
          };
          expect({ format, intent, key, omitted: outcome.read_output.result_omitted, count: outcome.count }).toEqual({ format, intent, key, omitted: false, count: 1 });
          expect(outcome.items![0]![key]).toHaveLength(255);
          expect(readCompactionMarker(outcome.items![0]![key]!)).toBe(30_000 - 240);
        }
      }
    }
  });

  it("compacts an item's own focus_row_states field; only the envelope's focus-row state stays whole", () => {
    const outcome = attachReadOutputContracts("list", { full: true, outputBudget: "2000", resolvedOutputFormat: "json" }, {
      items: [{ id: "demo-one", focus_row_states: { next_cursor: oversized, note: oversized } }],
      count: 1,
      total: 1,
      has_more: false,
    }) as { count: number; items: Array<{ focus_row_states: { next_cursor: string; note: string } }>; read_output: { result_omitted: boolean } };
    expect({ omitted: outcome.read_output.result_omitted, count: outcome.count }).toEqual({ omitted: false, count: 1 });
    expect(readCompactionMarker(outcome.items[0]!.focus_row_states.next_cursor)).toBe(30_000 - 240);
    expect(readCompactionMarker(outcome.items[0]!.focus_row_states.note)).toBe(30_000 - 240);
  });

  it("compacts cursor-named fields of a single item read and of nested item records", () => {
    const bounded = applyReadOutputDimensions("get", { outputFormat: "json", outputBudget: 2000 }, {
      item: { id: "pm-one", title: "One", sync_cursor: oversized, nested: { next_cursor: oversized } },
    });
    expect(readCompactionMarker(bounded.item.sync_cursor)).toBe(30_000 - 240);
    expect(readCompactionMarker(bounded.item.nested.next_cursor)).toBe(30_000 - 240);
    const intent = attachContextIntentReceipt("list", { for: "triage", tokenBudget: 2000 }, {
      items: [{ id: "pm-one", title: "One", output_cursor: oversized, nested: [{ cursor: oversized }] }],
      count: 1,
      total: 1,
      has_more: false,
    });
    expect(readCompactionMarker(intent.items[0]!.output_cursor)).toBe(30_000 - 240);
    expect(readCompactionMarker(intent.items[0]!.nested[0]!.cursor)).toBe(30_000 - 240);
  });

  it("still delivers the envelope's own continuation tokens whole beside a compacted item field, and the page cursor replays", () => {
    const cursor = `eyJ2${"QUJD".repeat(120)}`;
    const page = {
      items: [1, 2, 3].map((index) => ({ id: `pm-${index}`, title: `${"T".repeat(2000)}${index}`, next_cursor: oversized })),
      count: 3,
      total: 8,
      has_more: true,
      next_cursor: cursor,
      nested: { section: { next_cursor: cursor, output_cursor: cursor } },
    };
    for (const format of ["json", "toon"] as const) {
      const bounded = applyReadOutputDimensions("list", { outputFormat: format, outputBudget: 2000 }, structuredClone(page));
      expect(bounded.next_cursor).toBe(cursor);
      expect(bounded.nested.section).toEqual({ next_cursor: cursor, output_cursor: cursor });
      expect(bounded.items.map((item) => readCompactionMarker(item.next_cursor))).toEqual(bounded.items.map(() => 30_000 - 240));
    }
    const intent = attachContextIntentReceipt("list", { for: "triage", tokenBudget: 2000 }, structuredClone(page));
    expect(intent.next_cursor).toBe(cursor);
    expect(intent.nested.section).toEqual({ next_cursor: cursor, output_cursor: cursor });
    expect(readCompactionMarker(intent.items[0]!.next_cursor)).toBe(30_000 - 240);
    // A real producer page cursor emitted beside compacted cursor-named item fields still replays.
    const producer = Buffer.from(JSON.stringify({ version: 1, fingerprint: "fp", after_id: "pm-3", after_index: 3 })).toString("base64url");
    const replayable = applyReadOutputDimensions("list", { outputFormat: "json", outputBudget: 2000 }, { ...structuredClone(page), next_cursor: producer });
    expect(decodeQueryCursorEnvelope(replayable.next_cursor as string)).toMatchObject({ fingerprint: "fp" });
  });

  it("keeps genuine tokens inside an extension's items rows, which are not tracker items", async () => {
    const activation = await activateSyntheticExtensions([{
      name: "evidence-probe", capabilities: ["commands"], activate(api) {
        api.registerCommand({ name: "probe evidence", read_output: { row_keys: ["items"] }, run: () => ({}) });
      },
    }]);
    setActiveExtensionRegistrations(activation.registrations);
    const token = `eyJ2${"QUJD".repeat(120)}`;
    const outcome = attachReadOutputContracts("probe evidence", { outputBudget: "2000", resolvedOutputFormat: "json" }, {
      items: [{ id: "row-one", evidence: { next_cursor: token }, note: "N".repeat(12_000) }],
      count: 1,
    }) as { items: Array<{ evidence: { next_cursor: string }; note: string }>; read_output: { result_omitted: boolean; strings_compacted: boolean } };
    expect(outcome.read_output).toMatchObject({ result_omitted: false, strings_compacted: true });
    expect(outcome.items[0]!.evidence.next_cursor).toBe(token);
    expect(readCompactionMarker(outcome.items[0]!.note)).toBe(12_000 - 240);
  });

  it("scopes item documents to the native item reads", () => {
    for (const surface of ["get", "list", "search"]) {
      expect(isTrackerItemDocumentKey(surface, "item")).toBe(true);
      expect(isTrackerItemDocumentKey(surface, "items")).toBe(true);
      expect(isTrackerItemDocumentKey(surface, "rows")).toBe(false);
    }
    for (const surface of [undefined, "next", "context", "events", "extension:probe evidence", "extension:list probe"]) {
      expect(isTrackerItemDocumentKey(surface, "items")).toBe(false);
    }
  });
});

afterEach(() => setActiveExtensionRegistrations(null));
