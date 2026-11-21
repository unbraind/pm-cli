/**
 * @module core/fs/atomic-create
 *
 * Publishes complete immutable files without replacing an existing document.
 */
import { link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Link failures that mean the filesystem cannot hard-link, not that the path exists. */
const HARD_LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** The destination's filesystem cannot publish by hard link; nothing was published. */
export class AtomicLinkUnsupportedError extends Error {
  /** The errno code the link failed with. */
  readonly code: string;

  /** Wrap the link failure that showed the filesystem cannot hard-link. */
  constructor(code: string, cause: unknown) {
    super(`The filesystem cannot publish a file by hard link (${code}).`, { cause });
    this.name = "AtomicLinkUnsupportedError";
    this.code = code;
  }
}

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
 * pathname. A competing creator wins without being overwritten. A filesystem
 * that cannot hard-link throws AtomicLinkUnsupportedError, and other link
 * failures propagate; no unsafe overwrite fallback is used.
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
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") {
        return false;
      }
      if (HARD_LINK_UNSUPPORTED.has(code)) throw new AtomicLinkUnsupportedError(code, error);
      throw error;
    }
  } finally {
    // Cleanup is best effort: a published file must never be reported as a failure.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
