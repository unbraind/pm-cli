#!/usr/bin/env node

/**
 * Measures independently importable SDK entrypoints and enforces cost ratchets.
 *
 * Tracker: pm-38bskj. Each sample starts a fresh Node process so the report
 * includes loader and module-evaluation work instead of a warm module cache.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bundleRoot = path.join(repoRoot, "dist", "cli-bundle");
const budgetPath = path.join(
  repoRoot,
  "scripts",
  "bench",
  "sdk-entrypoint-budgets.json",
);
const documentationPath = path.join(
  repoRoot,
  "docs",
  "performance",
  "sdk-entrypoint-import-costs.md",
);
const ENTRYPOINT_FILES = Object.freeze({
  "./sdk": "sdk.js",
  "./sdk/authoring": "sdk-authoring.js",
  "./sdk/contracts": "sdk-contracts.js",
  "./sdk/core": "sdk-core.js",
  "./sdk/governance": "sdk-governance.js",
  "./sdk/graph": "sdk-graph.js",
  "./sdk/merge": "sdk-merge.js",
  "./sdk/query": "sdk-query.js",
  "./sdk/runtime": "sdk-runtime.js",
  "./sdk/testing": "sdk-testing.js",
});
const RSS_SAMPLE_INTERVAL_MS = 5;
const LATENCY_NOISE_MARGIN_MS = 30;

/** Return the nearest-rank percentile for a non-empty numeric sample. */
export function nearestRank(values, percentile) {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

/** Collapse process observations into the stable import-cost report contract. */
export function summarizeImportSamples(samples) {
  return {
    runs: samples.length,
    min_ms: Math.round(
      Math.min(...samples.map((sample) => sample.duration_ms)),
    ),
    p50_ms: Math.round(
      nearestRank(
        samples.map((sample) => sample.duration_ms),
        50,
      ),
    ),
    p95_ms: Math.round(
      nearestRank(
        samples.map((sample) => sample.duration_ms),
        95,
      ),
    ),
    max_peak_rss_bytes: samples.every(
      (sample) => sample.peak_rss_bytes === undefined,
    )
      ? null
      : Math.max(
          ...samples
            .map((sample) => sample.peak_rss_bytes)
            .filter((value) => value !== undefined),
        ),
  };
}

async function readLinuxRssBytes(pid) {
  if (process.platform !== "linux" || pid === undefined) return undefined;
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu);
    return match ? Number.parseInt(match[1], 10) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** Measure one fresh Node process that loads an entry module. */
export async function measureEntrypointProcess(modulePath, options = {}) {
  const executablePath = options.executablePath ?? process.execPath;
  const args = modulePath === null ? ["-e", ""] : [modulePath];
  const startedAt = performance.now();
  const child = spawn(executablePath, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let complete = false;
  let peakRssBytes;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const sampler = (async () => {
    while (!complete) {
      const rssBytes = await readLinuxRssBytes(child.pid);
      if (rssBytes !== undefined)
        peakRssBytes = Math.max(peakRssBytes ?? 0, rssBytes);
      await delay(RSS_SAMPLE_INTERVAL_MS);
    }
  })();
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    if (exitCode !== 0) {
      throw new Error(
        `SDK entrypoint process failed (${String(exitCode)}): ${modulePath ?? "bare node"}\n${stderr.trim()}`,
      );
    }
    return {
      duration_ms: performance.now() - startedAt,
      peak_rss_bytes: peakRssBytes,
    };
  } finally {
    complete = true;
    await sampler;
  }
}

async function measureSamples(modulePath, iterations, measure) {
  await measure(modulePath);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await measure(modulePath));
  }
  return summarizeImportSamples(samples);
}

/** Measure the bare Node floor and every public bundled SDK entrypoint. */
export async function buildEntrypointCostReport(options = {}) {
  const iterations = Number(options.iterations ?? 5);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 30) {
    throw new Error("iterations must be an integer between 1 and 30");
  }
  const measure = options.measure ?? measureEntrypointProcess;
  const baseline = await measureSamples(null, iterations, measure);
  const entrypoints = {};
  for (const [entrypoint, fileName] of Object.entries(ENTRYPOINT_FILES)) {
    const summary = await measureSamples(
      path.join(bundleRoot, fileName),
      iterations,
      measure,
    );
    entrypoints[entrypoint] = {
      ...summary,
      delta_vs_node_ms: Math.max(0, summary.p50_ms - baseline.p50_ms),
      reduction_vs_aggregate_percent: entrypoint === "./sdk" ? 0 : null,
    };
  }
  const aggregateDelta = entrypoints["./sdk"].delta_vs_node_ms;
  for (const [entrypoint, summary] of Object.entries(entrypoints)) {
    if (entrypoint === "./sdk") continue;
    summary.reduction_vs_aggregate_percent =
      aggregateDelta === 0
        ? 0
        : Math.round(
            ((aggregateDelta - summary.delta_vs_node_ms) / aggregateDelta) *
              1000,
          ) / 10;
  }
  return {
    schema_version: 1,
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    iterations,
    baseline,
    entrypoints,
  };
}

/** Build monotonic upper bounds from a measured entrypoint report. */
export function buildEntrypointBudgets(report, headroom = 1.35) {
  return {
    schema_version: 1,
    policy:
      "Upper bounds are ratchets: update only for a measured reduction or an explicitly reviewed platform correction.",
    baseline: {
      max_import_ms: Math.ceil(report.baseline.p95_ms * headroom),
    },
    entrypoints: Object.fromEntries(
      Object.entries(report.entrypoints).map(([entrypoint, summary]) => [
        entrypoint,
        {
          max_import_ms: Math.ceil(summary.p95_ms * headroom),
          max_peak_rss_bytes:
            summary.max_peak_rss_bytes === null
              ? null
              : Math.ceil(summary.max_peak_rss_bytes * headroom),
        },
      ]),
    ),
  };
}

