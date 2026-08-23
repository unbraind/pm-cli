#!/usr/bin/env node

/** Execute closed-domain refusal retries and score their recovery closure. */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scorePmRefusalClosure } from "../../dist/sdk/agent/refusal-closure.js";
import { listCoreClosedDomainContracts } from "../../dist/sdk/agent/closed-domain-contracts.js";
import {
  listPmRequiredArgumentRefusalContracts,
  listPmSubcommandRefusalContracts,
  scorePmGrammarRefusalClosure,
} from "../../dist/sdk/agent/refusal-corpus-contracts.js";
import {
  buildPmRefusalClosureCensus,
  verifyPmRefusalClosureIdentityRatchet,
  verifyPmRefusalClosureRatchet,
} from "../../dist/sdk/agent/refusal-closure-census.js";
import { PM_ERROR_CODE_CATALOG } from "../../dist/sdk/generated-error-code-catalog.js";
import {
  listTrackerPreflightRecoveryContracts,
  scoreTrackerPreflightRecoveryClosure,
} from "../../dist/sdk/agent/tracker-preflight-contracts.js";
import {
  estimatePmOutputTokens,
  resolvePmDiagnosticOutputBudget,
} from "../../dist/sdk/cli-contracts.js";

const REFUSAL_CLOSURE_BASELINE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./refusal-closure-baseline.json", import.meta.url)),
    "utf8",
  ),
);
const DIAGNOSTIC_OUTPUT_BASELINE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./diagnostic-output-baseline.json", import.meta.url),
    ),
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

function snapshotDirectory(root) {
  const hash = createHash("sha256");
  const entries = new Map();
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      // Runtime locks and caches are explicitly non-authoritative. Refusals
      // must preserve schema, items, history, settings, and package state.
      if (prefix === "" && entry.name === "runtime") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      hash.update(`${entry.isDirectory() ? "d" : "f"}:${relativePath}\0`);
      if (entry.isDirectory()) {
        entries.set(relativePath, "directory");
        visit(absolutePath, relativePath);
      } else {
        const content = readFileSync(absolutePath);
        const contentHash = createHash("sha256").update(content).digest("hex");
        entries.set(relativePath, contentHash);
        hash.update(content);
      }
    }
  };
  if (statSync(root).isDirectory()) visit(root, "");
  return { digest: hash.digest("hex"), entries };
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
      allowed_values: stringArray(
        envelope.refusal?.legal_domain ?? recovery.allowed_values,
      ),
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
      diagnostic_output: envelope.diagnostic_output,
      diagnostic_output_present: Object.hasOwn(envelope, "diagnostic_output"),
      diagnostic_actual_estimated_tokens: estimatePmOutputTokens(
        Buffer.byteLength(JSON.stringify(envelope, null, 2), "utf8"),
      ),
      corrective_action_present:
        typeof envelope.required === "string" &&
        envelope.required.trim().length > 0 &&
        (retryArguments.some((entry) => entry.trim().length > 0) ||
          stringArray(recovery.allowed_values).some(
            (entry) => entry.trim().length > 0,
          ) ||
          stringArray(envelope.next_steps).some(
            (entry) => entry.trim().length > 0,
          )),
    };
  });
}

function executeGrammarRefusalProbes(probes, spawn, environment) {
  return probes.map((contract) => {
    const before = snapshotDirectory(environment.PM_PATH);
    const refusal = runCli(
      spawn,
      [...contract.refusal_args, "--json"],
      environment,
    );
    const after = snapshotDirectory(environment.PM_PATH);
    const envelope = parseProblemEnvelope(refusal);
    const recovery = runCli(
      spawn,
      [...contract.recovery_args, "--json"],
      environment,
    );
    return {
      probe_id: contract.probe_id,
      error_code: typeof envelope.code === "string" ? envelope.code : "",
      exit_code: refusal.status ?? 1,
      allowed_values: strictStringArray(
        (envelope.recovery ?? {}).allowed_values,
      ),
      recovery_succeeded: recovery.status === 0,
      refusal_mutated_state: before.digest !== after.digest,
      mutated_paths: [
        ...new Set([...before.entries.keys(), ...after.entries.keys()]),
      ]
        .filter(
          (entryPath) =>
            before.entries.get(entryPath) !== after.entries.get(entryPath),
        )
        .sort(),
    };
  });
}

