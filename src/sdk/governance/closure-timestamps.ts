/**
 * @module sdk/governance/closure-timestamps
 * Derives legacy closure dates from verified history and applies opt-in repairs
 * through the audited item store. Checkpoints never invent a historical date.
 */
import { applyHistoryPatch, readHistoryEntries, verifyHistoryEntries } from "../history-read.js";
import { cloneEmptyReplayDocument } from "../../core/history/replay.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolveAuthor } from "../../core/shared/author.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { isMillisecondPrecisionRfc3339DateTime } from "../../core/shared/time.js";
import { mutateItem } from "../../core/store/item-store.js";
import { getHistoryPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import type { ValidateFixRecord } from "../../core/validate/fix-planning.js";
import type { HistoryEntry, ItemDocument } from "../../types/index.js";
import type { ValidateItem } from "./validate-item-reader.js";

/** A replay-proven transition or an explicit reason no safe date can be assigned. */
export type ClosureTimestampEvidence =
  | { timestamp: string; source_index: number }
  | { reason: "missing_history" | "unverified_history" | "not_terminal" | "no_proven_transition" };

/**
 * Find the beginning of the final uninterrupted terminal interval in stream order.
 * Metadata writes do not move it; reopening clears it. Only actual lifecycle
 * writes, including terminal creation, establish evidence. Maintenance baselines
 * carry state but do not prove when that state was originally reached.
 */
export function deriveClosureTimestamp(
  history: HistoryEntry[],
  document: ItemDocument,
  terminalStatuses: ReadonlySet<string>,
): ClosureTimestampEvidence {
  if (!terminalStatuses.has(document.metadata.status)) return { reason: "not_terminal" };
  if (history.length === 0) return { reason: "missing_history" };
  if (!verifyHistoryEntries(history, document).ok) return { reason: "unverified_history" };
  let replay = cloneEmptyReplayDocument();
  let evidence: ClosureTimestampEvidence = { reason: "no_proven_transition" };
  for (const [index, entry] of history.entries()) {
    const wasTerminal = terminalStatuses.has(String(replay.metadata.status));
    replay = applyHistoryPatch(replay, entry.patch, index + 1, entry.op);
    const isTerminal = terminalStatuses.has(String(replay.metadata.status));
    if (!isTerminal) evidence = { reason: "no_proven_transition" };
    else if (!wasTerminal) {
      evidence = ["create", "close", "cancel", "update", "update_audit"].includes(entry.op) &&
        isMillisecondPrecisionRfc3339DateTime(entry.ts)
        ? { timestamp: entry.ts, source_index: index + 1 }
        : { reason: "no_proven_transition" };
    }
  }
  return evidence;
}

/** Include persisted legacy aliases without rewriting the verified replay document. */
function closureTerminalStatuses(registry: RuntimeStatusRegistry): Set<string> {
  return new Set([
    ...registry.terminal_statuses,
    ...[...registry.alias_to_id].filter(([, id]) => registry.terminal_statuses.has(id)).map(([alias]) => alias),
  ]);
}

/** Missing closure dates, bounded diagnostics, and the complete opt-in repair plan. */
export interface ClosureTimestampScan {
  /** Scalar counts and explicitly bounded residual/evidence rows for validate output. */
  details: Record<string, unknown>;
  /** Audited fixes; no entry exists for unproven history. */
  fixes: ValidateFixRecord[];
  /** Advisory warnings for the missing population. */
  warnings: string[];
}

/** Inspect only terminal items missing a date; replay is requested explicitly by remediation callers. */
export async function scanClosureTimestamps(
  pmRoot: string,
  items: readonly ValidateItem[],
  registry: RuntimeStatusRegistry,
  inspectHistory: boolean,
  limit: number,
): Promise<ClosureTimestampScan> {
  const terminalStatuses = closureTerminalStatuses(registry);
  const missing = items.filter((item) => terminalStatuses.has(item.status) && !item.closed_at);
  const fixes: ValidateFixRecord[] = [];
  const residual: Array<{ id: string; reason: string }> = [];
  for (const item of inspectHistory ? missing : []) {
    let evidence: ClosureTimestampEvidence;
    try {
      const history = await readHistoryEntries(getHistoryPath(pmRoot, item.id), item.id);
      const { body, ...metadata } = item;
      evidence = deriveClosureTimestamp(history, { metadata, body }, terminalStatuses);
    } catch {
      residual.push({ id: item.id, reason: "unreadable_history" });
      continue;
    }
    if ("reason" in evidence) {
      residual.push({ id: item.id, reason: evidence.reason });
      continue;
    }
    fixes.push({
      item_id: item.id, check: "metadata", field: "closed_at", kind: "set_closed_at",
      value: evidence.timestamp, gate: "timestamps",
      command: "pm validate --check-metadata --auto-fix --fix-scope timestamps",
    });
  }
  return {
    details: {
      missing_closed_at_count: missing.length,
      missing_closed_at_item_ids: missing.slice(0, limit).map((item) => item.id),
      missing_closed_at_item_ids_truncated: missing.length > limit,
      closure_history_inspected: inspectHistory,
      closure_timestamp_derivable_count: fixes.length,
      closure_timestamp_residual_count: residual.length,
      closure_timestamp_residual: residual.slice(0, limit),
      closure_timestamp_residual_truncated: residual.length > limit,
      ...(missing.length > 0 ? { closure_timestamp_fix_hint: "pm validate --check-metadata --auto-fix --fix-scope timestamps --dry-run" } : {}),
    },
    fixes,
    warnings: missing.length > 0 ? [`validate_metadata_missing_closed_at:${missing.length}`] : [],
  };
}

/** Re-prove the planned timestamp under the item lock before appending a normal audited mutation. */
export async function applyClosureTimestampFix(fix: ValidateFixRecord, global: GlobalOptions): Promise<void> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const registry = resolveRuntimeStatusRegistry(settings.schema);
  await mutateItem({
    pmRoot, settings, id: fix.item_id, op: "update", author: resolveAuthor(global.author, settings.author_default),
    message: "Backfill closed_at from verified lifecycle history", skipNoop: true,
    async mutate(document) {
      if (document.metadata.closed_at) return { changedFields: [] };
      const history = await readHistoryEntries(getHistoryPath(pmRoot, document.metadata.id), document.metadata.id);
      const terminalStatuses = closureTerminalStatuses(registry);
      const evidence = deriveClosureTimestamp(history, document, terminalStatuses);
      if (!("timestamp" in evidence) || evidence.timestamp !== fix.value) {
        throw new PmCliError("Closure timestamp evidence changed or cannot be verified; rerun the timestamp repair preview.", EXIT_CODE.GENERIC_FAILURE);
      }
      document.metadata.closed_at = evidence.timestamp;
      return { changedFields: ["closed_at"] };
    },
  });
}
