import os from "node:os";
import path from "node:path";
import { PM_DIRNAME, SETTINGS_FILENAME, TYPE_TO_FOLDER } from "../shared/constants.js";
import type { ItemType } from "../../types/index.js";

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

export function getItemPath(pmRoot: string, type: ItemType, id: string): string {
  return path.join(getTypeDirPath(pmRoot, type), `${id}.md`);
}

export function getHistoryPath(pmRoot: string, id: string): string {
  return path.join(pmRoot, "history", `${id}.jsonl`);
}

export function getLockPath(pmRoot: string, id: string): string {
  return path.join(pmRoot, "locks", `${id}.lock`);
}
