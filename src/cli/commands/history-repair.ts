/**
 * @module cli/commands/history-repair
 *
 * Presentation compatibility shim for the public SDK history-repair
 * primitives. The SDK owns replay, re-anchor, rollback, and bulk repair logic.
 */
export {
  assertHistoryRepairTarget,
  runHistoryRepair,
  runHistoryRepairAll,
  type HistoryRepairAllResult,
  type HistoryRepairAllStreamResult,
  type HistoryRepairCommandOptions,
  type HistoryRepairResult,
} from "../../sdk/history-repair.js";
