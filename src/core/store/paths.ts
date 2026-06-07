import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PM_DIRNAME, SETTINGS_FILENAME, TYPE_TO_FOLDER } from "../shared/constants.js";
import type { ItemFormat, ItemType } from "../../types/index.js";

export const ITEM_FILE_EXTENSION_BY_FORMAT: Record<ItemFormat, ".md" | ".toon"> = {
  json_markdown: ".md",
  toon: ".toon",
};

const ITEM_FORMAT_BY_EXTENSION = {
  ".md": "json_markdown",
  ".toon": "toon",
} as const satisfies Record<string, ItemFormat>;

export const ITEM_FILE_EXTENSIONS: Array<keyof typeof ITEM_FORMAT_BY_EXTENSION> = [".md", ".toon"];

function pathExists(pathValue: string): boolean {
  try {
    statSync(pathValue);
    return true;
  } catch {
    return false;
  }
}

function discoverPmRootFromAncestors(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const candidateRoot = path.join(current, PM_DIRNAME);
    const candidateSettingsPath = path.join(candidateRoot, SETTINGS_FILENAME);
    if (pathExists(candidateSettingsPath)) {
      return candidateRoot;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function resolvePmRoot(cwd: string, cliPath?: string): string {
  const envPath = process.env.PM_PATH;
  const explicitPath = cliPath?.trim() || envPath?.trim();
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    // When an explicit --path/PM_PATH points at a project root that contains an
    // initialized `.agents/pm`, resolve into it. Without this, an agent passing
    // the directory where it ran `pm init` (which creates `<dir>/.agents/pm`)
    // hits a hard "tracker not initialized" dead-end, while cwd discovery walks
    // up to find the same `.agents/pm`. We only redirect when the path itself is
    // not already a tracker root, so `pm init --path <dir>` (which writes
    // `<dir>/settings.json` directly) and existing tracker roots keep working.
    if (!pathExists(getSettingsPath(resolved))) {
      const nestedRoot = path.join(resolved, PM_DIRNAME);
      if (pathExists(getSettingsPath(nestedRoot))) {
        return nestedRoot;
      }
    }
    return resolved;
  }
  const discoveredRoot = discoverPmRootFromAncestors(cwd);
  if (discoveredRoot) {
    return discoveredRoot;
  }
  const selected = PM_DIRNAME;
  return path.resolve(cwd, selected);
}

export function resolveGlobalPmRoot(cwd: string): string {
  const envPath = process.env.PM_GLOBAL_PATH?.trim();
  const selected = envPath && envPath.length > 0 ? envPath : path.join(os.homedir(), ".pm-cli");
  return path.resolve(cwd, selected);
}

export function getSettingsPath(pmRoot: string): string {
  return path.join(pmRoot, SETTINGS_FILENAME);
}

function deriveDefaultTypeFolder(type: string): string {
  const normalized = toSlugToken(type);
  if (normalized.length === 0) {
    return "items";
  }
  return normalized.endsWith("s") ? normalized : `${normalized}s`;
}

function toSlugToken(value: string): string {
  const trimmed = value.trim().toLowerCase();
  let slug = "";
  let pendingDash = false;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    const isAlpha = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isAlpha || isDigit) {
      if (pendingDash && slug.length > 0) {
        slug += "-";
      }
      slug += character;
      pendingDash = false;
      continue;
    }
    if (slug.length > 0) {
      pendingDash = true;
    }
  }
  return slug;
}

export function getTypeDirPath(pmRoot: string, type: ItemType, typeToFolder: Record<string, string> = TYPE_TO_FOLDER): string {
  const folder = typeToFolder[type] ?? deriveDefaultTypeFolder(type);
  return path.join(pmRoot, folder);
}

export function getItemPath(
  pmRoot: string,
  type: ItemType,
  id: string,
  itemFormat: ItemFormat = "toon",
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
): string {
  return path.join(getTypeDirPath(pmRoot, type, typeToFolder), `${id}${ITEM_FILE_EXTENSION_BY_FORMAT[itemFormat]}`);
}

export function getItemFormatFromPath(itemPath: string): ItemFormat | null {
  const extension = path.extname(itemPath).toLowerCase() as keyof typeof ITEM_FORMAT_BY_EXTENSION;
  return ITEM_FORMAT_BY_EXTENSION[extension] ?? null;
}

export function getHistoryPath(pmRoot: string, id: string): string {
  return path.join(pmRoot, "history", `${id}.jsonl`);
}

export function getLockPath(pmRoot: string, id: string): string {
  return path.join(pmRoot, "locks", `${id}.lock`);
}

export function getRuntimePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime");
}

export function getTestRunsPath(pmRoot: string): string {
  return path.join(getRuntimePath(pmRoot), "test-runs");
}

export function getTestRunsRecordsPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "runs");
}

export function getTestRunRecordPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsRecordsPath(pmRoot), `${runId}.json`);
}

export function getTestRunsStdoutPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "stdout");
}

export function getTestRunsStderrPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "stderr");
}

export function getTestRunStdoutPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsStdoutPath(pmRoot), `${runId}.log`);
}

export function getTestRunStderrPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsStderrPath(pmRoot), `${runId}.log`);
}

export function getTestRunsResultsPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "results");
}

export function getTestRunResultPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsResultsPath(pmRoot), `${runId}.json`);
}