function scoreDiagnosticOutputCorpus(observations, baseline) {
  const observationsById = new Map(
    observations.map((observation) => [observation.probe_id, observation]),
  );
  const findings = [];
  let originalEstimatedTokens = 0;
  let estimatedTokens = 0;
  let withinBudgetCount = 0;
  let correctiveActionCount = 0;
  for (const probeId of baseline.required_probe_ids) {
    const observation = observationsById.get(probeId);
    if (!observation) {
      findings.push({
        code: "diagnostic_probe_missing",
        probe_id: probeId,
        detail: `${probeId} is required by diagnostic-output baseline v${baseline.version}.`,
      });
      continue;
    }
    const {
      budget,
      reportedEstimatedTokens,
      originalObservationEstimatedTokens,
      invalidReceipt,
    } = diagnosticObservationMetrics(observation);
    originalEstimatedTokens += originalObservationEstimatedTokens;
    estimatedTokens += reportedEstimatedTokens;
    if (invalidReceipt) {
      findings.push({
        code: "diagnostic_receipt_invalid",
        probe_id: probeId,
        detail: `${probeId} exposed a malformed diagnostic_output receipt.`,
      });
    } else if (
      reportedEstimatedTokens <= budget &&
      reportedEstimatedTokens === observation.diagnostic_actual_estimated_tokens
    ) {
      withinBudgetCount += 1;
    } else {
      findings.push({
        code: "diagnostic_budget_mismatch",
        probe_id: probeId,
        detail: `${probeId} reported ${reportedEstimatedTokens}/${budget} tokens; measured ${observation.diagnostic_actual_estimated_tokens}.`,
      });
    }
    if (observation.corrective_action_present) correctiveActionCount += 1;
    else {
      findings.push({
        code: "diagnostic_corrective_action_missing",
        probe_id: probeId,
        detail: `${probeId} did not retain a mechanically actionable correction.`,
      });
    }
  }
  return {
    ok: findings.length === 0,
    baseline_version: baseline.version,
    probe_count: baseline.required_probe_ids.length,
    within_budget_count: withinBudgetCount,
    corrective_action_count: correctiveActionCount,
    original_estimated_tokens: originalEstimatedTokens,
    estimated_tokens: estimatedTokens,
    findings,
  };
}

function diagnosticObservationMetrics(observation) {
  const measured = observation.diagnostic_actual_estimated_tokens;
  if (observation.diagnostic_output_present !== true) {
    return {
      budget:
        resolvePmDiagnosticOutputBudget("error")
          .default_max_estimated_tokens_by_format.json,
      reportedEstimatedTokens: measured,
      originalObservationEstimatedTokens: measured,
      invalidReceipt: false,
    };
  }
  const receipt = observation.diagnostic_output;
  if (
    receipt !== null &&
    typeof receipt === "object" &&
    !Array.isArray(receipt) &&
    Number.isSafeInteger(receipt.budget) &&
    receipt.budget > 0 &&
    Number.isSafeInteger(receipt.estimated_tokens) &&
    receipt.estimated_tokens >= 0 &&
    Number.isSafeInteger(receipt.original_estimated_tokens) &&
    receipt.original_estimated_tokens >= 0
  ) {
    return {
      budget: receipt.budget,
      reportedEstimatedTokens: receipt.estimated_tokens,
      originalObservationEstimatedTokens: receipt.original_estimated_tokens,
      invalidReceipt: false,
    };
  }
  return {
    budget: 0,
    reportedEstimatedTokens: measured,
    originalObservationEstimatedTokens: measured,
    invalidReceipt: true,
  };
}

function executeTrackerPreflightProbes(probes, root, spawn, environment) {
  const roots = {
    missing_root: path.join(root, "tracker-root-missing"),
    settings_missing: path.join(root, "tracker-root-settings-missing"),
    not_directory: path.join(root, "tracker-root-not-directory"),
    unreadable_root: path.join(root, "tracker-root-unreadable"),
  };
  if (probes.length > 0) {
    mkdirSync(roots.settings_missing, { recursive: true });
    writeFileSync(roots.not_directory, "not a tracker directory\n", "utf8");
  }
  const needsUnreadableRoot = probes.some(
    ({ failure_kind: failureKind }) => failureKind === "unreadable_root",
  );
  if (needsUnreadableRoot) {
    const initialized = runCli(
      spawn,
      [
        "--pm-path",
        roots.unreadable_root,
        "init",
        "--defaults",
        "--agent-guidance",
        "skip",
        "--json",
      ],
      environment,
    );
    requireSuccessfulSetup(initialized, "unreadable tracker setup");
    chmodSync(roots.unreadable_root, 0o000);
  }
  try {
    return probes.map((contract) => {
      const selectedRoot = roots[contract.failure_kind];
      if (typeof selectedRoot !== "string") {
        return {
          probe_id: contract.probe_id,
          error_code: "invalid_tracker_preflight_failure_kind",
          exit_code: 1,
          recovery_kind: contract.recovery_kind,
          suggested_retry_args: [],
          retry_succeeded: false,
          unsafe_init_recommended: false,
        };
      }
      const refusal = runCli(
        spawn,
        ["--pm-path", selectedRoot, "list", "--json"],
        environment,
      );
      const envelope = parseProblemEnvelope(refusal);
      const retryArguments = strictStringArray(
        (envelope.recovery ?? {}).suggested_retry_args,
      );
      if (contract.recovery_kind === "repair_permissions") {
        chmodSync(selectedRoot, 0o700);
      }
      const retry = runCli(
        spawn,
        contract.recovery_kind === "initialize"
          ? [...retryArguments, "--json"]
          : contract.recovery_kind === "repair_permissions"
            ? ["--pm-path", selectedRoot, "list", "--json"]
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
          contract.recovery_kind !== "initialize" &&
          (retryArguments.includes("init") ||
            refusal.stderr.includes("pm init")),
      };
    });
  } finally {
    if (needsUnreadableRoot) {
      chmodSync(roots.unreadable_root, 0o700);
    }
  }
}

