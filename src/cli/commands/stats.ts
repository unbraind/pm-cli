import fs from "node:fs/promises";
import path from "node:path";
import { getActiveExtensionRegistrations, runActiveOnReadHooks } from "../../core/extensions/index.js";
import {
  computeMetadataCoverage,
  groupItemsByDimension,
  lifecycleClassifierFromStatusRegistry,
  type GroupedBreakdown,
  type MetadataCoverageReport,
} from "../../core/governance/metadata-coverage.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { enforceHistoryStreamPolicyForItems } from "../../core/history/history-stream-policy.js";
import { computeHistoryStorageStats, type HistoryStorageStats } from "../../core/history/history-storage-stats.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatterLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemStatus, ItemType } from "../../types/index.js";

export interface StatsCommandOptions {
  /** Include aggregate per-stream history storage metrics (sizes, depth, oldest/newest). */
  storage?: boolean;
  /** Include metadata coverage percentages (AC, estimates, resolution, tags, parent) overall and by type. */
  metadataCoverage?: boolean;
  /** Include a lifecycle-bucketed breakdown grouped by assignee. */
  byAssignee?: boolean;
  /** Include a lifecycle-bucketed breakdown grouped by tag (optionally filtered by --tag-prefix). */
  byTag?: boolean;
  /** Include a lifecycle-bucketed breakdown grouped by priority. */
  byPriority?: boolean;
  /** With --by-tag: only consider tags starting with this prefix (e.g. "domain:"). */
  tagPrefix?: string;
}

export interface StatsResult {
  totals: {
    items: number;
    history_streams: number;
    history_entries: number;
  };
  by_type: Record<ItemType, number>;
  by_status: Record<ItemStatus, number>;
  /** Present only with --metadata-coverage: per-field coverage overall and by type. */
  metadata_coverage?: MetadataCoverageReport;
  /** Present only with --by-assignee/--by-tag/--by-priority: lifecycle-bucketed group breakdowns. */
  breakdowns?: {
    assignee?: GroupedBreakdown;
    tag?: GroupedBreakdown;
    priority?: GroupedBreakdown;
  };
  /** Present only with --storage: aggregate history-stream metrics for compaction/planning. */
  storage?: HistoryStorageStats;
  generated_at: string;
}

function zeroByType(itemTypes: string[]): Record<ItemType, number> {
  return itemTypes.reduce(
    (acc, value) => {
      acc[value] = 0;
      return acc;
    },
    {} as Record<ItemType, number>,
  );
}

function zeroByStatus(statuses: string[]): Record<ItemStatus, number> {
  return statuses.reduce(
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

async function readHistoryStreamContents(pmRoot: string): Promise<Array<{ id: string; raw: string }>> {
  const historyDir = path.join(pmRoot, "history");
  if (!(await pathExists(historyDir))) {
    return [];
  }

  await runActiveOnReadHooks({
    path: historyDir,
    scope: "project",
  });
  const historyFiles = (await fs.readdir(historyDir))
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b));

  const streams: Array<{ id: string; raw: string }> = [];
  for (const file of historyFiles) {
    const historyPath = path.join(historyDir, file);
    const raw = await fs.readFile(historyPath, "utf8");
    await runActiveOnReadHooks({
      path: historyPath,
      scope: "project",
    });
    streams.push({ id: file.slice(0, -".jsonl".length), raw });
  }

  return streams;
}

export const _testOnly = {
  zeroByType,
  zeroByStatus,
  countNonEmptyLines,
  readHistoryStreamContents,
};

export async function runStats(global: GlobalOptions, options: StatsCommandOptions = {}): Promise<StatsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const items = await listAllFrontMatterLight(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema);
  await enforceHistoryStreamPolicyForItems({
    pmRoot,
    settings,
    itemIds: items.map((item) => item.id),
    commandLabel: "stats",
  });

  const byType = zeroByType(typeRegistry.types);
  const byStatus = zeroByStatus(statusRegistry.definitions.map((definition) => definition.id));
  // zeroByType/zeroByStatus pre-seed a bucket for every registry type/status, and
  // the light front-matter reader drops any item whose type/status falls outside
  // the active registry (parse rejects them) — so every item's bucket is already
  // present here and no on-the-fly initialization is reachable.
  for (const item of items) {
    byType[item.type] += 1;
    byStatus[item.status] += 1;
  }

  const streams = await readHistoryStreamContents(pmRoot);
  let historyEntries = 0;
  for (const stream of streams) {
    historyEntries += countNonEmptyLines(stream.raw);
  }
  const storage = options.storage ? computeHistoryStorageStats(streams) : undefined;

  const classifier = lifecycleClassifierFromStatusRegistry(statusRegistry);
  const metadataCoverage = options.metadataCoverage ? computeMetadataCoverage(items, classifier) : undefined;
  const breakdowns: NonNullable<StatsResult["breakdowns"]> = {};
  if (options.byAssignee) {
    breakdowns.assignee = groupItemsByDimension(items, "assignee", classifier);
  }
  if (options.byTag) {
    breakdowns.tag = groupItemsByDimension(items, "tag", classifier, { tagPrefix: options.tagPrefix });
  }
  if (options.byPriority) {
    breakdowns.priority = groupItemsByDimension(items, "priority", classifier);
  }
  const hasBreakdowns = Object.keys(breakdowns).length > 0;

  return {
    totals: {
      items: items.length,
      history_streams: streams.length,
      history_entries: historyEntries,
    },
    by_type: byType,
    by_status: byStatus,
    ...(metadataCoverage ? { metadata_coverage: metadataCoverage } : {}),
    ...(hasBreakdowns ? { breakdowns } : {}),
    ...(storage ? { storage } : {}),
    generated_at: nowIso(),
  };
}
