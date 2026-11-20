import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  ORIENT_ARGS,
  RELEASE_NODE_MAJOR,
  absoluteCeilingDiscriminates,
  buildHistoryReadBudgets,
  buildHistoryReadReport,
  compareHistoryReadBudgets,
  main,
  padHistoryStreams,
  renderHistoryReadMarkdown,
  runCliRead,
  runEntrypoint,
  summarizeLatency,
  withFixtureGlobalProfile,
} from "../../../scripts/bench/history-read-costs.mjs";

const temporaryRoots: string[] = [];
const MIB = 1024 * 1024;

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function report() {
  return {
    schema_version: 1,
    node_version: "v24.22.3",
    platform: "linux",
    architecture: "x64",
    command: `pm ${ORIENT_ARGS.join(" ")}`,
    fixture: { streams: 2_001, history_bytes: 200 * MIB, entries_per_stream: 100 },
    bounded: { runs: 5, min_ms: 900, p50_ms: 1_000, max_ms: 1_100 },
    full_scan: { runs: 3, min_ms: 2_800, p50_ms: 3_000, max_ms: 3_200 },
    baseline: { runs: 5, p50_ms: 40 },
    baseline_after: { runs: 5, p50_ms: 42 },
  };
}

afterEach(async () => {
  delete process.env.PM_CLOCK;
  delete process.env.PM_SEED;
  delete process.env.PM_CLOCK_TICK_MS;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("history read cost benchmark (GH-1664)", () => {
  it("pads every stream with archive entries that end at distinct times", async () => {
    const pmRoot = await temporaryRoot("pm-history-read-pad-");
    await mkdir(path.join(pmRoot, "history"));
    await writeFile(path.join(pmRoot, "history", "pm-a.jsonl"), "");
    await writeFile(path.join(pmRoot, "history", "pm-b.jsonl"), "");
    await writeFile(path.join(pmRoot, "history", "notes.txt"), "ignored");
    const fixture = await padHistoryStreams(pmRoot, { entriesPerStream: 2, padBytes: 8 });
    expect(fixture.streams).toBe(2);
    const newest = await Promise.all(["pm-a.jsonl", "pm-b.jsonl"].map(async (file) => {
      const lines = (await readFile(path.join(pmRoot, "history", file), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      return (JSON.parse(lines.at(-1)!) as { ts: string }).ts;
    }));
    expect(new Set(newest).size).toBe(2);
    expect(fixture.history_bytes).toBe(
      (await stat(path.join(pmRoot, "history", "pm-a.jsonl"))).size + (await stat(path.join(pmRoot, "history", "pm-b.jsonl"))).size,
    );
  });

  it("generates the fixture under its own global profile and restores the caller's", async () => {
    const previous = process.env.PM_GLOBAL_PATH;
    try {
      delete process.env.PM_GLOBAL_PATH;
      await expect(withFixtureGlobalProfile("/tmp/fixture-a", async () => process.env.PM_GLOBAL_PATH)).resolves.toBe(path.join("/tmp/fixture-a", ".pm-global"));
      expect(process.env.PM_GLOBAL_PATH).toBeUndefined();
      process.env.PM_GLOBAL_PATH = "/caller/global";
      await expect(withFixtureGlobalProfile("/tmp/fixture-b", async () => { throw new Error("generator failed"); })).rejects.toThrow("generator failed");
      expect(process.env.PM_GLOBAL_PATH).toBe("/caller/global");
    } finally {
      if (previous === undefined) delete process.env.PM_GLOBAL_PATH;
      else process.env.PM_GLOBAL_PATH = previous;
    }
  });

  it("summarizes latency with the nearest-rank median", () => {
    expect(summarizeLatency([{ duration_ms: 30.4 }, { duration_ms: 10.2 }, { duration_ms: 20.6 }])).toEqual({
      runs: 3, min_ms: 10, p50_ms: 21, max_ms: 30,
    });
  });

  it("runs the real CLI and reports failures with the command line", async () => {
    const workspaceRoot = await temporaryRoot("pm-history-read-cli-");
    // Both tracker roots stay inside the fixture, whatever the shell exports.
    const environment = {
      workspaceRoot,
      env: {
        ...process.env,
        PM_PATH: path.join(workspaceRoot, ".agents", "pm"),
        PM_GLOBAL_PATH: path.join(workspaceRoot, ".pm-global"),
        PM_TELEMETRY_DISABLED: "1",
        PM_SENTRY_DISABLED: "1",
      },
    };
    const contract = await runCliRead(["contracts", "--command", "list", "--flags-only", "--json"], environment);
    expect(contract.duration_ms).toBeGreaterThan(0);
    expect(contract.output).toMatchObject({ selected: { command: "list" } });
    await expect(runCliRead(["--version"], environment)).rejects.toThrow("printed no JSON document: pm --version");
    await expect(runCliRead(["definitely-not-a-command"], environment)).rejects.toThrow("pm definitely-not-a-command");
  });

  it("measures warm bounded reads and summary-removed full scans on one fixture", async () => {
    process.env.PM_CLOCK = "2020-01-01T00:00:00.000Z";
    process.env.PM_SEED = "inherited";
    process.env.PM_CLOCK_TICK_MS = "1";
    const calls: string[] = [];
    const phases: string[] = [];
    let workspaceRoot = "";
    let summaryPresentDuringFullScan = false;
    const settled: number[] = [];
    const result = await buildHistoryReadReport({
      streams: 3,
      entriesPerStream: 2,
      padBytes: 4,
      boundedIterations: 2,
      fullScanIterations: 2,
      settle: async () => { settled.push(calls.length); },
      measureControl: async () => ({ duration_ms: 40, peak_rss_bytes: 1_000 }),
      measure: async (args: string[], environment: { workspaceRoot: string; env: Record<string, string> }, phase: string) => {
        calls.push(args.join(" "));
        phases.push(phase);
        workspaceRoot = environment.workspaceRoot;
        expect(environment.env.PM_CLOCK).toBeUndefined();
        expect(environment.env.PM_SEED).toBeUndefined();
        const summaryFile = path.join(environment.env.PM_PATH!, "runtime", "history-stream-summary.json");
        const fullScan = phase === "full_scan";
        if (fullScan) {
          // The control blocks the summary path with a directory before each sample.
          summaryPresentDuringFullScan ||= !(await stat(summaryFile)).isDirectory();
        }
        return {
          duration_ms: fullScan ? 3_000 : 1_000,
          output: { activity: [{}, {}, {}], ...(fullScan ? { activity_history_read: { reason: "summary_invalid" } } : {}) },
        };
      },
    });
    expect(calls).toHaveLength(2 + 2 + 2);
    expect(phases).toEqual(["warmup", "warmup", "bounded", "bounded", "full_scan", "full_scan"]);
    expect(new Set(calls)).toEqual(new Set([ORIENT_ARGS.join(" ")]));
    expect(settled).toEqual([1]);
    expect(summaryPresentDuringFullScan).toBe(false);
    // Three item streams plus the workspace stream that init records.
    expect(result.fixture).toMatchObject({ streams: 4, entries_per_stream: 2 });
    expect(result.bounded).toMatchObject({ runs: 2, p50_ms: 1_000 });
    expect(result.full_scan).toMatchObject({ runs: 2, p50_ms: 3_000 });
    expect(result.baseline).toMatchObject({ runs: 5 });
    expect(DEFAULT_OPTIONS.streams).toBeGreaterThanOrEqual(2_000);
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drives the real CLI, control and racy settle, and refuses a fixture too small to keep stream bounds", async () => {
    // Below the 500-stream minimum the summary is never consulted, so the
    // forced full scan carries no summary_invalid receipt.
    await expect(buildHistoryReadReport({ streams: 3, entriesPerStream: 1, padBytes: 1, boundedIterations: 1, fullScanIterations: 1 }))
      .rejects.toThrow("reported a bounded read, expected summary_invalid");
  }, 60_000);

  it("refuses a bounded read that was not bounded and a full scan that was", async () => {
    const options = {
      streams: 2,
      entriesPerStream: 1,
      padBytes: 1,
      boundedIterations: 1,
      fullScanIterations: 1,
      settle: async () => undefined,
      measureControl: async () => ({ duration_ms: 40, peak_rss_bytes: 1_000 }),
    };
    await expect(buildHistoryReadReport({
      ...options,
      measure: async () => ({ duration_ms: 1, output: { activity: [{}, {}, {}], activity_history_read: { reason: "summary_stale" } } }),
    })).rejects.toThrow("reported summary_stale, expected a bounded read");
    let call = 0;
    await expect(buildHistoryReadReport({
      ...options,
      measure: async () => {
        call += 1;
        return { duration_ms: 1, output: { activity: [{}, {}, {}] } };
      },
    })).rejects.toThrow("reported a bounded read, expected summary_invalid");
    expect(call).toBe(4);
    await expect(buildHistoryReadReport({
      ...options,
      measure: async () => ({ duration_ms: 1, output: { activity: [{}] } }),
    })).rejects.toThrow("did not return three activity rows");
    await expect(buildHistoryReadReport({
      ...options,
      measure: async () => ({ duration_ms: 1, output: {} }),
    })).rejects.toThrow("did not return three activity rows");
  });

  it("derives the declared ceiling as a ratchet and reports every violated condition", () => {
    const budgets = buildHistoryReadBudgets(report());
    expect(budgets.orient_three_rows).toEqual({ max_p50_ms: 2_000, max_p50_fraction_of_full_scan: 0.6 });
    expect(compareHistoryReadBudgets(report(), budgets, true)).toEqual([]);
    const committed = { orient_three_rows: { max_p50_ms: 1_200 } };
    expect(buildHistoryReadBudgets(report(), committed).orient_three_rows.max_p50_ms).toBe(1_200);
    expect(buildHistoryReadBudgets(report(), { orient_three_rows: { max_p50_ms: 9_000 } }).orient_three_rows.max_p50_ms).toBe(2_000);
    expect(buildHistoryReadBudgets(report(), committed, "reviewed").orient_three_rows).toMatchObject({ max_p50_ms: 2_000, last_increase: { reason: "reviewed", from_ms: 1_200, to_ms: 2_000 } });
    expect(buildHistoryReadBudgets(report(), {}).orient_three_rows.max_p50_ms).toBe(2_000);

    const regressed = report();
    regressed.fixture = { streams: 10, history_bytes: MIB, entries_per_stream: 1 };
    regressed.bounded.p50_ms = 2_900;
    regressed.full_scan.p50_ms = 1_500;
    expect(compareHistoryReadBudgets(regressed, budgets, true)).toEqual([
      "fixture: 10 streams < 2000",
      `fixture: ${MIB} history bytes < ${100 * MIB}`,
      "orient: bounded p50 2900ms > 900ms (0.6 of full-scan p50 1500ms)",
      "orient: bounded p50 2900ms > 2100ms",
    ]);
    // Without the absolute ceiling only the runner-independent conditions remain.
    expect(compareHistoryReadBudgets(regressed, budgets, false)).toHaveLength(3);
    // The ceiling discriminates only where the full scan exceeds what it enforces.
    expect(absoluteCeilingDiscriminates(report(), budgets)).toBe(true);
    const marginal = report();
    marginal.full_scan.p50_ms = 2_100;
    expect(absoluteCeilingDiscriminates(marginal, budgets)).toBe(false);
  });

  it("renders the measured report with its declared gate", () => {
    const markdown = renderHistoryReadMarkdown(report(), buildHistoryReadBudgets(report()));
    expect(markdown).toContain("2001 history");
    expect(markdown).toContain("200.0 MiB");
    expect(markdown).toContain("| Bounded (trusted stream bounds) | 5 | 900 ms | 1000 ms | 1100 ms |");
    expect(markdown).toContain("declared 2000 ms");
  });

  it("writes budgets and documentation on a qualified update and verifies them on check", async () => {
    const root = await temporaryRoot("pm-history-read-budgets-");
    const budgetPath = path.join(root, "budgets.json");
    const documentationPath = path.join(root, "docs", "history-read-costs.md");
    await expect(main(["--update"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => report() }))
      .resolves.toMatchObject({ mode: "update", violations: [] });
    expect(JSON.parse(await readFile(budgetPath, "utf8")).orient_three_rows.max_p50_ms).toBe(2_000);
    expect(await readFile(documentationPath, "utf8")).toContain("# History read costs");
    await expect(main(["--check"], { budgetPath, buildReport: async () => report() }))
      .resolves.toMatchObject({ mode: "check", violations: [], absolute_admission: "passed" });

    const slowRunner = report();
    slowRunner.baseline_after.p50_ms = 9_999;
    slowRunner.bounded.p50_ms = 1_750;
    await expect(main(["--check"], { budgetPath, buildReport: async () => slowRunner }))
      .resolves.toMatchObject({ absolute_admission: "unverified", absolute_unverified_reason: "runner_unqualified", runner_qualification: { status: "unqualified" } });
    // A faster runner whose full scan stays under the ceiling cannot prove it.
    const fastRunner = report();
    fastRunner.bounded.p50_ms = 700;
    fastRunner.full_scan.p50_ms = 1_900;
    await expect(main(["--check"], { budgetPath, buildReport: async () => fastRunner }))
      .resolves.toMatchObject({ absolute_admission: "unverified", absolute_unverified_reason: "full_scan_within_ceiling" });
    // An update refuses a ceiling its own full scan does not exceed.
    const undiscriminating = report();
    undiscriminating.full_scan.p50_ms = 2_050;
    await expect(main(["--update"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => undiscriminating }))
      .rejects.toMatchObject({ violations: [expect.stringContaining("negative control: full-scan p50 2050ms")] });

    const regressed = report();
    regressed.bounded.p50_ms = 2_950;
    await expect(main(["--check"], { budgetPath, buildReport: async () => regressed }))
      .rejects.toMatchObject({ code: "benchmark_product_budget_exceeded", product_admission: "failed" });
    await expect(main(["--check"], { budgetPath, buildReport: async () => ({ ...regressed, baseline_after: { runs: 5, p50_ms: 9_999 } }) }))
      .rejects.toMatchObject({ code: "benchmark_runner_unqualified", product_admission: "unverified" });
    await expect(main(["--check"], { budgetPath: path.join(root, "missing.json"), buildReport: async () => report() }))
      .rejects.toThrow("missing.json");
  });

  it("keeps the committed ceiling on update unless a reviewed increase is allowed", async () => {
    const root = await temporaryRoot("pm-history-read-ratchet-");
    const budgetPath = path.join(root, "budgets.json");
    const documentationPath = path.join(root, "doc.md");
    await main(["--update"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => report() });
    const slower = report();
    slower.bounded.p50_ms = 1_200;
    await main(["--update"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => slower });
    expect(JSON.parse(await readFile(budgetPath, "utf8")).orient_three_rows.max_p50_ms).toBe(2_000);
    await main(["--update", "--allow-increase", "reviewed runner image change"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => slower });
    const raised = JSON.parse(await readFile(budgetPath, "utf8")).orient_three_rows;
    expect(raised.max_p50_ms).toBe(2_400);
    // The reviewed reason is recorded with the increase and carried forward.
    expect(raised.last_increase).toEqual({ reason: "reviewed runner image change", from_ms: 2_000, to_ms: 2_400, measured_on: "v24.22.3" });
    await main(["--update"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => slower });
    expect(JSON.parse(await readFile(budgetPath, "utf8")).orient_three_rows.last_increase.reason).toBe("reviewed runner image change");
    expect(await readFile(documentationPath, "utf8")).toContain("--allow-increase <reviewed reason>");
    for (const argv of [["--check", "--allow-increase", "why"], ["--update", "--allow-increase"], ["--update", "--allow-increase", "   "], ["--update", "--allow-increase", "--check"]]) {
      await expect(main(argv, { buildReport: async () => report() })).rejects.toThrow("Usage:");
    }
  });

  it("calibrates only on the release Node major, which matches the release workflow pin", async () => {
    const release = await readFile(path.resolve(".github/workflows/release.yml"), "utf8");
    expect(release).toContain(`node-version: ${RELEASE_NODE_MAJOR}`);
    const root = await temporaryRoot("pm-history-read-major-");
    const budgetPath = path.join(root, "budgets.json");
    let measured = false;
    await expect(main(["--update"], { nodeVersion: "v26.13.1", budgetPath, documentationPath: path.join(root, "doc.md"), buildReport: async () => { measured = true; return report(); } }))
      .rejects.toThrow("calibrated on Node 24, the release major; this runtime is v26.13.1");
    // The refusal comes before the fixture is built or any sample runs.
    expect(measured).toBe(false);
    await expect(stat(budgetPath)).rejects.toMatchObject({ code: "ENOENT" });
    // Checks run on any supported major.
    await writeFile(budgetPath, JSON.stringify(buildHistoryReadBudgets(report())));
    await expect(main(["--check"], { budgetPath, buildReport: async () => ({ ...report(), node_version: "v26.13.1" }) })).resolves.toMatchObject({ mode: "check" });
  });

  it("refuses an update from an unqualified runner or a measurement that violates its own gate", async () => {
    const root = await temporaryRoot("pm-history-read-update-");
    const budgetPath = path.join(root, "budgets.json");
    const documentationPath = path.join(root, "doc.md");
    await expect(main(["--update"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => ({ ...report(), baseline: { runs: 5, p50_ms: 9_999 } }) }))
      .rejects.toMatchObject({ code: "benchmark_runner_unqualified" });
    const flat = report();
    flat.full_scan.p50_ms = 1_100;
    await expect(main(["--update"], { nodeVersion: "v24.22.3", budgetPath, documentationPath, buildReport: async () => flat }))
      .rejects.toMatchObject({ code: "benchmark_product_budget_exceeded" });
    await expect(stat(budgetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(main([], { buildReport: async () => report() })).rejects.toThrow("Usage:");
    await expect(main(["--update", "--check"], { nodeVersion: "v24.22.3", buildReport: async () => report() })).rejects.toThrow("Usage:");
  });

  it("accepts, against the committed budget, a report derived from that budget's own ceiling", async () => {
    const committed = JSON.parse(await readFile(path.resolve("scripts/bench/history-read-budgets.json"), "utf8"));
    const ceiling = committed.orient_three_rows.max_p50_ms;
    const derived = report();
    // Bounded well inside the ceiling and the fraction, a full scan that exceeds it.
    derived.bounded = { runs: 5, min_ms: Math.floor(ceiling / 4), p50_ms: Math.floor(ceiling / 3), max_ms: Math.floor(ceiling / 2) };
    derived.full_scan = { runs: 3, min_ms: ceiling * 2, p50_ms: ceiling * 2, max_ms: ceiling * 2 };
    derived.fixture = { streams: committed.fixture.min_streams, history_bytes: committed.fixture.min_history_bytes, entries_per_stream: 100 };
    await expect(main(["--check"], { buildReport: async () => derived })).resolves.toMatchObject({ absolute_admission: "passed", violations: [] });
  });

  it("executes, skips and reports failures through the script entrypoint", async () => {
    const scriptPath = path.resolve("scripts/bench/history-read-costs.mjs");
    const measured = { bounded: { p50_ms: 1 }, full_scan: { p50_ms: 3 } };
    await expect(runEntrypoint(["node"])).resolves.toBe(false);
    for (const result of [
      { mode: "update", report: measured },
      { mode: "check", report: measured, absolute_admission: "passed" },
      { mode: "check", report: measured, absolute_admission: "unverified", absolute_unverified_reason: "full_scan_within_ceiling" },
    ]) {
      await expect(runEntrypoint(["node", scriptPath], { runMain: async () => result })).resolves.toBe(true);
    }
    const previousExitCode = process.exitCode;
    await expect(runEntrypoint(["node", scriptPath], { runMain: async () => { throw "entrypoint failure"; } })).resolves.toBe(false);
    await expect(runEntrypoint(["node", scriptPath])).resolves.toBe(false);
    process.exitCode = previousExitCode;
  });
});
