#!/usr/bin/env node
/**
 * Exercise the public assurance prose-edge census over a canonical million-item
 * chain. Every prose mention has a matching structured edge, so the benchmark
 * covers resolution and suppression without producing an unbounded diagnostic.
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { evaluateMeasurement } from "../../dist/sdk/index.js";

/** Validate the benchmark size before allocating its canonical item chain. */
export function proseEdgeGapScaleNodeCount(value) {
  const nodeCount = Number(value ?? 1_000_000);
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 2) {
    throw new TypeError("node count must be a safe integer of at least 2");
  }
  return nodeCount;
}

/** Fail when the public SDK returns anything but the exact linked-chain receipt. */
export function assertProseEdgeGapScaleResult(result, nodeCount) {
  if (
    result.value !== 0 ||
    result.population_size !== nodeCount ||
    result.contributors.length !== 0 ||
    result.cost.units !== nodeCount * 3 - 2
  ) {
    throw new Error(
      `unexpected prose-edge-gap scale result: ${JSON.stringify(result)}`,
    );
  }
}

/** Refuse an unexpected external adapter call from the built-in census source. */
export async function rejectUnexpectedExternalMeasurement() {
  throw new Error(
    "prose-edge-gap benchmark unexpectedly called an external source",
  );
}

/** Run the real public-SDK prose census over a fully linked item chain. */
export async function runProseEdgeGapScaleBenchmark(nodeCount) {
  const items = new Array(nodeCount);
  items[0] = { id: "pm-0", status: "open", type: "Task" };
  for (let index = 1; index < nodeCount; index += 1) {
    const targetId = `pm-${index - 1}`;
    items[index] = {
      id: `pm-${index}`,
      status: "open",
      type: "Task",
      description: `Continues ${targetId}.`,
      dependencies: [{ id: targetId, kind: "implements" }],
    };
  }

  const before = process.memoryUsage();
  const started = performance.now();
  const result = await evaluateMeasurement(
    {
      id: "prose-edge-gap-scale",
      source: { kind: "prose_edge_gap", sample_limit: 25 },
      max_cost: nodeCount * 3,
    },
    {
      tree_id: `scale-${nodeCount}`,
      items,
      history: [],
      external: rejectUnexpectedExternalMeasurement,
    },
  );
  const finished = performance.now();
  const after = process.memoryUsage();
  assertProseEdgeGapScaleResult(result, nodeCount);

  return {
    ok: true,
    node_count: nodeCount,
    observed_gaps: result.value,
    contributor_count: result.contributors.length,
    partitions: result.partitions,
    cost: result.cost,
    duration_ms: Number((finished - started).toFixed(2)),
    memory_bytes: {
      rss_delta: after.rss - before.rss,
      heap_used_delta: after.heapUsed - before.heapUsed,
      rss_peak: after.rss,
    },
  };
}

/** Execute the scale benchmark CLI and emit one machine-readable report line. */
export async function proseEdgeGapScaleMain(
  argv = process.argv.slice(2),
  write = process.stdout.write.bind(process.stdout),
) {
  write(
    `${JSON.stringify(await runProseEdgeGapScaleBenchmark(proseEdgeGapScaleNodeCount(argv[0])))}\n`,
  );
}

/** Execute the CLI only when Node loaded this module as the process entrypoint. */
export async function runProseEdgeGapScaleCliIfDirect(
  argv = process.argv,
  moduleUrl = import.meta.url,
  executeMain = proseEdgeGapScaleMain,
) {
  if (argv[1] && moduleUrl === pathToFileURL(argv[1]).href) await executeMain();
}

await runProseEdgeGapScaleCliIfDirect();
