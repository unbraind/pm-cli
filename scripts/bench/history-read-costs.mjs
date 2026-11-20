#!/usr/bin/env node

/**
 * Bounded recent-activity read benchmark.
 *
 * Tracker: pm-gh1664. Measures the canonical cold-start read,
 * `pm context --for orient --limit 3`, on an isolated fixture with thousands of
 * history streams and at least 100 MiB of history. Bounded samples run with
 * trusted derived stream bounds; the negative control removes the derived
 * summary before every sample, forcing the complete read. The gate always
 * requires the bounded p50 to stay below a declared fraction of the
 * same-runner full-scan p50, and on a qualified runner also enforces the
 * declared absolute p50 ceiling and proves the full scan exceeds it.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { nearestRank } from "./run-scale-benchmarks.mjs";
import { generateSyntheticWorkspace } from "./scale-workspace.mjs";
import { measureEntrypointProcess, summarizeImportSamples } from "./sdk-entrypoint-costs.mjs";
import { benchmarkAdmissionError, captureFinalRunnerControl, captureRunnerEnvironment, qualifyBenchmarkRunner } from "./runner-qualification.mjs";
import { registerTempOperation } from "../temp-lifecycle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_PATH = path.join(repoRoot, "dist", "cli.js");
const BUDGET_PATH = path.join(repoRoot, "scripts", "bench", "history-read-budgets.json");
const DOCUMENTATION_PATH = path.join(repoRoot, "docs", "performance", "history-read-costs.md");
const CONTROL_BUDGET_PATH = path.join(repoRoot, "scripts", "bench", "sdk-entrypoint-budgets.json");
const SUMMARY_RELATIVE_PATH = path.join("runtime", "history-stream-summary.json");
const MIB = 1024 * 1024;
const CONTROL_NOISE_MARGIN_MS = 30;
const LATENCY_NOISE_MARGIN_MS = 100;
/**
 * Baselines are calibrated on the Node major pinned by the release and primary
 * CI workflows (docs/PERFORMANCE.md); newer runtimes stay compatibility targets
 * and must not rewrite the release baseline.
 */
export const RELEASE_NODE_MAJOR = 24;
/** A fresh ceiling allows this multiple of the measured bounded p50. */
const CEILING_HEADROOM = 2;
/** Longer than the summary's two-second racy window, so warm-up bounds persist. */
const RACY_SETTLE_MS = 2_100;
const BASE_TIMESTAMP_MS = Date.UTC(2026, 0, 2);

/** The canonical three-row cold-start read this benchmark gates. */
export const ORIENT_ARGS = Object.freeze(["context", "--for", "orient", "--limit", "3", "--json"]);

/** Fixture and sampling defaults; the committed budget records the fixture it was measured on. */
export const DEFAULT_OPTIONS = Object.freeze({
  streams: 2_000,
  entriesPerStream: 100,
  padBytes: 760,
  boundedIterations: 5,
  fullScanIterations: 3,
});

/** Append archive depth: every entry is newer than item creation and each stream ends at a distinct time. */
export async function padHistoryStreams(pmRoot, { entriesPerStream, padBytes }) {
  const historyDir = path.join(pmRoot, "history");
  const files = (await readdir(historyDir)).filter((file) => file.endsWith(".jsonl")).sort();
  const pad = "x".repeat(padBytes);
  for (const [index, file] of files.entries()) {
    const lines = [];
    for (let entry = 0; entry < entriesPerStream; entry += 1) {
      lines.push(JSON.stringify({
        ts: new Date(BASE_TIMESTAMP_MS + (entry * files.length + index) * 1_000).toISOString(),
        author: "pm-history-read-benchmark",
        op: "comment_add",
        patch: [{ op: "add", path: "/comments/-", value: { text: pad } }],
        before_hash: "0".repeat(64),
        after_hash: "0".repeat(64),
        message: "Synthetic archive depth",
      }));
    }
    await appendFile(path.join(historyDir, file), `${lines.join("\n")}\n`);
  }
  let historyBytes = 0;
  for (const file of files) historyBytes += (await stat(path.join(historyDir, file))).size;
  return { streams: files.length, history_bytes: historyBytes };
}

