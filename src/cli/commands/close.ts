/**
 * @module cli/commands/close
 *
 * Compatibility presentation shim for the SDK-owned close-item operation.
 */
export {
  _testOnlyCloseCommand,
  closeItem,
  runClose,
  type CloseCommandOptions,
  type CloseResult,
} from "../../sdk/lifecycle/close.js";
