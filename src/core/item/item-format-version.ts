/**
 * @module core/item/item-format-version
 *
 * Tracks the on-disk item item-metadata format version so a future breaking
 * storage change can tell already-current items apart from items that a staged
 * migration must rewrite, without re-parsing and structurally guessing every
 * file. The version is an explicit, monotonically increasing integer stamped in
 * item-metadata as `pm_format_version`.
 *
 * Token economy is a first-class constraint here: the baseline version (1) is
 * the implicit default and is never serialized, so today's corpus gains zero
 * bytes and zero churn. The field only materializes once an item reaches
 * version 2 or higher. Absence of the field is therefore always interpreted as
 * the baseline version, both now and after future bumps. The classification
 * helpers below power the advisory `pm health` integrity surface and the
 * `pm validate` format-version check.
 */
import type { ItemMetadata } from "../../types/index.js";

/** The original (and implicit) item item-metadata format version. Items missing a `pm_format_version` field are always treated as this version, so the baseline is never written to disk and adds no per-item token cost. */
export const BASELINE_ITEM_FORMAT_VERSION = 1;

/**
 * The format version this runtime writes and considers current. When a breaking
 * item-metadata change ships, bump this constant and add a migration that
 * rewrites items whose {@link effectiveItemFormatVersion} is lower; items at or
 * above it need no migration. It stays equal to
 * {@link BASELINE_ITEM_FORMAT_VERSION} until the first such change.
 */
export const CURRENT_ITEM_FORMAT_VERSION = 1;

/**
 * Resolve the format version an item is effectively stored at. A present,
 * positive-integer `pm_format_version` is taken verbatim (including versions
 * ahead of this runtime, so they can be flagged rather than silently clamped);
 * an absent, malformed, or sub-baseline value resolves to
 * {@link BASELINE_ITEM_FORMAT_VERSION}.
 */
export function effectiveItemFormatVersion(
  metadata: Pick<ItemMetadata, "pm_format_version">,
): number {
  const raw = metadata.pm_format_version;
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= BASELINE_ITEM_FORMAT_VERSION
  ) {
    return raw;
  }
  return BASELINE_ITEM_FORMAT_VERSION;
}

/**
 * Reduce an item's `pm_format_version` to its persisted form: the baseline
 * version (and any malformed or sub-baseline value) is dropped so it is never
 * serialized, while versions at or above {@link BASELINE_ITEM_FORMAT_VERSION}
 * plus one are preserved verbatim. This keeps the field absent for the entire
 * current corpus and only writes it once an item genuinely advances past the
 * implicit baseline.
 */
export function normalizeItemFormatVersion(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= BASELINE_ITEM_FORMAT_VERSION
  ) {
    return undefined;
  }
  return value;
}

/** Relationship between an item's stored format version and the runtime's current version: `outdated` (below current, a migration would rewrite it), `ahead` (above current, written by a newer pm than this one), or `current`. */
export type ItemFormatVersionStatus = "current" | "outdated" | "ahead";

/**
 * Classify a single stored format version against the runtime's current
 * version. Defaults to {@link CURRENT_ITEM_FORMAT_VERSION}; the `current`
 * parameter exists so callers (and tests) can evaluate against a hypothetical
 * future version without mutating the module constant.
 */
export function classifyItemFormatVersion(
  version: number,
  current: number = CURRENT_ITEM_FORMAT_VERSION,
): ItemFormatVersionStatus {
  if (version < current) {
    return "outdated";
  }
  if (version > current) {
    return "ahead";
  }
  return "current";
}

/**
 * One item's reference (id or relative path) paired with the format version it
 * is stored at, used as input to {@link scanItemFormatVersions}.
 */
export interface ItemFormatVersionScanEntry {
  /** Value that configures or reports ref for this contract. */
  ref: string;
  /** Value that configures or reports version for this contract. */
  version: number;
}

/** Sorted references partitioned by how their stored format version compares to the runtime's current version. References at the current version are omitted from both lists. */
export interface ItemFormatVersionScanResult {
  /** Value that configures or reports outdated for this contract. */
  outdated: string[];
  /** Value that configures or reports ahead for this contract. */
  ahead: string[];
}

/** Partition a set of items by format version into `outdated` (need migration) and `ahead` (written by a newer pm) reference lists, each sorted for stable diagnostics. Pushing all comparison branches into this pure, exhaustively tested helper lets `pm health` and `pm validate` emit findings by iterating the result lists, with no version-comparison branching of their own. */
export function scanItemFormatVersions(
  entries: readonly ItemFormatVersionScanEntry[],
  current: number = CURRENT_ITEM_FORMAT_VERSION,
): ItemFormatVersionScanResult {
  const outdated: string[] = [];
  const ahead: string[] = [];
  for (const entry of entries) {
    const status = classifyItemFormatVersion(entry.version, current);
    if (status === "outdated") {
      outdated.push(entry.ref);
    } else if (status === "ahead") {
      ahead.push(entry.ref);
    }
  }
  return {
    outdated: outdated.sort((left, right) => left.localeCompare(right)),
    ahead: ahead.sort((left, right) => left.localeCompare(right)),
  };
}
