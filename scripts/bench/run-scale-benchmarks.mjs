#!/usr/bin/env node

/**
 * CLI and SDK scale benchmark runner with regression and product-target gates.
 *
 * Tracker: pm-mi2x. Every run owns an isolated generated workspace, reports
 * p50/p95 latency, peak RSS where the host exposes `/proc`, output bytes, and
 * estimated agent tokens, then removes the workspace unless explicitly kept.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PmClient } from "../../dist/cli-bundle/sdk.js";
import { fail, parseFlags, repoRoot } from "../release/utils.mjs";
import {
  generateSyntheticWorkspace,
  parsePositiveInteger,
  resolveScaleItemCount,
} from "./scale-workspace.mjs";

const DEFAULT_BUDGET_PATH = path.join(repoRoot, "scripts", "bench", "scale-budgets.json");
const DEFAULT_REPORT_PATH = path.join(repoRoot, "docs", "performance", "latest-scale-report.json");
const CLI_PATH = path.join(repoRoot, "dist", "cli.js");
const RSS_SAMPLE_INTERVAL_MS = 5;
const LATENCY_NOISE_MARGIN_MS = 25;
const PRODUCT_TARGET = Object.freeze({ p95_ms: 1000, max_estimated_tokens: 5000 });

/** Estimate agent tokens from UTF-8 bytes using the repo-wide four-byte rule. */
export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

