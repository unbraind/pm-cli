/**
 * @module cli/commands/delete
 *
 * Preserves the CLI import path while the delete transaction is owned by the SDK.
 */
export {
  runDelete,
  type DeleteCommandOptions,
  type DeleteResult,
} from "../../sdk/lifecycle/delete.js";
