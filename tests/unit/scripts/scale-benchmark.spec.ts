import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  benchmarkOptionsFromFlags,
  buildTierBudget,
  compareScaleBudgets,
  estimateTokens,
  main,
  measureCliProcess,
  nearestRank,
  readLinuxRssBytes,
  resolveBenchmarkPathFlag,
  runScaleBenchmarkEntrypoint,
  runScaleBenchmarks,
  summarizeSamples,
} from "../../../scripts/bench/run-scale-benchmarks.mjs";
import { withTempDir } from "../../helpers/temp.js";

function sampleReport() {
  return {
    fixture: { item_count: 10 },
    transports: {
      cli: {
        list: {
          runs: 3,
          p50_ms: 90,
          min_ms: 80,
          p95_ms: 100,
          max_peak_rss_bytes: 1000,
          max_estimated_tokens: 50,
        },
      },
    },
  };
}

describe("scale benchmark runner", () => {
  it("calculates token estimates, nearest-rank percentiles, and summaries", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(9)).toBe(3);
    expect(nearestRank([9, 1, 5], 50)).toBe(5);
    expect(nearestRank([9, 1, 5], 95)).toBe(9);
    expect(() => nearestRank([], 50)).toThrow(/empty sample/);
    expect(
      summarizeSamples([
        { duration_ms: 10.4, peak_rss_bytes: undefined, output_bytes: 8, estimated_tokens: 2 },
        { duration_ms: 20.6, peak_rss_bytes: undefined, output_bytes: 12, estimated_tokens: 3 },
      ]),
    ).toEqual({
      runs: 2,
      p50_ms: 10,
      p95_ms: 21,
      min_ms: 10,
      max_ms: 21,
      max_peak_rss_bytes: null,
      max_output_bytes: 12,
      max_estimated_tokens: 3,
    });
    expect(
      summarizeSamples(
        [
          {
            duration_ms: 5,
            peak_rss_bytes: 500,
            output_bytes: 4,
            estimated_tokens: 1,
          },
        ],
        {
          duration_ms: 25.4,
          peak_rss_bytes: undefined,
          output_bytes: 4,
          estimated_tokens: 1,
        },
      ),
    ).toMatchObject({ warmup_ms: 25, warmup_peak_rss_bytes: null });
    expect(benchmarkOptionsFromFlags(new Map())).toEqual({
      itemCount: "ci",
      iterations: 3,
      seed: 42,
      mode: "direct",
      transport: "both",
      keepWorkspace: false,
    });
    expect(
      benchmarkOptionsFromFlags(
        new Map([
          ["items", "100"],
          ["iterations", "2"],
          ["seed", "7"],
          ["mode", "sdk"],
          ["transport", "cli"],
          ["keep-workspace", true],
        ]),
      ),
    ).toEqual({
      itemCount: "100",
      iterations: "2",
      seed: "7",
      mode: "sdk",
      transport: "cli",
      keepWorkspace: true,
    });
    expect(resolveBenchmarkPathFlag(new Map(), "output", "/default")).toBe("/default");
    expect(resolveBenchmarkPathFlag(new Map([["output", true]]), "output", "/default")).toBe("/default");
    expect(resolveBenchmarkPathFlag(new Map([["output", "relative.json"]]), "output", "/default")).toBe(
      path.resolve("relative.json"),
    );
  });

  it("reports non-Linux RSS fallback and real failing CLI stderr", async () => {
    await expect(readLinuxRssBytes(process.pid, "win32")).resolves.toBeUndefined();
    await expect(readLinuxRssBytes(Number.MAX_SAFE_INTEGER, "linux")).resolves.toBeUndefined();
    await expect(
      measureCliProcess(["definitely-not-a-command"], {
        workspaceRoot: process.cwd(),
        env: { ...process.env, PM_SENTRY_DISABLED: "1", PM_TELEMETRY_DISABLED: "1" },
      }),
    ).rejects.toThrow(/Benchmark command failed.*definitely-not-a-command/s);
  });

  it("builds budgets and reports missing, latency, memory, and token violations", () => {
    const report = sampleReport();
    const budget = buildTierBudget(report, 1.25);
    expect(budget).toEqual({
      headroom: 1.25,
      transports: {
        cli: {
          list: {
            max_latency_ms: 100,
            max_peak_rss_bytes: 1250,
            max_estimated_tokens: 63,
          },
        },
      },
    });
    expect(compareScaleBudgets(report, { tiers: {} })).toEqual(["missing regression budget for 10 items"]);
    expect(compareScaleBudgets(report, { tiers: { 10: { transports: { cli: {} } } } })).toEqual([
      "cli.list: missing budget",
    ]);
    expect(
      compareScaleBudgets(report, {
        tiers: {
          10: {
            transports: {
              cli: {
                list: {
                  max_latency_ms: 54,
                  max_peak_rss_bytes: 999,
                  max_estimated_tokens: 49,
                },
              },
            },
          },
        },
      }),
    ).toEqual([
      "cli.list: best 80ms > 79ms",
      "cli.list: 50 tokens > 49",
      "cli.list: peak RSS 1000 > 999",
    ]);
    expect(compareScaleBudgets(report, { tiers: { 10: budget } })).toEqual([]);
    const noRssReport = structuredClone(report);
    noRssReport.transports.cli.list.max_peak_rss_bytes = null;
    expect(buildTierBudget(noRssReport).transports.cli.list.max_peak_rss_bytes).toBeNull();
    expect(compareScaleBudgets(noRssReport, { tiers: { 10: budget } })).toEqual([]);

    const microOperationReport = structuredClone(report);
    microOperationReport.transports.cli.list.min_ms = 5;
    expect(
      buildTierBudget(microOperationReport).transports.cli.list.max_latency_ms,
    ).toBe(7);

    const tailReport = structuredClone(report);
    tailReport.transports.cli.list.runs = 20;
    expect(buildTierBudget(tailReport).transports.cli.list.max_latency_ms).toBe(125);
    expect(
      compareScaleBudgets(tailReport, {
        tiers: {
          10: {
            transports: {
              cli: {
                list: {
                  max_latency_ms: 74,
                  max_peak_rss_bytes: 1000,
                  max_estimated_tokens: 50,
                },
              },
            },
          },
        },
      }),
    ).toContain("cli.list: p95 100ms > 99ms");
  });

  it("runs real isolated CLI and SDK operations and reports every hot path", async () => {
    const report = await runScaleBenchmarks({
      itemCount: 100,
      iterations: 1,
      transport: "both",
      mode: "direct",
      seed: 23,
    });
    expect(report).toMatchObject({ iterations: 1, fixture: { item_count: 100, seed: 23 } });
    expect(Object.keys(report.transports.cli)).toEqual([
      "list",
      "get",
      "next",
      "context",
      "search",
      "create",
      "claim",
    ]);
    expect(Object.keys(report.transports.sdk)).toEqual(Object.keys(report.transports.cli));
    expect(report.product_target.commands).toHaveLength(14);
  }, 30_000);

  it("supports caller-owned workspaces and transport selection and validates limits", async () => {
    await withTempDir("pm-scale-runner-owned-", async (tempRoot) => {
      const cli = await runScaleBenchmarks({
        workspaceRoot: path.join(tempRoot, "cli"),
        itemCount: 100,
        iterations: 1,
        transport: "cli",
      });
      expect(cli.transports).toHaveProperty("cli");
      expect(cli.transports).not.toHaveProperty("sdk");
      const sdk = await runScaleBenchmarks({
        workspaceRoot: path.join(tempRoot, "sdk"),
        itemCount: 100,
        iterations: 1,
        transport: "sdk",
        keepWorkspace: true,
      });
      expect(sdk.transports).toHaveProperty("sdk");
      expect(sdk.transports).not.toHaveProperty("cli");
    });
    await expect(runScaleBenchmarks({ itemCount: 100, transport: "invalid" })).rejects.toThrow(
      /transport/,
    );
    await expect(runScaleBenchmarks({ itemCount: 100, iterations: 101 })).rejects.toThrow(/<= 100/);
    await expect(runScaleBenchmarks({ itemCount: 1, iterations: 2 })).rejects.toThrow(/open items/);
  }, 30_000);

  it("updates and checks a custom budget manifest through the real CLI entrypoint", async () => {
    await withTempDir("pm-scale-runner-main-", async (tempRoot) => {
      const reportPath = path.join(tempRoot, "reports", "scale.json");
      const manifestPath = path.join(tempRoot, "budgets", "scale.json");
      const updated = await main([
        "--items",
        "100",
        "--iterations",
        "1",
        "--transport",
        "sdk",
        "--output",
        reportPath,
        "--manifest",
        manifestPath,
        "--update",
        "--headroom",
        "100",
      ]);
      expect(updated.outputPath).toBe(reportPath);
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toHaveProperty("tiers.100");
      await expect(
        main([
          "--items",
          "100",
          "--iterations",
          "1",
          "--transport",
          "sdk",
          "--output",
          reportPath,
          "--manifest",
          manifestPath,
          "--check",
        ]),
      ).resolves.toMatchObject({ outputPath: reportPath, manifestPath });
      await expect(
        main([
          "--items",
          "100",
          "--iterations",
          "1",
          "--transport",
          "sdk",
          "--output",
          reportPath,
          "--manifest",
          manifestPath,
          "--update",
          "--headroom",
          "0.5",
        ]),
      ).rejects.toThrow(/headroom/);

      await main([
        "--items",
        "100",
        "--iterations",
        "1",
        "--transport",
        "sdk",
        "--output",
        reportPath,
        "--manifest",
        manifestPath,
        "--update",
      ]);
      const strictManifest = JSON.parse(await readFile(manifestPath, "utf8"));
      strictManifest.tiers[100].transports.sdk.list.max_estimated_tokens = 0;
      await writeFile(manifestPath, `${JSON.stringify(strictManifest)}\n`, "utf8");
      await expect(
        main([
          "--items",
          "100",
          "--iterations",
          "1",
          "--transport",
          "sdk",
          "--output",
          reportPath,
          "--manifest",
          manifestPath,
          "--check",
        ]),
      ).rejects.toThrow(/Scale benchmark gate failed/);
    });
  }, 30_000);

  it("runs executable entrypoint success, failure, and import outcomes", async () => {
    const scriptPath = path.resolve(process.cwd(), "scripts/bench/run-scale-benchmarks.mjs");
    await withTempDir("pm-scale-benchmark-entrypoint-", async (tempRoot) => {
      const write = vi.fn();
      await expect(
        runScaleBenchmarkEntrypoint({
          argv: [process.execPath, scriptPath, "--items", "100"],
          run: async () => ({
            report: {
              fixture: { item_count: 100 },
              iterations: 1,
              product_target: { target: { p95_ms: 1000 } },
            },
            outputPath: path.join(tempRoot, "report.json"),
          }),
          write,
        }),
      ).resolves.toBe(true);
      expect(String(write.mock.calls[0]?.[0])).toContain('"ok": true');

      const onError = vi.fn();
      await expect(
        runScaleBenchmarkEntrypoint({
          argv: [process.execPath, scriptPath],
          run: async () => {
            throw new Error("benchmark failed");
          },
          onError,
        }),
      ).resolves.toBe(false);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "benchmark failed" }));
      await expect(
        runScaleBenchmarkEntrypoint({ argv: [process.execPath] }),
      ).resolves.toBe(false);

      const defaultRunWrite = vi.fn();
      await expect(
        runScaleBenchmarkEntrypoint({
          argv: [
            process.execPath,
            scriptPath,
            "--items",
            "100",
            "--iterations",
            "1",
            "--transport",
            "sdk",
            "--output",
            path.join(tempRoot, "default-run.json"),
          ],
          write: defaultRunWrite,
        }),
      ).resolves.toBe(true);
      expect(defaultRunWrite).toHaveBeenCalled();

      const stdoutWrite = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      await runScaleBenchmarkEntrypoint({
        argv: [process.execPath, scriptPath],
        run: async () => ({
          report: {
            fixture: { item_count: 1 },
            iterations: 1,
            product_target: { target: { p95_ms: 1000 } },
          },
          outputPath: path.join(tempRoot, "default-write.json"),
        }),
      });
      expect(stdoutWrite).toHaveBeenCalled();
      stdoutWrite.mockRestore();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("EXIT:1");
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(
        runScaleBenchmarkEntrypoint({
          argv: [process.execPath, scriptPath],
          run: async () => {
            throw new Error("default failure");
          },
        }),
      ).rejects.toThrow("EXIT:1");
      expect(errorSpy).toHaveBeenCalledWith("Error: default failure");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  }, 30_000);
});
