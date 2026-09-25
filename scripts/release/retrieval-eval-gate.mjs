#!/usr/bin/env node

/**
 * Enforced retrieval-quality gate over the version-controlled pm eval corpus.
 *
 * Tracker: pm-b2hc4x. The gate executes the shipped CLI surface rather than a
 * parallel evaluator, checks a committed multi-metric baseline, and exposes an
 * executable negative control that must observe a non-zero CLI exit.
 */
import { evaluateMetricFloors, parseEvalMetricFloors } from "../../dist/sdk/query.js";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const CLI_PATH = path.join(repoRoot, "dist", "cli.js");
const DEFAULT_BASELINE_PATH = path.join(
  repoRoot,
  "tests",
  "search-eval",
  "retrieval-gate-baseline.json",
);

/** Execute the built eval command and retain output for pass and fail cases. */
export async function runRetrievalEval(args, options = {}) {
  const child = (options.spawn ?? spawn)(options.executablePath ?? process.execPath, [
    options.cliPath ?? CLI_PATH,
    "--pm-path",
    options.pmPath ?? path.join(repoRoot, ".agents", "pm"),
    "eval",
    "--json",
    "--k",
    "10",
    ...args,
  ], {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      PM_SENTRY_DISABLED: "1",
      PM_TELEMETRY_DISABLED: "1",
      FORCE_COLOR: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputError;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maxOutputBytes) {
      outputError ??= new Error(
        `Retrieval eval output exceeded ${maxOutputBytes} bytes`,
      );
      child.kill?.("SIGKILL");
    } else {
      stdout += chunk;
    }
  });
  child.stderr.on("data", (chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maxOutputBytes) {
      outputError ??= new Error(
        `Retrieval eval output exceeded ${maxOutputBytes} bytes`,
      );
      child.kill?.("SIGKILL");
    } else {
      stderr += chunk;
    }
  });
  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(exitCode ?? 1);
    };
    const timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      finish(
        new Error(`Retrieval eval timed out after ${timeoutMs}ms`),
        undefined,
      );
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(error, undefined));
    child.once("close", (exitCode) =>
      finish(outputError, exitCode),
    );
  });
  return { code, stdout, stderr };
}

function finiteMetric(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`Retrieval gate ${label} must be finite and in [0, 1]`);
  }
  return Number(value);
}

/** Keep every named query accountable even when the macro average improves. */
function evaluateQueryFloors(report, baseline) {
  const violations = [];
  for (const floor of baseline.queries ?? []) {
    const matches = Array.isArray(report.queries)
      ? report.queries.filter((query) => query.query === floor.query && query.mode === floor.mode)
      : [];
    if (matches.length !== 1) {
      violations.push(`query:${floor.query}:expected_one_result:received=${matches.length}`);
      continue;
    }
    for (const violation of evaluateMetricFloors(matches[0], floor.minimum)) {
      violations.push(`query:${floor.query}:${violation}`);
    }
  }
  return violations;
}

/** Return actionable retrieval-gate violations for one eval report. */
export function evaluateRetrievalGate(report, baseline) {
  const violations = [];
  if (baseline.version !== 1) {
    violations.push(`baseline_version:${baseline.version}`);
  }
  if (!Number.isSafeInteger(report.query_count)) {
    violations.push("query_count:missing");
  } else if (report.query_count < baseline.minimum_query_count) {
    violations.push(
      `query_count:${report.query_count}<${baseline.minimum_query_count}`,
    );
  }
  for (const metric of ["ndcg", "mrr", "precision", "recall"]) {
    const current = report.aggregate?.[metric];
    const minimum = baseline.minimum?.[metric];
    if (!Number.isFinite(current) || !Number.isFinite(minimum)) {
      violations.push(`${metric}:missing`);
    } else if (current < minimum) {
      violations.push(`${metric}:${current}<${minimum}`);
    }
  }
  if (
    !Array.isArray(report.queries) ||
    !report.queries.some(
      (query) =>
        Number.isFinite(query.recall) &&
        query.recall > 0 &&
        query.recall < 1,
    )
  ) {
    violations.push("judgment_set:saturated_recall");
  }
  violations.push(...evaluateQueryFloors(report, baseline));
  return violations;
}

