/**
 * @module core/fs/fs-utils
 *
 * Provides filesystem helpers for Fs Utils.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Implements ensure dir for the public runtime surface of this module.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Implements path exists for the public runtime surface of this module.
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Implements read file if exists for the public runtime surface of this module.
 */
export async function readFileIfExists(targetPath: string): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

/**
 * Implements write file atomic for the public runtime surface of this module.
 */
export async function writeFileAtomic(targetPath: string, contents: string): Promise<void> {
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
 * Implements append line atomic for the public runtime surface of this module.
 */
export async function appendLineAtomic(targetPath: string, line: string): Promise<void> {
  const dirPath = path.dirname(targetPath);
  await ensureDir(dirPath);
  const handle = await fs.open(targetPath, "a");
  try {
    await handle.writeFile(`${line}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Implements remove file if exists for the public runtime surface of this module.
 */
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
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