/** Run one CLI read and return its wall time and parsed JSON output. */
export function runCliRead(args, environment) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI_PATH, ...args], {
      cwd: environment.workspaceRoot,
      env: environment.env,
      signal: environment.signal,
      maxBuffer: 64 * MIB,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Benchmark command failed: pm ${args.join(" ")}\n${String(stderr).trim()}`));
        return;
      }
      try {
        resolve({ duration_ms: performance.now() - startedAt, output: JSON.parse(stdout) });
      } catch {
        reject(new Error(`Benchmark command printed no JSON document: pm ${args.join(" ")}`));
      }
    });
  });
}

/** Collapse latency samples into the committed report shape. */
export function summarizeLatency(samples) {
  const latencies = samples.map((sample) => sample.duration_ms);
  return {
    runs: latencies.length,
    min_ms: Math.round(Math.min(...latencies)),
    p50_ms: Math.round(nearestRank(latencies, 50)),
    max_ms: Math.round(Math.max(...latencies)),
  };
}

/** Reproducible-clock settings a caller may export; the fixture's history needs the real clock. */
const INHERITED_CLOCK_VARIABLES = Object.freeze(["PM_CLOCK", "PM_CLOCK_TICK_MS", "PM_SEED"]);

function benchmarkEnvironment(workspaceRoot, pmRoot, signal) {
  const inherited = { ...process.env };
  // A caller's reproducible clock before the generated history would empty
  // the activity window and fail the row check without any regression.
  for (const variable of INHERITED_CLOCK_VARIABLES) delete inherited[variable];
  return {
    workspaceRoot,
    signal,
    env: {
      ...inherited,
      PM_PATH: pmRoot,
      PM_GLOBAL_PATH: path.join(workspaceRoot, ".pm-global"),
      PM_AUTHOR: "pm-history-read-benchmark",
      PM_SENTRY_DISABLED: "1",
      PM_TELEMETRY_DISABLED: "1",
      PM_TELEMETRY_OTEL_DISABLED: "1",
      PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1",
      FORCE_COLOR: "0",
    },
  };
}

function assertOrientRead(output, expectedReason) {
  if (!Array.isArray(output.activity) || output.activity.length !== 3) {
    throw new Error("Benchmark orient read did not return three activity rows");
  }
  if (output.activity_history_read?.reason !== expectedReason) {
    throw new Error(`Benchmark orient read reported ${output.activity_history_read?.reason ?? "a bounded read"}, expected ${expectedReason ?? "a bounded read"}`);
  }
}

async function measureNodeControl(measure) {
  await measure(null);
  const samples = [];
  for (let index = 0; index < 5; index += 1) samples.push(await measure(null));
  return summarizeImportSamples(samples);
}

/** Run `operation` with PM_GLOBAL_PATH pointing into the fixture, restoring the caller's value. */
export async function withFixtureGlobalProfile(workspaceRoot, operation) {
  const previous = process.env.PM_GLOBAL_PATH;
  process.env.PM_GLOBAL_PATH = path.join(workspaceRoot, ".pm-global");
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.PM_GLOBAL_PATH;
    else process.env.PM_GLOBAL_PATH = previous;
  }
}

/** Measure bounded and forced full-scan orient reads on one generated fixture. */
export async function buildHistoryReadReport(options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const measure = options.measure ?? runCliRead;
  const measureControl = options.measureControl ?? measureEntrypointProcess;
  const settle = options.settle ?? (() => delay(RACY_SETTLE_MS));
  const environmentBefore = captureRunnerEnvironment();
  const baseline = await measureNodeControl(measureControl);
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "pm-history-read-costs-"));
  const lifecycle = registerTempOperation(workspaceRoot);
  try {
    // The generator initializes a tracker in-process, so it runs under the
    // fixture's own global profile, never the caller's.
    const manifest = await withFixtureGlobalProfile(workspaceRoot, () =>
      generateSyntheticWorkspace({ workspaceRoot, itemCount: settings.streams, seed: 1664, mode: "direct", force: true }));
    const fixture = await padHistoryStreams(manifest.pm_root, settings);
    const environment = benchmarkEnvironment(workspaceRoot, manifest.pm_root, lifecycle.signal);
    // The first read builds every derived projection; only reads after the
    // racy window may persist stream bounds.
    await measure(ORIENT_ARGS, environment, "warmup");
    await settle();
    await measure(ORIENT_ARGS, environment, "warmup");
    const bounded = [];
    for (let index = 0; index < settings.boundedIterations; index += 1) {
      const sample = await measure(ORIENT_ARGS, environment, "bounded");
      assertOrientRead(sample.output, undefined);
      bounded.push(sample);
    }
    // The control forces the complete traversal without timing a rebuild:
    // a directory at the summary path makes it unreadable and unwritable, so
    // each sample parses every stream and persists nothing.
    const fullScan = [];
    const summaryPath = path.join(manifest.pm_root, SUMMARY_RELATIVE_PATH);
    for (let index = 0; index < settings.fullScanIterations; index += 1) {
      await rm(summaryPath, { recursive: true, force: true });
      await mkdir(summaryPath, { recursive: true });
      const sample = await measure(ORIENT_ARGS, environment, "full_scan");
      assertOrientRead(sample.output, "summary_invalid");
      fullScan.push(sample);
    }
    return {
      schema_version: 1,
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      command: `pm ${ORIENT_ARGS.join(" ")}`,
      fixture: { ...fixture, entries_per_stream: settings.entriesPerStream },
      bounded: summarizeLatency(bounded),
      full_scan: summarizeLatency(fullScan),
      baseline,
      baseline_after: await captureFinalRunnerControl(() => measureNodeControl(measureControl)),
      runner_environment: { before: environmentBefore, after: captureRunnerEnvironment() },
    };
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    lifecycle.finish();
  }
}

/**
 * Derive the declared ceiling from a qualified measurement. The ceiling is a
 * ratchet: a committed ceiling is kept when the measurement would raise it,
 * unless a reviewed increase is explicitly allowed.
 */
export function buildHistoryReadBudgets(report, committed, increaseReason = undefined) {
  const measured = Math.ceil(report.bounded.p50_ms * CEILING_HEADROOM);
  const previous = committed?.orient_three_rows?.max_p50_ms;
  const ceiling = Number.isFinite(previous) && increaseReason === undefined ? Math.min(measured, previous) : measured;
  // A reviewed increase is recorded with the budget it changed; otherwise the
  // last recorded increase is carried forward.
  const lastIncrease = Number.isFinite(previous) && ceiling > previous
    ? { reason: increaseReason, from_ms: previous, to_ms: ceiling, measured_on: report.node_version }
    : committed?.orient_three_rows?.last_increase;
  return {
    schema_version: 1,
    policy: "Ceilings may only decrease unless a reviewed platform correction is documented. The fraction gate applies on every runner; the absolute ceiling and its negative control apply on qualified runners.",
    fixture: {
      min_streams: 2_000,
      min_history_bytes: 100 * MIB,
    },
    orient_three_rows: {
      max_p50_ms: ceiling,
      max_p50_fraction_of_full_scan: 0.6,
      ...(lastIncrease === undefined ? {} : { last_increase: lastIncrease }),
    },
  };
}

/**
 * Refuse a budget whose thresholds are missing or not positive numbers: a
 * misspelled key would compare as NaN and silently disable the gate.
 */
export function validateHistoryReadBudgets(budgets) {
  const fraction = budgets?.orient_three_rows?.max_p50_fraction_of_full_scan;
  const required = {
    "fixture.min_streams": budgets?.fixture?.min_streams,
    "fixture.min_history_bytes": budgets?.fixture?.min_history_bytes,
    "orient_three_rows.max_p50_ms": budgets?.orient_three_rows?.max_p50_ms,
    "orient_three_rows.max_p50_fraction_of_full_scan": fraction,
  };
  const malformed = Object.entries(required)
    .filter(([, value]) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    .map(([key]) => key);
  if (typeof fraction === "number" && fraction > 1) malformed.push("orient_three_rows.max_p50_fraction_of_full_scan");
  if (malformed.length > 0) throw new TypeError(`History read budget is malformed: ${malformed.join(", ")} must be positive numbers (the fraction at most 1).`);
  return budgets;
}

/**
 * Whether the full scan exceeds the enforced ceiling on this runner, so the
 * absolute check could catch a regression to the complete read here.
 */
export function absoluteCeilingDiscriminates(report, budgets) {
  return report.full_scan.p50_ms > budgets.orient_three_rows.max_p50_ms + LATENCY_NOISE_MARGIN_MS;
}

/** Return every violated fixture and fraction condition, plus the absolute ceiling when enforced. */
export function compareHistoryReadBudgets(report, budgets, enforceAbsolute) {
  const violations = [];
  const budget = budgets.orient_three_rows;
  if (report.fixture.streams < budgets.fixture.min_streams) {
    violations.push(`fixture: ${report.fixture.streams} streams < ${budgets.fixture.min_streams}`);
  }
  if (report.fixture.history_bytes < budgets.fixture.min_history_bytes) {
    violations.push(`fixture: ${report.fixture.history_bytes} history bytes < ${budgets.fixture.min_history_bytes}`);
  }
  const fractionCeiling = report.full_scan.p50_ms * budget.max_p50_fraction_of_full_scan;
  if (report.bounded.p50_ms > fractionCeiling) {
    violations.push(`orient: bounded p50 ${report.bounded.p50_ms}ms > ${Math.round(fractionCeiling)}ms (${budget.max_p50_fraction_of_full_scan} of full-scan p50 ${report.full_scan.p50_ms}ms)`);
  }
  const enforced = budget.max_p50_ms + LATENCY_NOISE_MARGIN_MS;
  if (enforceAbsolute && report.bounded.p50_ms > enforced) {
    violations.push(`orient: bounded p50 ${report.bounded.p50_ms}ms > ${enforced}ms`);
  }
  return violations;
}

function negativeControlViolation(report, budgets) {
  return `negative control: full-scan p50 ${report.full_scan.p50_ms}ms does not exceed the enforced ${budgets.orient_three_rows.max_p50_ms + LATENCY_NOISE_MARGIN_MS}ms ceiling, so the gate cannot fail`;
}

/** Render the committed performance note from a measured report. */
export function renderHistoryReadMarkdown(report, budgets) {
  return `# History read costs

Tracked by
[pm-gh1664](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1664.toon)
(repository-only; PM records are excluded from the npm package).

\`${report.command}\` on a generated fixture with ${report.fixture.streams} history
streams and ${(report.fixture.history_bytes / MIB).toFixed(1)} MiB of history
(${report.fixture.entries_per_stream} archive entries per stream, each stream
ending at a distinct time), measured on Node ${report.node_version}
${report.platform}/${report.architecture}. Each sample is a fresh CLI process.

| Path | runs | best | p50 | max |
|---|---:|---:|---:|---:|
| Bounded (trusted stream bounds) | ${report.bounded.runs} | ${report.bounded.min_ms} ms | ${report.bounded.p50_ms} ms | ${report.bounded.max_ms} ms |
| Full scan (summary path blocked before each sample) | ${report.full_scan.runs} | ${report.full_scan.min_ms} ms | ${report.full_scan.p50_ms} ms | ${report.full_scan.max_ms} ms |

The ceiling is a ratchet: \`--update\` keeps the committed ceiling when a
measurement would raise it, unless \`--allow-increase <reviewed reason>\` is
given.

The gate (\`node scripts/bench/history-read-costs.mjs --check\`, part of
\`pnpm quality:static\`) fails when the bounded p50 exceeds
${budgets.orient_three_rows.max_p50_fraction_of_full_scan} of the same runner's
full-scan p50. On a runner whose bare-Node control is within its budget and
whose full scan exceeds the declared ${budgets.orient_three_rows.max_p50_ms} ms
ceiling plus a ${LATENCY_NOISE_MARGIN_MS} ms noise margin, it also fails when
the bounded p50 exceeds that enforced ceiling. Where the full scan does not
exceed it, the absolute check could not detect a regression, so it is
reported as unverified and the fraction gate decides; \`--update\` refuses a
ceiling its own measurement cannot prove. The first read of a fresh fixture also builds the history event
index and is excluded from both samples.
`;
}