function defaultGrammarRefusalProbes(closedDomainProbes) {
  if (closedDomainProbes !== undefined) return [];
  return [
    ...listPmRequiredArgumentRefusalContracts(),
    ...listPmSubcommandRefusalContracts(),
  ];
}

function warmExtensionRegistry(probes, spawn, environment) {
  if (!probes.some(({ command }) => command.startsWith("extension "))) return;
  requireSuccessfulSetup(
    runCli(spawn, ["extension", "list", "--json"], environment),
    "extension registry warmup",
  );
}

function scoreTrackerPreflightCorpus(probes, observations) {
  return probes.length === 0
    ? { probe_count: 0, closed_probe_count: 0, findings: [] }
    : scoreTrackerPreflightRecoveryClosure(observations);
}

function buildRefusalRatchetFindings(baseline, probeIds, contractCount) {
  const findings = baseline.required_probe_ids
    .filter((probeId) => !probeIds.has(probeId))
    .map((probeId) => ({
      code: "required_probe_missing",
      probe_id: probeId,
      detail: `${probeId} is required by refusal-closure baseline v${baseline.version}.`,
    }));
  if (contractCount < baseline.minimum_probe_count) {
    findings.push({
      code: "minimum_probe_count_regressed",
      probe_id: "corpus",
      detail: `${contractCount} probes are below the ratcheted minimum ${baseline.minimum_probe_count}.`,
    });
  }
  return findings;
}

/** Score complete-catalog refusal evidence and its executable-code ratchet. */
export function scorePmRefusalCatalogClosure(
  errorCodeCatalog = PM_ERROR_CODE_CATALOG,
) {
  const catalogClosure = buildPmRefusalClosureCensus(
    errorCodeCatalog,
    listCoreClosedDomainContracts(),
    [
      ...listPmRequiredArgumentRefusalContracts(),
      ...listPmSubcommandRefusalContracts(),
    ],
  );
  const catalogCountRatchet = verifyPmRefusalClosureRatchet(catalogClosure);
  const catalogIdentityRatchet =
    verifyPmRefusalClosureIdentityRatchet(catalogClosure);
  const catalogRatchet = {
    ...catalogCountRatchet,
    ...catalogIdentityRatchet,
    ok: catalogCountRatchet.ok && catalogIdentityRatchet.ok,
  };
  return {
    catalogClosure,
    catalogRatchet,
    catalogRatchetFindings: [
      ...(catalogRatchet.actual < catalogRatchet.baseline
        ? [
            {
              code: "executable_error_code_count_regressed",
              probe_id: "catalog-census",
              detail: `${catalogRatchet.actual} executable error codes are below the ratcheted minimum ${catalogRatchet.baseline}.`,
            },
          ]
        : []),
      ...catalogRatchet.missing_required_canonical_codes.map((code) => ({
        code: "executable_error_code_identity_regressed",
        probe_id: `catalog-census:${code}`,
        detail: `Required canonical error code ${code} has no executable refusal evidence.`,
      })),
    ],
  };
}

