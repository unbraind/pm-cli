import fs from "fs/promises";
import { getHistoryPath } from "../store/paths.js";
import { hashDocument } from "./history.js";
import { verifyHistoryChain } from "./replay.js";
import type { HistoryEntry, ItemMetadata } from "../../types/index.js";

export interface DriftScanResult {
  missingStreams: string[];
  unreadableStreams: string[];
  hashMismatches: string[];
  chainMismatches: string[];
  driftedItems: string[];
}

export async function scanHistoryDrift(
  pmRoot: string,
  items: Array<ItemMetadata & { body: string }>,
): Promise<DriftScanResult> {
  const missingStreams: string[] = [];
  const unreadableStreams: string[] = [];
  const hashMismatches: string[] = [];
  const chainMismatches: string[] = [];

  for (const item of items) {
    const historyPath = getHistoryPath(pmRoot, item.id);
    let latestAfterHash: string | null = null;
    try {
      const raw = await fs.readFile(historyPath, "utf8");
      if (raw.trim().length === 0) {
        missingStreams.push(item.id);
        continue;
      }
      const entries: HistoryEntry[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        const parsed = JSON.parse(trimmed) as HistoryEntry;
        if (typeof parsed.after_hash !== "string" || parsed.after_hash.trim().length === 0) {
          throw new Error("missing after_hash");
        }
        entries.push(parsed);
        latestAfterHash = parsed.after_hash;
      }
      const chainVerification = verifyHistoryChain(entries);
      if (!chainVerification.ok) {
        chainMismatches.push(item.id);
      }
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
        missingStreams.push(item.id);
      } else {
        unreadableStreams.push(item.id);
      }
      continue;
    }
    /* c8 ignore start -- defensive guard for future history schema changes. */
    if (!latestAfterHash) {
      missingStreams.push(item.id);
      continue;
    }
    /* c8 ignore stop */
    const { body, ...frontMatter } = item;
    const currentHash = hashDocument({
      metadata: frontMatter as ItemMetadata,
      body,
    });
    if (currentHash !== latestAfterHash) {
      hashMismatches.push(item.id);
    }
  }

  const driftedItems = [...new Set([...missingStreams, ...unreadableStreams, ...hashMismatches, ...chainMismatches])].sort((a, b) =>
    a.localeCompare(b),
  );
  return { missingStreams, unreadableStreams, hashMismatches, chainMismatches, driftedItems };
}
