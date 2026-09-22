/**
 * @module cli/commands/history/history-compact
 *
 * Presentation compatibility shim for public SDK history compaction. The SDK
 * owns checkpointing, pruning, integrity verification, and bulk target policy.
 */
export {
  assertHistoryCompactTarget,
  runHistoryCompact,
  runHistoryCompactBulk,
} from "../../../sdk/history-compact.js";
