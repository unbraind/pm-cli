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
 * @throws {TypeError} When a row or its `toJSON` projection is not a non-null,
 * non-array object.
 */
export function serializeNdjsonRows(rows: readonly unknown[]): string {
  return rows
    .map((row, index) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new TypeError(
          `NDJSON row ${index} must be a non-null object.`,
        );
      }
      const serialized = JSON.stringify(row);
      if (serialized === undefined) {
        throw new TypeError(
          `NDJSON row ${index} must serialize to a non-null object.`,
        );
      }
      const projected: unknown = JSON.parse(serialized);
      if (
        typeof projected !== "object" ||
        projected === null ||
        Array.isArray(projected)
      ) {
        throw new TypeError(
          `NDJSON row ${index} must serialize to a non-null object.`,
        );
      }
      return serialized;
    })
    .join("\n");
}

/** Terminal metadata that makes an NDJSON batch independently resumable. */
export interface PmNdjsonStreamTrailer {
  /** Producer-owned constant-size fields may extend the shared trailer. */
  readonly [key: string]: unknown;
  /** Stable discriminator that cannot be confused with a domain row. */
  record_type: "pm.stream.trailer";
  /** Number of domain rows preceding this trailer in the batch. */
  count: number;
  /** Whether another row was available when the batch was read. */
  has_more: boolean;
  /** Opaque cursor that resumes strictly after this batch. */
  next_cursor: string | null;
  /** Name of the authoritative or derived source that produced the batch. */
  source: string;
  /** Optional constant-size metadata owned by the stream producer. */
  metadata?: Readonly<Record<string, unknown>>;
}

/** Metadata accepted by {@link serializeNdjsonStream}. */
export type PmNdjsonStreamTrailerInput = Omit<
  PmNdjsonStreamTrailer,
  "record_type"
>;

/**
 * Serialize a bounded NDJSON batch followed by exactly one typed terminal
 * trailer. The result has no trailing newline so callers retain framing
 * control while consumers always receive count and recovery metadata, even
 * for an empty batch.
 */
export function serializeNdjsonStream(
  rows: readonly unknown[],
  trailer: PmNdjsonStreamTrailerInput,
): string {
  return serializeNdjsonRows([
    ...rows,
    { record_type: "pm.stream.trailer", ...trailer },
  ]);
}