/** Return the nearest-rank percentile for a non-empty numeric sample. */
export function nearestRank(values, percentile) {
  if (values.length === 0) throw new Error("Cannot calculate a percentile for an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

/** Collapse raw benchmark observations into the committed report contract. */
export function summarizeSamples(samples, warmupSample) {
  const latencies = samples.map((sample) => sample.duration_ms);
  const rssValues = samples
    .map((sample) => sample.peak_rss_bytes)
    .filter((value) => Number.isFinite(value));
  return {
    runs: samples.length,
    p50_ms: Math.round(nearestRank(latencies, 50)),
    p95_ms: Math.round(nearestRank(latencies, 95)),
    min_ms: Math.round(Math.min(...latencies)),
    max_ms: Math.round(Math.max(...latencies)),
    max_peak_rss_bytes: rssValues.length === 0 ? null : Math.max(...rssValues),
    max_output_bytes: Math.max(...samples.map((sample) => sample.output_bytes)),
    max_estimated_tokens: Math.max(...samples.map((sample) => sample.estimated_tokens)),
    ...(warmupSample
      ? {
          warmup_ms: Math.round(warmupSample.duration_ms),
          warmup_peak_rss_bytes: warmupSample.peak_rss_bytes ?? null,
        }
      : {}),
  };
}

/** Read one Linux process RSS sample, or return undefined on other hosts. */
export async function readLinuxRssBytes(pid, platform = process.platform) {
  if (platform !== "linux" || pid === undefined) return undefined;
  try {
    const raw = await readFile(`/proc/${pid}/status`, "utf8");
    const match = raw.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number.parseInt(match[1], 10) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** Measure one real built-CLI subprocess including output and sampled RSS. */
export async function measureCliProcess(args, environment) {
  const startedAt = performance.now();
  const child = spawn(environment.executablePath ?? process.execPath, [CLI_PATH, ...args], {
    cwd: environment.workspaceRoot,
    env: environment.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let complete = false;
  let peakRssBytes;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const resourceSampler = (async () => {
    while (!complete) {
      const rssBytes = await readLinuxRssBytes(child.pid);
      if (rssBytes !== undefined) peakRssBytes = Math.max(peakRssBytes ?? 0, rssBytes);
      await delay(RSS_SAMPLE_INTERVAL_MS);
    }
  })();
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code === 0 ? 0 : 1));
    });
    if (exitCode !== 0) {
      throw new Error(`Benchmark command failed (${exitCode}): pm ${args.join(" ")}\n${stderr.trim()}`);
    }
    const outputBytes = Buffer.byteLength(stdout);
    return {
      duration_ms: performance.now() - startedAt,
      peak_rss_bytes: peakRssBytes,
      output_bytes: outputBytes,
      estimated_tokens: estimateTokens(outputBytes),
    };
  } finally {
    complete = true;
    await resourceSampler;
  }
}

async function measureSdkOperation(operation) {
  const startedAt = performance.now();
  const result = await operation();
  const outputBytes = Buffer.byteLength(JSON.stringify(result));
  return {
    duration_ms: performance.now() - startedAt,
    peak_rss_bytes: process.memoryUsage().rss,
    output_bytes: outputBytes,
    estimated_tokens: estimateTokens(outputBytes),
  };
}

function cliCommandDefinitions(manifest) {
  return [
    { name: "list", args: () => ["list", "--status", "all", "--limit", "20", "--json"] },
    { name: "get", args: () => ["get", manifest.sample_ids.get, "--json"] },
    { name: "next", args: () => ["next", "--limit", "10", "--json"] },
    { name: "context", args: () => ["context", "--limit", "10", "--json"] },
    {
      name: "search",
      args: () => ["search", "synthetic", "--status", "all", "--limit", "10", "--json"],
    },
    {
      name: "create",
      args: (run) => [
        "create",
        "--create-mode",
        "progressive",
        "--title",
        `Benchmark CLI create ${run}`,
        "--type",
        "Task",
        "--status",
        "open",
        "--json",
      ],
    },
    {
      name: "claim",
      args: (run) => ["claim", manifest.sample_ids.open[run], "--json"],
    },
  ];
}

function sdkCommandDefinitions(client, manifest) {
  return [
    { name: "list", run: () => client.list({ status: "all", limit: "20" }) },
    { name: "get", run: () => client.get(manifest.sample_ids.get) },
    { name: "next", run: () => client.next({ limit: "10" }) },
    { name: "context", run: () => client.context({ limit: "10" }) },
    { name: "search", run: () => client.search("synthetic", { status: "all", limit: "10" }) },
    {
      name: "create",
      run: (iteration) =>
        client.create({
          createMode: "progressive",
          title: `Benchmark SDK create ${iteration}`,
          type: "Task",
          status: "open",
        }),
    },
    { name: "claim", run: (iteration) => client.claim(manifest.sample_ids.open[iteration]) },
  ];
}

async function runCliBenchmarks(manifest, iterations, environment) {
  const report = {};
  for (const definition of cliCommandDefinitions(manifest)) {
    const warmup = await measureCliProcess(definition.args(iterations), environment);
    const samples = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      samples.push(await measureCliProcess(definition.args(iteration), environment));
    }
    report[definition.name] = summarizeSamples(samples, warmup);
  }
  return report;
}

async function runSdkBenchmarks(manifest, iterations, environment) {
  const client = new PmClient({
    pmRoot: manifest.pm_root,
    cwd: environment.workspaceRoot,
    author: "pm-scale-benchmark",
    noExtensions: true,
  });
  const report = {};
  for (const definition of sdkCommandDefinitions(client, manifest)) {
    const warmup = await measureSdkOperation(() => definition.run(iterations));
    const samples = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      samples.push(await measureSdkOperation(() => definition.run(iteration)));
    }
    report[definition.name] = summarizeSamples(samples, warmup);
  }
  return report;
}

function budgetFromSummary(summary, headroom) {
  const latency = summary.runs >= 20 ? summary.p95_ms : summary.min_ms;
  return {
    max_latency_ms: Math.ceil(latency * headroom),
    max_peak_rss_bytes:
      summary.max_peak_rss_bytes === null
        ? null
        : Math.ceil(summary.max_peak_rss_bytes * headroom),
    max_estimated_tokens: Math.ceil(summary.max_estimated_tokens * headroom),
  };
}

/** Build a regression budget entry from a measured report. */
export function buildTierBudget(report, headroom = 1.25) {
  const transports = {};
  for (const [transport, commands] of Object.entries(report.transports)) {
    transports[transport] = Object.fromEntries(
      Object.entries(commands).map(([name, summary]) => [name, budgetFromSummary(summary, headroom)]),
    );
  }
  return { headroom, transports };
}

