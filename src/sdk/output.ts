/**
 * @module sdk/output
 *
 * Defines public output-control primitives for extension commands, exporters,
 * renderers, and custom SDK-built hosts.
 */

export {
  SUPPRESS_HOST_OUTPUT_MARKER,
  isHostOutputSuppressed,
  suppressHostOutput,
  type SuppressedHostOutput,
} from "../core/output/output-control.js";

/**
 * Serialize object rows as newline-delimited JSON without adding a trailing
 * newline. CLI hosts can append their final newline while SDK consumers can
 * stream or frame the returned payload themselves.
 *
 * @throws {TypeError} When a row is not a non-null, non-array object.
 */
export function serializeNdjsonRows(rows: readonly unknown[]): string {
  return rows
    .map((row, index) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new TypeError(
          `NDJSON row ${index} must be a non-null object.`,
        );
      }
      return JSON.stringify(row);
    })
    .join("\n");
}