/** Execute the real core CLI refusal corpus in an isolated tracker. */
export function verifyExecutableRefusalClosure({
  injectMismatch = false,
  probes,
  grammarProbes,
  preflightProbes,
  baseline = REFUSAL_CLOSURE_BASELINE,
  diagnosticBaseline,
  spawn = spawnSync,
  makeTemporaryDirectory = mkdtempSync,
  removeDirectory = rmSync,
  errorCodeCatalog = PM_ERROR_CODE_CATALOG,
} = {}) {
  const closedDomainProbes = probes ?? listCoreClosedDomainContracts();
  // Preserve injected closed-domain-only tests: preflights default only with the production corpus.
  const trackerPreflightProbes =
    preflightProbes ??
    (probes === undefined ? listTrackerPreflightRecoveryContracts() : []);
  const grammarRefusalProbes =
    grammarProbes ?? defaultGrammarRefusalProbes(probes);
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
    warmExtensionRegistry(grammarRefusalProbes, spawn, environment);
    const observations = executeClosedDomainProbes(
      closedDomainProbes,
      spawn,
      environment,
    );
    if (injectMismatch) observations[0].allowed_values = [];
    const closedDomainScore = scorePmRefusalClosure(observations);
    const grammarObservations = executeGrammarRefusalProbes(
      grammarRefusalProbes,
      spawn,
      environment,
    );
    const grammarRefusalScore = scorePmGrammarRefusalClosure(
      grammarRefusalProbes,
      grammarObservations,
    );
    const trackerPreflightObservations = executeTrackerPreflightProbes(
      trackerPreflightProbes,
      root,
      spawn,
      environment,
    );
    const trackerPreflightScore = scoreTrackerPreflightCorpus(
      trackerPreflightProbes,
      trackerPreflightObservations,
    );
    const effectiveDiagnosticBaseline =
      diagnosticBaseline ??
      (probes === undefined ? DIAGNOSTIC_OUTPUT_BASELINE : null);
    const diagnosticOutputScore = resolveDiagnosticOutputScore(
      observations,
      effectiveDiagnosticBaseline,
    );
    const probeIds = new Set(
      [
        ...closedDomainProbes,
        ...grammarRefusalProbes,
        ...trackerPreflightProbes,
      ].map(({ probe_id: probeId }) => probeId),
    );
    const contractCount =
      closedDomainProbes.length +
      grammarRefusalProbes.length +
      trackerPreflightProbes.length;
    const ratchetFindings = buildRefusalRatchetFindings(
      baseline,
      probeIds,
      contractCount,
    );
    const { catalogClosure, catalogRatchet, catalogRatchetFindings } =
      scorePmRefusalCatalogClosure(errorCodeCatalog);
    const findings = [
      ...closedDomainScore.findings,
      ...grammarRefusalScore.findings,
      ...trackerPreflightScore.findings,
      ...diagnosticOutputScore.findings,
      ...ratchetFindings,
      ...catalogRatchetFindings,
    ].sort(
      (left, right) =>
        left.probe_id.localeCompare(right.probe_id) ||
        left.code.localeCompare(right.code),
    );
    const closedProbeCount =
      closedDomainScore.closed_probe_count +
      grammarRefusalScore.closed_probe_count +
      trackerPreflightScore.closed_probe_count;
    return {
      ok: findings.length === 0,
      probe_count: contractCount,
      closed_probe_count: closedProbeCount,
      closure_fraction:
        contractCount === 0 ? 1 : closedProbeCount / contractCount,
      contract_count: contractCount,
      closed_domain_contract_count: closedDomainProbes.length,
      grammar_refusal_contract_count: grammarRefusalProbes.length,
      required_argument_contract_count: grammarRefusalProbes.filter(
        (contract) => Object.hasOwn(contract, "missing_argument"),
      ).length,
      subcommand_contract_count: grammarRefusalProbes.filter((contract) =>
        Object.hasOwn(contract, "allowed_values"),
      ).length,
      tracker_preflight_contract_count: trackerPreflightProbes.length,
      baseline_version: baseline.version,
      baseline_minimum_probe_count: baseline.minimum_probe_count,
      diagnostic_output: diagnosticOutputScore,
      catalog_closure: {
        complete: catalogClosure.ok,
        catalog_error_code_count: catalogClosure.catalog_error_code_count,
        executable_error_code_count: catalogClosure.executable_error_code_count,
        uncovered_error_code_count: catalogClosure.uncovered_error_code_count,
        coverage_fraction: catalogClosure.coverage_fraction,
        ratchet: catalogRatchet,
        restore_with: "docs/generated/REFUSAL_CLOSURE_CENSUS.md",
      },
      findings,
    };
  } finally {
    removeDirectory(root, { recursive: true, force: true });
  }
}

function resolveDiagnosticOutputScore(observations, baseline) {
  if (baseline) return scoreDiagnosticOutputCorpus(observations, baseline);
  return {
    ok: true,
    baseline_version: null,
    probe_count: 0,
    within_budget_count: 0,
    corrective_action_count: 0,
    original_estimated_tokens: 0,
    estimated_tokens: 0,
    findings: [],
  };
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
