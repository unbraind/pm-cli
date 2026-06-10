import { stat } from "node:fs/promises";

export interface SettingsReadCachePathSignature {
  path: string;
  mtime_ms: number | null;
  size: number | null;
}

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

export async function collectSettingsReadCacheSignatures(paths: string[]): Promise<SettingsReadCachePathSignature[]> {
  const normalizedPaths = normalizeTrackedPaths(paths);
  const signatures = await Promise.all(normalizedPaths.map((targetPath) => readPathSignature(targetPath)));
  signatures.sort((left, right) => left.path.localeCompare(right.path));
  return signatures;
}

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

export function getSettingsReadCacheEntry<T>(pmRoot: string): SettingsReadCacheEntry<T> | undefined {
  return settingsReadCacheByRoot.get(pmRoot) as SettingsReadCacheEntry<T> | undefined;
}

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

export function clearSettingsReadCache(pmRoot?: string): void {
  if (pmRoot) {
    settingsReadCacheByRoot.delete(pmRoot);
    return;
  }
  settingsReadCacheByRoot.clear();
}
