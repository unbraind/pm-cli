#!/usr/bin/env node

/** Execute closed-domain refusal retries and score their recovery closure. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scorePmRefusalClosure } from "../../dist/sdk/agent/refusal-closure.js";
import { listCoreClosedDomainContracts } from "../../dist/sdk/agent/closed-domain-contracts.js";
import {
  listTrackerPreflightRecoveryContracts,
  scoreTrackerPreflightRecoveryClosure,
} from "../../dist/sdk/agent/tracker-preflight-contracts.js";

const REFUSAL_CLOSURE_BASELINE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./refusal-closure-baseline.json", import.meta.url)),
    "utf8",
  ),
);

function requireSuccessfulSetup(result, label) {
  if (result.status !== 0) {
    throw new Error(`Refusal closure ${label} failed: ${result.stderr}`);
  }
}

function runCli(spawn, argumentsList, environment) {
  return spawn(process.execPath, ["dist/cli.js", ...argumentsList], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
  });
}

function parseProblemEnvelope(result) {
  const problemStart = result.stderr.indexOf("{");
  return JSON.parse(
    problemStart >= 0 ? result.stderr.slice(problemStart) : result.stderr,
  );
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

function strictStringArray(value) {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function executeClosedDomainProbes(probes, spawn, environment) {
  return probes.map((contract) => {
    const { probe_id: probeId, refusal_args: args } = contract;
    const refusal = runCli(spawn, [...args, "--json"], environment);
    const envelope = parseProblemEnvelope(refusal);
    const recovery = envelope.recovery ?? {};
    const retryArguments = strictStringArray(recovery.suggested_retry_args);
    const retry =
      retryArguments.length > 0
        ? runCli(spawn, [...retryArguments, "--json"], environment)
        : { status: 1 };
    return {
      probe_id: probeId,
      entrypoint: `pm ${args.join(" ")}`,
      exit_code: refusal.status ?? 1,
      rejected_value: contract.rejected_value,
      allowed_values: stringArray(recovery.allowed_values),
      expected_allowed_values: contract.allowed_values,
      allowed_values_required: contract.allowed_values_required,
      error_code: typeof envelope.code === "string" ? envelope.code : "",
      expected_error_code: contract.error_code,
      suggested_retry:
        typeof recovery.suggested_retry === "string"
          ? recovery.suggested_retry
          : "",
      suggested_retry_args: retryArguments,
      expected_suggested_retry_args: contract.suggested_retry_args,
      retry_succeeded: retry.status === 0,
    };
  });
}

function executeTrackerPreflightProbes(probes, root, spawn, environment) {
  const roots = {
    missing_root: path.join(root, "tracker-root-missing"),
    settings_missing: path.join(root, "tracker-root-settings-missing"),
    not_directory: path.join(root, "tracker-root-not-directory"),
  };
  if (probes.length > 0) {
    mkdirSync(roots.settings_missing, { recursive: true });
    writeFileSync(roots.not_directory, "not a tracker directory\n", "utf8");
  }
  return probes.map((contract) => {
    const selectedRoot = roots[contract.failure_kind];
    const refusal = runCli(
      spawn,
      ["--pm-path", selectedRoot, "list", "--json"],
      environment,
    );
    const envelope = parseProblemEnvelope(refusal);
    const retryArguments = strictStringArray(
      (envelope.recovery ?? {}).suggested_retry_args,
    );
    const retry = runCli(
      spawn,
      contract.recovery_kind === "initialize"
        ? [...retryArguments, "--json"]
        : ["--pm-path", environment.PM_PATH, "list", "--json"],
      environment,
    );
    return {
      probe_id: contract.probe_id,
      error_code: typeof envelope.code === "string" ? envelope.code : "",
      exit_code: refusal.status ?? 1,
      recovery_kind: contract.recovery_kind,
      suggested_retry_args: retryArguments,
      retry_succeeded: retry.status === 0,
      unsafe_init_recommended:
        contract.recovery_kind === "select_directory" &&
        (retryArguments.includes("init") || refusal.stderr.includes("pm init")),
    };
  });
}

/** Execute the real core CLI refusal corpus in an isolated tracker. */
export function verifyExecutableRefusalClosure({
  injectMismatch = false,
  probes,
  preflightProbes,
  baseline = REFUSAL_CLOSURE_BASELINE,
  spawn = spawnSync,
  makeTemporaryDirectory = mkdtempSync,
  removeDirectory = rmSync,
} = {}) {
  const closedDomainProbes = probes ?? listCoreClosedDomainContracts();
  const trackerPreflightProbes =
    preflightProbes ??
    (probes === undefined ? listTrackerPreflightRecoveryContracts() : []);
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
    const initialized = runCli(
      spawn,
      ["init", "--defaults", "--json"],
      environment,
    );
    requireSuccessfulSetup(initialized, "tracker setup");
    const seeded = runCli(
      spawn,
      [
        "create",
        "--id",
        "pm-domain",
        "--title",
        "Domain query target",
        "--json",
      ],
      environment,
    );
    requireSuccessfulSetup(seeded, "item setup");
    const observations = executeClosedDomainProbes(
      closedDomainProbes,
      spawn,
      environment,
    );
    if (injectMismatch) observations[0].allowed_values = [];
    const closedDomainScore = scorePmRefusalClosure(observations);
    const trackerPreflightObservations = executeTrackerPreflightProbes(
      trackerPreflightProbes,
      root,
      spawn,
      environment,
    );
    const trackerPreflightScore =
      trackerPreflightProbes.length === 0
        ? { probe_count: 0, closed_probe_count: 0, findings: [] }
        : scoreTrackerPreflightRecoveryClosure(trackerPreflightObservations);
    const probeIds = new Set(
      [...closedDomainProbes, ...trackerPreflightProbes].map(
        ({ probe_id: probeId }) => probeId,
      ),
    );
    const ratchetFindings = baseline.required_probe_ids
      .filter((probeId) => !probeIds.has(probeId))
      .map((probeId) => ({
        code: "required_probe_missing",
        probe_id: probeId,
        detail: `${probeId} is required by refusal-closure baseline v${baseline.version}.`,
      }));
    const contractCount =
      closedDomainProbes.length + trackerPreflightProbes.length;
    if (contractCount < baseline.minimum_probe_count) {
      ratchetFindings.push({
        code: "minimum_probe_count_regressed",
        probe_id: "corpus",
        detail: `${contractCount} probes are below the ratcheted minimum ${baseline.minimum_probe_count}.`,
      });
    }
    const findings = [
      ...closedDomainScore.findings,
      ...trackerPreflightScore.findings,
      ...ratchetFindings,
    ].sort(
      (left, right) =>
        left.probe_id.localeCompare(right.probe_id) ||
        left.code.localeCompare(right.code),
    );
    const closedProbeCount =
      closedDomainScore.closed_probe_count +
      trackerPreflightScore.closed_probe_count;
    return {
      ok: findings.length === 0,
      probe_count: contractCount,
      closed_probe_count: closedProbeCount,
      closure_fraction:
        contractCount === 0 ? 1 : closedProbeCount / contractCount,
      contract_count: contractCount,
      closed_domain_contract_count: closedDomainProbes.length,
      tracker_preflight_contract_count: trackerPreflightProbes.length,
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
