/**
 * @module core/fs/atomic-create
 *
 * Publishes complete immutable files without replacing an existing document.
 */
import { link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Write and flush the staged bytes, so a published name never points at unflushed data. */
async function writeDurably(file: string, contents: string): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Stage bytes beside the destination, then atomically link them into an absent
 * pathname. A competing creator wins without being overwritten. Hard-link
 * failures other than EEXIST propagate; no unsafe overwrite fallback is used.
 * Publication provides atomic visibility; `sync` also flushes the staged bytes
 * before they are published, for file-data durability.
 */
export async function createFileAtomic(
  targetPath: string,
  contents: string,
  options: { sync?: boolean } = {},
): Promise<boolean> {
  const parent = path.dirname(targetPath);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".pm-seed-"));
  const stagedFile = path.join(staging, "value");
  try {
    await (options.sync === true ? writeDurably(stagedFile, contents) : writeFile(stagedFile, contents, "utf8"));
    try {
      await link(stagedFile, targetPath);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
