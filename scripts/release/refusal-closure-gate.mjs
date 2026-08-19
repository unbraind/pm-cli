#!/usr/bin/env node

/** Execute closed-domain refusal retries and score their recovery closure. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scorePmRefusalClosure } from "../../dist/sdk/agent/refusal-closure.js";
import { listCoreClosedDomainContracts } from "../../dist/sdk/agent/closed-domain-contracts.js";

const REFUSAL_CLOSURE_BASELINE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./refusal-closure-baseline.json", import.meta.url)),
    "utf8",
  ),
);

/** Execute the real core CLI refusal corpus in an isolated tracker. */
export function verifyExecutableRefusalClosure({
  injectMismatch = false,
  probes = listCoreClosedDomainContracts(),
  baseline = REFUSAL_CLOSURE_BASELINE,
  spawn = spawnSync,
  makeTemporaryDirectory = mkdtempSync,
  removeDirectory = rmSync,
} = {}) {
  const root = makeTemporaryDirectory(
    path.join(tmpdir(), "pm-refusal-closure-"),
  );
  try {
    const environment = {
      ...process.env,
      PM_PATH: path.join(root, "project"),
      PM_GLOBAL_PATH: path.join(root, "global"),
      PM_TELEMETRY_DISABLED: "1",
    };
    const initialized = spawn(
      process.execPath,
      ["dist/cli.js", "init", "--defaults", "--json"],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    if (initialized.status !== 0) {
      throw new Error(
        `Refusal closure tracker setup failed: ${initialized.stderr}`,
      );
    }
    const seeded = spawn(
      process.execPath,
      [
        "dist/cli.js",
        "create",
        "--id",
        "pm-domain",
        "--title",
        "Domain query target",
        "--json",
      ],
      { cwd: process.cwd(), env: environment, encoding: "utf8" },
    );
    if (seeded.status !== 0) {
      throw new Error(`Refusal closure item setup failed: ${seeded.stderr}`);
    }
    const observations = probes.map((contract) => {
      const { probe_id: probeId, refusal_args: args } = contract;
      const refusal = spawn(
        process.execPath,
        ["dist/cli.js", ...args, "--json"],
        { cwd: process.cwd(), env: environment, encoding: "utf8" },
      );
      const problemStart = refusal.stderr.indexOf("{");
      const envelope = JSON.parse(
        problemStart >= 0 ? refusal.stderr.slice(problemStart) : refusal.stderr,
      );
      const recovery = envelope.recovery ?? {};
      const suggestedRetry =
        typeof recovery.suggested_retry === "string"
          ? recovery.suggested_retry
          : "";
      const retryArguments =
        Array.isArray(recovery.suggested_retry_args) &&
        recovery.suggested_retry_args.every(
          (argument) => typeof argument === "string",
        )
          ? recovery.suggested_retry_args
          : [];
      const retry =
        retryArguments.length > 0
          ? spawn(
              process.execPath,
              ["dist/cli.js", ...retryArguments, "--json"],
              { cwd: process.cwd(), env: environment, encoding: "utf8" },
            )
          : { status: 1 };
      return {
        probe_id: probeId,
        entrypoint: `pm ${args.join(" ")}`,
        exit_code: refusal.status ?? 1,
        rejected_value: contract.rejected_value,
        allowed_values: Array.isArray(recovery.allowed_values)
          ? recovery.allowed_values.filter((value) => typeof value === "string")
          : [],
        expected_allowed_values: contract.allowed_values,
        allowed_values_required: contract.allowed_values_required,
        error_code: typeof envelope.code === "string" ? envelope.code : "",
        expected_error_code: contract.error_code,
        suggested_retry: suggestedRetry,
        suggested_retry_args: retryArguments,
        expected_suggested_retry_args: contract.suggested_retry_args,
        retry_succeeded: retry.status === 0,
      };
    });
    if (injectMismatch) observations[0].allowed_values = [];
    const score = scorePmRefusalClosure(observations);
    const probeIds = new Set(probes.map(({ probe_id: probeId }) => probeId));
    const ratchetFindings = baseline.required_probe_ids
      .filter((probeId) => !probeIds.has(probeId))
      .map((probeId) => ({
        code: "required_probe_missing",
        probe_id: probeId,
        detail: `${probeId} is required by refusal-closure baseline v${baseline.version}.`,
      }));
    if (probes.length < baseline.minimum_probe_count) {
      ratchetFindings.push({
        code: "minimum_probe_count_regressed",
        probe_id: "corpus",
        detail: `${probes.length} probes are below the ratcheted minimum ${baseline.minimum_probe_count}.`,
      });
    }
    const findings = [...score.findings, ...ratchetFindings].sort(
      (left, right) =>
        left.probe_id.localeCompare(right.probe_id) ||
        left.code.localeCompare(right.code),
    );
    return {
      ...score,
      ok: findings.length === 0,
      contract_count: probes.length,
      baseline_version: baseline.version,
      baseline_minimum_probe_count: baseline.minimum_probe_count,
      findings,
    };
  } finally {
    removeDirectory(root, { recursive: true, force: true });
  }
}

/** Run the standalone repository gate. */
export function main(argv = process.argv.slice(2), options = {}) {
  const report = verifyExecutableRefusalClosure({
    ...options,
    injectMismatch: argv.includes("--inject-mismatch"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

/** Run the gate only when this module is the invoked Node entrypoint. */
export function runIfMain(candidate = process.argv[1], options = {}) {
  if (candidate && pathToFileURL(candidate).href === import.meta.url) {
    main([], options);
  }
}

runIfMain();
