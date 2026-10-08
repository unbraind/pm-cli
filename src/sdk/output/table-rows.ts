/**
 * @module sdk/output/table-rows
 *
 * Lossless nested-cell projection for key-hoisted agent tables. Scalar columns
 * retain their types; declared JSON columns and absent coordinates restore the
 * original rows without confusing missing fields with explicit null values.
 */
import type { JsonValue } from "@toon-format/toon";

/** Metadata required to restore nested cells and sparse object rows. */
export interface PmTableCellEncoding {
  /** Columns whose every present cell contains a JSON-serialized value. */
  json_columns: string[];
  /** Missing field coordinates, expressed as [zero-based row, column name]. */
  absent: Array<[number, string]>;
}

/** Primitive rows accepted by the standard TOON tabular encoder. */
export interface PmEncodedTableRows {
  /** Key-hoisted rows with primitive cells and null padding for absent keys. */
  rows: Record<string, string | number | boolean | null>[];
  /** Explicit decoding metadata; never inferred from cell content. */
  encoding: PmTableCellEncoding;
}

/**
 * Project JSON object rows into a lossless table, preserving key order by first
 * occurrence. A column containing any container serializes all present values
 * as JSON so mixed strings, nulls, arrays, and objects remain unambiguous.
 */
export function encodePmTableRows(
  rows: readonly Record<string, JsonValue>[],
): PmEncodedTableRows {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const jsonColumns = columns.filter((column) =>
    rows.some((row) => {
      const cell = row[column];
      return cell !== null && typeof cell === "object";
    }),
  );
  const nested = new Set(jsonColumns);
  const absent: Array<[number, string]> = [];
  const encoded = rows.map(
    (row, index) =>
      Object.fromEntries(
        columns.map((column) => {
          if (!Object.hasOwn(row, column)) {
            absent.push([index, column]);
            return [column, null];
          }
          const cell = row[column]!;
          return [column, nested.has(column) ? JSON.stringify(cell) : cell];
        }),
      ) as PmEncodedTableRows["rows"][number],
  );
  return { rows: encoded, encoding: { json_columns: jsonColumns, absent } };
}

/**
 * Restore rows emitted by {@link encodePmTableRows}. Metadata is explicit, so
 * strings resembling JSON stay strings unless their column declares JSON.
 * Malformed JSON cells throw instead of silently changing their meaning.
 */
export function decodePmTableRows(
  table: PmEncodedTableRows,
): Record<string, JsonValue>[] {
  const nested = new Set(table.encoding.json_columns);
  const absent = new Set(
    table.encoding.absent.map(([row, column]) => JSON.stringify([row, column])),
  );
  return table.rows.map((row, index) =>
    Object.fromEntries(
      Object.entries(row).flatMap(([column, cell]) => {
        if (absent.has(JSON.stringify([index, column]))) return [];
        return [
          [
            column,
            nested.has(column) ? (JSON.parse(String(cell)) as JsonValue) : cell,
          ],
        ];
      }),
    ),
  );
}
