/**
 * @module sdk/governance/validate-history-drift
 *
 * Projects append-only item and workspace singleton drift into the validation
 * check contract without adding history-specific weight to the main validate
 * orchestration module.
 */
import { scanHistoryDrift } from "../../core/history/drift-scan.js";
import type { ValidateCheck } from "./validate.js";
import type { ValidateItem } from "./validate-item-reader.js";

const DEFAULT_DIAGNOSTIC_LIMIT = 5;

/** Build the validation warning and bounded evidence projection for history drift. */
export async function buildValidateHistoryDriftCheck(
  pmRoot: string,
  items: ValidateItem[],
  verboseDiagnostics: boolean,
): Promise<{ check: ValidateCheck; warnings: string[] }> {
  const drift = await scanHistoryDrift(pmRoot, items);
  const warningCounts = [
    ["validate_history_drift_missing_streams", drift.missingStreams.length],
    ["validate_history_drift_unreadable_streams", drift.unreadableStreams.length],
    ["validate_history_drift_hash_mismatches", drift.hashMismatches.length],
    ["validate_history_drift_chain_mismatches", drift.chainMismatches.length],
    [
      "validate_history_drift_workspace_state_mismatches",
      drift.workspaceStateMismatches.length,
    ],
    [
      "validate_history_drift_workspace_state_missing",
      drift.workspaceStateMissing.length,
    ],
    [
      "validate_history_drift_workspace_state_unreadable",
      drift.workspaceStateUnreadable.length,
    ],
  ] as const;
  const warnings = warningCounts
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${code}:${count}`);
  const diagnosticLimit = verboseDiagnostics
    ? Number.POSITIVE_INFINITY
    : DEFAULT_DIAGNOSTIC_LIMIT;
  const driftedItems = drift.driftedItems.slice(0, diagnosticLimit);
  return {
    check: {
      name: "history_drift",
      status: warnings.length === 0 ? "ok" : "warn",
      ok: warnings.length === 0,
      details: {
        checked_items: items.length,
        drifted_items_count: drift.driftedItems.length,
        drifted_items: driftedItems,
        drifted_items_truncated: driftedItems.length < drift.driftedItems.length,
        counts: {
          missing_streams: drift.missingStreams.length,
          unreadable_streams: drift.unreadableStreams.length,
          hash_mismatches: drift.hashMismatches.length,
          chain_mismatches: drift.chainMismatches.length,
          workspace_state_mismatches: drift.workspaceStateMismatches.length,
          workspace_state_missing: drift.workspaceStateMissing.length,
          workspace_state_unreadable: drift.workspaceStateUnreadable.length,
        },
        workspace_state_mismatches: drift.workspaceStateMismatches,
        workspace_state_missing: drift.workspaceStateMissing,
        workspace_state_unreadable: drift.workspaceStateUnreadable,
      },
    },
    warnings,
  };
}