/** Retain prior query identities and floors so missing rows cannot weaken a baseline refresh. */
function ratchetQueryFloors(queries, previous) {
  const floors = new Map(previous.map((entry) => [JSON.stringify([entry.query, entry.mode]), entry]));
  const seen = new Set();
  for (const query of queries) {
    if (typeof query.query !== "string" || !query.query.trim() || !["keyword", "semantic", "hybrid"].includes(query.mode)) {
      throw new TypeError("Retrieval query must declare text and a supported mode");
    }
    const key = JSON.stringify([query.query, query.mode]);
    if (seen.has(key)) throw new TypeError(`Duplicate retrieval query: ${query.query}`);
    seen.add(key);
    const prior = floors.get(key);
    const minimum = {};
    for (const metric of ["ndcg", "mrr", "precision", "recall"]) {
      minimum[metric] = Math.max(prior?.minimum?.[metric] ?? 0, Math.round((finiteMetric(query[metric], `query.${metric}`) - 0.02) * 10_000) / 10_000, 0);
    }
    floors.set(key, { query: query.query, mode: query.mode, minimum: parseEvalMetricFloors(minimum) });
  }
  return [...floors.values()];
}

function baselineFromReport(report, previous) {
  if (!Array.isArray(report.queries) || report.queries.length === 0 || report.queries.length !== report.query_count) {
    throw new TypeError("Retrieval report must contain exactly query_count non-empty query rows");
  }
  const previousMinimum = previous?.minimum ?? {};
  const minimum = {};
  for (const metric of ["ndcg", "mrr", "precision", "recall"]) {
    minimum[metric] = Math.max(
      previousMinimum[metric] ?? 0,
      finiteMetric(report.aggregate?.[metric], metric) - 0.02,
      0,
    );
  }
  return {
    version: 1,
    minimum_query_count: Math.max(
      previous?.minimum_query_count ?? 0,
      report.query_count,
    ),
    minimum,
    queries: ratchetQueryFloors(report.queries, previous?.queries ?? []),
  };
}

async function readBaseline(baselinePath, allowMissing) {
  try {
    return JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    if (
      allowMissing &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Require a real failed metric verdict, rather than accepting an unrelated process error. */
function assertRankingNegativeControl(negative) {
  let report;
  try {
    report = JSON.parse(negative.stdout);
  } catch {
    throw new Error("Retrieval eval negative control failed: no valid metric report; infrastructure failures are not ranking evidence");
  }
  if (
    negative.code !== 1 ||
    report?.passed !== false ||
    report.fail_under !== 1 ||
    !Number.isFinite(report.aggregate?.ndcg) ||
    report.aggregate.ndcg < 0 ||
    report.aggregate.ndcg >= 1
  ) {
    throw new Error("Retrieval eval negative control failed: expected exit 1 and a failed perfect-score metric verdict");
  }
}

/** Run the enforced gate, refresh its baseline, or exercise its negative control. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const { flags } = parseFlags(argv);
  const baselineFlag = flags.get("baseline");
  const baselinePath =
    baselineFlag === undefined || baselineFlag === true
      ? DEFAULT_BASELINE_PATH
      : path.resolve(String(baselineFlag));
  const runner =
    options.run ??
    ((args) => runRetrievalEval(args, options.runOptions));
  if (flags.has("negative-control")) {
    const negative = await runner(["--fail-under", "1"]);
    assertRankingNegativeControl(negative);
    return { ok: true, negative_control: "seeded_ranking_regression" };
  }
  const baseline = await readBaseline(baselinePath, flags.has("update"));
  const threshold =
    baseline === undefined
      ? "0"
      : String(finiteMetric(baseline.minimum?.ndcg, "minimum.ndcg"));
  const result = await runner(["--fail-under", threshold]);
  if (result.code !== 0) {
    throw new Error(
      `Retrieval eval command failed (${result.code}): ${result.stderr.trim()}`,
    );
  }
  const report = JSON.parse(result.stdout);
  if (flags.has("update")) {
    const nextBaseline = baselineFromReport(report, baseline);
    await writeFile(
      baselinePath,
      `${JSON.stringify(nextBaseline, null, 2)}\n`,
      "utf8",
    );
    return { ok: true, updated: true, baseline: nextBaseline, report };
  }
  const violations = evaluateRetrievalGate(report, baseline);
  if (violations.length > 0) {
    throw new Error(`Retrieval evaluation gate failed: ${violations.join(", ")}`);
  }
  return { ok: true, updated: false, baseline, report };
}

/** Execute the retrieval entrypoint without mutating process globals in tests. */
export async function runRetrievalEvalEntrypoint(options = {}) {
  const argv = options.argv ?? process.argv;
  if (
    argv[1] === undefined ||
    fileURLToPath(import.meta.url) !== path.resolve(argv[1])
  ) {
    return false;
  }
  try {
    const execute =
      options.run ??
      ((args) => main(args, options.mainOptions));
    const result = await execute(argv.slice(2));
    (options.write ?? ((output) => process.stdout.write(output)))(
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return true;
  } catch (error) {
    (options.onError ?? ((cause) => fail(String(cause))))(error);
    return false;
  }
}

void runRetrievalEvalEntrypoint();