function parseArguments(argv) {
  const update = argv.includes("--update");
  const check = argv.includes("--check");
  const increaseIndex = argv.indexOf("--allow-increase");
  const increaseReason = increaseIndex === -1 ? undefined : argv[increaseIndex + 1];
  if (update === check || (increaseIndex !== -1 && (!update || !increaseReason?.trim() || increaseReason.startsWith("--")))) {
    throw new Error("Usage: node scripts/bench/history-read-costs.mjs --update [--allow-increase <reviewed reason>]|--check");
  }
  return { mode: update ? "update" : "check", increaseReason: increaseReason?.trim() };
}

/** Ratchet and write the committed budget and report from a qualified measurement. */
async function updateHistoryReadBudgets(report, increaseReason, { budgetPath, documentationPath }, qualification) {
  // Only an absent budget is a first calibration; any other read failure
  // would otherwise drop the ratchet's previous ceiling.
  const committedText = await readFile(budgetPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  const committed = committedText === undefined ? undefined : JSON.parse(committedText);
  // A malformed committed budget would lose the ratchet's previous ceiling.
  if (committed !== undefined) validateHistoryReadBudgets(committed);
  const budgets = buildHistoryReadBudgets(report, committed, increaseReason);
  // A committed ceiling must be one this measurement proves can fail.
  const violations = [
    ...compareHistoryReadBudgets(report, budgets, true),
    ...(absoluteCeilingDiscriminates(report, budgets) ? [] : [negativeControlViolation(report, budgets)]),
  ];
  if (violations.length > 0) throw benchmarkAdmissionError("History read", report, violations, qualification);
  await mkdir(path.dirname(documentationPath), { recursive: true });
  await writeFile(budgetPath, `${JSON.stringify(budgets, null, 2)}\n`, "utf8");
  await writeFile(documentationPath, renderHistoryReadMarkdown(report, budgets), "utf8");
}

/** Run the benchmark in update or check mode; `options.buildReport` measures the report. */
export async function main(argv, options) {
  const parsed = parseArguments(argv);
  // Refuse a calibration on another major before building the fixture.
  const runtimeVersion = options.nodeVersion ?? process.version;
  const runtimeMajor = Number(String(runtimeVersion).replace(/^v/u, "").split(".")[0]);
  if (parsed.mode === "update" && runtimeMajor !== RELEASE_NODE_MAJOR) {
    throw new Error(`History read budgets are calibrated on Node ${RELEASE_NODE_MAJOR}, the release major; this runtime is ${runtimeVersion}. Run --update under Node ${RELEASE_NODE_MAJOR}.`);
  }
  const report = await options.buildReport();
  const budgetPath = options.budgetPath ?? BUDGET_PATH;
  const documentationPath = options.documentationPath ?? DOCUMENTATION_PATH;
  const controlBudgets = JSON.parse(await readFile(options.controlBudgetPath ?? CONTROL_BUDGET_PATH, "utf8"));
  const qualification = qualifyBenchmarkRunner([report.baseline, report.baseline_after], controlBudgets.baseline, CONTROL_NOISE_MARGIN_MS);
  const qualified = qualification.status === "qualified";
  if (parsed.mode === "update") {
    if (!qualified) throw benchmarkAdmissionError("History read", report, [], qualification);
    await updateHistoryReadBudgets(report, parsed.increaseReason, { budgetPath, documentationPath }, qualification);
    return { mode: parsed.mode, report, violations: [], runner_qualification: qualification };
  }
  const budgets = validateHistoryReadBudgets(JSON.parse(await readFile(budgetPath, "utf8")));
  // The absolute ceiling is evidence only where it could fail: on a qualified
  // runner whose full scan exceeds it. Elsewhere the fraction gate decides.
  const discriminates = absoluteCeilingDiscriminates(report, budgets);
  const enforceAbsolute = qualified && discriminates;
  const violations = compareHistoryReadBudgets(report, budgets, enforceAbsolute);
  if (violations.length > 0) throw benchmarkAdmissionError("History read", report, violations, qualification);
  return {
    mode: parsed.mode,
    report,
    violations,
    runner_qualification: qualification,
    absolute_admission: enforceAbsolute ? "passed" : "unverified",
    ...(enforceAbsolute ? {} : { absolute_unverified_reason: qualified ? "full_scan_within_ceiling" : "runner_unqualified" }),
  };
}

/** Execute the benchmark CLI while leaving all logic importable. */
export async function runEntrypoint(argv = process.argv, options = {}) {
  if (argv[1] === undefined || path.resolve(argv[1]) !== fileURLToPath(import.meta.url)) return false;
  try {
    const runMain = options.runMain ?? ((args) => main(args, { buildReport: buildHistoryReadReport }));
    const result = await runMain(argv.slice(2));
    const { bounded, full_scan: fullScan } = result.report;
    console.log(`${result.mode === "update" ? "Updated" : "Verified"} history read costs (bounded p50 ${bounded.p50_ms}ms, full scan p50 ${fullScan.p50_ms}ms${result.absolute_admission === "unverified" ? `, absolute ceiling unverified: ${result.absolute_unverified_reason}` : ""})`);
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return false;
  }
}

void runEntrypoint();
