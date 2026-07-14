/**
 * @module cli/commands/history-compact
 *
 * Presentation compatibility shim for public SDK history compaction. The SDK
 * owns checkpointing, pruning, integrity verification, and bulk target policy.
 */
export {
  assertHistoryCompactTarget,
  runHistoryCompact,
  runHistoryCompactBulk,
  type HistoryCompactBulkCommandOptions,
  type HistoryCompactBulkItemResult,
  type HistoryCompactBulkResult,
  type HistoryCompactCommandOptions,
  type HistoryCompactResult,
} from "../../sdk/history-compact.js";
