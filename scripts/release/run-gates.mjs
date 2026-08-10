#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { recordGateFailure } from "./release-failure-record.mjs";
import {
  commandFor,
  fail,
  flagBool,
  flagString,
  parseFlags,
  repoRoot,
  runCommand,
} from "./utils.mjs";

const releasePolicyToken = process.env.RELEASE_POLICY_TOKEN?.trim() ?? "";
delete process.env.RELEASE_POLICY_TOKEN;

function usage() {
  console.log(`Usage:
  node scripts/release/run-gates.mjs [--json]
    [--skip-compatibility]
    [--skip-dogfood]
    [--skip-greptile]
    [--skip-telemetry-sentry]
    [--telemetry-mode off|best-effort|required]
    [--sentry-window-days 14]
    [--max-sentry-critical 0]
    [--max-sentry-high 0]
    [--max-telemetry-error-rate 6]
    [--max-telemetry-missing-error-rows 0]

Runs strict release readiness quality gates used by local and CI automation.
The exact Git HEAD must already be pushed so DeepScan and CodeFactor results
exist for the hosted-analysis gate.
`);
}

function parseJson(stdout, context) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(error) fallback is unreachable */
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to parse JSON for ${context}: ${message}`);
  }
}

function runCheckedStep(name, command, args, options = {}) {
  const result = runCommand(command, args, { ...options, allowFailure: true });
  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const details = [
      stdout ? `stdout:\n${stdout}` : "",
      stderr ? `stderr:\n${stderr}` : "",
    ].filter(Boolean);
    const suffix = details.length > 0 ? `\n${details.join("\n")}` : "";
    // Keep the verdict the gate just produced. Without this the blocked-release
    // alert can only report the run's preflight configuration (pm-x63izf).
    recordGateFailure({
      gate: name,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    fail(`Gate failed: ${name}${suffix}`, result.status);
  }
  return result;
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const variables = {
    telemetry_mode: flagString(flags, "telemetry-mode", "best-effort"),
    sentry_window_days: flagString(flags, "sentry-window-days", "14"),
    max_sentry_critical: flagString(flags, "max-sentry-critical", "0"),
    max_sentry_high: flagString(flags, "max-sentry-high", "0"),
    max_telemetry_error_rate: flagString(
      flags,
      "max-telemetry-error-rate",
      "6",
    ),
    max_telemetry_missing_error_rows: flagString(
      flags,
      "max-telemetry-missing-error-rows",
      "0",
    ),
    release_policy_token: releasePolicyToken,
  };
  const registry = JSON.parse(
    readFileSync(`${repoRoot}/scripts/release/gate-registry.json`, "utf8"),
  );
  const steps = registry.local_preflight?.steps;
  if (!Array.isArray(steps)) fail("Local preflight registry has no steps.");
  const checks = [];
  for (const step of steps) {
    if (
      step.skip_policy === "optional" &&
      flagBool(flags, step.optional_flag.slice(2), false)
    ) {
      checks.push({
        name: step.id,
        status: "skipped",
        ok: false,
        skipped: true,
        reason: `Requested by ${step.optional_flag}`,
      });
      continue;
    }
    const substitute = (value) =>
      value.replace(/\{\{([a-z0-9_]+)\}\}/gu, (_match, name) => {
        if (!(name in variables)) fail(`Unknown gate variable: ${name}`);
        return variables[name];
      });
    const executable = step.executable;
    const command =
      executable.command === "node"
        ? process.execPath
        : commandFor(executable.command);
    const env = Object.fromEntries(
      Object.entries(executable.env ?? {})
        .map(([key, value]) => [key, substitute(value)])
        .filter(([, value]) => value.length > 0),
    );
    const result = runCheckedStep(
      step.id,
      command,
      executable.args.map(substitute),
      {
        capture: executable.capture_json === true,
        env: Object.keys(env).length > 0 ? env : undefined,
      },
    );
    checks.push({
      name: step.id,
      status: "passed",
      ok: true,
      ...(executable.capture_json === true
        ? { details: parseJson(result.stdout, step.id) }
        : {}),
    });
  }

  if (outputJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
    return;
  }

  console.log("Release gates passed.");
}

main();
