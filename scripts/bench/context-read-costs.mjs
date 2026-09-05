/**
 * Reproducible public-SDK cost and recall measurements for pm-pshhry and pm-bab3gb.
 * Run after build: node scripts/bench/context-read-costs.mjs [item-count ...].
 * Metadata analysis excludes filesystem ingestion; receipts measure actual ledger
 * writes under contention. All feedback stays in disposable temporary storage.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDuplicateItems, CONTEXT_USAGE_LIMITS, recordContextUsageDelivery, recordContextUsageServing } from "@unbrained/pm-cli/sdk/query";

/** Measure deterministic paired titles, exact oracle recall and bounded concurrent feedback. */
export async function measureContextReadCosts(sizes = [1000], iterations = 10, concurrency = 4) {
  for (const value of [...sizes, iterations, concurrency]) assert(Number.isSafeInteger(value) && value > 0, "Measurement sizes and writer controls must be positive integers");
  const reports = [];
  for (const size of sizes) {
    const items = Array.from({ length: size }, (_, index) => {
      const family = Math.floor(index / 2);
      return { id: `pm-${String(index).padStart(8, "0")}`, title: `project context family${family} owner${family} requirement${family}`, status: "open", type: "Task" };
    });
    const started = performance.now();
    const duplicates = analyzeDuplicateItems(items, { limit: 1000 });
    const duplicateMs = performance.now() - started;
    const reference = items.slice(0, 1000);
    const oracle = analyzeDuplicateItems(reference, { exhaustive: true, limit: 1000 });
    const filtered = analyzeDuplicateItems(reference, { limit: 1000 });
    assert.deepEqual(filtered.clusters, oracle.clusters, "Prefix filtering lost exhaustive evidence");
    assert.equal(duplicates.cost.scored_pairs, Math.floor(size / 2));
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-context-read-costs-"));
    try {
      const rows = items.map(({ id }, index) => ({ id, rank: index + 1, included: index < 10 }));
      const receipts = [];
      const fleetStarted = performance.now();
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        await Promise.all(Array.from({ length: concurrency }, async (_, writer) => {
          const receipt = await recordContextUsageServing({ pmRoot, author: `writer-${writer}`, surface: "context", profile: "orient", rows });
          assert(receipt?.storage, "A measured serve must include its persistence receipt");
          receipts.push(receipt.storage);
          await recordContextUsageDelivery({ pmRoot, receipt, deliveredItemIds: rows.slice(0, 10).map(({ id }) => id), resultOmitted: false });
        }));
      }
      const fleetMs = performance.now() - fleetStarted;
      const bytes = (await stat(path.join(pmRoot, "runtime", "context-usage.jsonl"))).size;
      assert(bytes <= CONTEXT_USAGE_LIMITS.max_bytes, "Physical feedback ceiling exceeded");
      assert(receipts.filter(({ compacted }) => compacted).length < receipts.length, "Every serve compacted the ledger");
      const lockWaits = receipts.map(({ lock_wait_ms }) => lock_wait_ms).sort((left, right) => left - right);
      reports.push({
        items: size,
        duplicate_analysis_ms: duplicateMs,
        duplicate_cost: duplicates.cost,
        oracle_items: reference.length,
        exact_recall: 1,
        fleet_writers: concurrency,
        fleet_serves: receipts.length,
        fleet_serves_per_second: receipts.length * 1000 / fleetMs,
        mean_serve_written_bytes: receipts.reduce((sum, receipt) => sum + receipt.written_bytes, 0) / receipts.length,
        min_lock_wait_ms: lockWaits[0],
        p50_lock_wait_ms: lockWaits[Math.ceil(lockWaits.length * 0.5) - 1],
        p95_lock_wait_ms: lockWaits[Math.ceil(lockWaits.length * 0.95) - 1],
        max_lock_wait_ms: lockWaits.at(-1),
        compactions: receipts.filter(({ compacted }) => compacted).length,
        physical_ledger_bytes: bytes,
      });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  }
  return reports;
}

/** Run the standalone measurement without starting work when imported by tests. */
export async function runEntrypoint(argv = process.argv) {
  if (argv[1] === undefined || path.resolve(argv[1]) !== fileURLToPath(import.meta.url)) return false;
  const sizes = argv.slice(2).map(Number);
  console.log(JSON.stringify(await measureContextReadCosts(sizes.length === 0 ? undefined : sizes), null, 2));
  return true;
}

await runEntrypoint();