/** Return human-readable regression and product-target violations. */
export function compareScaleBudgets(report, manifest) {
  const violations = [];
  const tier = manifest?.tiers?.[String(report.fixture.item_count)];
  if (!tier) {
    violations.push(`missing regression budget for ${report.fixture.item_count} items`);
    return violations;
  }
  for (const [transport, commands] of Object.entries(report.transports)) {
    for (const [name, summary] of Object.entries(commands)) {
      const budget = tier.transports?.[transport]?.[name];
      if (!budget) {
        violations.push(`${transport}.${name}: missing budget`);
        continue;
      }
      violations.push(...compareCommandBudget(transport, name, summary, budget));
    }
  }
  return violations;
}

function compareCommandBudget(transport, name, summary, budget) {
  const violations = [];
  const useP95 = summary.runs >= 20;
  const latency = useP95 ? summary.p95_ms : summary.min_ms;
  const latencyBudget = budget.max_latency_ms + LATENCY_NOISE_MARGIN_MS;
  if (latency > latencyBudget) {
    violations.push(
      `${transport}.${name}: ${useP95 ? "p95" : "best"} ${latency}ms > ${latencyBudget}ms`,
    );
  }
  if (summary.max_estimated_tokens > budget.max_estimated_tokens) {
    violations.push(
      `${transport}.${name}: ${summary.max_estimated_tokens} tokens > ${budget.max_estimated_tokens}`,
    );
  }
  if (
    budget.max_peak_rss_bytes !== null &&
    summary.max_peak_rss_bytes !== null &&
    summary.max_peak_rss_bytes > budget.max_peak_rss_bytes
  ) {
    violations.push(
      `${transport}.${name}: peak RSS ${summary.max_peak_rss_bytes} > ${budget.max_peak_rss_bytes}`,
    );
  }
  return violations;
}

function productTargetStatus(transports) {
  const commands = [];
  for (const [transport, summaries] of Object.entries(transports)) {
    for (const [name, summary] of Object.entries(summaries)) {
      commands.push({
        transport,
        command: name,
        p95_ms: summary.p95_ms,
        max_estimated_tokens: summary.max_estimated_tokens,
        latency_ok: summary.p95_ms <= PRODUCT_TARGET.p95_ms,
        tokens_ok: summary.max_estimated_tokens <= PRODUCT_TARGET.max_estimated_tokens,
      });
    }
  }
  return { target: PRODUCT_TARGET, commands };
}

