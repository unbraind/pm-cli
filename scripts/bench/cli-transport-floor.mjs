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
const OPERATION_NAMES = Object.freeze([
  "get",
  "list",
  "context",
  "next",
  "create",
  "claim",
]);

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
  const iterations = Number(options.iterations ?? 3);
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
    operations[operation] = summarizeSamples(samples);
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
      Object.entries(report.operations).map(([operation, summary]) => [
        operation,
        {
          max_latency_ms: Math.ceil(summary.min_ms * headroom),
          max_peak_rss_bytes:
            summary.max_peak_rss_bytes === null
              ? null
              : Math.ceil(summary.max_peak_rss_bytes * headroom),
        },
      ]),
    ),
  };
}

/** Return cold-start latency and RSS violations. */
export function compareCliTransportFloorBudgets(report, budgets) {
  const violations = [];
  for (const [operation, summary] of Object.entries(report.operations)) {
    const budget = budgets.operations?.[operation];
    if (!budget) {
      violations.push(`${operation}: missing budget`);
      continue;
    }
    if (summary.min_ms > budget.max_latency_ms + LATENCY_NOISE_MARGIN_MS) {
      violations.push(
        `${operation}: best ${summary.min_ms}ms > ${budget.max_latency_ms + LATENCY_NOISE_MARGIN_MS}ms`,
      );
    }
    if (
      budget.max_peak_rss_bytes !== null &&
      summary.max_peak_rss_bytes !== null &&
      summary.max_peak_rss_bytes > budget.max_peak_rss_bytes
    ) {
      violations.push(
        `${operation}: peak RSS ${summary.max_peak_rss_bytes} > ${budget.max_peak_rss_bytes}`,
      );
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

Tracked by [pm-yse5dt](../../.agents/pm/tasks/pm-yse5dt.toon).

Each result starts from a fresh isolated workspace containing exactly one item.
The command runs in a fresh Node ${report.node_version} process on
${report.platform}/${report.architecture}; setup and fixture generation are
outside the timed interval. Short local gates use the best observed latency,
while the report retains p50 and p95 evidence.

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
    iterations: iterationsIndex === -1 ? 3 : Number(argv[iterationsIndex + 1]),
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
