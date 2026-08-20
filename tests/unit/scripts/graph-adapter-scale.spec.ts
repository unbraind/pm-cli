import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  graphAdapterScaleOptions,
  main,
  runCliIfDirect,
  runGraphAdapterScaleBenchmark,
} from "../../../scripts/benchmarks/graph-adapter-scale.mjs";
import {
  assertProseEdgeGapScaleResult,
  proseEdgeGapScaleMain,
  proseEdgeGapScaleNodeCount,
  rejectUnexpectedExternalMeasurement,
  runProseEdgeGapScaleBenchmark,
  runProseEdgeGapScaleCliIfDirect,
} from "../../../scripts/benchmarks/prose-edge-gap-scale.mjs";

describe("graph adapter scale benchmark", () => {
  it("resolves canonical defaults and caller-provided controls", () => {
    expect(graphAdapterScaleOptions([])).toEqual({
      nodeCount: 1_000_000,
      edgeStride: 100,
    });
    expect(
      graphAdapterScaleOptions(["--nodes", "12", "--edge-stride", "3"]),
    ).toEqual({
      nodeCount: 12,
      edgeStride: 3,
    });
  });

  it("runs the public SDK graph, snapshot, and adapter path", async () => {
    const report = await runGraphAdapterScaleBenchmark({
      nodeCount: 12,
      edgeStride: 3,
    });

    expect(report).toMatchObject({
      ok: true,
      node_count: 12,
      edge_count: 3,
      adapter: { first: "written", second: "current" },
    });
    expect(report.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.timings_ms.total).toBeGreaterThanOrEqual(0);
    expect(report.memory_bytes.rss_peak).toBeGreaterThan(0);
  });

  it("emits JSON and executes only for the direct module entrypoint", async () => {
    const write = vi.fn();
    await main(["--nodes", "4", "--edge-stride", "2"], write);
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? "")).toMatchObject({
      node_count: 4,
      edge_count: 1,
    });

    const executeMain = vi.fn();
    const scriptPath = "/tmp/graph-adapter-scale.mjs";
    await runCliIfDirect(
      ["node", scriptPath],
      pathToFileURL(scriptPath).href,
      executeMain,
    );
    await runCliIfDirect(
      ["node", scriptPath],
      pathToFileURL(`${scriptPath}.importer`).href,
      executeMain,
    );
    await runCliIfDirect(["node"], pathToFileURL(scriptPath).href, executeMain);
    expect(executeMain).toHaveBeenCalledTimes(1);
  });
});

describe("prose edge-gap scale benchmark", () => {
  it("validates canonical defaults and explicit node counts", () => {
    expect(proseEdgeGapScaleNodeCount()).toBe(1_000_000);
    expect(proseEdgeGapScaleNodeCount("12")).toBe(12);
    expect(() => proseEdgeGapScaleNodeCount("1.5")).toThrow("safe integer");
    expect(() => proseEdgeGapScaleNodeCount("1")).toThrow("at least 2");
  });

  it("runs the real public SDK census over a reduced linked chain", async () => {
    await expect(runProseEdgeGapScaleBenchmark(12)).resolves.toMatchObject({
      ok: true,
      node_count: 12,
      observed_gaps: 0,
      contributor_count: 0,
      partitions: { explicit_subject: 0, implicit_subject: 0 },
      cost: { units: 34, items_scanned: 12 },
    });
    await expect(rejectUnexpectedExternalMeasurement()).rejects.toThrow(
      "unexpectedly called an external source",
    );
  });

  it("rejects every malformed scale receipt dimension", () => {
    const valid = {
      value: 0,
      population_size: 4,
      contributors: [],
      cost: { units: 10 },
    };
    expect(() => assertProseEdgeGapScaleResult(valid, 4)).not.toThrow();
    for (const result of [
      { ...valid, value: 1 },
      { ...valid, population_size: 3 },
      { ...valid, contributors: ["pm-1->pm-0"] },
      { ...valid, cost: { units: 9 } },
    ]) {
      expect(() => assertProseEdgeGapScaleResult(result, 4)).toThrow(
        "unexpected prose-edge-gap scale result",
      );
    }
  });

  it("emits JSON and executes only for the direct module entrypoint", async () => {
    const write = vi.fn();
    await proseEdgeGapScaleMain(["4"], write);
    expect(JSON.parse(write.mock.calls[0]?.[0] ?? "")).toMatchObject({
      node_count: 4,
      observed_gaps: 0,
    });

    const executeMain = vi.fn();
    const scriptPath = "/tmp/prose-edge-gap-scale.mjs";
    await runProseEdgeGapScaleCliIfDirect(
      ["node", scriptPath],
      pathToFileURL(scriptPath).href,
      executeMain,
    );
    await runProseEdgeGapScaleCliIfDirect(
      ["node", scriptPath],
      pathToFileURL(`${scriptPath}.importer`).href,
      executeMain,
    );
    await runProseEdgeGapScaleCliIfDirect(
      ["node"],
      pathToFileURL(scriptPath).href,
      executeMain,
    );
    expect(executeMain).toHaveBeenCalledTimes(1);
  });
});
