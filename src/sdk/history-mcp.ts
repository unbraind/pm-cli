/**
 * @module sdk/history-mcp
 *
 * Adapts MCP's alias-rich untyped option bags to the typed public history
 * maintenance engines without duplicating their selection or integrity policy.
 */
import type { HistoryCompactScope } from "../core/history/history-compact-bulk.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  assertHistoryCompactTarget,
  runHistoryCompact,
  runHistoryCompactBulk,
  type HistoryCompactBulkResult,
  type HistoryCompactResult,
} from "./history-compact.js";
import {
  assertHistoryRepairTarget,
  runHistoryRepair,
  runHistoryRepairAll,
} from "./history-repair.js";
import { parseRuntimeInteger, readRuntimeString } from "./runtime-input.js";

/** Minimal action context required by MCP history maintenance adapters. */
export interface HistoryMcpActionContext {
  /** Optional positional item id used by single-stream mode. */
  id?: string;
  /** Alias-rich MCP options normalized by the selected history adapter. */
  options: Record<string, unknown>;
  /** Force flag forwarded to integrity-sensitive maintenance engines. */
  force?: boolean;
  /** Global tracker and output controls shared with native command handlers. */
  global: GlobalOptions;
}

/** Dispatch single-stream or all-stream history repair from an MCP payload. */
export function runMcpHistoryRepairAction(
  context: HistoryMcpActionContext,
): Promise<unknown> {
  const repairAll = context.options.all === true;
  const repairId = context.id ?? readRuntimeString(context.options, "id");
  assertHistoryRepairTarget(repairId, repairAll);
  return repairAll
    ? runHistoryRepairAll(context.options, context.global)
    : runHistoryRepair(repairId as string, context.options, context.global);
}

/** Dispatch single or bounded bulk history compaction from an MCP payload. */
export function runMcpHistoryCompactAction(
  context: HistoryMcpActionContext,
): Promise<HistoryCompactResult | HistoryCompactBulkResult> {
  const idsSource = context.options.ids;
  const ids = Array.isArray(idsSource)
    ? idsSource.map(String).filter((value) => value.trim().length > 0)
    : typeof idsSource === "string"
      ? idsSource
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined;
  const allOver = parseRuntimeInteger(
    context.options.allOver ?? context.options.all_over,
    "history-compact allOver",
  );
  const minEntries = parseRuntimeInteger(
    context.options.minEntries ?? context.options.min_entries,
    "history-compact minEntries",
  );
  const explicitScope = readRuntimeString(context.options, "scope");
  const requestedScopes: HistoryCompactScope[] = [];
  if (context.options.closed === true) requestedScopes.push("closed");
  if (
    context.options.allStreams === true ||
    context.options.all_streams === true
  ) {
    requestedScopes.push("all-streams");
  }
  if (explicitScope === "closed" || explicitScope === "all-streams") {
    requestedScopes.push(explicitScope);
  }
  const distinctScopes = [...new Set(requestedScopes)];
  if (distinctScopes.length > 1) {
    throw new PmCliError(
      "history-compact: closed and all-streams scopes are mutually exclusive.",
      EXIT_CODE.USAGE,
    );
  }
  const scope = distinctScopes[0];
  assertHistoryCompactTarget(context.id, { ids, allOver, scope });
  if (context.id !== undefined) {
    return runHistoryCompact(
      context.id,
      {
        before: readRuntimeString(context.options, "before"),
        dryRun:
          context.options.dryRun === true || context.options.dry_run === true,
        author: readRuntimeString(context.options, "author"),
        message: readRuntimeString(context.options, "message"),
        force: context.force,
      },
      context.global,
    );
  }
  return runHistoryCompactBulk(
    {
      ids,
      scope,
      allOver,
      minEntries,
      dryRun:
        context.options.dryRun === true || context.options.dry_run === true,
      author: readRuntimeString(context.options, "author"),
      message: readRuntimeString(context.options, "message"),
      force: context.force,
    },
    context.global,
  );
}
