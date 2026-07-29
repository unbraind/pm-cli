#!/usr/bin/env node

/**
 * Enforced retrieval-quality gate over the version-controlled pm eval corpus.
 *
 * Tracker: pm-b2hc4x. The gate executes the shipped CLI surface rather than a
 * parallel evaluator, checks a committed multi-metric baseline, and exposes an
 * executable negative control that must observe a non-zero CLI exit.
 */
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
  if (!Number.isFinite(value)) {
    throw new TypeError(`Retrieval gate ${label} must be finite`);
  }
  return Number(value);
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
  return violations;
}

function baselineFromReport(report, previous) {
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
    if (negative.code === 0) {
      throw new Error(
        "Retrieval eval negative control failed: the CLI accepted a deliberately impossible perfect-score threshold",
      );
    }
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
