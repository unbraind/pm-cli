#!/usr/bin/env node
/**
 * @module scripts/bench/defect-recurrence-index
 *
 * Measures deterministic full and incremental recurrence indexing at a
 * million-item project scale with explicit latency and memory ceilings.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  buildDefectRecurrenceIndex,
  parseDefectRecurrencePolicy,
} from "../../dist/sdk/governance.js";

function readItemCount(argv, defaultItemCount) {
  const itemFlagIndex = argv.indexOf("--items");
  return itemFlagIndex === -1 ? defaultItemCount : Number(argv[itemFlagIndex + 1]);
}

async function readPolicy(repositoryRoot, providedPolicy) {
  if (providedPolicy) return providedPolicy;
  return parseDefectRecurrencePolicy(
    JSON.parse(
      await readFile(
        path.join(repositoryRoot, "config/defect-recurrence-policy.json"),
        "utf8",
      ),
    ),
  );
}

function measureIndex(policy, itemCount, options) {
  const items = Array.from({ length: itemCount }, (_, index) => ({
    id: `pm-scale-${index}`,
    status: index % 5 === 0 ? "closed" : "open",
    type: index % 7 === 0 ? "Issue" : "Task",
    ...(index % 100_000 === 0 ? { tags: ["boundary-contract"] } : {}),
  }));
  const beforeMemory = options.memoryUsage();
  const fullStarted = options.now();
  const full = options.buildIndex(policy, items);
  const fullDurationMs = options.now() - fullStarted;
  const changedItems = items.slice(0, Math.min(1_000, itemCount)).map((item) => ({
    ...item,
    tags: ["review-feedback"],
  }));
  const changedItemIds = changedItems.map((item) => item.id);
  const incrementalStarted = options.now();
  const incremental = options.buildIndex(policy, changedItems, {
    previous_index: full,
    changed_item_ids: changedItemIds,
  });
  const incrementalDurationMs = options.now() - incrementalStarted;
  const repeatedFull = options.buildIndex(policy, items);
  const repeatedIncremental = options.buildIndex(policy, changedItems, {
    previous_index: repeatedFull,
    changed_item_ids: changedItemIds,
  });
  return {
    full,
    incremental,
    fullDurationMs,
    incrementalDurationMs,
    heapDeltaBytes: Math.max(0, options.memoryUsage() - beforeMemory),
    deterministic:
      full.index_fingerprint === repeatedFull.index_fingerprint &&
      incremental.index_fingerprint === repeatedIncremental.index_fingerprint,
  };
}

function renderResult(result, json) {
  return json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Defect recurrence index: ${result.ok ? "PASS" : "FAIL"}; ${result.item_count} items; full ${result.full_duration_ms}ms; incremental ${result.incremental_duration_ms}ms; heap ${result.heap_delta_bytes} bytes\n`;
}

function resolveOptions(options) {
  return {
    repositoryRoot:
      options.repositoryRoot ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    defaultItemCount: options.defaultItemCount ?? 1_000_000,
    writeStdout: options.writeStdout ?? ((value) => process.stdout.write(value)),
    writeStderr: options.writeStderr ?? ((value) => process.stderr.write(value)),
    policy: options.policy,
    measure: {
      memoryUsage: options.memoryUsage ?? (() => process.memoryUsage().heapUsed),
      now: options.now ?? (() => performance.now()),
      buildIndex: options.buildIndex ?? buildDefectRecurrenceIndex,
    },
    thresholds: options.thresholds ?? {
      full_duration_ms: 30_000,
      incremental_duration_ms: 1_000,
      heap_delta_bytes: 768 * 1024 * 1024,
    },
  };
}

function isWithinThresholds(measurement, thresholds) {
  return (
    measurement.fullDurationMs <= thresholds.full_duration_ms &&
    measurement.incrementalDurationMs <= thresholds.incremental_duration_ms &&
    measurement.heapDeltaBytes <= thresholds.heap_delta_bytes
  );
}

/** Run the benchmark with injectable clocks, thresholds, and sinks. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const resolved = resolveOptions(options);
  const itemCount = readItemCount(argv, resolved.defaultItemCount);
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    resolved.writeStderr("--items must be a positive integer\n");
    return 2;
  }
  const policy = await readPolicy(resolved.repositoryRoot, resolved.policy);
  const measurement = measureIndex(policy, itemCount, resolved.measure);
  const withinThresholds = isWithinThresholds(measurement, resolved.thresholds);
  const result = {
    ok: measurement.deterministic && (!argv.includes("--check") || withinThresholds),
    item_count: itemCount,
    family_count: policy.families.length,
    indexed_item_count: measurement.full.build.items_indexed,
    incremental_indexed_item_count: measurement.incremental.build.items_indexed,
    full_duration_ms: Math.round(measurement.fullDurationMs),
    incremental_duration_ms: Math.round(measurement.incrementalDurationMs),
    heap_delta_bytes: measurement.heapDeltaBytes,
    thresholds: resolved.thresholds,
    policy_fingerprint: measurement.full.policy_fingerprint,
    deterministic: measurement.deterministic,
  };
  resolved.writeStdout(renderResult(result, argv.includes("--json")));
  return result.ok ? 0 : 1;
}

/* c8 ignore next 3 -- direct-entry wiring is exercised by the manual million-item gate. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
