import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../core/fs/fs-utils.js";
import { runActiveOnReadHooks } from "../../core/extensions/index.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { readHistoryEntries } from "./history.js";
import type { HistoryEntry } from "../../types/index.js";

export interface ActivityCommandOptions {
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

  const limit = parseLimit(options.limit);
  await readSettings(pmRoot);
  const historyDir = path.join(pmRoot, "history");
  await runActiveOnReadHooks({
    path: historyDir,
    scope: "project",
  });
  const historyFiles = await listHistoryFiles(historyDir);

  const combined: ActivityEntry[] = [];
  for (const file of historyFiles) {
    const id = file.slice(0, -".jsonl".length);
    const entries = await readHistoryEntries(path.join(historyDir, file), id);
    for (const entry of entries) {
      combined.push({
        id,
        ...entry,
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
