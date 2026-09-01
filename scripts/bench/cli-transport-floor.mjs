#!/usr/bin/env node

/**
 * Measures the fixed CLI bootstrap floor on one-item workspaces.
 *
 * Tracker: pm-yse5dt. Every sample gets a fresh isolated tracker so mutations
 * never benefit from previous state and the measured workspace starts with
 * exactly one item.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  measureCliProcess,
  nearestRank,
  summarizeSamples,
} from "./run-scale-benchmarks.mjs";
import { generateSyntheticWorkspace } from "./scale-workspace.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const budgetPath = path.join(
  repoRoot,
  "scripts",
  "bench",
  "cli-transport-budgets.json",
);
const documentationPath = path.join(
  repoRoot,
  "docs",
  "performance",
  "cli-transport-overhead.md",
);
const LATENCY_NOISE_MARGIN_MS = 25;
const RSS_NOISE_MARGIN_BYTES = 512 * 1024;
const DEFAULT_ITERATIONS = 10;
const OPERATION_NAMES = Object.freeze([
  "get",
  "list",
  "context",
  "next",
  "create",
  "claim",
]);

function assertNullableFiniteRss(value, field) {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new TypeError(`${field} must be null or a finite number`);
  }
}

function argsForOperation(operation, manifest, iteration) {
  if (operation === "get") return ["get", manifest.sample_ids.get, "--json"];
  if (operation === "list")
    return ["list", "--status", "all", "--limit", "1", "--json"];
  if (operation === "context") return ["context", "--limit", "1", "--json"];
  if (operation === "next") return ["next", "--limit", "1", "--json"];
  if (operation === "create") {
    return [
      "create",
      "--create-mode",
      "progressive",
      "--title",
      `Cold start create ${iteration}`,
      "--type",
      "Task",
      "--status",
      "open",
      "--json",
    ];
  }
  return ["claim", manifest.sample_ids.get, "--json"];
}

async function measureColdStartOperation(operation, iteration, options) {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), "pm-cli-cold-floor-"),
  );
  try {
    const manifest = await generateSyntheticWorkspace({
      workspaceRoot,
      itemCount: 1,
      seed: iteration + 1,
      mode: "direct",
      force: true,
    });
    return await (options.measure ?? measureCliProcess)(
      argsForOperation(operation, manifest, iteration),
      {
        workspaceRoot,
        env: {
          ...process.env,
          PM_PATH: manifest.pm_root,
          PM_GLOBAL_PATH: path.join(workspaceRoot, ".pm-global"),
          PM_AUTHOR: "pm-cli-transport-benchmark",
          PM_SENTRY_DISABLED: "1",
          PM_TELEMETRY_DISABLED: "1",
          PM_TELEMETRY_OTEL_DISABLED: "1",
          PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1",
          FORCE_COLOR: "0",
        },
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** Measure every required command on fresh one-item workspaces. */
export async function buildCliTransportFloorReport(options = {}) {
  const iterations = Number(options.iterations ?? DEFAULT_ITERATIONS);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) {
    throw new Error("iterations must be an integer between 1 and 20");
  }
  const operations = {};
  for (const operation of OPERATION_NAMES) {
    await measureColdStartOperation(operation, iterations, options);
    const samples = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      samples.push(
        await measureColdStartOperation(operation, iteration, options),
      );
    }
    const rssSamples = samples.map((sample) => sample.peak_rss_bytes);
    const hasCompleteRssSamples = rssSamples.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    );
    operations[operation] = {
      ...summarizeSamples(samples),
      median_peak_rss_bytes: hasCompleteRssSamples
        ? nearestRank(rssSamples, 50)
        : null,
    };
  }
  return {
    schema_version: 1,
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    workspace_items_at_start: 1,
    iterations,
    operations,
  };
}

/** Build monotonic cold-start upper bounds from a measured report. */
export function buildCliTransportFloorBudgets(report, headroom = 1.25) {
  return {
    schema_version: 1,
    policy:
      "Cold-start upper bounds may only decrease unless a reviewed platform correction is documented.",
    operations: Object.fromEntries(
      Object.entries(report.operations).map(([operation, summary]) => {
        assertNullableFiniteRss(
          summary.median_peak_rss_bytes,
          `operations.${operation}.median_peak_rss_bytes`,
        );
        assertNullableFiniteRss(
          summary.max_peak_rss_bytes,
          `operations.${operation}.max_peak_rss_bytes`,
        );
        return [
          operation,
          {
            max_latency_ms: Math.ceil(summary.min_ms * headroom),
            max_peak_rss_bytes:
              summary.median_peak_rss_bytes === null
                ? null
                : Math.ceil(summary.median_peak_rss_bytes * headroom),
          },
        ];
      }),
    ),
  };
}

