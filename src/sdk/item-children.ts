/**
 * @module sdk/item-children
 *
 * Builds deterministic, bounded direct-child projections for every item type.
 * The primitive accepts metadata from either the persistent derived index or a
 * source scan, allowing CLI, MCP, packages, and custom hosts to share one graph
 * projection contract.
 */
import { isTerminalStatus } from "../core/item/status.js";
import type { RuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import type { ItemMetadata } from "../types/index.js";

/** Maximum corpus rows inspected by one child projection. */
export const MAX_CHILD_PROJECTION_ITEMS = 1_000_000;
/** Default number of child summaries retained inline. */
export const DEFAULT_CHILD_SAMPLE_LIMIT = 20;

/** Stable compact child row embedded in a parent read. */
export interface ChildRollupSample {
  /** Stable child identifier. */
  id: string;
  /** Human-readable child title. */
  title: string;
  /** Schema type of the child item. */
  type: string;
  /** Current lifecycle status of the child item. */
  status: string;
  /** Current priority of the child item. */
  priority: number;
}

/** Bounded direct-child summary shared across SDK and presentation surfaces. */
export interface ChildRollupContext {
  /** Total direct children discovered. */
  count: number;
  /** Direct children whose statuses are non-terminal. */
  active: number;
  /** Counts grouped by normalized lifecycle status. */
  by_status: Record<string, number>;
  /** Deterministic id-sorted inline sample. */
  sample: ChildRollupSample[];
  /** Configured maximum sample size. */
  sample_limit: number;
  /** Whether additional children exist beyond the inline sample. */
  truncated: boolean;
  /** Offset for the next page, or null when the sample is complete. */
  next_offset: number | null;
  /** Token-efficient CLI continuation command, or null when complete. */
  continuation: string | null;
  /** Number of corpus rows inspected to produce this projection. */
  scanned: number;
}

/**
 * Build a type-agnostic child rollup from indexed or source metadata. Input is
 * capped at one million rows to keep custom-host behavior explicitly bounded.
 */
export function buildItemChildrenRollup(
  parentId: string,
  corpus: Iterable<ItemMetadata>,
  statusRegistry: RuntimeStatusRegistry,
  sampleLimit = DEFAULT_CHILD_SAMPLE_LIMIT,
): ChildRollupContext {
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 0) {
    throw new PmCliError(
      "Child projection sample limit must be a non-negative integer.",
      EXIT_CODE.USAGE,
    );
  }
  const normalizedParentId = parentId.trim().toLowerCase();
  const byStatus: Record<string, number> = {};
  const children: ItemMetadata[] = [];
  let active = 0;
  let scanned = 0;
  for (const candidate of corpus) {
    scanned += 1;
    if (scanned > MAX_CHILD_PROJECTION_ITEMS) {
      throw new PmCliError(
        `Child projection exceeded the ${MAX_CHILD_PROJECTION_ITEMS.toLocaleString("en-US")} item safety bound.`,
        EXIT_CODE.GENERIC_FAILURE,
        {
          code: "child_projection_item_bound_exceeded",
          required: "Use an indexed or parent-filtered metadata source.",
          why: "Unbounded graph scans can exhaust memory in universal project stores.",
          nextSteps: ["Build the derived item index, then retry the parent read."],
        },
      );
    }
    if (candidate.parent?.trim().toLowerCase() !== normalizedParentId) {
      continue;
    }
    children.push(candidate);
    const status = candidate.status.trim().toLowerCase();
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (!isTerminalStatus(status, statusRegistry)) {
      active += 1;
    }
  }
  children.sort((left, right) => left.id.localeCompare(right.id));
  const sample = children.slice(0, sampleLimit).map((child) => ({
    id: child.id,
    title: child.title,
    type: child.type,
    status: child.status,
    priority: child.priority,
  }));
  const truncated = children.length > sample.length;
  return {
    count: children.length,
    active,
    by_status: Object.fromEntries(
      Object.entries(byStatus).sort(([left], [right]) => left.localeCompare(right)),
    ),
    sample,
    sample_limit: sampleLimit,
    truncated,
    next_offset: truncated ? sample.length : null,
    continuation: truncated
      ? `pm list --status all --parent ${parentId} --offset ${sample.length} --limit ${sampleLimit}`
      : null,
    scanned,
  };
}
