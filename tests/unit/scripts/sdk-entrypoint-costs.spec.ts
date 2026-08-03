import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEntrypointBudgets,
  buildEntrypointCostReport,
  compareEntrypointBudgets,
  main,
  measureEntrypointProcess,
  nearestRank,
  readLinuxRssBytes,
  renderEntrypointCostMarkdown,
  runEntrypoint,
  summarizeImportSamples,
} from "../../../scripts/bench/sdk-entrypoint-costs.mjs";

const temporaryRoots: string[] = [];

interface ImportSummary {
  runs: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_peak_rss_bytes: number | null;
  delta_vs_node_ms: number;
  reduction_vs_aggregate_percent: number | null;
}

interface ImportReport {
  schema_version: number;
  node_version: string;
  platform: string;
  architecture: string;
  iterations: number;
  baseline: Omit<
    ImportSummary,
    "delta_vs_node_ms" | "reduction_vs_aggregate_percent"
  >;
  entrypoints: Record<string, ImportSummary>;
}

function report(): ImportReport {
  return {
    schema_version: 1,
    node_version: "v26.5.0",
    platform: "linux",
    architecture: "x64",
    iterations: 3,
    baseline: {
      runs: 3,
      min_ms: 40,
      p50_ms: 42,
      p95_ms: 44,
      max_peak_rss_bytes: 10,
    },
    entrypoints: {
      "./sdk": {
        runs: 3,
        min_ms: 280,
        p50_ms: 300,
        p95_ms: 320,
        max_peak_rss_bytes: 100,
        delta_vs_node_ms: 258,
        reduction_vs_aggregate_percent: 0,
      },
      "./sdk/query": {
        runs: 3,
        min_ms: 80,
        p50_ms: 90,
        p95_ms: 100,
        max_peak_rss_bytes: 40,
        delta_vs_node_ms: 48,
        reduction_vs_aggregate_percent: 81.4,
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SDK entrypoint import-cost calculations", () => {
  it("calculates nearest-rank percentiles and rejects empty samples", () => {
    expect(nearestRank([9, 1, 5], 50)).toBe(5);
    expect(nearestRank([9, 1, 5], 95)).toBe(9);
    expect(() => nearestRank([], 50)).toThrow("empty sample");
  });

  it("summarizes latency and optional RSS samples", () => {
    expect(
      summarizeImportSamples([
        { duration_ms: 10 },
        { duration_ms: 20, peak_rss_bytes: 100 },
        { duration_ms: 15, peak_rss_bytes: 80 },
      ]),
    ).toEqual({
      runs: 3,
      min_ms: 10,
      p50_ms: 15,
      p95_ms: 20,
      max_peak_rss_bytes: 100,
    });
    expect(
      summarizeImportSamples([{ duration_ms: 1 }]).max_peak_rss_bytes,
    ).toBeNull();
  });

  it("reads Linux RSS and fails closed on unavailable proc status", async () => {
    const unexpectedRead = async (): Promise<string> => {
      throw new Error("reader must not run");
    };
    await expect(
      readLinuxRssBytes(undefined, {
        platform: "linux",
        readStatus: unexpectedRead,
      }),
    ).resolves.toBeUndefined();
    await expect(
      readLinuxRssBytes(42, {
        platform: "darwin",
        readStatus: unexpectedRead,
      }),
    ).resolves.toBeUndefined();
    await expect(
      readLinuxRssBytes(42, {
        platform: "linux",
        readStatus: async () => "Name:\tnode\nVmRSS:\t12 kB\n",
      }),
    ).resolves.toBe(12 * 1024);
    await expect(
      readLinuxRssBytes(42, {
        platform: "linux",
        readStatus: async () => "Name:\tnode\n",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readLinuxRssBytes(42, {
        platform: "linux",
        readStatus: async () => {
          throw new Error("process exited");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("measures every entrypoint and derives aggregate reductions", async () => {
    const result = await buildEntrypointCostReport({
      iterations: 2,
      measure: async (modulePath) => ({
        duration_ms:
          modulePath === null ? 40 : modulePath.endsWith("sdk.js") ? 300 : 100,
        peak_rss_bytes: 100,
      }),
    });
    expect(Object.keys(result.entrypoints)).toHaveLength(10);
    expect(
      result.entrypoints["./sdk/query"]?.reduction_vs_aggregate_percent,
    ).toBeGreaterThan(70);
    await expect(buildEntrypointCostReport({ iterations: 0 })).rejects.toThrow(
      "between 1 and 30",
    );
    const zeroDelta = await buildEntrypointCostReport({
      iterations: 1,
      measure: async () => ({ duration_ms: 40 }),
    });
    expect(
      zeroDelta.entrypoints["./sdk/query"]?.reduction_vs_aggregate_percent,
    ).toBe(0);
  });

  it("measures successful and failing fresh Node processes", async () => {
    await expect(measureEntrypointProcess(null)).resolves.toMatchObject({
      duration_ms: expect.any(Number),
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-process-"));
    temporaryRoots.push(root);
    const failing = path.join(root, "failing.mjs");
    await writeFile(
      failing,
      'process.stderr.write("expected failure"); process.exitCode = 2;\n',
    );
    await expect(measureEntrypointProcess(failing)).rejects.toThrow(
      "expected failure",
    );
    await expect(
      measureEntrypointProcess(null, { executablePath: "missing-node-binary" }),
    ).rejects.toThrow();
    await expect(
      measureEntrypointProcess(null, {
        env: { ...process.env, NODE_OPTIONS: "--pm-invalid-node-option" },
      }),
    ).rejects.toThrow("bare node");
  });

  it("runs the default measurement and committed-budget path", async () => {
    const measured = await buildEntrypointCostReport({
      measure: async () => ({ duration_ms: 40 }),
    });
    expect(measured.iterations).toBe(5);
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-real-cost-"));
    temporaryRoots.push(root);
    const budgetPath = path.join(root, "budgets.json");
    await writeFile(
      budgetPath,
      JSON.stringify({
        baseline: { max_import_ms: 1_000_000 },
        entrypoints: Object.fromEntries(
          [
            "./sdk",
            "./sdk/authoring",
            "./sdk/contracts",
            "./sdk/core",
            "./sdk/governance",
            "./sdk/graph",
            "./sdk/merge",
            "./sdk/query",
            "./sdk/runtime",
            "./sdk/testing",
          ].map((entrypoint) => [
            entrypoint,
            {
              max_import_ms: 1_000_000,
              max_peak_rss_bytes: null,
            },
          ]),
        ),
      }),
    );
    await expect(
      main(["--check", "--iterations", "1"], { budgetPath }),
    ).resolves.toMatchObject({ mode: "check", violations: [] });
  });

  it("builds headroom budgets and reports latency, RSS, and missing entries", () => {
    const baseline = report();
    const budgets = buildEntrypointBudgets(baseline, 1);
    expect(budgets.entrypoints["./sdk/query"]).toEqual({
      max_import_ms: 100,
      max_peak_rss_bytes: 40,
    });
    expect(compareEntrypointBudgets(baseline, budgets)).toEqual([]);
    const regressed = structuredClone(baseline);
    regressed.entrypoints["./sdk/query"].p95_ms = 200;
    regressed.entrypoints["./sdk/query"].max_peak_rss_bytes = 80;
    delete budgets.entrypoints["./sdk"];
    expect(compareEntrypointBudgets(regressed, budgets)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("./sdk: missing budget"),
        expect.stringContaining("./sdk/query: 200ms"),
        expect.stringContaining("peak RSS"),
      ]),
    );
    regressed.baseline.p95_ms = 999;
    expect(compareEntrypointBudgets(regressed, budgets)).toContain(
      "bare node: 999ms > 74ms",
    );
    const withoutRss = structuredClone(baseline);
    withoutRss.entrypoints["./sdk/query"].max_peak_rss_bytes = null;
    expect(
      buildEntrypointBudgets(withoutRss).entrypoints["./sdk/query"]
        .max_peak_rss_bytes,
    ).toBeNull();
  });

  it("renders package guidance and measured reductions", () => {
    const markdown = renderEntrypointCostMarkdown(report());
    expect(markdown).toContain("`./sdk/query`");
    expect(markdown).toContain("81.4%");
    expect(markdown).toContain("@unbrained/pm-cli/sdk");
  });
});

describe("SDK entrypoint import-cost command", () => {
  it("writes budgets and documentation, then verifies a passing report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-costs-"));
    temporaryRoots.push(root);
    const budgetPath = path.join(root, "nested", "budgets.json");
    const documentationPath = path.join(root, "docs", "costs.md");
    const baseline = report();
    await expect(
      main(["--update", "--iterations", "3"], {
        budgetPath,
        documentationPath,
        buildReport: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "update", violations: [] });
    expect(await readFile(documentationPath, "utf8")).toContain("./sdk/query");
    await expect(
      main(["--check"], {
        budgetPath,
        buildReport: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "check", violations: [] });
  });

  it("fails the check on a regression and validates command mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-sdk-cost-fail-"));
    temporaryRoots.push(root);
    const budgetPath = path.join(root, "budgets.json");
    const baseline = report();
    await main(["--update"], {
      budgetPath,
      documentationPath: path.join(root, "costs.md"),
      buildReport: async () => structuredClone(baseline),
    });
    const regressed = structuredClone(baseline);
    regressed.entrypoints["./sdk/query"].p95_ms = 999;
    await expect(
      main(["--check"], {
        budgetPath,
        buildReport: async () => regressed,
      }),
    ).rejects.toThrow("import-cost gate failed");
    await expect(main([])).rejects.toThrow("Usage:");
    await expect(main(["--check", "--update"])).rejects.toThrow("Usage:");
    await expect(
      main(["--check", "--iterations", "7"], {
        buildReport: async () => structuredClone(baseline),
      }),
    ).resolves.toMatchObject({ mode: "check" });
  });

  it("executes, skips, and reports failures through the script entrypoint", async () => {
    const scriptPath = path.resolve("scripts/bench/sdk-entrypoint-costs.mjs");
    await expect(runEntrypoint(["node"])).resolves.toBe(false);
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => ({
          mode: "check",
          report: { entrypoints: { "./sdk": {} } },
        }),
      }),
    ).resolves.toBe(true);
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => ({
          mode: "update",
          report: { entrypoints: { "./sdk": {} } },
        }),
      }),
    ).resolves.toBe(true);
    const previousExitCode = process.exitCode;
    await expect(
      runEntrypoint(["node", scriptPath], {
        runMain: async () => {
          throw "entrypoint failure";
        },
      }),
    ).resolves.toBe(false);
    await expect(runEntrypoint(["node", scriptPath])).resolves.toBe(false);
    process.exitCode = previousExitCode;
  });
});
