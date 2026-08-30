/**
 * @module sdk/governance/workspace-position
 *
 * Produces one bounded, read-only workspace readiness answer from merge-fence,
 * merge-receipt, and append-only history evidence.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { nowIso } from "../../core/shared/time.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import {
  auditMergeAttributeFence,
  auditMergeDriverConfiguration,
  findGitWorkspaceRoot,
  resolveProjectMergeTypeFolders,
  type MergeDriverConfigurationAuditResult,
  type MergeFenceAuditResult,
} from "../merge/install.js";
import {
  inspectMergeReceiptEvidence,
  partitionMergeReceipts,
} from "../merge/receipts.js";
import { buildValidateHistoryDriftCheck } from "./validate-history-drift.js";
import { readValidateItems } from "./validate-item-reader.js";

/** Stable readiness classifications returned by the workspace-position read. */
export type WorkspacePositionState =
  | "ready"
  | "merge_evidence_invalid"
  | "merge_reconciliation_required"
  | "history_repair_required"
  | "merge_fence_unprepared";

/** One deterministic recovery action selected from aggregate workspace evidence. */
export interface WorkspacePositionNextAction {
  /** Executable pm command, or null when the workspace is ready. */
  command: string | null;
  /** Stable reason code explaining why this action takes precedence. */
  reason: WorkspacePositionState;
}

/** Bounded SDK result shared by CLI, MCP, and package consumers. */
export interface WorkspacePositionResult {
  /** Whether all readiness evidence is clean. */
  ok: boolean;
  /** Highest-priority workspace readiness classification. */
  state: WorkspacePositionState;
  /** Committed merge-fence and clone-local driver evidence. */
  merge_fence: {
    committed: MergeFenceAuditResult;
    clone_local_drivers: MergeDriverConfigurationAuditResult | null;
  };
  /** Bounded pending receipt evidence without private merge values. */
  merge_receipts: {
    pending_decision_count: number;
    pending_item_ids: string[];
    pending_item_ids_truncated: boolean;
    lossless_count: number;
    invalid_evidence_count: number;
  };
  /** Bounded append-only history drift evidence. */
  history_drift: {
    drifted_item_count: number;
    drifted_item_ids: string[];
    drifted_item_ids_truncated: boolean;
    counts: Record<string, unknown>;
  };
  /** One deterministic next action, avoiding multi-command guesswork. */
  next_action: WorkspacePositionNextAction;
  /** Non-fatal read warnings retained from the authoritative item scan. */
  warnings: string[];
  /** ISO timestamp for this aggregate read. */
  generated_at: string;
}

function selectWorkspacePositionState(params: {
  invalidEvidenceCount: number;
  pendingDecisionCount: number;
  driftedItemCount: number;
  fence: MergeFenceAuditResult;
  drivers: MergeDriverConfigurationAuditResult | null;
}): WorkspacePositionState {
  if (params.invalidEvidenceCount > 0) return "merge_evidence_invalid";
  if (params.pendingDecisionCount > 0) return "merge_reconciliation_required";
  if (params.driftedItemCount > 0) return "history_repair_required";
  if (
    params.fence.status !== "ok" ||
    params.drivers === null ||
    params.drivers.status !== "ok"
  ) {
    return "merge_fence_unprepared";
  }
  return "ready";
}

function commandForWorkspacePositionState(
  state: WorkspacePositionState,
  pmRoot: string,
): string | null {
  const commandPrefix = `pm --pm-path '${pmRoot.replaceAll("'", `'"'"'`)}'`;
  if (state === "merge_evidence_invalid")
    return `${commandPrefix} merge report`;
  if (state === "merge_reconciliation_required") {
    return `${commandPrefix} merge reconcile`;
  }
  if (state === "history_repair_required") {
    return `${commandPrefix} history-repair --all`;
  }
  if (state === "merge_fence_unprepared") {
    return `${commandPrefix} merge install`;
  }
  return null;
}

