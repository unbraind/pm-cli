import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  graphAdapterScaleOptions,
  main,
  runCliIfDirect,
  runGraphAdapterScaleBenchmark,
} from "../../../scripts/benchmarks/graph-adapter-scale.mjs";

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
