import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const CLEANUP_RETRYABLE_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

function readErrorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function cleanupTempRoot(tempRoot) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
      if (!existsSync(tempRoot)) {
        return;
      }
    } catch (error) {
      lastError = error;
      if (!CLEANUP_RETRYABLE_CODES.has(readErrorCode(error))) {
        break;
      }
    }

    if (!existsSync(tempRoot)) {
      return;
    }
    try {
      for (const entry of readdirSync(tempRoot)) {
        rmSync(path.join(tempRoot, entry), { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
      }
    } catch {
      // Best effort only; the next retry will reattempt the full root removal.
    }
    sleepSync(attempt * 120);
  }

  if (existsSync(tempRoot)) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to remove temporary smoke directory: ${tempRoot}`);
  }
}
