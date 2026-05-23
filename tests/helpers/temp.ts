import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempDir<T>(prefix: string, run: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
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
