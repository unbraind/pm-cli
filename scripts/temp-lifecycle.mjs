import { writeSync } from "node:fs";
import { cleanupTempRoot } from "./smoke-cleanup.mjs";

const workspaces = new Map();
let stopping = false;

/** Write exit-time diagnostics synchronously; unavailable stderr must not mask the original failure. */
function reportFailure(root, error) {
  try {
    writeSync(2, `Temporary workspace retained at ${root}: ${String(error)}\n`);
  } catch {
    // Reporting is best effort when the stderr descriptor is closed or unwritable.
  }
}

/** Remove only roots whose producers need no asynchronous shutdown at process exit. */
function cleanupOnExit() {
  for (const [root, entry] of workspaces) {
    if (entry.shutdown) {
      reportFailure(root, "process exited before asynchronous shutdown completed");
      continue;
    }
    try {
      cleanupTempRoot(root);
    } catch (error) {
      reportFailure(root, error);
    }
  }
}

/** Stop producers before deleting their roots; a failed shutdown preserves its evidence. */
async function cleanupOnSignal(signal) {
  if (stopping) return;
  stopping = true;
  await Promise.all([...workspaces].map(async ([root, entry]) => {
    try {
      await entry.shutdown?.();
      cleanupTempRoot(root);
    } catch (error) {
      reportFailure(root, error);
    } finally {
      workspaces.delete(root);
    }
  }));
  process.exit(signal === "SIGINT" ? 130 : 143);
}

/**
 * Register one script-owned temporary root for exit and interrupt cleanup.
 * Return a release function for normal finally blocks or deliberate retention.
 * Asynchronous consumers must supply bounded shutdown and release after disposal;
 * abrupt exits retain their roots because deleting a live consumer's files is unsafe.
 */
export function registerTempCleanup(root, options = {}) {
  if (workspaces.has(root)) throw new Error(`Temporary workspace already registered: ${root}`);
  if (workspaces.size === 0) {
    process.on("exit", cleanupOnExit);
    process.on("SIGINT", cleanupOnSignal);
    process.on("SIGTERM", cleanupOnSignal);
  }
  workspaces.set(root, options);
  return () => {
    workspaces.delete(root);
    if (workspaces.size === 0) {
      process.off("exit", cleanupOnExit);
      process.off("SIGINT", cleanupOnSignal);
      process.off("SIGTERM", cleanupOnSignal);
    }
  };
}
