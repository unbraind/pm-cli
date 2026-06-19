/**
 * @module core/output/tabular
 *
 * Renders projected item rows as CSV or fixed-width text tables for human
 * export. These are presentation-only modes (GH-154): agents continue to read
 * the structured `--json`/TOON output, while humans piping `pm list` into a
 * spreadsheet or terminal get a directly consumable shape.
 */

/** A projected row: a flat map of column name to scalar/collection cell value. */
export type TabularRow = Record<string, unknown>;

/**
 * Collects the ordered union of column names across every row, preserving the
 * order in which each key is first encountered so the rendered columns mirror
 * the projection field order rather than an arbitrary object-key order.
 */
function resolveColumns(rows: TabularRow[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

/**
 * Converts a single cell value to its flat string form. Arrays join with `;`
 * (spreadsheet-friendly and unambiguous against the CSV `,` delimiter), objects
 * serialize to compact JSON, and null/undefined render as an empty cell.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderCell(entry)).join(";");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Escapes a CSV field per RFC 4180: values containing the delimiter, a quote,
 * or a line break are wrapped in double quotes with embedded quotes doubled.
 */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Renders rows as RFC 4180 CSV with a header row of column names. Returns an
 * empty string when there are no rows so callers emit nothing rather than a
 * stray blank line.
 */
export function renderRowsAsCsv(rows: TabularRow[]): string {
  if (rows.length === 0) {
    return "";
  }
  const columns = resolveColumns(rows);
  const lines = [columns.map((column) => escapeCsvField(column)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvField(renderCell(row[column]))).join(","));
  }
  return lines.join("\n");
}

/**
 * Renders rows as a fixed-width text table: a header row, a dashed separator,
 * and one padded row per item. Columns are widened to fit their widest cell so
 * the output stays aligned in a monospace terminal. Returns an empty string
 * when there are no rows.
 */
export function renderRowsAsTable(rows: TabularRow[]): string {
  if (rows.length === 0) {
    return "";
  }
  const columns = resolveColumns(rows);
  const cells = rows.map((row) => columns.map((column) => renderCell(row[column])));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((rowCells) => rowCells[index].length)),
  );
  const pad = (value: string, index: number): string => value.padEnd(widths[index]);
  const lines = [columns.map((column, index) => pad(column, index)).join(" | ")];
  lines.push(widths.map((width) => "-".repeat(width)).join("-+-"));
  for (const rowCells of cells) {
    lines.push(rowCells.map((value, index) => pad(value, index)).join(" | "));
  }
  return lines.join("\n");
}
