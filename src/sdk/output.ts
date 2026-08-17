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
export interface PmNdjsonStreamTrailerInput {
  /** Producer-owned constant-size fields may extend the shared trailer. */
  readonly [key: string]: unknown;
  /** The serializer owns the discriminator and callers cannot override it. */
  readonly record_type?: never;
  /** Number of domain rows preceding the terminal trailer. */
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

/**
 * Serialize a bounded NDJSON batch followed by exactly one typed terminal
 * trailer. The result has no trailing newline so callers retain framing
 * control while consumers always receive count and recovery metadata, even
 * for an empty batch.
 *
 * @throws {TypeError} When the trailer count differs from the number of domain
 * rows or a domain row uses the reserved terminal discriminator.
 */
export function serializeNdjsonStream(
  rows: readonly unknown[],
  trailer: PmNdjsonStreamTrailerInput,
): string {
  if (trailer.count !== rows.length) {
    throw new TypeError(
      `NDJSON trailer count ${trailer.count} does not match ${rows.length} ${rows.length === 1 ? "row" : "rows"}.`,
    );
  }
  for (const [index, row] of rows.entries()) {
    if (
      typeof row === "object" &&
      row !== null &&
      !Array.isArray(row) &&
      Reflect.get(row, "record_type") === "pm.stream.trailer"
    ) {
      throw new TypeError(
        `NDJSON row ${index} uses reserved record_type pm.stream.trailer`,
      );
    }
  }
  return serializeNdjsonRows([
    ...rows,
    { ...trailer, record_type: "pm.stream.trailer" },
  ]);
}
