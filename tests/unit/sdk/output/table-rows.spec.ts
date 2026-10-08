import { decode, encode, type JsonValue } from "@toon-format/toon";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import fc from "fast-check";
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
