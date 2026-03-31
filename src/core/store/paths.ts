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

export function resolvePmRoot(cwd: string, cliPath?: string): string {
  const envPath = process.env.PM_PATH;
  const selected = cliPath?.trim() || envPath?.trim() || PM_DIRNAME;
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

export function getTypeDirPath(pmRoot: string, type: ItemType): string {
  return path.join(pmRoot, TYPE_TO_FOLDER[type]);
}

export function getItemPath(pmRoot: string, type: ItemType, id: string, itemFormat: ItemFormat = "json_markdown"): string {
  return path.join(getTypeDirPath(pmRoot, type), `${id}${ITEM_FILE_EXTENSION_BY_FORMAT[itemFormat]}`);
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
