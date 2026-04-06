import fs from "node:fs/promises";
import path from "node:path";
import { getActiveExtensionRegistrations, runActiveOnReadHooks } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { enforceHistoryStreamPolicyForItems } from "../../core/history/history-stream-policy.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { readHistoryEntries } from "./history.js";
import type { HistoryEntry } from "../../types/index.js";

export interface ActivityCommandOptions {
  id?: string;
  op?: string;
  author?: string;
  from?: string;
  to?: string;
  limit?: string;
}

export interface ActivityEntry extends HistoryEntry {
  id: string;
}

export interface ActivityResult {
  activity: ActivityEntry[];
  count: number;
  limit: number | null;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PmCliError("Invalid --limit value", EXIT_CODE.USAGE);
  }
  return Math.floor(parsed);
}

function parseNonEmptyFilter(raw: string | undefined, flagLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new PmCliError(`${flagLabel} must not be empty`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseRangeBound(raw: string | undefined, nowValue: string): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new PmCliError("Activity time bounds must not be empty", EXIT_CODE.USAGE);
  }
  return resolveIsoOrRelative(normalized, new Date(nowValue));
}

function includeByTimeWindow(entry: ActivityEntry, from: string | undefined, to: string | undefined): boolean {
  if (from && compareTimestampStrings(entry.ts, from) < 0) {
    return false;
  }
  if (to && compareTimestampStrings(entry.ts, to) >= 0) {
    return false;
  }
  return true;
}

function limitEntries<T>(values: T[], limit: number | undefined): T[] {
  if (limit === undefined) return values;
  return values.slice(0, limit);
}

function sortActivity(entries: ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((a, b) => {
    const byTimestamp = b.ts.localeCompare(a.ts);
    if (byTimestamp !== 0) return byTimestamp;
    const byId = a.id.localeCompare(b.id);
    if (byId !== 0) return byId;
    return a.op.localeCompare(b.op);
  });
}

async function listHistoryFiles(historyDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(historyDir))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error: unknown) {
    // Activity should degrade gracefully when optional history storage is absent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function runActivity(options: ActivityCommandOptions, global: GlobalOptions): Promise<ActivityResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const nowValue = nowIso();
  const idFilter = parseNonEmptyFilter(options.id, "Activity --id");
  const opFilter = parseNonEmptyFilter(options.op, "Activity --op");
  const authorFilter = parseNonEmptyFilter(options.author, "Activity --author");
  const fromBound = parseRangeBound(options.from, nowValue);
  const toBound = parseRangeBound(options.to, nowValue);
  if (fromBound && toBound && compareTimestampStrings(fromBound, toBound) >= 0) {
    throw new PmCliError("Activity --from must be before --to", EXIT_CODE.USAGE);
  }
  const limit = parseLimit(options.limit);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder);
  await enforceHistoryStreamPolicyForItems({
    pmRoot,
    settings,
    itemIds: items.map((item) => item.id),
    commandLabel: "activity",
  });
  const historyDir = path.join(pmRoot, "history");
  await runActiveOnReadHooks({
    path: historyDir,
    scope: "project",
  });
  const historyFiles = await listHistoryFiles(historyDir);

  const combined: ActivityEntry[] = [];
  for (const file of historyFiles) {
    const id = file.slice(0, -".jsonl".length);
    if (idFilter && id !== idFilter) {
      continue;
    }
    const entries = await readHistoryEntries(path.join(historyDir, file), id);
    for (const entry of entries) {
      if (opFilter && entry.op !== opFilter) {
        continue;
      }
      if (authorFilter && entry.author !== authorFilter) {
        continue;
      }
      const candidate: ActivityEntry = {
        id,
        ...entry,
      };
      if (!includeByTimeWindow(candidate, fromBound, toBound)) {
        continue;
      }
      combined.push({
        ...candidate,
      });
    }
  }

  const activity = limitEntries(sortActivity(combined), limit);
  return {
    activity,
    count: activity.length,
    limit: limit ?? null,
  };
}
