/** @module sdk/history/attestation-scan
 * Read-only exact-byte history snapshots, including deleted and workspace streams.
 */
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { isFileMissingError } from "../../core/fs/fs-utils.js";
import { resolveHistoryHashAlgorithm, type HistoryHashAlgorithm } from "../../core/history/digest.js";
import { verifyHistoryChain } from "../../core/history/replay.js";
import { stableStringify } from "../../core/shared/serialization.js";
import type { HistoryEntry } from "../../types.js";
import type { HistoryAttestationStream } from "./attestation-contract.js";

/** Snapshot row retained even when a stream is malformed or unreadable. */
export interface AttestationScanRow {
  /** Filename stem from the complete directory inventory. */
  id: string;
  /** Byte digest when reading succeeded. */
  digest: string | null;
  /** Verified payload-free stream summary, or null on invalid input. */
  stream: HistoryAttestationStream | null;
}

/** Read every JSONL filename in deterministic code-unit order. */
async function historyNames(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error: unknown) {
    if (isFileMissingError(error)) return [];
    throw error;
  }
}

/** Reduce a verified stream to bounded maintenance evidence without retaining payloads. */
function summarizeStream(id: string, entries: HistoryEntry[], bytes: number, digest: string): HistoryAttestationStream {
  const latest = entries.at(-1);
  let maintenance: HistoryEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (["history_compact", "history_compact_baseline", "history_redact", "history_repair", "history_salvage", "merge_reconcile"].includes(entries[index]!.op)) {
      maintenance = entries[index];
      break;
    }
  }
  const checkpoint = entries[0]?.context?.history_compaction;
  const checkpointDigest = typeof checkpoint === "object" && checkpoint !== null && "pruned_stream_digest" in checkpoint && typeof checkpoint.pruned_stream_digest === "string"
    ? checkpoint.pruned_stream_digest : null;
  return {
    id,
    entries: entries.length,
    bytes,
    stream_digest: digest,
    latest_after_hash: latest?.after_hash ?? null,
    latest_record_hash: latest?.record_hash ?? null,
    latest_hash_algorithm: latest ? resolveHistoryHashAlgorithm(latest.hash_algorithm) : null,
    rewrite_count: entries.reduce((count, entry) => count + (entry.reanchor_evidence?.length ?? 0), 0),
    checkpoint_digest: checkpointDigest,
    last_maintenance: maintenance ? { op: maintenance.op, ts: maintenance.ts, record_hash: maintenance.record_hash ?? null } : null,
  };
}

/** Decode and verify without invoking extension hooks or changing any workspace state. */
function decodeAttestedStream(id: string, bytes: Buffer, digest: string): HistoryAttestationStream | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(id)) return null;
    if (!isUtf8(bytes)) return null;
    const entries: HistoryEntry[] = [];
    for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
      const record = entry as HistoryEntry;
      if (![record.op, record.author, record.ts, record.before_hash, record.after_hash].every((field) => typeof field === "string") || !Array.isArray(record.patch)) return null;
      entries.push(record);
    }
    return verifyHistoryChain(entries).ok ? summarizeStream(id, entries, bytes.length, digest) : null;
  } catch {
    return null;
  }
}

/**
 * Capture all retained streams and reject observed concurrent changes. This is
 * a per-stream snapshot, not a transaction across unrelated history writers.
 */
export async function scanAttestationStreams(pmRoot: string, algorithm: HistoryHashAlgorithm): Promise<AttestationScanRow[]> {
  if (!(await fs.stat(pmRoot)).isDirectory()) throw new TypeError("attestation tracker root must be a directory");
  const directory = path.join(pmRoot, "history");
  const names = await historyNames(directory);
  const observations = new Map<string, string>();
  const rows: AttestationScanRow[] = [];
  for (const name of names) {
    const id = name.slice(0, -6);
    const row: AttestationScanRow = { id, digest: null, stream: null };
    rows.push(row);
    const filename = path.join(directory, name);
    try {
      const before = await fs.lstat(filename);
      observations.set(name, stableStringify([before.ino, before.size, before.mtimeMs, before.ctimeMs]));
      if (!before.isFile()) continue;
      const bytes = await fs.readFile(filename);
      row.digest = createHash(algorithm).update(bytes).digest("hex");
      row.stream = decodeAttestedStream(id, bytes, row.digest);
    } catch {
      // Verification reports the unreadable filename instead of concealing it.
    }
  }
  if (stableStringify(names) !== stableStringify(await historyNames(directory))) throw new TypeError("attestation history inventory changed during read; retry");
  for (const [name, observed] of observations) {
    const after = await fs.lstat(path.join(directory, name));
    if (observed !== stableStringify([after.ino, after.size, after.mtimeMs, after.ctimeMs])) throw new TypeError("attestation history stream changed during read; retry");
  }
  return rows;
}
