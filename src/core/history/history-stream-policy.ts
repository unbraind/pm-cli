/**
 * @module core/history/history-stream-policy
 *
 * Implements append-only history and replay behavior for History Stream Policy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnWriteHooks } from "../extensions/index.js";
import { ensureDir, pathExists } from "../fs/fs-utils.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { getHistoryPath } from "../store/paths.js";
import type { PmSettings } from "../../types/index.js";

interface HistoryStreamPolicyParams {
  pmRoot: string;
  settings: PmSettings;
  itemId: string;
  commandLabel: string;
}

interface HistoryStreamPolicyManyParams {
  pmRoot: string;
  settings: PmSettings;
  itemIds: string[];
  commandLabel: string;
}

/** Documents the history stream policy result payload exchanged by command, SDK, and package integrations. */
export interface HistoryStreamPolicyResult {
  /** Value that configures or reports auto created ids for this contract. */
  auto_created_ids: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

function toSortedUniqueItemIds(itemIds: string[]): string[] {
  return [...new Set(itemIds.filter((value) => value.trim().length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function strictMissingStreamError(
  itemId: string,
  commandLabel: string,
): PmCliError {
  return new PmCliError(
    `Missing history stream for ${itemId}. ${commandLabel} requires history streams when settings.history.missing_stream is strict_error.`,
    EXIT_CODE.NOT_FOUND,
  );
}

async function createStream(
  historyPath: string,
  commandLabel: string,
): Promise<string[]> {
  await ensureDir(path.dirname(historyPath));
  const handle = await fs.open(historyPath, "a");
  await handle.close();
  return runActiveOnWriteHooks({
    path: historyPath,
    scope: "project",
    op: `${commandLabel}:history:auto_create`,
  });
}

/** Implements enforce history stream policy for item for the public runtime surface of this module. */
export async function enforceHistoryStreamPolicyForItem(
  params: HistoryStreamPolicyParams,
): Promise<HistoryStreamPolicyResult> {
  return enforceHistoryStreamPolicyForItems({
    pmRoot: params.pmRoot,
    settings: params.settings,
    itemIds: [params.itemId],
    commandLabel: params.commandLabel,
  });
}

/** Implements enforce history stream policy for items for the public runtime surface of this module. */
export async function enforceHistoryStreamPolicyForItems(
  params: HistoryStreamPolicyManyParams,
): Promise<HistoryStreamPolicyResult> {
  const ids = toSortedUniqueItemIds(params.itemIds);
  const autoCreated: string[] = [];
  const warnings: string[] = [];

  for (const itemId of ids) {
    const historyPath = getHistoryPath(params.pmRoot, itemId);
    if (await pathExists(historyPath)) {
      continue;
    }
    if (params.settings.history.missing_stream === "strict_error") {
      throw strictMissingStreamError(itemId, params.commandLabel);
    }
    warnings.push(...(await createStream(historyPath, params.commandLabel)));
    warnings.push(`history_stream_auto_created:${itemId}`);
    autoCreated.push(itemId);
  }

  return {
    auto_created_ids: autoCreated,
    warnings,
  };
}
