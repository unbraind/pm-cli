import { decode, encode, type JsonValue } from "@toon-format/toon";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import fc from "fast-check";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { createTestItemId } from "../../../helpers/itemFactory.js";
import { runContext } from "../../../../src/sdk/query/context.js";
import { runUpdate } from "../../../../src/sdk/lifecycle/update.js";
import { describe, expect, it } from "vitest";
import {
  formatBuiltInOutput,
  formatOutput,
} from "../../../../src/core/output/output.js";
import {
  decodePmTableRows,
  encodePmTableRows,
  type PmEncodedTableRows,
} from "../../../../src/sdk/output.js";

const baseline = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/agent-encoding-baseline.json", import.meta.url),
    "utf8",
  ),
) as {
  measurements: Array<{
    surface: string;
    size: number;
    selected_tokens: number;
    baseline_tokens: number;
    selected_bytes: number;
  }>;
};

/** Restore declared cells independently of the formatter's table-selection policy. */
function restoreTables(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(restoreTables);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, cell]) => [key, restoreTables(cell)]),
  );
  for (const [key, cell] of Object.entries(value)) {
    const metadata = value[`${key}_encoding`];
    if (
      Array.isArray(cell) &&
      metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      Array.isArray(metadata.json_columns) &&
      Array.isArray(metadata.absent)
    ) {
      result[key] = decodePmTableRows({
        rows: cell,
        encoding: metadata,
      } as PmEncodedTableRows);
      delete result[`${key}_encoding`];
    }
  }
  return result;
}

/** Reproducible non-private results with distinct ranking, provenance, and count facts. */
function fixture(surface: string, size: number): Record<string, JsonValue> {
  const rows = Array.from({ length: size }, (_, index) => ({
    id: `pm-example-${index}`,
    title: `Preserve project context ${index}`,
    status: "open",
    tags: ["sdk", "context"],
    rank: index + 1,
    ...(surface === "search" ? { matched_fields: ["title", "notes"] } : {}),
    ...(surface === "next"
      ? { readiness: { actionable: true, blockers: ["pm-policy"] } }
      : {}),
    ...(surface === "context"
      ? { reasons: ["priority", "dependency"], score: 100 - index }
      : {}),
  }));
  if (surface === "get")
    return {
      item: {
        id: "pm-example",
        title: "Preserve project context",
        collection_counts: { notes: size, tests: size },
        notes: rows.map((row) => ({ text: row.title, tags: row.tags })),
        tests: rows.map((row) => ({
          command: `pm get ${row.id}`,
          expected: { status: "open" },
        })),
      },
    };
  return {
    [surface === "next"
      ? "ready"
      : surface === "context"
        ? "low_level"
        : "items"]: rows,
    count: size,
    provenance: { source: "authoritative", complete: true },
  };
}

/** Compare declared row encodings, retaining field names and independent restoration metadata. */
function projectCandidate(value: JsonValue, ordinal: boolean): JsonValue {
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every(
        (cell) =>
          cell !== null && typeof cell === "object" && !Array.isArray(cell),
      )
    ) {
      const rows = value as Record<string, JsonValue>[];
      if (ordinal) {
        const columns = Object.keys(rows[0]!);
        return {
          columns,
          rows: rows.map((row) => columns.map((column) => row[column]!)),
        };
      }
      return encodePmTableRows(rows) as unknown as JsonValue;
    }
    return value.map((cell) => projectCandidate(cell, ordinal));
  }
  return value !== null && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).map(([key, cell]) => [
          key,
          projectCandidate(cell, ordinal),
        ]),
      )
    : value;
}

/** Restore benchmark-only candidates without relying on their size or renderer selection. */
function restoreCandidate(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(restoreCandidate);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value.rows) && Array.isArray(value.columns)) {
    const columns = value.columns as string[];
    return value.rows.map((row) =>
      Object.fromEntries(
        columns.map((column, index) => [
          column,
          restoreCandidate((row as JsonValue[])[index]!),
        ]),
      ),
    );
  }
  if (
    Array.isArray(value.rows) &&
    value.encoding !== null &&
    typeof value.encoding === "object"
  ) {
    return decodePmTableRows(value as unknown as PmEncodedTableRows);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, cell]) => [key, restoreCandidate(cell)]),
  );
}

