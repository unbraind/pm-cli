/**
 * @module sdk/ownership-source
 *
 * Resolves whether an item's current assignee originated from an explicit
 * claim or a general metadata assignment using the append-only history stream.
 */
import { readHistoryEntries } from "../core/history/read.js";
import { getHistoryPath } from "../core/store/paths.js";

/** Describe the current ownership source for an atomic claim conflict. */
export async function describeItemOwnershipConflict(
  pmRoot: string,
  itemId: string,
  assignee: string,
): Promise<string> {
  const history = await readHistoryEntries(getHistoryPath(pmRoot, itemId), itemId);
  const latestOwnershipOperation = [...history]
    .reverse()
    .find((entry) =>
      entry.patch.some(
        (operation) => operation.path === "/metadata/assignee",
      ),
    )?.op;
  return latestOwnershipOperation === "claim"
    ? `claimed by ${assignee}`
    : `assigned to ${assignee}`;
}
