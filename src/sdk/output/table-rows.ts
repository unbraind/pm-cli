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
  /** Zero-based original position of each omitted null column, parallel to `null_columns`. */
  null_column_index?: number[];
  /**
   * Legacy full column list accepted on decode. Encoders emit
   * `null_column_index` instead, so one omitted column no longer costs the
   * whole column list in metadata.
   */
  column_order?: string[];
  /** Missing field coordinates, expressed as [zero-based row, column name]. */
  absent: Array<[number, string]>;
}

/**
 * An encoding block in the form the TOON host renders it (GH-1684). Empty
 * `json_columns` and `absent` arrays are left out, and missing cells are
 * grouped by column in `absent_rows`, so consumers recognize the block by its
 * reserved `<collection>_encoding` key rather than by the arrays it carries.
 * {@link decodePmTableRows} accepts this form and every earlier one.
 */
export interface PmRenderedTableCellEncoding
  extends Omit<PmTableCellEncoding, "json_columns" | "absent"> {
  /** Columns whose every present cell contains a JSON-serialized value; omitted when none. */
  json_columns?: string[];
  /** Missing field coordinates as [zero-based row, column name] pairs, as earlier releases rendered them. */
  absent?: Array<[number, string]>;
  /** Missing field coordinates grouped by column: column name to its zero-based row indexes. */
  absent_rows?: Record<string, number[]>;
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
    ...(nullColumns.length
      ? { null_columns: nullColumns, null_column_index: nullColumns.map((column) => columns.indexOf(column)) }
      : {}),
  } };
}

/**
 * Project an encoding for TOON delivery without losing a fact: empty
 * `json_columns` and `absent` arrays are dropped, and absent coordinates are
 * grouped by column. Grouping writes each column name once, so it is smaller
 * whenever a column misses more than one cell, which is the shape of sparse
 * focus rows such as unblocked `pm context` rows.
 */
export function projectPmTableEncodingForToon(
  encoding: PmTableCellEncoding,
): PmRenderedTableCellEncoding {
  const { json_columns: jsonColumns, absent, ...declarations } = encoding;
  const absentRows = new Map<string, number[]>();
  for (const [row, column] of absent) {
    const rows = absentRows.get(column) ?? [];
    rows.push(row);
    absentRows.set(column, rows);
  }
  return {
    ...(jsonColumns.length > 0 ? { json_columns: jsonColumns } : {}),
    ...(absentRows.size > 0 ? { absent_rows: Object.fromEntries(absentRows) } : {}),
    ...declarations,
  };
}

/** Reinsert omitted null columns at their recorded original positions. */
function restoreColumnOrder(encodedColumns: readonly string[], encoding: PmRenderedTableCellEncoding): string[] {
  const nullColumns = encoding.null_columns ?? [];
  const positions = encoding.null_column_index ?? [];
  const columns = [...encodedColumns];
  const insertions = nullColumns
    .map((column, index) => ({ column, position: positions[index] }))
    .filter((entry): entry is { column: string; position: number } => typeof entry.position === "number")
    .sort((left, right) => left.position - right.position);
  for (const { column, position } of insertions) columns.splice(Math.min(position, columns.length), 0, column);
  for (const column of nullColumns) if (!columns.includes(column)) columns.push(column);
  return columns;
}

/**
 * Restore rows emitted by {@link encodePmTableRows}, including the TOON form
 * that omits empty metadata and groups absent cells by column. Metadata is
 * explicit, so strings resembling JSON stay strings unless their column
 * declares JSON. Malformed JSON cells throw instead of silently changing their
 * meaning.
 */
export function decodePmTableRows(table: {
  rows: PmEncodedTableRows["rows"];
  encoding: PmRenderedTableCellEncoding;
}): Record<string, JsonValue>[] {
  const nested = new Set(table.encoding.json_columns ?? []);
  const delimiters = new Map(Object.entries(table.encoding.list_columns ?? {}));
  const absent = new Set([
    ...(table.encoding.absent ?? []).map(([row, column]) => JSON.stringify([row, column])),
    ...Object.entries(table.encoding.absent_rows ?? {}).flatMap(([column, rows]) =>
      rows.map((row) => JSON.stringify([row, column])),
    ),
  ]);
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
    const columns = table.encoding.column_order ?? restoreColumnOrder(Object.keys(row), table.encoding);
    return Object.fromEntries(columns.filter(column => cells.has(column)).map(column => [column, cells.get(column)!]));
  });
}
