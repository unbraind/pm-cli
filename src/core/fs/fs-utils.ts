import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

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

export async function writeFileAtomic(targetPath: string, contents: string): Promise<void> {
  const dirPath = path.dirname(targetPath);
  await ensureDir(dirPath);
  const tempPath = path.join(
    dirPath,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, targetPath);
}

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
