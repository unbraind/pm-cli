/**
 * @module cli/commands/get
 *
 * Preserves the CLI import path while item retrieval is owned by the SDK.
 */
export {
  _testOnlyGetCommand,
  runGet,
  type GetOptions,
  type GetResult,
} from "../../sdk/query/get.js";
