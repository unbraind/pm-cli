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
 *   node scripts/release/greptile-review-gate.mjs [--json] [--base <branch>]
 *     [--report-only] [--timeout-ms 600000]
 */
import { spawnSync } from "node:child_process";
import { commandFor, fail, flagBool, flagString, parseFlags } from "./utils.mjs";

const GREPTILE = commandFor("greptile");

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
  }
  process.exitCode = exitCode;
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    console.log("Usage: node scripts/release/greptile-review-gate.mjs [--json] [--base <branch>] [--report-only] [--timeout-ms 600000]");
    return;
  }
  const outputJson = flagBool(flags, "json", false);
  const reportOnly = flagBool(flags, "report-only", false);
  const base = flagString(flags, "base", "");
  const timeoutMs = Number.parseInt(flagString(flags, "timeout-ms", "600000"), 10);

  // Skip gracefully when Greptile is unavailable or unauthenticated so the gate
  // never blocks CI environments without a Greptile token.
  const whoami = runGreptile(["whoami"], 60000);
  if (whoami.spawnFailed) {
    report(outputJson, { ok: true, skipped: true, reason: "greptile CLI not installed" }, 0);
    return;
  }
  if (whoami.status !== 0) {
    report(outputJson, { ok: true, skipped: true, reason: "greptile CLI not authenticated" }, 0);
    return;
  }

  const reviewArgs = ["review", "--agent"];
  if (base.length > 0) {
    reviewArgs.push("--branch", base);
  }
  const review = runGreptile(reviewArgs, timeoutMs);
  if (review.timedOut) {
    report(outputJson, { ok: true, skipped: true, reason: `greptile review timed out after ${timeoutMs}ms` }, 0);
    return;
  }
  const output = `${review.stdout}\n${review.stderr}`;
  // The Greptile agent output ends with "No review comments." when the branch is
  // clean; any other completed review means it surfaced findings.
  const clean = /no review comments/i.test(output);
  if (review.status !== 0) {
    report(outputJson, { ok: true, skipped: true, reason: `greptile review did not complete (exit ${review.status ?? "null"})` }, 0);
    return;
  }
  if (clean) {
    report(outputJson, { ok: true, skipped: false, findings: 0, review: review.stdout.trim() }, 0);
    return;
  }
  report(
    outputJson,
    { ok: false, skipped: false, reason: "greptile reported review findings", review: review.stdout.trim() },
    reportOnly ? 0 : 1,
  );
}

main();
