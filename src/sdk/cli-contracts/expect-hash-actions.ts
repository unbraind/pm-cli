/**
 * @module sdk/cli-contracts/expect-hash-actions
 *
 * The one inventory of native actions whose locked item writes honour the
 * `expectHash` / `--expect-hash` precondition (pm-gh1576). The strict tool
 * schema declares the parameter for exactly these actions, and dispatch admits
 * the precondition for them, so the two can never disagree.
 */

/**
 * Lifecycle, annotation, linked-artifact, plan, linked-test persistence and
 * history-maintenance writers of existing items. `create` and `copy` only
 * create new items, so a revision has nothing to guard there.
 */
export const PM_EXPECT_HASH_ACTIONS: ReadonlySet<string> = new Set([
  "update",
  "item-reopen",
  "close",
  "claim",
  "release",
  "start-task",
  "pause-task",
  "close-task",
  "restore",
  "append",
  "update-many",
  "close-many",
  "delete",
  "comments",
  "notes",
  "learnings",
  "files",
  "docs",
  "test",
  "test-all",
  "plan",
  "history-redact",
  "history-repair",
  "history-compact",
  // validate --auto-fix and --prune-missing write existing items through audited mutation paths.
  "validate",
]);
