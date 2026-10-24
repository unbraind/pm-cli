/** Preserve whole-field scalar intent when another branch removed its target. */
import { tryApplyReplayPatch, type ReplayDocument } from "../../core/history/replay.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { HistoryPatchOp } from "../../types/index.js";

/** Rebase only validated whole-field assignments/removals; nested and conditional operations stay strict. */
export function rebaseHistoryScalarPatch(current: ReplayDocument, patch: HistoryPatchOp[], coordinate: {
  branch: "ours" | "theirs";
  line: number;
  op: string;
}): ReplayDocument {
  const direct = tryApplyReplayPatch(current, patch);
  if (direct.ok) return direct.document;
  let next = structuredClone(current);
  for (const [index, operation] of patch.entries()) {
    const field = /^\/metadata\/([^/]*)$/u.exec(operation.path)?.[1];
    const missingField = field !== undefined && !Object.hasOwn(next.metadata, field.replaceAll("~1", "/").replaceAll("~0", "~"));
    // Original branch replay has already proved these operations valid. A
    // whole-field remove is satisfied by absence; replace still assigns its
    // exact value, even after a concurrent release deleted the field.
    if (missingField && operation.op === "remove") continue;
    const projected: HistoryPatchOp = missingField && operation.op === "replace" ? { ...operation, op: "add" } : operation;
    const applied = tryApplyReplayPatch(next, [projected]);
    if (!applied.ok) {
      throw new PmCliError(
        `History union cannot rebase a scalar patch at ${coordinate.branch} line ${coordinate.line} (${coordinate.op}), operation ${index + 1} ${operation.op} ${operation.path}; preserve the source histories for manual recovery.`,
        EXIT_CODE.CONFLICT,
        {
          code: "history_union_rebase_conflict",
          field: operation.path,
          history_merge: { ...coordinate, patch_index: index, patch_path: operation.path },
          nextSteps: ["Preserve all three history inputs and both item snapshots. Review the named branch event against the merged replay state; do not drop the event or concatenate unchecked patches. After resolving the history and item deliberately, run pm history <id> --verify and pm merge reconcile --dry-run before committing."],
        },
      );
    }
    next = applied.document;
  }
  return next;
}
