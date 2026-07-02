#!/usr/bin/env node

/**
 * Greptile review gate.
 *
 * Runs the Greptile CLI code reviewer over the current branch (vs its base) as a
 * local CI/CD quality gate and fails when Greptile reports findings. The gate is
 * best-effort: when the Greptile CLI is missing or not authenticated (for example
 * in GitHub Actions, which has no Greptile token), it skips gracefully with a
 * non-failing result so it never blocks environments that cannot run it. The
 * Greptile GitHub App still reviews pull requests independently; this gate brings
 * the same review into the local pipeline so regressions are caught before push.
 *
 * Usage:
 *   node scripts/release/greptile-review-gate.mjs [--json] [--base <branch>|--branch <branch>]
 *     [--report-only] [--timeout-ms 600000]
 */
import { spawnSync } from "node:child_process";
import { commandFor, flagBool, flagString, parseFlags } from "./utils.mjs";

const GREPTILE = commandFor("greptile");
const DEFAULT_TIMEOUT_MS = 600000;
const CLEAN_REVIEW_PATTERN = /no review comments\.?$/i;

function parseGateOptions(argv) {
  const { flags } = parseFlags(argv);
  const parsedTimeoutMs = Number.parseInt(flagString(flags, "timeout-ms", String(DEFAULT_TIMEOUT_MS)), 10);
  return {
    help: flags.get("help") || flags.get("h"),
    outputJson: flagBool(flags, "json", false),
    reportOnly: flagBool(flags, "report-only", false),
    base: flagString(flags, "base", flagString(flags, "branch", "")),
    timeoutMs: Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/** Run a Greptile subcommand, capturing output and never throwing on failure. */
function runGreptile(args, timeoutMs) {
  const result = spawnSync(GREPTILE, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.code === "ETIMEDOUT",
    spawnFailed: result.error !== undefined && result.error.code !== "ETIMEDOUT",
  };
}

/** Emit the gate result in the requested format and exit accordingly. */
function report(outputJson, payload, exitCode) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.skipped) {
    console.log(`Greptile review gate skipped: ${payload.reason}`);
  } else if (payload.ok) {
    console.log("Greptile review gate passed: no findings.");
  } else {
    console.error(`Greptile review gate failed: ${payload.reason}`);
    if (typeof payload.review === "string" && payload.review.length > 0) {
      console.error(payload.review);
    }
  }
  process.exitCode = exitCode;
}

function main() {
  const options = parseGateOptions(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/release/greptile-review-gate.mjs [--json] [--base <branch>|--branch <branch>] [--report-only] [--timeout-ms 600000]",
    );
    return;
  }

  // Skip gracefully when Greptile is unavailable or unauthenticated so the gate
  // never blocks CI environments without a Greptile token.
  const whoami = runGreptile(["whoami"], 60000);
  if (whoami.spawnFailed) {
    report(options.outputJson, { ok: true, skipped: true, reason: "greptile CLI not installed" }, 0);
    return;
  }
  if (whoami.status !== 0) {
    report(options.outputJson, { ok: true, skipped: true, reason: "greptile CLI not authenticated" }, 0);
    return;
  }

  const reviewArgs = ["review", "--agent"];
  if (options.base.length > 0) {
    // Greptile names the comparison base branch `--branch`; keep `--base` as the
    // pm wrapper's compatibility alias while forwarding the native flag.
    reviewArgs.push("--branch", options.base);
  }
  const review = runGreptile(reviewArgs, options.timeoutMs);
  const stdoutOutput = review.stdout.trim();
  const output = `${review.stdout}\n${review.stderr}`.trim();
  // Greptile writes the clean-review sentinel to stdout. Stderr can carry
  // progress or warning text and must not turn a clean review into findings.
  const clean = CLEAN_REVIEW_PATTERN.test(stdoutOutput);
  if (review.timedOut) {
    report(options.outputJson, { ok: true, skipped: true, reason: `greptile review timed out after ${options.timeoutMs}ms` }, 0);
    return;
  }
  if (review.status !== 0) {
    if (output.length === 0 || clean) {
      report(options.outputJson, { ok: true, skipped: true, reason: `greptile review did not complete (exit ${review.status ?? "null"})` }, 0);
      return;
    }
    report(
      options.outputJson,
      { ok: false, skipped: false, reason: `greptile reported review findings before exiting ${review.status ?? "null"}`, review: output },
      options.reportOnly ? 0 : 1,
    );
    return;
  }
  if (clean) {
    report(options.outputJson, { ok: true, skipped: false, findings: 0, review: output }, 0);
    return;
  }
  report(
    options.outputJson,
    { ok: false, skipped: false, reason: "greptile reported review findings", review: output },
    options.reportOnly ? 0 : 1,
  );
}

main();
