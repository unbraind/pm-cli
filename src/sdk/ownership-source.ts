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
  /** Whether the latest ownership mutation was an explicit claim or a metadata assignment. */
  source: "claim" | "assignment";
  /** Timestamp of the latest assignee change, or null when history is unavailable or silent. */
  since: string | null;
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
  const source = latestOwnershipEntry?.op === "claim" ? "claim" : "assignment";
  return {
    phrase: source === "claim" ? `claimed by ${assignee}` : `assigned to ${assignee}`,
    holder: assignee,
    source,
    since: latestOwnershipEntry?.ts ?? null,
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
