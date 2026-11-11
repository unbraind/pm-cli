/**
 * @module sdk/lifecycle/dependency-removal
 *
 * Lossless dependency-row removal for `pm update` (pm-4yxzvd): stored-row
 * identity, `--dep-remove` selector matching, the zero-match refusal, and the
 * `dependencies_removed` receipt that names every row an update dropped.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { Dependency } from "../../types/index.js";

/** Selects stored dependency rows for `--dep-remove`; `id` is absent only for the kind-wide form. */
export interface DependencyRemovalSelector {
  /** Absent only for the explicit kind-wide form `kind=<kind>` (pm-4yxzvd). */
  id?: string;
  /** Exact stored relationship kind the row must carry. */
  kind?: string;
  /** Stored provenance source kind the row must carry, compared case-insensitively. */
  source_kind?: string;
  /** Stored author the row must carry, compared case-insensitively. */
  author?: string;
  /** Normalized ISO creation instant the row must carry. */
  created_at?: string;
}

/** Return the complete normalized identity of one stored dependency row. */
export function storedDependencyIdentityKey(
  value: Pick<
    Dependency,
    "id" | "kind" | "source_kind" | "author" | "created_at"
  >,
): string {
  const sourceKind = value.source_kind?.trim().toLowerCase() ?? "";
  const author = value.author?.trim().toLowerCase() ?? "";
  const rawCreatedAt = value.created_at?.trim() ?? "";
  const parsedCreatedAt = Date.parse(rawCreatedAt);
  const createdAt = Number.isFinite(parsedCreatedAt)
    ? new Date(parsedCreatedAt).toISOString()
    : rawCreatedAt;
  return [
    value.id.trim().toLowerCase(),
    value.kind,
    sourceKind,
    author,
    createdAt,
  ].join("\u0000");
}

/** Whether a stored dependency row matches one `--dep-remove` selector on every coordinate it names. */
export function matchesDependencySelector(
  value: Dependency,
  selector: DependencyRemovalSelector,
): boolean {
  if (
    selector.id !== undefined &&
    value.id.trim().toLowerCase() !== selector.id.trim().toLowerCase()
  ) {
    return false;
  }
  if (selector.kind && value.kind !== selector.kind) {
    return false;
  }
  if (
    selector.source_kind !== undefined &&
    value.source_kind?.trim().toLowerCase() !==
      selector.source_kind.trim().toLowerCase()
  ) {
    return false;
  }
  if (
    selector.author !== undefined &&
    value.author?.trim().toLowerCase() !== selector.author.trim().toLowerCase()
  ) {
    return false;
  }
  if (
    selector.created_at !== undefined &&
    (value.created_at === undefined ||
      !Number.isFinite(Date.parse(value.created_at)) ||
      new Date(Date.parse(value.created_at)).toISOString() !==
        selector.created_at)
  ) {
    return false;
  }
  return true;
}

/** Refuse lossless removals unless every selector resolves against stored edges. */
export function assertDependencyRemovalSelectorsMatch(
  current: readonly Dependency[],
  selectors: readonly DependencyRemovalSelector[],
  itemId: string,
): void {
  const unmatchedSelectors = selectors.filter(
    (selector) =>
      !current.some((entry) => matchesDependencySelector(entry, selector)),
  );
  if (unmatchedSelectors.length === 0) {
    return;
  }
  throw new PmCliError(
    `Dependency removal did not match ${unmatchedSelectors.length === 1 ? "a stored edge" : "stored edges"}.`,
    EXIT_CODE.NOT_FOUND,
    {
      code: "dependency_remove_no_match",
      reason: "selector_not_found",
      // The kind-wide selector names no id; "*" keeps the declared string id.
      unmatched_selectors: unmatchedSelectors.map((selector) => ({
        ...selector,
        id: selector.id ?? "*",
      })),
      available_dependencies: current.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        source_kind: entry.source_kind,
        author: entry.author,
        created_at: entry.created_at,
      })),
      why: "Failing on a zero-match selector prevents a mistyped dependency removal from being reported as successful.",
      nextSteps: [
        `Inspect the current item with: pm get ${itemId} --full`,
        "Retry --dep-remove with the exact id plus any kind, source_kind, author, or created_at selectors needed to identify one stored row.",
      ],
    },
  );
}

/**
 * Name every stored dependency row an update removed, as `<id>/<kind>` pairs
 * (pm-4yxzvd), so a scalar clear, a kind-wide or bare-id `--dep-remove`, and a
 * dependency clear or replacement all report the edges they dropped. Rows are
 * compared by full stored identity as a multiset, so collapsing a duplicate
 * row is reported too.
 */
export function describeRemovedDependencies(
  before: unknown,
  after: unknown,
): string | undefined {
  if (!Array.isArray(before) || before.length === 0) return undefined;
  // A malformed legacy row has no identity to report; skipping it keeps the receipt from crashing the write.
  const rows = (value: unknown): Dependency[] =>
    (Array.isArray(value) ? value : []).filter(
      (row): row is Dependency =>
        typeof row === "object" && row !== null && typeof (row as Dependency).id === "string",
    );
  const retained = new Map<string, number>();
  for (const row of rows(after)) {
    const key = storedDependencyIdentityKey(row);
    retained.set(key, (retained.get(key) ?? 0) + 1);
  }
  const removed: string[] = [];
  for (const row of rows(before)) {
    const key = storedDependencyIdentityKey(row);
    const left = retained.get(key) ?? 0;
    if (left > 0) retained.set(key, left - 1);
    else removed.push(`${row.id}/${row.kind}`);
  }
  return removed.length > 0 ? removed.join(",") : undefined;
}
