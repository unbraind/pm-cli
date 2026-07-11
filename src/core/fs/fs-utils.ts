/**
 * @module core/fs/fs-utils
 *
 * Provides filesystem helpers for Fs Utils.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

/** Implements ensure dir for the public runtime surface of this module. */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/** Implements path exists for the public runtime surface of this module. */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Implements read file if exists for the public runtime surface of this module. */
export async function readFileIfExists(
  targetPath: string,
): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

/** Implements write file atomic for the public runtime surface of this module. */
export async function writeFileAtomic(
  targetPath: string,
  contents: string,
): Promise<void> {
  const dirPath = path.dirname(targetPath);
  await ensureDir(dirPath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  await fs.writeFile(tempPath, contents, "utf8");
  try {
    await fs.rename(tempPath, targetPath);
  } catch (error: unknown) {
    if (
      process.platform === "win32" &&
      (isErrno(error, "EPERM") || isErrno(error, "EBUSY"))
    ) {
      let lastError = error;
      for (const delayMs of WINDOWS_RENAME_RETRY_DELAYS_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        try {
          await fs.rename(tempPath, targetPath);
          return;
        } catch (retryError: unknown) {
          lastError = retryError;
          if (!isErrno(retryError, "EPERM") && !isErrno(retryError, "EBUSY")) {
            break;
          }
        }
      }
      try {
        await fs.unlink(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
      throw lastError;
    }
    if (isErrno(error, "EXDEV")) {
      try {
        await fs.copyFile(tempPath, targetPath);
      } finally {
        try {
          await fs.unlink(tempPath);
        } catch {
          // Best-effort cleanup only.
        }
      }
      return;
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

/**
 * Append a single newline-terminated line to a file, opened with `O_APPEND`.
 *
 * Concurrency contract: `O_APPEND` makes the seek-to-EOF that precedes each
 * `write(2)` atomic, so independent appenders never overwrite each other's
 * bytes. For the common case the whole `${line}\n` buffer is handed to the
 * kernel in one `write(2)`, which mainstream filesystems (ext4/xfs/apfs) commit
 * atomically under the inode lock — concurrent multi-process appends of small
 * records (e.g. the telemetry and OTLP-span queues) therefore stay
 * line-coherent without an external lock.
 *
 * The guarantee weakens only for a single record large enough that the OS
 * splits it across multiple `write(2)` calls (multi-KiB lines), where another
 * process's append could interleave between fragments. History JSONL — the only
 * caller that can produce large lines — is always written while the per-item
 * store lock is held (see core/store/item-store.ts), so those appends are
 * serialized regardless. Callers writing large records concurrently from
 * multiple processes must hold an equivalent lock.
 */
export async function appendLineAtomic(
  targetPath: string,
  line: string,
): Promise<void> {
  const dirPath = path.dirname(targetPath);
  await ensureDir(dirPath);
  const handle = await fs.open(targetPath, "a");
  try {
    await handle.writeFile(`${line}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/** Implements remove file if exists for the public runtime surface of this module. */
export async function removeFileIfExists(targetPath: string): Promise<void> {
  try {
    await fs.unlink(targetPath);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
