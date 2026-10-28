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
  /** String-array columns joined by a declared delimiter; empty cells restore empty arrays. */
  list_columns?: Record<string, string>;
  /** Columns omitted from every encoded row because every source value is explicit null. */
  null_columns?: string[];
  /** Original first-occurrence column order when omitted null columns need reinsertion. */
  column_order?: string[];
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
 * Allocation is proportional to rows times distinct columns; callers budget
 * that dense grid before encoding sparse inputs. The host formatter preflights
 * automatic candidates and falls back to expanded TOON for sparse grids.
 */
export function encodePmTableRows(
  rows: readonly Record<string, JsonValue>[],
  options: { compact?: boolean } = {},
): PmEncodedTableRows {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const nullColumns = options.compact ? columns.filter(column => rows.every(row => Object.hasOwn(row, column) && row[column] === null)) : [];
  const listColumns = options.compact ? columns.filter(column => rows.every(row => {
    if (!Object.hasOwn(row, column)) return true;
    const cell = row[column];
    return Array.isArray(cell) && cell.every(value => typeof value === "string" && value !== "" && !value.includes(";"));
  })) : [];
  const lists = new Set(listColumns);
  const nulls = new Set(nullColumns);
  const jsonColumns = columns.filter((column) => !lists.has(column) &&
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
        columns.filter(column => !nulls.has(column)).map((column) => {
          if (!Object.hasOwn(row, column)) {
            absent.push([index, column]);
            return [column, null];
          }
          const cell = row[column]!;
          if (lists.has(column)) return [column, (cell as string[]).join(";")];
          return [column, nested.has(column) ? JSON.stringify(cell) : cell];
        }),
      ) as PmEncodedTableRows["rows"][number],
  );
  return { rows: encoded, encoding: { json_columns: jsonColumns, absent,
    ...(listColumns.length ? { list_columns: Object.fromEntries(listColumns.map(column => [column, ";"])) } : {}),
    ...(nullColumns.length ? { null_columns: nullColumns, column_order: columns } : {}),
  } };
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
  const delimiters = new Map(Object.entries(table.encoding.list_columns ?? {}));
  const absent = new Set(
    table.encoding.absent.map(([row, column]) => JSON.stringify([row, column])),
  );
  return table.rows.map((row, index) => {
    const cells = new Map<string, JsonValue>(
      Object.entries(row).flatMap(([column, cell]): Array<[string, JsonValue]> => {
        if (absent.has(JSON.stringify([index, column]))) return [];
        const delimiter = delimiters.get(column);
        const value = delimiter !== undefined
          ? (cell === "" ? [] : String(cell).split(delimiter))
          : nested.has(column) ? (JSON.parse(String(cell)) as JsonValue) : cell;
        return [[column, value]];
      }),
    );
    for (const column of table.encoding.null_columns ?? []) cells.set(column, null);
    const columns = table.encoding.column_order ?? [...cells.keys()];
    return Object.fromEntries(columns.filter(column => cells.has(column)).map(column => [column, cells.get(column)!]));
  });
}
