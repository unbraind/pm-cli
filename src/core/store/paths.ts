/**
 * @module core/store/paths
 *
 * Reads and writes tracker storage with format-aware helpers for Paths.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PM_DIRNAME,
  SETTINGS_FILENAME,
  TYPE_TO_FOLDER,
} from "../shared/constants.js";
import { toDefaultFolder } from "../item/type-registry.js";
import type { ItemFormat, ItemType } from "../../types/index.js";

/** Public contract for item file extension by format, shared by SDK and presentation-layer consumers. */
export const ITEM_FILE_EXTENSION_BY_FORMAT: Record<
  ItemFormat,
  ".md" | ".toon"
> = {
  json_markdown: ".md",
  toon: ".toon",
};

const ITEM_FORMAT_BY_EXTENSION = {
  ".md": "json_markdown",
  ".toon": "toon",
} as const satisfies Record<string, ItemFormat>;

const NEARBY_TRACKER_SCAN_IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

/** Public contract for item file extensions, shared by SDK and presentation-layer consumers. */
export const ITEM_FILE_EXTENSIONS: Array<
  keyof typeof ITEM_FORMAT_BY_EXTENSION
> = [".md", ".toon"];

function pathExists(pathValue: string): boolean {
  try {
    statSync(pathValue);
    return true;
  } catch {
    return false;
  }
}

// Adopting a bare <dir>/settings.json during implicit ancestor discovery must
// not let an unrelated tool's settings.json hijack tracker resolution (and
// receive pm writes), so root-layout candidates need a pm-specific marker.
// `pm init` always writes both markers; explicit --path/PM_PATH targets skip
// this check because they carry user intent.
function isPmSettingsFile(settingsPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    return "id_prefix" in parsed || "item_format" in parsed;
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
    // Root-layout trackers (`pm init <dir>` writes settings.json directly into
    // <dir>) must be discoverable too; otherwise implicit invocations — and the
    // pm_root handed to extensions — fall back to a non-existent
    // <cwd>/.agents/pm (GH-495).
    const rootLayoutSettingsPath = path.join(current, SETTINGS_FILENAME);
    if (
      pathExists(rootLayoutSettingsPath) &&
      isPmSettingsFile(rootLayoutSettingsPath)
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Find a directly nested custom tracker root so recovery guidance can preserve existing data instead of recommending a second initialization. */
export function discoverNearbyPmRoot(
  cwd: string,
  excludedRoot?: string,
): string | undefined {
  const normalizedExcluded = excludedRoot ? path.resolve(excludedRoot) : undefined;
  try {
    return readdirSync(path.resolve(cwd), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !NEARBY_TRACKER_SCAN_IGNORED_DIRECTORIES.has(entry.name),
      )
      .map((entry) => path.join(path.resolve(cwd), entry.name))
      .filter((candidate) => candidate !== normalizedExcluded)
      .filter((candidate) => pathExists(getSettingsPath(candidate)))
      .filter((candidate) => isPmSettingsFile(getSettingsPath(candidate)))
      .sort((left, right) => left.localeCompare(right))[0];
  } catch {
    return undefined;
  }
}

/** Implements resolve pm root for the public runtime surface of this module. */
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

/** Resolve the project workspace that owns a tracker root. */
export function resolveWorkspaceRoot(pmRoot: string): string {
  const normalizedRoot = path.resolve(pmRoot);
  const parent = path.dirname(normalizedRoot);
  return path.basename(normalizedRoot) === "pm" && path.basename(parent) === ".agents"
    ? path.dirname(parent)
    : normalizedRoot;
}

/** Implements resolve global pm root for the public runtime surface of this module. */
export function resolveGlobalPmRoot(cwd: string): string {
  const envPath = process.env.PM_GLOBAL_PATH?.trim();
  const selected =
    envPath && envPath.length > 0
      ? envPath
      : path.join(os.homedir(), ".pm-cli");
  return path.resolve(cwd, selected);
}

/** Implements get settings path for the public runtime surface of this module. */
export function getSettingsPath(pmRoot: string): string {
  return path.join(pmRoot, SETTINGS_FILENAME);
}

/** Implements get type dir path for the public runtime surface of this module. */
export function getTypeDirPath(
  pmRoot: string,
  type: ItemType,
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
): string {
  const folder = typeToFolder[type] ?? toDefaultFolder(type);
  return path.join(pmRoot, folder);
}

/** Implements get item path for the public runtime surface of this module. */
export function getItemPath(
  pmRoot: string,
  type: ItemType,
  id: string,
  itemFormat: ItemFormat = "toon",
  typeToFolder: Record<string, string> = TYPE_TO_FOLDER,
): string {
  return path.join(
    getTypeDirPath(pmRoot, type, typeToFolder),
    `${id}${ITEM_FILE_EXTENSION_BY_FORMAT[itemFormat]}`,
  );
}

/** Implements get item format from path for the public runtime surface of this module. */
export function getItemFormatFromPath(itemPath: string): ItemFormat | null {
  const normalizedItemPath = itemPath.replaceAll("\\", "/");
  const extension = path.posix
    .extname(normalizedItemPath)
    .toLowerCase() as keyof typeof ITEM_FORMAT_BY_EXTENSION;
  return ITEM_FORMAT_BY_EXTENSION[extension] ?? null;
}

/** Implements get history path for the public runtime surface of this module. */
export function getHistoryPath(pmRoot: string, id: string): string {
  return path.join(pmRoot, "history", `${id}.jsonl`);
}

/** Implements get lock path for the public runtime surface of this module. */
export function getLockPath(pmRoot: string, id: string): string {
  return path.join(pmRoot, "locks", `${id}.lock`);
}

/** Implements get runtime path for the public runtime surface of this module. */
export function getRuntimePath(pmRoot: string): string {
  return path.join(pmRoot, "runtime");
}

/** Implements get test runs path for the public runtime surface of this module. */
export function getTestRunsPath(pmRoot: string): string {
  return path.join(getRuntimePath(pmRoot), "test-runs");
}

/** Implements get test runs records path for the public runtime surface of this module. */
export function getTestRunsRecordsPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "runs");
}

/** Implements get test run record path for the public runtime surface of this module. */
export function getTestRunRecordPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsRecordsPath(pmRoot), `${runId}.json`);
}

/** Implements get test runs stdout path for the public runtime surface of this module. */
export function getTestRunsStdoutPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "stdout");
}

/** Implements get test runs stderr path for the public runtime surface of this module. */
export function getTestRunsStderrPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "stderr");
}

/** Implements get test run stdout path for the public runtime surface of this module. */
export function getTestRunStdoutPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsStdoutPath(pmRoot), `${runId}.log`);
}

/** Implements get test run stderr path for the public runtime surface of this module. */
export function getTestRunStderrPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsStderrPath(pmRoot), `${runId}.log`);
}

/** Implements get test runs results path for the public runtime surface of this module. */
export function getTestRunsResultsPath(pmRoot: string): string {
  return path.join(getTestRunsPath(pmRoot), "results");
}

/** Implements get test run result path for the public runtime surface of this module. */
export function getTestRunResultPath(pmRoot: string, runId: string): string {
  return path.join(getTestRunsResultsPath(pmRoot), `${runId}.json`);
}
