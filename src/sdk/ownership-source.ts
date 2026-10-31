/**
 * @module sdk/ownership-source
 *
 * Resolves whether an item's current assignee originated from an explicit
 * claim or a general metadata assignment using the append-only history stream.
 */
import { readHistoryEntries } from "../core/history/read.js";
import { getHistoryPath } from "../core/store/paths.js";

/** Typed holder evidence behind an `already_claimed_by` refusal (GH-1610). */
export interface ItemOwnershipConflict {
  /** Prose used by the refusal message: `claimed by <holder>` or `assigned to <holder>`. */
  phrase: string;
  /** Principal that currently holds the item. */
  holder: string;
  /**
   * Whether the latest ownership mutation was an explicit claim or a metadata
   * assignment; `unknown` when history is unreadable, records no assignee
   * change, or its latest change set a different holder, so an unproven
   * origin is never reported as either.
   */
  source: "claim" | "assignment" | "unknown";
  /** Timestamp of the latest assignee change, or null when history is unavailable or silent. */
  since: string | null;
}

/** Map the operation of the latest assignee change to the holder's origin. */
function classifyOwnershipSource(
  operation: string | undefined,
): ItemOwnershipConflict["source"] {
  if (operation === undefined) return "unknown";
  return operation === "claim" ? "claim" : "assignment";
}

/** Resolve the current holder, its source and its start time for an atomic claim conflict. */
export async function resolveItemOwnershipConflict(
  pmRoot: string,
  itemId: string,
  assignee: string,
): Promise<ItemOwnershipConflict> {
  const history = await Promise.resolve()
    .then(() => readHistoryEntries(getHistoryPath(pmRoot, itemId), itemId))
    .catch(() => []);
  const latestOwnershipEntry = [...history]
    .reverse()
    .find((entry) =>
      entry.patch.some(
        (operation) => operation.path === "/metadata/assignee",
      ),
    );
  // The newest assignee change is evidence only when it set the current holder;
  // if item state and history diverge, its origin and time describe someone else.
  const assigneeOperation = latestOwnershipEntry?.patch.find(
    (operation) => operation.path === "/metadata/assignee",
  );
  const evidence =
    assigneeOperation !== undefined &&
    typeof assigneeOperation.value === "string" &&
    assigneeOperation.value.trim() === assignee.trim()
      ? latestOwnershipEntry
      : undefined;
  const source = classifyOwnershipSource(evidence?.op);
  return {
    phrase: source === "claim" ? `claimed by ${assignee}` : `assigned to ${assignee}`,
    holder: assignee,
    source,
    since: evidence?.ts ?? null,
  };
}

/** Describe the current ownership source for an atomic claim conflict. */
export async function describeItemOwnershipConflict(
  pmRoot: string,
  itemId: string,
  assignee: string,
): Promise<string> {
  return (await resolveItemOwnershipConflict(pmRoot, itemId, assignee)).phrase;
}