describe("lossless SDK table cells", () => {
  it("preserves native context agenda facts while reducing brief and standard output", async () => {
    await withTempPmPath(async context => {
      for (let index = 0; index < 10; index += 1) {
        const id = createTestItemId(context, { title: `Agenda ${index}`, deadline: "2099-01-01T09:00:00Z", tags: "automation,ci,fleet,release" });
        await runUpdate(id, { reminder: ["at=2099-01-02T09:00:00Z,text=Follow up"], event: ["start=2099-01-03T09:00:00Z,title=Review"] }, { path: context.pmPath });
      }
      for (const depth of ["brief", "standard", "full"]) {
        const result = await runContext({ depth, limit: "30", tokenBudget: 100000 }, { path: context.pmPath });
        expect(new Set(result.agenda.events.map(event => event.kind))).toEqual(new Set(["deadline", "reminder", "event"]));
        const facts = JSON.parse(JSON.stringify({ agenda: result.agenda, low_level: result.low_level }));
        const rendered = formatBuiltInOutput(facts, "toon");
        expect(restoreTables(decode(rendered))).toEqual(facts);
        expect(JSON.parse(formatBuiltInOutput(facts, "json"))).toEqual(facts);
        expect(rendered).toContain("null_columns");
        expect(countTokens(rendered)).toBeLessThan(countTokens(encode(facts)));
      }
    });
  });

  it("encodes omitted null columns by position so one null column no longer costs the whole column list (GH-1627)", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `pm-${index}`,
      title: `Ready ${index}`,
      priority: 1,
      order: null,
      deadline: index === 1 ? "2099-01-01T00:00:00.000Z" : null,
      assignee: index === 2 ? "agent" : null,
      tags: ["agent-ux", "github"],
      rank: index + 1,
    }));
    const compact = encodePmTableRows(rows, { compact: true });
    expect(compact.encoding.null_columns).toEqual(["order"]);
    expect(compact.encoding.null_column_index).toEqual([3]);
    expect(compact.encoding.column_order).toBeUndefined();
    expect(decodePmTableRows(compact)).toEqual(rows);
    expect(Object.keys(decodePmTableRows(compact)[0]!)).toEqual(Object.keys(rows[0]!));
    const plain = encodePmTableRows(rows, { compact: false });
    const size = (table: PmEncodedTableRows): number =>
      Buffer.byteLength(encode({ ready: table.rows, ready_encoding: table.encoding }));
    expect(size(compact)).toBeLessThan(size(plain));
    const rendered = formatBuiltInOutput({ ready: rows }, "toon");
    expect(rendered).toContain("list_columns");
    expect(rendered).toContain("null_column_index");
    expect(rendered).not.toContain("column_order");
    expect(restoreTables(decode(rendered))).toEqual({ ready: rows });
  });

  it("still restores rows that carry legacy column_order metadata", () => {
    const table: PmEncodedTableRows = {
      rows: [{ b: 1 }],
      encoding: { json_columns: [], absent: [], null_columns: ["a", "c"], column_order: ["a", "b", "c"] },
    };
    expect(decodePmTableRows(table)).toEqual([{ a: null, b: 1, c: null }]);
    expect(Object.keys(decodePmTableRows(table)[0]!)).toEqual(["a", "b", "c"]);
    const positional: PmEncodedTableRows = {
      rows: [{ b: 1 }],
      encoding: { json_columns: [], absent: [], null_columns: ["a", "c"], null_column_index: [0, 2] },
    };
    expect(Object.keys(decodePmTableRows(positional)[0]!)).toEqual(["a", "b", "c"]);
    const unpositioned: PmEncodedTableRows = {
      rows: [{ b: 1 }],
      encoding: { json_columns: [], absent: [], null_columns: ["a", "c"], null_column_index: [0] },
    };
    expect(Object.keys(decodePmTableRows(unpositioned)[0]!)).toEqual(["a", "b", "c"]);
    const legacy: PmEncodedTableRows = {
      rows: [{ b: 1 }],
      encoding: { json_columns: [], absent: [], null_columns: ["a"] },
    };
    expect(Object.keys(decodePmTableRows(legacy)[0]!)).toEqual(["b", "a"]);
  });

  it("compacts agenda null columns and safe string lists with exact restoration", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      item_id: `pm-${index}`, kind: "deadline", event_title: null, event_end: null,
      event_location: null, event_all_day: null, event_timezone: null,
      event_recurring: null, event_recurrence_rule: null,
      tags: index === 0 ? [] : ["automation", "ci", "fleet", "release"],
    }));
    const table = encodePmTableRows(rows, { compact: true });
    expect(table.encoding.list_columns).toEqual({ tags: ";" });
    expect(table.encoding.null_columns).toContain("event_title");
    expect(table.rows[1]).toMatchObject({ tags: "automation;ci;fleet;release" });
    expect(table.rows[0]).not.toHaveProperty("event_title");
    expect(decodePmTableRows(table)).toEqual(rows);
    expect(Object.keys(decodePmTableRows(table)[0]!)).toEqual(Object.keys(rows[0]!));
    expect(Object.keys(decodePmTableRows(encodePmTableRows([{ a: null, b: 1 }], { compact: true }))[0]!)).toEqual(["a", "b"]);
    const source = { agenda: { events: rows } };
    const rendered = formatBuiltInOutput(source, "toon");
    expect(restoreTables(decode(rendered))).toEqual(source);
    expect(JSON.parse(formatBuiltInOutput(source, "json"))).toEqual(source);
    expect(Buffer.byteLength(rendered)).toBeLessThan(Buffer.byteLength(encode(source)));
    expect(countTokens(rendered)).toBeLessThan(countTokens(encode(source)));
    for (const tags of [["a;b"], [""], [",", '"', "\\", "\n", "雪"], []]) {
      const facts = [{ tags, nil: null }, { tags: ["normal"], nil: null }];
      expect(decodePmTableRows(encodePmTableRows(facts, { compact: true }))).toEqual(facts);
    }
  });

  it("retains reserved JSON row keys through native and lean host projection", () => {
    const rows: Record<string, JsonValue>[] = JSON.parse('[{"id":"one","__proto__":{"value":1,"empty":[]},"constructor":[]},{"id":"two","__proto__":{"value":2,"nil":null},"constructor":{}}]');
    const before = structuredClone(rows);
    const source = { items: rows };
    expect(restoreTables(decode(formatBuiltInOutput(source, "toon")))).toEqual(source);
    expect(JSON.parse(formatOutput(source, { json: true, lean: true }))).toEqual({
      items: JSON.parse('[{"id":"one","__proto__":{"value":1}},{"id":"two","__proto__":{"value":2}}]'),
    });
    expect(rows).toEqual(before);
  });

  it("preserves context null cells and nested empty row values without inventing absent fields", () => {
    const high_level = Array.from({ length: 12 }, (_, index) => ({
      id: `pm-${index}`,
      title: `Context ${index}`,
      assignee: null,
      parent: index % 2 === 0 ? "pm-parent" : null,
      deadline: null,
      order: null,
    }));
    const source = {
      high_level,
      low_level: [
        { id: "one", cell: null, nested: { empty: [], nil: null }, tags: [] },
        { id: "two", nested: { empty: {} }, tags: [] },
        {},
      ],
    };
    const text = formatBuiltInOutput(source, "toon");
    expect(restoreTables(decode(text))).toEqual(source);
    expect(text).toContain("null_columns");
    expect(text).toContain("high_level[12]{id,title,parent}");
    expect(JSON.parse(formatBuiltInOutput(source, "json"))).toEqual(source);
    expect(
      JSON.parse(formatOutput(source, { json: true, lean: true })),
    ).toEqual({
      high_level: high_level.map(({ id, title, parent }) => ({
        id,
        title,
        ...(parent === null ? {} : { parent }),
      })),
      low_level: [{ id: "one" }, { id: "two" }],
    });
  });

  it("restores mixed columns, sparse keys, nulls, empty values, and strings resembling JSON", () => {
    const rows = [
      {
        id: "one",
        cell: ["x,y", '"quoted"', "\n", "雪"],
        empty: {},
        flag: false,
      },
      { id: "two", cell: "[1]", empty: [], count: 0 },
      { id: "three", cell: null, flag: true },
      {},
    ];
    const table = encodePmTableRows(rows);
    expect(table.encoding.json_columns).toEqual(["cell", "empty"]);
    expect(table.encoding.absent).toContainEqual([2, "empty"]);
    expect(decodePmTableRows(table)).toEqual(rows);
    expect(decodePmTableRows(encodePmTableRows([]))).toEqual([]);
  });

  it("rejects corrupted JSON cells and leaves ordinary scalar strings untouched", () => {
    expect(() =>
      decodePmTableRows({
        rows: [{ cell: "{" }],
        encoding: { json_columns: ["cell"], absent: [] },
      }),
    ).toThrow(SyntaxError);
    const rows = [{ cell: "{", n: 0, flag: false, nil: null }];
    expect(decodePmTableRows(encodePmTableRows(rows))).toEqual(rows);
  });

  it("round-trips arbitrary JSON facts, sparse columns, and reserved-looking keys", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.dictionary(
            fc.oneof(fc.string(), fc.constant("__proto__")),
            fc.jsonValue(),
          ),
          { maxLength: 12 },
        ),
        (rows) => {
          expect(decodePmTableRows(encodePmTableRows(rows))).toEqual(rows);
          expect(decodePmTableRows(encodePmTableRows(rows, { compact: true }))).toEqual(rows);
        },
      ),
      { seed: 1401, numRuns: 100 },
    );
  });

  it("keeps producer encoding fields and falls back when metadata costs more than expansion", () => {
    const source = {
      items: [
        { id: "one", tags: ["a"] },
        { id: "two", tags: ["b"] },
      ],
      items_encoding: "producer fact",
    };
    expect(restoreTables(decode(formatBuiltInOutput(source, "toon")))).toEqual(
      source,
    );
    expect(formatBuiltInOutput({ items: source.items }, "toon")).not.toContain(
      "items_encoding",
    );
  });

  it("preserves sparse scalar rows with distinct fields through the public renderer", () => {
    const source = {
      items: Array.from({ length: 64 }, (_, index) => ({
        id: `row-${index}`,
        [`field_${index}`]: `fact-${index}`,
      })),
    };
    const restored = restoreTables(decode(formatBuiltInOutput(source, "toon")));
    expect(restored).toEqual(source);
    expect(JSON.parse(formatBuiltInOutput(source, "json"))).toEqual(source);
  });

  it("renders 10,000 sparse rows without exhausting a real bounded Node heap", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--input-type=module",
        "--eval",
        `
import { deepStrictEqual } from "node:assert";
import { decode } from "@toon-format/toon";
import { formatBuiltInOutput } from "./dist/core/output/output.js";

const source = {
  items: Array.from({ length: 10_000 }, (_, index) => ({
    id: "row-" + index,
    ["field_" + index]: "fact-" + index,
  })),
};
const restored = decode(formatBuiltInOutput(source, "toon"));
deepStrictEqual(restored, source);
console.log(JSON.stringify({ ok: true, rows: source.items.length }));
`,
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ ok: true, rows: 10_000 });
  });

  it("removes only equal count aliases in TOON and preserves zero counts and distinct values", () => {
    const item = {
      collection_counts: { notes: 0, tests: 2 },
      notes_count: 0,
      tests_count: 3,
    };
    const text = formatBuiltInOutput({ item }, "toon");
    expect(text).not.toContain("notes_count");
    expect(text).toContain("notes: 0");
    expect(text).toContain("tests_count: 3");
    expect(JSON.parse(formatBuiltInOutput({ item }, "json"))).toEqual({ item });
    expect(formatBuiltInOutput({ notes_count: 2 }, "toon")).toContain(
      "notes_count: 2",
    );
  });

  it("preserves collection count aliases in explicit lean JSON", () => {
    const item = {
      id: "pm-example",
      collection_counts: { notes: 0, tests: 2 },
      notes_count: 0,
      tests_count: 2,
    };
    const result = { item, items: [item] };
    expect(
      JSON.parse(formatOutput(result, { json: true, lean: true })),
    ).toEqual(result);
  });
});