async function readBudgetManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function updateBudgetManifest(manifestPath, report, headroom) {
  let manifest = { version: 1, tiers: {} };
  try {
    manifest = await readBudgetManifest(manifestPath);
  } catch {
    // A first baseline creates the manifest.
  }
  manifest.tiers[String(report.fixture.item_count)] = buildTierBudget(report, headroom);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function resolveTransport(value) {
  const transport = String(value ?? "both");
  if (!["both", "cli", "sdk"].includes(transport)) {
    throw new Error("--transport must be both, cli, or sdk");
  }
  return transport;
}

/** Generate a fixture, benchmark requested transports, and return the report. */
export async function runScaleBenchmarks(options) {
  const itemCount = resolveScaleItemCount(options.itemCount);
  const iterations = parsePositiveInteger(options.iterations ?? 3, "--iterations");
  if (iterations > 100) throw new Error("--iterations must be <= 100");
  const transport = resolveTransport(options.transport);
  const ownsWorkspace = options.workspaceRoot === undefined;
  const workspaceRoot = ownsWorkspace
    ? await mkdtemp(path.join(os.tmpdir(), "pm-scale-benchmark-"))
    : path.resolve(options.workspaceRoot);
  try {
    const fixture = await generateSyntheticWorkspace({
      workspaceRoot,
      itemCount,
      seed: options.seed ?? 42,
      mode: options.mode ?? "direct",
      force: true,
    });
    if (fixture.sample_ids.open.length < iterations + 1) {
      throw new Error(`Fixture has ${fixture.sample_ids.open.length} open items; need ${iterations + 1}`);
    }
    const environment = {
      workspaceRoot,
      env: {
        ...process.env,
        PM_PATH: fixture.pm_root,
        PM_GLOBAL_PATH: path.join(workspaceRoot, ".pm-global"),
        PM_AUTHOR: "pm-scale-benchmark",
        PM_SENTRY_DISABLED: "1",
        PM_TELEMETRY_DISABLED: "1",
        PM_TELEMETRY_OTEL_DISABLED: "1",
        PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1",
        FORCE_COLOR: "0",
      },
    };
    const transports = {};
    if (transport !== "sdk") {
      transports.cli = await runCliBenchmarks(fixture, iterations, environment);
    }
    if (transport !== "cli") {
      transports.sdk = await runSdkBenchmarks(fixture, iterations, environment);
    }
    return {
      version: 1,
      generated_at: new Date().toISOString(),
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      iterations,
      fixture,
      product_target: productTargetStatus(transports),
      transports,
    };
  } finally {
    if (ownsWorkspace && options.keepWorkspace !== true) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

/** Resolve a path-valued CLI flag while preserving a caller-supplied default. */
export function resolveBenchmarkPathFlag(flags, key, defaultPath) {
  const value = flags.get(key);
  return value === undefined || value === true ? defaultPath : path.resolve(String(value));
}

/** Convert parsed benchmark flags into the runner's stable default options. */
export function benchmarkOptionsFromFlags(flags) {
  return {
    itemCount: flags.get("items") ?? "ci",
    iterations: flags.get("iterations") ?? 3,
    seed: flags.get("seed") ?? 42,
    mode: flags.get("mode") === undefined ? "direct" : String(flags.get("mode")),
    transport: flags.get("transport") ?? "both",
    keepWorkspace: flags.has("keep-workspace"),
  };
}

async function applyBudgetActions(flags, report, manifestPath) {
  if (flags.has("update")) {
    const headroomValue = flags.get("headroom");
    const headroom = headroomValue === undefined || headroomValue === true ? 1.25 : Number(headroomValue);
    if (!Number.isFinite(headroom) || headroom < 1) throw new Error("--headroom must be >= 1");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await updateBudgetManifest(manifestPath, report, headroom);
  }
  if (!flags.has("check")) return;
  const violations = compareScaleBudgets(report, await readBudgetManifest(manifestPath));
  if (violations.length > 0) throw new Error(`Scale benchmark gate failed:\n${violations.join("\n")}`);
}

/** Execute the scale benchmark command-line interface. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const report = await runScaleBenchmarks(benchmarkOptionsFromFlags(flags));
  const outputPath = resolveBenchmarkPathFlag(flags, "output", DEFAULT_REPORT_PATH);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const manifestPath = resolveBenchmarkPathFlag(flags, "manifest", DEFAULT_BUDGET_PATH);
  await applyBudgetActions(flags, report, manifestPath);
  return { report, outputPath, manifestPath };
}

function isMainModule(argv) {
  return argv[1] !== undefined && path.resolve(argv[1]) === fileURLToPath(import.meta.url);
}

/** Run the executable entrypoint without mutating process globals in tests. */
export async function runScaleBenchmarkEntrypoint(options = {}) {
  const argv = options.argv ?? process.argv;
  if (!isMainModule(argv)) return false;
  try {
    const { report, outputPath } = await (options.run ?? main)(argv.slice(2));
    (options.write ?? ((output) => process.stdout.write(output)))(
      `${JSON.stringify(
        {
          ok: true,
          item_count: report.fixture.item_count,
          iterations: report.iterations,
          report: path.relative(repoRoot, outputPath),
          product_target: report.product_target.target,
        },
        null,
        2,
      )}\n`,
    );
    return true;
  } catch (error) {
    (options.onError ?? ((cause) => fail(String(cause))))(error);
    return false;
  }
}

void runScaleBenchmarkEntrypoint();
