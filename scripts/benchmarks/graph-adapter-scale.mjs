#!/usr/bin/env node
/**
 * Build and synchronize a real public-SDK graph scale fixture without reading
 * repository tracker data. The default is the canonical million-node sparse
 * acceptance envelope; callers can lower it for quick local diagnostics.
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  MemoryRelationshipGraphAdapter,
  RelationshipGraph,
  createRelationshipGraphScaleFixture,
  createRelationshipGraphSnapshot,
  createRelationshipKindRegistry,
  syncRelationshipGraphAdapter,
} from "../../dist/sdk/index.js";

/** Resolve the benchmark's bounded numeric controls from alternating CLI flags. */
export function graphAdapterScaleOptions(argv) {
  const argumentsByName = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    argumentsByName.set(argv[index], argv[index + 1]);
  }
  return {
    nodeCount: Number(argumentsByName.get("--nodes") ?? 1_000_000),
    edgeStride: Number(argumentsByName.get("--edge-stride") ?? 100),
  };
}

/** Run the real in-memory graph adapter acceptance envelope and return its report. */
export async function runGraphAdapterScaleBenchmark({ nodeCount, edgeStride }) {
  const fixture = createRelationshipGraphScaleFixture({
    nodeCount,
    edgeStride,
    topology: "chain",
  });
  const before = process.memoryUsage();
  const started = performance.now();
  const registry = createRelationshipKindRegistry();
  const graph = new RelationshipGraph(fixture.nodes, fixture.edges, registry);
  const graphBuilt = performance.now();
  const snapshot = createRelationshipGraphSnapshot(graph, registry, {
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  const snapshotBuilt = performance.now();
  const adapter = new MemoryRelationshipGraphAdapter("scale-memory");
  const first = await syncRelationshipGraphAdapter(adapter, {
    workspace: `scale-${nodeCount}-${edgeStride}`,
    snapshot,
  });
  const second = await syncRelationshipGraphAdapter(adapter, {
    workspace: `scale-${nodeCount}-${edgeStride}`,
    snapshot,
  });
  const finished = performance.now();
  const after = process.memoryUsage();

  return {
    ok: true,
    node_count: fixture.node_count,
    edge_count: fixture.edge_count,
    fingerprint: snapshot.fingerprint,
    timings_ms: {
      graph_build: Number((graphBuilt - started).toFixed(2)),
      snapshot_build: Number((snapshotBuilt - graphBuilt).toFixed(2)),
      adapter_write_and_reuse: Number((finished - snapshotBuilt).toFixed(2)),
      total: Number((finished - started).toFixed(2)),
    },
    memory_bytes: {
      rss_delta: after.rss - before.rss,
      heap_used_delta: after.heapUsed - before.heapUsed,
      rss_peak: after.rss,
    },
    adapter: {
      first: first.disposition,
      second: second.disposition,
    },
  };
}

/** Execute the benchmark CLI and emit one machine-readable report line. */
export async function main(
  argv = process.argv.slice(2),
  write = process.stdout.write.bind(process.stdout),
) {
  write(
    `${JSON.stringify(await runGraphAdapterScaleBenchmark(graphAdapterScaleOptions(argv)))}\n`,
  );
}

/** Execute the CLI only when Node loaded this module as the process entrypoint. */
export async function runCliIfDirect(
  argv = process.argv,
  moduleUrl = import.meta.url,
  executeMain = main,
) {
  if (argv[1] && moduleUrl === pathToFileURL(argv[1]).href) await executeMain();
}

await runCliIfDirect();
