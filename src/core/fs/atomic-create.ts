/**
 * @module core/fs/atomic-create
 *
 * Publishes complete immutable files without replacing an existing document.
 */
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Stage bytes beside the destination, then atomically link them into an absent
 * pathname. A competing creator wins without being overwritten. Hard-link
 * failures other than EEXIST propagate; no unsafe overwrite fallback is used.
 * Publication provides atomic visibility, not fsync-backed power-loss durability.
 */
export async function createFileAtomic(targetPath: string, contents: string): Promise<boolean> {
  const parent = path.dirname(targetPath);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".pm-seed-"));
  const stagedFile = path.join(staging, "value");
  try {
    await writeFile(stagedFile, contents, "utf8");
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
