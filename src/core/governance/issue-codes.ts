/**
 * Logical issue-code governance primitives (GH-235).
 *
 * Trackers frequently adopt a title convention that embeds a logical issue
 * code at the START of the title, e.g. `ISSUE-004: ...`, `BUG-12 ...`,
 * `TASK-7 — ...`, `ADR-001`, `RFC-9`. When two distinct items share the same
 * logical code, auditability and duplicate detection both suffer: a human or
 * agent searching for "ISSUE-004" can no longer assume a single canonical item.
 *
 * These primitives detect that condition. They are pure: no IO, no heavy
 * runtime dependencies. Callers pass plain structural item shapes so the logic
 * stays trivially unit-testable.
 */

/** Minimal structural shape needed to detect duplicate issue codes. */
export interface IssueCodeItem {
  id: string;
  title?: string | null;
}

/** A logical issue code shared by two or more items. */
export interface DuplicateIssueCode {
  /** The canonical (normalized, upper-case) issue code, e.g. `ISSUE-004`. */
  code: string;
  /** How many items carry this code. */
  count: number;
  /** The ids of the items carrying this code, sorted ascending. */
  ids: string[];
  /** The titles of the items carrying this code, in the same order as `ids`. */
  titles: string[];
}

/**
 * Match a conventional leading logical issue code: an upper-case alphanumeric
 * prefix (starting with a letter) followed by a `-` separator and a number, at
 * the very start of the title (after optional leading whitespace).
 *
 * Examples that match: `ISSUE-004`, `BUG-12`, `TASK-7`, `ADR-001`, `RFC-9`,
 * `GH-235`, `PM2-14`. The trailing `\b` requires the digit run to end at a word
 * boundary, so `ISSUE-004-extra` extracts `ISSUE-004` while `ISSUE-004foo`
 * (digit immediately followed by a letter — no boundary) does not match.
 */
const ISSUE_CODE_PATTERN = /^([A-Z][A-Z0-9]*-\d+)\b/;

/**
 * Extract the leading logical issue code from a title, or `null` when the title
 * does not begin with one. The title is trimmed and upper-cased before matching
 * so case differences (`issue-004` vs `ISSUE-004`) collapse to one logical
 * code; the returned code is therefore always normalized upper-case.
 *
 * Accepts unknown-ish input defensively (exported helper SDK consumers may call
 * from untyped JS): a non-string or empty title resolves to `null`.
 */
export function extractIssueCode(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim().toUpperCase();
  if (normalized.length === 0) {
    return null;
  }
  const match = ISSUE_CODE_PATTERN.exec(normalized);
  return match ? match[1] : null;
}

/**
 * Find logical issue codes used by 2+ items. Any item whose title begins with a
 * conventional issue code contributes; codes used by a single item are not
 * reported. Status is intentionally NOT considered — a closed item and an open
 * item sharing a code still collide for audit purposes, so both are flagged.
 *
 * Results are deterministic: duplicate groups are sorted by code, and the
 * `ids`/`titles` within each group are sorted by id. The first-seen title for a
 * given (id) is used; duplicate ids (should not occur for a valid corpus) are
 * de-duplicated so an item never inflates its own code's count.
 */
export function findDuplicateIssueCodes(items: readonly IssueCodeItem[]): DuplicateIssueCode[] {
  const byCode = new Map<string, Array<{ id: string; title: string }>>();
  for (const item of items) {
    // A non-string title can never carry a code, so skip it before extraction;
    // this also guarantees every stored title below is a real string.
    if (typeof item.title !== "string") {
      continue;
    }
    const code = extractIssueCode(item.title);
    if (code === null) {
      continue;
    }
    let entries = byCode.get(code);
    if (!entries) {
      entries = [];
      byCode.set(code, entries);
    }
    if (!entries.some((entry) => entry.id === item.id)) {
      entries.push({ id: item.id, title: item.title });
    }
  }

  const duplicates: DuplicateIssueCode[] = [];
  for (const [code, entries] of byCode) {
    if (entries.length < 2) {
      continue;
    }
    const sorted = [...entries].sort((left, right) => left.id.localeCompare(right.id));
    duplicates.push({
      code,
      count: sorted.length,
      ids: sorted.map((entry) => entry.id),
      titles: sorted.map((entry) => entry.title),
    });
  }
  return duplicates.sort((left, right) => left.code.localeCompare(right.code));
}
