/**
 * @module core/store/sqlite-runtime
 * Loads the optional native accelerator without its one-time experimental
 * announcement contaminating CLI machine channels. Application warnings retain
 * their original delivery; no environment or asynchronous warning policy changes.
 */
import type { DatabaseSync } from "node:sqlite";

/**
 * Load synchronously and filter only Node's exact SQLite announcement during
 * that call. Restore the prior emitter even when the optional module is absent.
 * The caller still receives every other warning with its original arguments.
 */
export function loadDatabaseSync(
  loadModule: (specifier: string) => unknown,
): typeof DatabaseSync | null {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args: unknown[]) => {
    if (warning === "SQLite is an experimental feature and might change at any time"
      && args[0] === "ExperimentalWarning") return;
    Reflect.apply(emitWarning, process, [warning, ...args]);
  };
  try {
    const loaded = loadModule(["node", "sqlite"].join(":")) as {
      DatabaseSync?: typeof DatabaseSync;
    };
    return loaded.DatabaseSync ?? null;
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Skip native probing on runtimes below the supported SQLite capability floor. */
export function loadStableDatabaseSync(
  nodeVersion: string,
  loadModule: (specifier: string) => unknown,
): typeof DatabaseSync | null {
  const nodeMajor = Number.parseInt(nodeVersion, 10);
  return Number.isFinite(nodeMajor) && nodeMajor >= 22
    ? loadDatabaseSync(loadModule)
    : null;
}
