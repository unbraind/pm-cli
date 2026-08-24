/**
 * @module sdk/merge/receipt-file-boundary
 *
 * Reads untrusted receipt candidates through a bounded, no-follow file
 * boundary whose race and short-read behavior can be exercised directly.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

/** Minimal filesystem operations required by the receipt reader. */
export interface ReceiptFileBoundary {
  /** Inspect the path without following its final symbolic link. */
  lstat(receiptPath: string): Promise<Stats>;
  /** Open the candidate and return the handle used for verified reads. */
  open(receiptPath: string, flags: number): Promise<FileHandle>;
}

const NODE_RECEIPT_FILE_BOUNDARY: ReceiptFileBoundary = { lstat, open };

/** Resolve the platform no-follow flag, falling back only where Node omits it. */
export function resolveReceiptNoFollowFlag(constants: {
  O_NOFOLLOW?: number;
}): number {
  return constants.O_NOFOLLOW ?? 0;
}

/** Read one regular file only when its opened identity remains bounded and stable. */
export async function readBoundedRegularFile(
  receiptPath: string,
  maximumBytes: number,
  boundary: ReceiptFileBoundary = NODE_RECEIPT_FILE_BOUNDARY,
): Promise<string | null> {
  const pathStats = await boundary.lstat(receiptPath);
  if (
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    pathStats.size > maximumBytes
  ) {
    return null;
  }
  const handle = await boundary.open(
    receiptPath,
    fsConstants.O_RDONLY | resolveReceiptNoFollowFlag(fsConstants),
  );
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size > maximumBytes) return null;
    const buffer = Buffer.alloc(openedStats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalStats = await handle.stat();
    return finalStats.size === openedStats.size && offset === openedStats.size
      ? buffer.toString("utf8", 0, offset)
      : null;
  } finally {
    await handle.close();
  }
}
