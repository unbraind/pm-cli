import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const CLEANUP_RETRYABLE_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"]);

function readErrorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

function sleepSync(milliseconds) {
  const start = Date.now();
  while (Date.now() - start < milliseconds) {
    // Short, synchronous cleanup retry delay for this standalone smoke helper.
  }
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
    // Opportunistically remove first-level entries before retrying the root.
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
