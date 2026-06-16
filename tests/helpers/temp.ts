import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TEMP_DIR_CLEANUP_MAX_RETRIES = 5;
const TEMP_DIR_CLEANUP_RETRYABLE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

function isRetryableTempDirCleanupError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TEMP_DIR_CLEANUP_RETRYABLE_CODES.has(code);
}

async function cleanupTempDirWithRetries(tempDir: string): Promise<void> {
  for (let attempt = 0; attempt <= TEMP_DIR_CLEANUP_MAX_RETRIES; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableTempDirCleanupError(error) || attempt === TEMP_DIR_CLEANUP_MAX_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export async function withTempDir<T>(prefix: string, run: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tempDir);
  } finally {
    await cleanupTempDirWithRetries(tempDir);
  }
}

export async function withTempRoot<T>(prefix: string, run: (tempRoot: string) => Promise<T>): Promise<T> {
  return withTempDir(prefix, run);
}

export async function withTempGlobalRoot<T>(prefix: string, run: (globalRoot: string) => Promise<T>): Promise<T> {
  return withTempDir(prefix, async (tempRoot) => {
    const globalRoot = path.join(tempRoot, ".pm-cli");
    return await run(globalRoot);
  });
}
