/**
 * @module cli/commands/restore
 *
 * Preserves the CLI import path while the restore transaction is owned by the SDK.
 */
export {
  _testOnlyRestoreCommand,
  runRestore,
  type RestoreCommandOptions,
  type RestoreResult,
} from "../../sdk/lifecycle/restore.js";
