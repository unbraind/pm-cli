import { pathExists, readFileIfExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { runActiveOnReadHooks } from "../../core/extensions/index.js";
import { normalizeItemId } from "../../core/item/id.js";
import { locateItem } from "../../core/store/item-store.js";
import { getHistoryPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { HistoryEntry } from "../../types/index.js";

export interface HistoryCommandOptions {
  limit?: string;
}

export interface HistoryResult {
  id: string;
  history: HistoryEntry[];
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
  return values.slice(Math.max(0, values.length - limit));
}

export async function readHistoryEntries(historyPath: string, itemId: string): Promise<HistoryEntry[]> {
  const raw = await readFileIfExists(historyPath);
  if (raw === null) {
    return [];
  }
  await runActiveOnReadHooks({
    path: historyPath,
    scope: "project",
  });
  if (raw.trim() === "") {
    return [];
  }

  const entries: HistoryEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      throw new PmCliError(
        `History for ${itemId} contains invalid JSON at line ${index + 1}`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
  }
  return entries;
}

export async function runHistory(id: string, options: HistoryCommandOptions, global: GlobalOptions): Promise<HistoryResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const limit = parseLimit(options.limit);
  const settings = await readSettings(pmRoot);
  const normalizedId = normalizeItemId(id, settings.id_prefix);
  const located = await locateItem(pmRoot, normalizedId, settings.id_prefix);
  const resolvedId = located?.id ?? normalizedId;
  const historyPath = getHistoryPath(pmRoot, resolvedId);
  if (!located && !(await pathExists(historyPath))) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }

  const history = limitEntries(await readHistoryEntries(historyPath, resolvedId), limit);
  return {
    id: resolvedId,
    history,
    count: history.length,
    limit: limit ?? null,
  };
}
