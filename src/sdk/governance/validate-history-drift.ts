/**
 * @module sdk/governance/validate-history-drift
 *
 * Projects append-only item and workspace singleton drift into the validation
 * check contract without adding history-specific weight to the main validate
 * orchestration module.
 */
import { scanHistoryDrift, type DriftScanResult } from "../../core/history/drift-scan.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { acquireLock } from "../../core/lock/lock.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { readSettings } from "../../core/store/settings.js";
import { WORKSPACE_HISTORY_ID } from "../../core/history/workspace-history.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { ValidateCheck } from "./validate.js";
import type { ValidateItem } from "./validate-item-reader.js";

const DEFAULT_DIAGNOSTIC_LIMIT = 5;

/**
 * Recheck item-hash discrepancies under the same lock ordinary writers
 * hold. The initial corpus read remains cheap; only findings incur a fresh
 * authoritative read. Contention and source-read failures propagate instead
 * of certifying corruption or silently accepting an unverified pair.
 */
async function recheckItemHistoryDrift(
  pmRoot: string,
  drift: DriftScanResult,
): Promise<void> {
  const ids = drift.hashMismatches.filter((id) => id !== WORKSPACE_HISTORY_ID);
  if (ids.length === 0) return;
  const settings = await readSettings(pmRoot);
  const registry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  for (const id of ids) {
    const release = await acquireLock(
      pmRoot, id, settings.locks.ttl_seconds, "history-drift-read",
      false, true, settings.locks.wait_ms,
    );
    try {
      const located = await locateItem(
        pmRoot, id, settings.id_prefix, settings.item_format, registry.type_to_folder,
      );
      if (located === null) {
        throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND, {
          code: "item_not_found",
          required: "Repeat validation after writers finish; each item-hash discrepancy requires readable canonical source.",
        });
      }
      const { document } = await readLocatedItem(located, {
        schema: settings.schema,
      });
      const verified = await scanHistoryDrift(
        pmRoot,
        [{ ...document.metadata, body: document.body }],
        { persistCache: false },
      );
      for (const key of [
        "missingStreams", "unreadableStreams", "hashMismatches",
        "chainMismatches", "versionSkews", "driftedItems",
      ] as const) {
        drift[key] = [
          ...drift[key].filter((itemId) => itemId !== id),
          ...verified[key].filter((itemId) => itemId === id),
        ].sort((left, right) => left.localeCompare(right));
      }
      const identities = [
        ...(drift.identityDiscontinuities ?? []).filter((finding) => finding.item_id !== id),
        ...(verified.identityDiscontinuities ?? []).filter((finding) => finding.item_id === id),
      ];
      if (identities.length > 0) drift.identityDiscontinuities = identities;
      else delete drift.identityDiscontinuities;
    } finally {
      await release();
    }
  }
}

/** Build the validation warning and bounded evidence projection for history drift. */
export async function buildValidateHistoryDriftCheck(
  pmRoot: string,
  items: ValidateItem[],
  verboseDiagnostics: boolean,
): Promise<{ check: ValidateCheck; warnings: string[] }> {
  const drift = await scanHistoryDrift(pmRoot, items);
  await recheckItemHistoryDrift(pmRoot, drift);
  const warningCounts = [
    ["validate_history_drift_missing_streams", drift.missingStreams.length],
    [
      "validate_history_drift_unreadable_streams",
      drift.unreadableStreams.length,
    ],
    ["validate_history_drift_hash_mismatches", drift.hashMismatches.length],
    ["validate_history_drift_chain_mismatches", drift.chainMismatches.length],
    ["validate_history_drift_version_skews", drift.versionSkews.length],
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
  const identityDiscontinuities = drift.identityDiscontinuities ?? [];
  return {
    check: {
      name: "history_drift",
      status:
        identityDiscontinuities.length > 0
          ? "error"
          : warnings.length === 0
            ? "ok"
            : "warn",
      ok: identityDiscontinuities.length === 0 && warnings.length === 0,
      details: {
        identity_discontinuities: identityDiscontinuities.slice(
          0,
          diagnosticLimit,
        ),
        identity_discontinuities_count: identityDiscontinuities.length,
        identity_discontinuities_truncated:
          identityDiscontinuities.length > diagnosticLimit,
        checked_items: items.length,
        drifted_items_count: drift.driftedItems.length,
        drifted_items: driftedItems,
        drifted_items_truncated:
          driftedItems.length < drift.driftedItems.length,
        counts: {
          missing_streams: drift.missingStreams.length,
          unreadable_streams: drift.unreadableStreams.length,
          hash_mismatches: drift.hashMismatches.length,
          chain_mismatches: drift.chainMismatches.length,
          version_skews: drift.versionSkews.length,
          workspace_state_mismatches: drift.workspaceStateMismatches.length,
          workspace_state_missing: drift.workspaceStateMissing.length,
          workspace_state_unreadable: drift.workspaceStateUnreadable.length,
        },
        workspace_state_mismatches: drift.workspaceStateMismatches,
        workspace_state_missing: drift.workspaceStateMissing,
        workspace_state_unreadable: drift.workspaceStateUnreadable,
        version_skews: drift.versionSkews.slice(0, diagnosticLimit),
      },
    },
    warnings,
  };
}
