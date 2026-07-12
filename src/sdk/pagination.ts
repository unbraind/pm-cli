/**
 * @module sdk/pagination
 *
 * Provides versioned opaque cursor primitives shared by CLI, SDK, MCP, and
 * package-authored query surfaces.
 */
import { createHash } from "node:crypto";
import { PmCliError } from "../core/shared/errors.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { stableStringify } from "../core/shared/serialization.js";

const QUERY_CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface QueryCursorEnvelope {
  version: number;
  fingerprint: string;
  after_id: string;
  after_index?: number;
}

/** Decoded cursor state for advanced package and retrieval-window integrations. */
export interface QueryCursorState {
  /** Stable id of the last row emitted by the previous page. */
  after_id: string;
  /** Zero-based position of that row when the producer supplied one. */
  after_index?: number;
}

/** Describes one stable cursor page over an already ordered query result. */
export interface QueryCursorPage<T> {
  /** Rows contained in the requested page. */
  rows: T[];
  /** Whether another page exists after these rows. */
  has_more: boolean;
  /** Opaque cursor for the next page when one exists. */
  next_cursor?: string;
}

/** Build a compact deterministic fingerprint for a normalized query contract. */
export function createQueryFingerprint(
  command: string,
  contract: unknown,
): string {
  return createHash("sha256")
    .update(command)
    .update("\0")
    .update(stableStringify(contract))
    .digest("hex")
    .slice(0, 24);
}

/** Encode the last emitted item id into a versioned opaque base64url cursor. */
export function encodeQueryCursor(
  fingerprint: string,
  afterId: string,
  afterIndex?: number,
): string {
  return Buffer.from(
    JSON.stringify({
      version: QUERY_CURSOR_VERSION,
      fingerprint,
      after_id: afterId,
      ...(afterIndex === undefined ? {} : { after_index: afterIndex }),
    } satisfies QueryCursorEnvelope),
  ).toString("base64url");
}

function invalidCursor(message: string): PmCliError {
  return new PmCliError(message, EXIT_CODE.USAGE, {
    code: "invalid_query_cursor",
    nextSteps: [
      "Repeat the original query without --after to obtain a fresh cursor.",
    ],
  });
}

/** Return whether an unknown payload is a supported cursor envelope. */
function isQueryCursorEnvelope(value: unknown): value is QueryCursorEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const envelope = value as Partial<QueryCursorEnvelope>;
  return (
    envelope.version === QUERY_CURSOR_VERSION &&
    typeof envelope.fingerprint === "string" &&
    typeof envelope.after_id === "string" &&
    envelope.after_id.length > 0 &&
    (envelope.after_index === undefined ||
      (Number.isSafeInteger(envelope.after_index) &&
        envelope.after_index >= 0))
  );
}

/** Decode and validate complete cursor state against a query fingerprint. */
export function decodeQueryCursorState(
  cursor: unknown,
  expectedFingerprint: string,
): QueryCursorState {
  if (typeof cursor !== "string") {
    throw invalidCursor("Query cursor is malformed.");
  }
  const normalized = cursor.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(normalized)
  ) {
    throw invalidCursor("Query cursor is malformed.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor("Query cursor is malformed.");
  }
  if (!isQueryCursorEnvelope(parsed)) {
    throw invalidCursor("Query cursor version or payload is unsupported.");
  }
  const envelope = parsed;
  if (envelope.fingerprint !== expectedFingerprint) {
    throw invalidCursor(
      `Query cursor does not match the current filters, sort, or query (${envelope.fingerprint} != ${expectedFingerprint}).`,
    );
  }
  return {
    after_id: envelope.after_id,
    ...(envelope.after_index === undefined
      ? {}
      : { after_index: envelope.after_index }),
  };
}

/** Decode and validate a cursor against the normalized query fingerprint. */
export function decodeQueryCursor(
  cursor: unknown,
  expectedFingerprint: string,
): string {
  return decodeQueryCursorState(cursor, expectedFingerprint).after_id;
}

/** Resolve the first row after a validated cursor's stable id tiebreaker. */
export function resolveQueryCursorStart<T>(
  rows: readonly T[],
  cursor: string | undefined,
  fingerprint: string,
  readId: (row: T) => string,
): number {
  if (cursor === undefined) {
    return 0;
  }
  const state = decodeQueryCursorState(cursor, fingerprint);
  const index = rows.findIndex((row) => readId(row) === state.after_id);
  if (index < 0) {
    if (state.after_index !== undefined) {
      return Math.min(state.after_index, rows.length);
    }
    throw invalidCursor(`Query cursor item ${state.after_id} is no longer present in this result set.`);
  }
  return index + 1;
}

/** Page an ordered result through the shared stable cursor contract. */
export function paginateQueryRows<T>(
  rows: readonly T[],
  options: {
    cursor?: string;
    fingerprint: string;
    limit: number;
    readId: (row: T) => string;
  },
): QueryCursorPage<T> {
  const pageStart = resolveQueryCursorStart(
    rows,
    options.cursor,
    options.fingerprint,
    options.readId,
  );
  const pageRows = rows.slice(pageStart, pageStart + options.limit);
  const hasMore =
    pageRows.length > 0 && pageStart + pageRows.length < rows.length;
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows,
    has_more: hasMore,
    ...(hasMore && lastRow !== undefined
      ? {
          next_cursor: encodeQueryCursor(
            options.fingerprint,
            options.readId(lastRow),
            pageStart + pageRows.length - 1,
          ),
        }
      : {}),
  };
}

/** Public pagination constants exposed for package authors and contract tests. */
export const QUERY_CURSOR_CONTRACT = Object.freeze({
  version: QUERY_CURSOR_VERSION,
  max_length: MAX_CURSOR_LENGTH,
});