/** Normalize defensive history-check evidence into the bounded position shape. */
function normalizeWorkspaceHistoryDrift(
  details: Record<string, unknown>,
): WorkspacePositionResult["history_drift"] {
  const driftedItemIds = Array.isArray(details.drifted_items)
    ? details.drifted_items.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return {
    drifted_item_count:
      typeof details.drifted_items_count === "number"
        ? details.drifted_items_count
        : driftedItemIds.length,
    drifted_item_ids: driftedItemIds,
    drifted_item_ids_truncated: details.drifted_items_truncated === true,
    counts:
      typeof details.counts === "object" && details.counts !== null
        ? (details.counts as Record<string, unknown>)
        : {},
  };
}

/** Read aggregate workspace position without flags, session state, or mutation. */
export async function readWorkspacePosition(
  global: GlobalOptions,
): Promise<WorkspacePositionResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const itemReadWarnings: string[] = [];
  const items = await readValidateItems({
    includeBody: true,
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    warnings: itemReadWarnings,
  });
  const gitWorkspaceRoot = await findGitWorkspaceRoot(pmRoot);
  const [fence, drivers, receiptEvidence, drift] = await Promise.all([
    auditMergeAttributeFence(pmRoot, resolveProjectMergeTypeFolders(settings)),
    gitWorkspaceRoot === null
      ? Promise.resolve(null)
      : auditMergeDriverConfiguration(gitWorkspaceRoot),
    inspectMergeReceiptEvidence(gitWorkspaceRoot ?? pmRoot, {
      includeLossless: true,
      pmRoot,
    }),
    buildValidateHistoryDriftCheck(pmRoot, items, false),
  ]);
  const { pendingDecisions, lossless } = partitionMergeReceipts(
    receiptEvidence.receipts,
  );
  const pendingItemIds = [
    ...new Set(pendingDecisions.map((receipt) => receipt.item_id)),
  ].sort((left, right) => left.localeCompare(right));
  const driftDetails = drift.check.details;
  const historyDrift = normalizeWorkspaceHistoryDrift(driftDetails);
  const state = selectWorkspacePositionState({
    invalidEvidenceCount: receiptEvidence.invalid_evidence_count,
    pendingDecisionCount: pendingDecisions.length,
    driftedItemCount: historyDrift.drifted_item_count,
    fence,
    drivers,
  });
  return {
    ok: state === "ready",
    state,
    merge_fence: {
      committed: fence,
      clone_local_drivers: drivers,
    },
    merge_receipts: {
      pending_decision_count: pendingDecisions.length,
      pending_item_ids: pendingItemIds.slice(0, 25),
      pending_item_ids_truncated: pendingItemIds.length > 25,
      lossless_count: lossless.length,
      invalid_evidence_count: receiptEvidence.invalid_evidence_count,
    },
    history_drift: historyDrift,
    next_action: {
      command: commandForWorkspacePositionState(state, pmRoot),
      reason: state,
    },
    warnings: [...new Set(itemReadWarnings)].sort((left, right) =>
      left.localeCompare(right),
    ),
    generated_at: nowIso(),
  };
}

/** Render the bounded workspace position for human CLI output. */
export function formatWorkspacePositionHuman(
  result: WorkspacePositionResult,
): string {
  const action = result.next_action.command ?? "none";
  return [
    `workspace_position: ${result.state}`,
    `merge_fence: ${result.merge_fence.committed.status}`,
    `clone_local_drivers: ${result.merge_fence.clone_local_drivers?.status ?? "unavailable"}`,
    `pending_merge_decisions: ${result.merge_receipts.pending_decision_count}`,
    `history_drifted_items: ${result.history_drift.drifted_item_count}`,
    `next_action: ${action}`,
  ].join("\n");
}

/** Public contract for focused unit verification. */
export const _testOnlyWorkspacePosition = {
  commandForWorkspacePositionState,
  normalizeWorkspaceHistoryDrift,
  selectWorkspacePositionState,
};
