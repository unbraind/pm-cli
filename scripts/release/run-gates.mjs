#!/usr/bin/env node

import { commandFor, fail, flagBool, flagString, parseFlags, runCommand } from "./utils.mjs";

function usage() {
  console.log(`Usage:
  node scripts/release/run-gates.mjs [--json]
    [--skip-compatibility]
    [--skip-dogfood]
    [--skip-telemetry-sentry]
    [--telemetry-mode off|best-effort|required]
    [--max-sentry-critical 0]
    [--max-sentry-high 0]
    [--max-telemetry-error-rate 6]
    [--max-telemetry-missing-error-rows 0]

Runs strict release readiness quality gates used by local and CI automation.
`);
}

function parseJson(stdout, context) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
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
  const skipCompatibility = flagBool(flags, "skip-compatibility", false);
  const skipDogfood = flagBool(flags, "skip-dogfood", false);
  const skipTelemetrySentry = flagBool(flags, "skip-telemetry-sentry", false);
  const telemetryMode = flagString(flags, "telemetry-mode", "best-effort");
  const maxSentryCritical = flagString(flags, "max-sentry-critical", "0");
  const maxSentryHigh = flagString(flags, "max-sentry-high", "0");
  const maxTelemetryErrorRate = flagString(flags, "max-telemetry-error-rate", "6");
  const maxTelemetryMissingRows = flagString(flags, "max-telemetry-missing-error-rows", "0");

  const pnpm = commandFor("pnpm");
  const npm = commandFor("npm");
  const checks = [];

  runCheckedStep("build", pnpm, ["build"]);
  checks.push({ name: "build", ok: true });

  runCheckedStep("typecheck", pnpm, ["typecheck"]);
  checks.push({ name: "typecheck", ok: true });

  runCheckedStep("docs-skills-gate", process.execPath, ["scripts/release/docs-skills-gate.mjs"]);
  checks.push({ name: "docs-skills-gate", ok: true });

  runCheckedStep("static-quality-gate", process.execPath, ["scripts/release/static-quality-gate.mjs"]);
  checks.push({ name: "static-quality-gate", ok: true });

  runCheckedStep("coverage", pnpm, ["test:coverage"], { env: { PM_RUN_TESTS_SKIP_BUILD: "1" } });
  checks.push({ name: "coverage", ok: true });

  runCheckedStep("version-policy", pnpm, ["version:check"]);
  checks.push({ name: "version-policy", ok: true });

  runCheckedStep("secret-scan", pnpm, ["security:scan"]);
  checks.push({ name: "secret-scan", ok: true });

  runCheckedStep("npx-smoke", pnpm, ["smoke:npx"]);
  checks.push({ name: "npx-smoke", ok: true });

  if (!skipDogfood) {
    runCheckedStep("package-first-dogfood", pnpm, ["dogfood:package-first"]);
    checks.push({ name: "package-first-dogfood", ok: true });
  } else {
    checks.push({ name: "package-first-dogfood", ok: true, skipped: true });
  }

  // Keep the same packaging validation but avoid huge tarball file listings in gate logs.
  runCheckedStep("npm-pack-dry-run", npm, ["pack", "--dry-run", "--silent"]);
  checks.push({ name: "npm-pack-dry-run", ok: true });

  if (!skipCompatibility) {
    const compatibilityResult = runCheckedStep(
      "compatibility-check",
      process.execPath,
      ["scripts/release/compatibility-check.mjs", "--json"],
      { capture: true },
    );
    checks.push({
      name: "compatibility-check",
      ok: true,
      details: parseJson(compatibilityResult.stdout, "compatibility-check"),
    });
  } else {
    checks.push({ name: "compatibility-check", ok: true, skipped: true });
  }

  if (!skipTelemetrySentry) {
    const sentryTelemetry = runCheckedStep(
      "sentry-telemetry-gate",
      process.execPath,
      [
        "scripts/release/sentry-telemetry-gate.mjs",
        "--json",
        "--telemetry-mode",
        telemetryMode,
        "--max-critical",
        maxSentryCritical,
        "--max-high",
        maxSentryHigh,
        "--max-telemetry-error-rate",
        maxTelemetryErrorRate,
        "--max-telemetry-missing-error-rows",
        maxTelemetryMissingRows,
      ],
      { capture: true },
    );
    checks.push({
      name: "sentry-telemetry-gate",
      ok: true,
      details: parseJson(sentryTelemetry.stdout, "sentry-telemetry-gate"),
    });
  } else {
    checks.push({ name: "sentry-telemetry-gate", ok: true, skipped: true });
  }

  if (outputJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
    return;
  }

  console.log("Release gates passed.");
}

main();