/** Return all import-cost budget violations in a report. */
export function compareEntrypointBudgets(report, budgets) {
  const violations = [];
  if (
    report.baseline.p95_ms >
    budgets.baseline.max_import_ms + LATENCY_NOISE_MARGIN_MS
  ) {
    violations.push(
      `bare node: ${report.baseline.p95_ms}ms > ${budgets.baseline.max_import_ms + LATENCY_NOISE_MARGIN_MS}ms`,
    );
  }
  for (const [entrypoint, summary] of Object.entries(report.entrypoints)) {
    const budget = budgets.entrypoints?.[entrypoint];
    if (!budget) {
      violations.push(`${entrypoint}: missing budget`);
      continue;
    }
    if (summary.p95_ms > budget.max_import_ms + LATENCY_NOISE_MARGIN_MS) {
      violations.push(
        `${entrypoint}: ${summary.p95_ms}ms > ${budget.max_import_ms + LATENCY_NOISE_MARGIN_MS}ms`,
      );
    }
    if (
      budget.max_peak_rss_bytes !== null &&
      summary.max_peak_rss_bytes !== null &&
      summary.max_peak_rss_bytes > budget.max_peak_rss_bytes
    ) {
      violations.push(
        `${entrypoint}: peak RSS ${summary.max_peak_rss_bytes} > ${budget.max_peak_rss_bytes}`,
      );
    }
  }
  return violations;
}

/** Render the committed human-readable import-cost evidence table. */
export function renderEntrypointCostMarkdown(report) {
  const rows = Object.entries(report.entrypoints)
    .map(
      ([entrypoint, summary]) =>
        `| \`${entrypoint}\` | ${summary.p50_ms} ms | ${summary.p95_ms} ms | ${summary.delta_vs_node_ms} ms | ${summary.reduction_vs_aggregate_percent}% |`,
    )
    .join("\n");
  return `# SDK entrypoint import costs

Tracked by [pm-38bskj](../../.agents/pm/tasks/pm-38bskj.toon).

This table measures fresh-process ESM import and module evaluation. The bare
Node ${report.node_version} process floor on ${report.platform}/${report.architecture}
was ${report.baseline.p50_ms} ms p50 (${report.baseline.p95_ms} ms p95) across
${report.iterations} measured runs after one warm-up. Focused entrypoints are
compared with the compatibility aggregate; negative reduction means the focused
entrypoint was slower in this sample.

| Package export | p50 | p95 | p50 above Node | Reduction vs aggregate |
|---|---:|---:|---:|---:|
${rows}

The aggregate \`@unbrained/pm-cli/sdk\` remains supported for compatibility.
New packages should import the narrowest subpath that owns their capability.
The committed budget file is an upper-bound ratchet and must not be weakened to
hide a regression.
`;
}

function parseArguments(argv) {
  const mode = argv.includes("--update")
    ? "update"
    : argv.includes("--check")
      ? "check"
      : null;
  if (
    mode === null ||
    (argv.includes("--update") && argv.includes("--check"))
  ) {
    throw new Error(
      "Usage: node scripts/bench/sdk-entrypoint-costs.mjs --update|--check [--iterations N]",
    );
  }
  const iterationsIndex = argv.indexOf("--iterations");
  return {
    mode,
    iterations: iterationsIndex === -1 ? 5 : Number(argv[iterationsIndex + 1]),
  };
}

/** Run the entrypoint import-cost benchmark command. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArguments(argv);
  const report = await (options.buildReport ?? buildEntrypointCostReport)({
    iterations: parsed.iterations,
  });
  const targetBudgetPath = options.budgetPath ?? budgetPath;
  const targetDocumentationPath =
    options.documentationPath ?? documentationPath;
  if (parsed.mode === "update") {
    await mkdir(path.dirname(targetBudgetPath), { recursive: true });
    await mkdir(path.dirname(targetDocumentationPath), { recursive: true });
    await writeFile(
      targetBudgetPath,
      `${JSON.stringify(buildEntrypointBudgets(report), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      targetDocumentationPath,
      renderEntrypointCostMarkdown(report),
      "utf8",
    );
    return { mode: parsed.mode, report, violations: [] };
  }
  const budgets = JSON.parse(await readFile(targetBudgetPath, "utf8"));
  const violations = compareEntrypointBudgets(report, budgets);
  if (violations.length > 0) {
    throw new Error(
      `SDK entrypoint import-cost gate failed:\n${violations.join("\n")}`,
    );
  }
  return { mode: parsed.mode, report, violations };
}

/** Execute the benchmark CLI while leaving its implementation importable. */
export async function runEntrypoint(argv = process.argv, options = {}) {
  if (
    argv[1] === undefined ||
    path.resolve(argv[1]) !== fileURLToPath(import.meta.url)
  ) {
    return false;
  }
  try {
    const result = await (options.runMain ?? main)(argv.slice(2));
    console.log(
      `${result.mode === "update" ? "Updated" : "Verified"} SDK entrypoint import costs (${Object.keys(result.report.entrypoints).length} entrypoints)`,
    );
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return false;
  }
}

void runEntrypoint();
