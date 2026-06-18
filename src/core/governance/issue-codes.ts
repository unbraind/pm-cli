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
  /**
   * The id of this item's parent, when it is a child in a hierarchy. Used to
   * suppress false positives where a child intentionally reuses its parent's
   * code prefix (the `PARENT` + `PARENT-T0n` task-breakdown convention, GH-275):
   * when an item's parent is another item in the same code group, the shared
   * code is by design and the child does not constitute a collision.
   */
  parent?: string | null;
  /**
   * The id of the canonical item this one was closed as a duplicate of, when
   * set. A closed-as-duplicate item has already been adjudicated, so it is
   * excluded from collision detection entirely (GH-278) — re-flagging a
   * resolved duplicate is permanent noise that erodes trust in `validate`.
   */
  duplicate_of?: string | null;
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

/** Test whether a value is a usable (non-empty after trim) item-id reference. */
function isNonEmptyIdReference(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Find logical issue codes used by 2+ items. Any item whose title begins with a
 * conventional issue code contributes; codes used by a single item are not
 * reported. Status is intentionally NOT considered for genuine collisions — a
 * closed item and an open item sharing a code still collide for audit purposes.
 *
 * Two adjudicated/by-design cases are excluded so `validate` output stays
 * trustworthy in real trackers (GH-275, GH-278):
 *
 * - **Closed-as-duplicate** (GH-278): an item with a non-empty `duplicate_of`
 *   has already been resolved against its canonical keeper, so it is dropped
 *   before grouping and never contributes to a collision.
 * - **Parent/child prefix sharing** (GH-275): the `PARENT` + `PARENT-T0n`
 *   task-breakdown convention makes a child's title share the parent's code.
 *   Within each code group, any item whose `parent` is another item in the same
 *   group is dropped, because the shared code is intentional hierarchy, not a
 *   collision. A genuine duplicate (two items with the same code, neither the
 *   parent of the other) still surfaces after this filtering.
 *
 * Results are deterministic: duplicate groups are sorted by code, and the
 * `ids`/`titles` within each group are sorted by id. The first-seen title for a
 * given (id) is used; duplicate ids (should not occur for a valid corpus) are
 * de-duplicated so an item never inflates its own code's count.
 */
export function findDuplicateIssueCodes(items: readonly IssueCodeItem[]): DuplicateIssueCode[] {
  const byCode = new Map<string, Array<{ id: string; title: string; parent: string | null }>>();
  for (const item of items) {
    // A non-string title can never carry a code, so skip it before extraction;
    // this also guarantees every stored title below is a real string.
    if (typeof item.title !== "string") {
      continue;
    }
    // GH-278: an item closed as a duplicate of another is already adjudicated.
    if (isNonEmptyIdReference(item.duplicate_of)) {
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
      entries.push({ id: item.id, title: item.title, parent: isNonEmptyIdReference(item.parent) ? item.parent.trim() : null });
    }
  }

  const duplicates: DuplicateIssueCode[] = [];
  for (const [code, entries] of byCode) {
    if (entries.length < 2) {
      continue;
    }
    // GH-275: drop children whose parent is another item carrying the same code
    // (intentional `PARENT` + `PARENT-T0n` breakdown), then re-check the group.
    // The parent reference is resolved only against the same-code group on
    // purpose: a child is by-design noise solely when its parent shares the code
    // (resolving against the full corpus would suppress genuinely colliding
    // siblings whose parent merely exists elsewhere). Comparison is
    // case-insensitive so a `parent` reference recorded in a different case than
    // the canonical id (e.g. an upper-case `id_prefix`) still matches.
    const idsInGroup = new Set(entries.map((entry) => entry.id.toLowerCase()));
    const collisionEntries = entries.filter(
      (entry) => entry.parent === null || !idsInGroup.has(entry.parent.toLowerCase()),
    );
    if (collisionEntries.length < 2) {
      continue;
    }
    const sorted = [...collisionEntries].sort((left, right) => left.id.localeCompare(right.id));
    duplicates.push({
      code,
      count: sorted.length,
      ids: sorted.map((entry) => entry.id),
      titles: sorted.map((entry) => entry.title),
    });
  }
  return duplicates.sort((left, right) => left.code.localeCompare(right.code));
}
