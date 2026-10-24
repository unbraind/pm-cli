/**
 * @module sdk/query/window-pagination
 *
 * Keeps time-relative query pages on one clock and refuses changed matching rows.
 */
import { nowIso, EXIT_CODE, PmCliError } from "../runtime-primitives.js";
import {
  createQueryFingerprint,
  decodeQueryCursorEnvelope,
  decodeQueryCursorState,
  paginateQueryRows,
} from "../pagination.js";

/** Recover the original evaluation clock from a producer-specific query cursor. */
export function resolveWindowQueryClock(command: string, after?: string): string {
  if (after === undefined) return nowIso();
  const snapshot = decodeQueryCursorEnvelope(after).snapshot;
  const prefix = `${command}:`;
  const clock = snapshot?.slice(prefix.length);
  if (!snapshot?.startsWith(prefix) || !clock || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(clock) || !Number.isFinite(Date.parse(clock))) {
    throw new PmCliError("Query cursor has no supported fixed-window clock.", EXIT_CODE.USAGE, {
      code: "invalid_query_cursor",
      nextSteps: ["Repeat the original query without --after to obtain a fresh cursor."],
    });
  }
  return clock;
}

/** Page a deterministic matching set, preserving duplicate rows by their position. */
export function paginateWindowQuery<T>(
  rows: readonly T[],
  options: { command: string; after?: string; clock: string; query: unknown; limit?: number },
): { rows: T[]; count: number; total_count: number; page_start: number; omitted_count: number; has_more: boolean; next_cursor?: string } {
  const indexed = rows.map((row, index) => ({ row, index }));
  const fingerprint = createQueryFingerprint(options.command, { query: options.query, rows });
  const state = options.after === undefined ? undefined : decodeQueryCursorState(options.after, fingerprint);
  if (state && (state.after_index === undefined || state.after_id !== String(state.after_index) || state.after_index >= rows.length)) {
    throw new PmCliError("Query cursor position is outside the matching window.", EXIT_CODE.USAGE, {
      code: "invalid_query_cursor",
      nextSteps: ["Repeat the original query without --after to obtain a fresh cursor."],
    });
  }
  const page = paginateQueryRows(indexed, {
    cursor: options.after,
    fingerprint,
    snapshot: `${options.command}:${options.clock}`,
    limit: options.limit ?? rows.length,
    readId: ({ index }) => String(index),
  });
  const pageStart = state?.after_index === undefined ? 0 : state.after_index + 1;
  return {
    ...page,
    rows: page.rows.map(({ row }) => row),
    count: page.rows.length,
    total_count: rows.length,
    page_start: pageStart,
    omitted_count: rows.length - pageStart - page.rows.length,
    has_more: pageStart + page.rows.length < rows.length,
  };
}
