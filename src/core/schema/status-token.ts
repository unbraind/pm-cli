/**
 * @module core/schema/status-token
 *
 * Owns the canonical bounded status-token normalization primitive used by
 * schema files, runtime registries, workflows, and package-facing SDK helpers.
 */
import { evictOldestMemoEntries } from "../shared/memo.js";

const STATUS_TOKEN_MEMO_MAX_ENTRIES = 2_000;
const statusTokenMemo = new Map<string, string>();

/** Lowercase a status token and collapse whitespace or hyphen runs to one underscore. */
export function normalizeStatusToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const memoized = statusTokenMemo.get(value);
  if (memoized !== undefined) {
    return memoized;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
  if (statusTokenMemo.size >= STATUS_TOKEN_MEMO_MAX_ENTRIES) {
    evictOldestMemoEntries(statusTokenMemo);
  }
  statusTokenMemo.set(value, normalized);
  return normalized;
}