/** Return cold-start latency and RSS violations. */
export function compareCliTransportFloorBudgets(report, budgets) {
  const violations = [];
  for (const [operation, summary] of Object.entries(report.operations)) {
    assertNullableFiniteRss(
      summary.median_peak_rss_bytes,
      `operations.${operation}.median_peak_rss_bytes`,
    );
    assertNullableFiniteRss(
      summary.max_peak_rss_bytes,
      `operations.${operation}.max_peak_rss_bytes`,
    );
    const budget = budgets.operations?.[operation];
    if (!budget) {
      violations.push(`${operation}: missing budget`);
      continue;
    }
    assertNullableFiniteRss(
      budget.max_peak_rss_bytes,
      `budgets.operations.${operation}.max_peak_rss_bytes`,
    );
    if (summary.min_ms > budget.max_latency_ms + LATENCY_NOISE_MARGIN_MS) {
      violations.push(
        `${operation}: best ${summary.min_ms}ms > ${budget.max_latency_ms + LATENCY_NOISE_MARGIN_MS}ms`,
      );
    }
    if (budget.max_peak_rss_bytes !== null) {
      if (summary.median_peak_rss_bytes === null) {
        violations.push(
          `${operation}: median peak RSS unavailable for budget ${budget.max_peak_rss_bytes}`,
        );
      } else if (
        summary.median_peak_rss_bytes >
        budget.max_peak_rss_bytes + RSS_NOISE_MARGIN_BYTES
      ) {
        violations.push(
          `${operation}: median peak RSS ${summary.median_peak_rss_bytes} > ${budget.max_peak_rss_bytes + RSS_NOISE_MARGIN_BYTES} (budget ${budget.max_peak_rss_bytes} + noise margin ${RSS_NOISE_MARGIN_BYTES})`,
        );
      }
    }
  }
  return violations;
}

/** Render the measured floor and its current architectural attribution. */
export function renderCliTransportFloorMarkdown(report) {
  const rows = Object.entries(report.operations)
    .map(
      ([operation, summary]) =>
        `| \`${operation}\` | ${summary.min_ms} ms | ${summary.p50_ms} ms | ${summary.p95_ms} ms |`,
    )
    .join("\n");
  return `# CLI transport overhead

Tracked by [pm-yse5dt](../../.agents/pm/tasks/pm-yse5dt.toon), with RSS
admission reliability owned by
[pm-pz49xc](../../.agents/pm/issues/pm-pz49xc.toon).

Each result starts from a fresh isolated workspace containing exactly one item.
The command runs in a fresh Node ${report.node_version} process on
${report.platform}/${report.architecture}; setup and fixture generation are
outside the timed interval. This report measures ${report.iterations} post-warmup fresh
processes per command and uses the best observed latency,
which keeps the immutable ratchets meaningful under transient host contention;
the report retains p50 and p95 evidence. RSS admission uses the measured median
so one page-level outlier cannot false-fail the gate; the maximum remains in the
report as diagnostic evidence. Every post-warmup RSS sample must be a finite
measurement; an unavailable sample makes the admission median unavailable and
fails closed when a budget exists. Admission adds a fixed 512 KiB noise margin
without changing the committed budget; a majority persistent increase beyond
that bounded margin still fails.

| Command | best | p50 | p95 |
|---|---:|---:|---:|
${rows}

## Current attribution

- Node process and ESM loader floor is measured independently in the
  [SDK entrypoint table](sdk-entrypoint-import-costs.md).
- Static CLI bootstrap loads the shared error, output, telemetry, extension
  discovery, Commander, and SDK-client kernels before command registration.
- Command registration is already family-selective; only the family owning the
  requested command is loaded, while bare/root help intentionally registers the
  complete discoverable surface.
- Settings/schema reads and extension discovery happen after the module floor
  and remain observable through \`--profile\`; the one-item fixture keeps their
  data-dependent work negligible.
- Focused SDK entrypoints remove 40-98% of aggregate import overhead for
  governance, graph, merge, query, authoring, contracts, and testing consumers.
  The compatibility aggregate and core client remain intentionally broad.

The committed budget is a ratchet. Existing absolute scale budgets are not
relaxed, and scale reports additionally gate the CLI-minus-SDK delta for every
operation whenever both transports are measured.
`;
}

function parseArguments(argv) {
  const update = argv.includes("--update");
  const check = argv.includes("--check");
  if (update === check) {
    throw new Error(
      "Usage: node scripts/bench/cli-transport-floor.mjs --update|--check [--iterations N]",
    );
  }
  const iterationsIndex = argv.indexOf("--iterations");
  return {
    mode: update ? "update" : "check",
    iterations:
      iterationsIndex === -1
        ? DEFAULT_ITERATIONS
        : Number(argv[iterationsIndex + 1]),
  };
}

/** Run the CLI transport-floor benchmark command. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArguments(argv);
  const report = await (options.buildReport ?? buildCliTransportFloorReport)({
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
      `${JSON.stringify(buildCliTransportFloorBudgets(report), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      targetDocumentationPath,
      renderCliTransportFloorMarkdown(report),
      "utf8",
    );
    return { mode: parsed.mode, report, violations: [] };
  }
  const budgets = JSON.parse(await readFile(targetBudgetPath, "utf8"));
  const violations = compareCliTransportFloorBudgets(report, budgets);
  if (violations.length > 0) {
    throw new Error(
      `CLI transport-floor gate failed:\n${violations.join("\n")}`,
    );
  }
  return { mode: parsed.mode, report, violations };
}

/** Execute the transport-floor CLI while leaving all logic importable. */
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
      `${result.mode === "update" ? "Updated" : "Verified"} CLI transport floor (${Object.keys(result.report.operations).length} operations)`,
    );
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return false;
  }
}

void runEntrypoint();
