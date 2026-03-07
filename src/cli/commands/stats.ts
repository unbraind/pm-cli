import fs from "node:fs/promises";
import path from "node:path";
import { runActiveOnReadHooks } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { ITEM_TYPE_VALUES, STATUS_VALUES } from "../../types/index.js";
import type { ItemStatus, ItemType } from "../../types/index.js";

export interface StatsResult {
  totals: {
    items: number;
    history_streams: number;
    history_entries: number;
  };
  by_type: Record<ItemType, number>;
  by_status: Record<ItemStatus, number>;
  generated_at: string;
}

function zeroByType(): Record<ItemType, number> {
  return ITEM_TYPE_VALUES.reduce(
    (acc, value) => {
      acc[value] = 0;
      return acc;
    },
    {} as Record<ItemType, number>,
  );
}

function zeroByStatus(): Record<ItemStatus, number> {
  return STATUS_VALUES.reduce(
    (acc, value) => {
      acc[value] = 0;
      return acc;
    },
    {} as Record<ItemStatus, number>,
  );
}

function countNonEmptyLines(raw: string): number {
  if (raw.trim().length === 0) {
    return 0;
  }
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .length;
}

async function readHistorySummary(pmRoot: string): Promise<{ history_streams: number; history_entries: number }> {
  const historyDir = path.join(pmRoot, "history");
  if (!(await pathExists(historyDir))) {
    return {
      history_streams: 0,
      history_entries: 0,
    };
  }

  await runActiveOnReadHooks({
    path: historyDir,
    scope: "project",
  });
  const historyFiles = (await fs.readdir(historyDir))
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b));

  let historyEntries = 0;
  for (const file of historyFiles) {
    const historyPath = path.join(historyDir, file);
    const raw = await fs.readFile(historyPath, "utf8");
    await runActiveOnReadHooks({
      path: historyPath,
      scope: "project",
    });
    historyEntries += countNonEmptyLines(raw);
  }

  return {
    history_streams: historyFiles.length,
    history_entries: historyEntries,
  };
}

export async function runStats(global: GlobalOptions): Promise<StatsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  await readSettings(pmRoot);
  const items = await listAllFrontMatter(pmRoot);

  const byType = zeroByType();
  const byStatus = zeroByStatus();
  for (const item of items) {
    byType[item.type] += 1;
    byStatus[item.status] += 1;
  }

  const historySummary = await readHistorySummary(pmRoot);

  return {
    totals: {
      items: items.length,
      history_streams: historySummary.history_streams,
      history_entries: historySummary.history_entries,
    },
    by_type: byType,
    by_status: byStatus,
    generated_at: nowIso(),
  };
}
