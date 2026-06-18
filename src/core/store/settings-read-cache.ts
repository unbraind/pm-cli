/**
 * @module core/store/settings-read-cache
 *
 * Reads and writes tracker storage with format-aware helpers for Settings Read Cache.
 */
import { stat } from "node:fs/promises";

/**
 * Documents the settings read cache path signature payload exchanged by command, SDK, and package integrations.
 */
export interface SettingsReadCachePathSignature {
  path: string;
  mtime_ms: number | null;
  size: number | null;
}

/**
 * Documents the settings read cache entry payload exchanged by command, SDK, and package integrations.
 */
export interface SettingsReadCacheEntry<T> {
  tracked_paths: string[];
  signatures: SettingsReadCachePathSignature[];
  value: T;
}

const settingsReadCacheByRoot = new Map<string, SettingsReadCacheEntry<unknown>>();

function normalizeTrackedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((pathValue) => pathValue.trim()).filter((pathValue) => pathValue.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

async function readPathSignature(targetPath: string): Promise<SettingsReadCachePathSignature> {
  try {
    const targetStats = await stat(targetPath);
    return {
      path: targetPath,
      mtime_ms: targetStats.mtimeMs,
      size: targetStats.size,
    };
  } catch {
    return {
      path: targetPath,
      mtime_ms: null,
      size: null,
    };
  }
}

/**
 * Implements collect settings read cache signatures for the public runtime surface of this module.
 */
export async function collectSettingsReadCacheSignatures(paths: string[]): Promise<SettingsReadCachePathSignature[]> {
  const normalizedPaths = normalizeTrackedPaths(paths);
  const signatures = await Promise.all(normalizedPaths.map((targetPath) => readPathSignature(targetPath)));
  signatures.sort((left, right) => left.path.localeCompare(right.path));
  return signatures;
}

/**
 * Implements settings read cache signatures equal for the public runtime surface of this module.
 */
export function settingsReadCacheSignaturesEqual(
  left: SettingsReadCachePathSignature[],
  right: SettingsReadCachePathSignature[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (
      leftEntry.path !== rightEntry.path ||
      leftEntry.mtime_ms !== rightEntry.mtime_ms ||
      leftEntry.size !== rightEntry.size
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Implements get settings read cache entry for the public runtime surface of this module.
 */
export function getSettingsReadCacheEntry<T>(pmRoot: string): SettingsReadCacheEntry<T> | undefined {
  return settingsReadCacheByRoot.get(pmRoot) as SettingsReadCacheEntry<T> | undefined;
}

/**
 * Implements set settings read cache entry for the public runtime surface of this module.
 */
export function setSettingsReadCacheEntry<T>(pmRoot: string, entry: SettingsReadCacheEntry<T>): void {
  const normalizedTrackedPaths = normalizeTrackedPaths(entry.tracked_paths);
  const normalizedSignatures = [...entry.signatures]
    .map((signature) => ({
      path: signature.path,
      mtime_ms: signature.mtime_ms,
      size: signature.size,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  settingsReadCacheByRoot.set(pmRoot, {
    tracked_paths: normalizedTrackedPaths,
    signatures: normalizedSignatures,
    value: entry.value,
  });
}

/**
 * Implements clear settings read cache for the public runtime surface of this module.
 */
export function clearSettingsReadCache(pmRoot?: string): void {
  if (pmRoot) {
    settingsReadCacheByRoot.delete(pmRoot);
    return;
  }
  settingsReadCacheByRoot.clear();
}
