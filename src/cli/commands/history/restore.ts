/**
 * @module cli/commands/history/restore
 *
 * Preserves the CLI import path while the restore transaction is owned by the SDK.
 */
export {
  _testOnlyRestoreCommand,
  runRestore,
} from "../../../sdk/lifecycle/restore.js";