describe("information-equivalent encoding gate (o200k_base)", () => {
  for (const surface of ["search", "next", "context", "get"]) {
    for (const size of [1, 8, 32]) {
      it(`${surface}/${size}: retains every fact within the measured token ratchet`, () => {
        const source = fixture(surface, size);
        const expanded = encode(source);
        const selected = formatBuiltInOutput(source, "toon");
        const candidates = [
          JSON.stringify(source, null, 2),
          expanded,
          encode(projectCandidate(source, false)),
          encode(projectCandidate(source, true)),
          selected,
        ];
        expect(candidates.map((text) => countTokens(text))).toHaveLength(5);
        expect(JSON.parse(candidates[0]!)).toEqual(source);
        expect(restoreCandidate(decode(candidates[2]!))).toEqual(source);
        expect(restoreCandidate(decode(candidates[3]!))).toEqual(source);
        const restored = restoreTables(decode(selected));
        expect(restored).toEqual(source);
        expect(decode(expanded)).toEqual(source);
        const ceiling = baseline.measurements.find(
          (row) => row.surface === surface && row.size === size,
        )!;
        expect(countTokens(selected)).toBeLessThanOrEqual(
          ceiling.selected_tokens,
        );
        expect(countTokens(selected)).toBeLessThan(ceiling.baseline_tokens);
        expect(Buffer.byteLength(selected)).toBeLessThanOrEqual(
          ceiling.selected_bytes,
        );
        // A smaller answer that loses a nested fact must fail equivalence.
        const missing = JSON.parse(JSON.stringify(restored)) as Record<
          string,
          JsonValue
        >;
        delete missing.provenance;
        if (surface === "get") delete missing.item;
        expect(missing).not.toEqual(source);
      });
    }
  }
});
