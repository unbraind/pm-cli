#!/usr/bin/env node

/**
 * Machine-checkable ownership and negative-control registry for hosted gates.
 *
 * Tracker: pm-k6t4yb. Hosted inventory uses stable workflow job identifiers,
 * while ownership, bypass, taxonomy, and negative-control evidence remain
 * explicit reviewable policy.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { GRAPH_SUBCOMMAND_VALUES } from "../../dist/sdk/cli-contracts/enum-contracts.js";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const DEFAULT_REGISTRY_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "gate-registry.json",
);
function gateIdsFromWorkflow(source, file) {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid workflow YAML ${file}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const workflow = document.toJS();
  const jobs =
    typeof workflow === "object" &&
    workflow !== null &&
    typeof workflow.jobs === "object" &&
    workflow.jobs !== null
      ? workflow.jobs
      : {};
  return Object.keys(jobs);
}

/** Discover every hosted workflow job by its stable machine identifier. */
export async function discoverWorkflowGates(workflowsRoot) {
  const files = (await readdir(workflowsRoot))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const discovered = [];
  for (const file of files) {
    const source = await readFile(path.join(workflowsRoot, file), "utf8");
    for (const id of gateIdsFromWorkflow(source, file)) {
      discovered.push(`${file}#${id}`);
    }
  }
  return [...new Set(discovered)].sort();
}

function requiredStrings(value, label, violations) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    violations.push(`${label}:requires_non_empty_strings`);
    return [];
  }
  return value;
}

async function validateNegativeControl(
  gate,
  root,
  violations,
  required = true,
) {
  const negative = gate.negative_control;
  if (negative === undefined && !required) return;
  if (
    typeof negative !== "object" ||
    negative === null ||
    typeof negative.test !== "string" ||
    typeof negative.assertion !== "string"
  ) {
    violations.push(`gate:${gate.id}:negative_control_invalid`);
    return;
  }
  try {
    const testSource = await readFile(path.join(root, negative.test), "utf8");
    if (!testSource.includes(negative.assertion)) {
      violations.push(`gate:${gate.id}:negative_control_assertion_missing`);
    }
  } catch {
    violations.push(`gate:${gate.id}:negative_control_test_missing`);
  }
}

async function validateGatePolicy(
  gate,
  root,
  ids,
  registeredPipelines,
  violations,
) {
  if (typeof gate.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(gate.id)) {
    violations.push("gate:id_invalid");
    return;
  }
  if (ids.has(gate.id)) {
    violations.push(`gate:${gate.id}:duplicate`);
  }
  ids.add(gate.id);
  if (typeof gate.owner !== "string" || !/^pm-[a-z0-9]+$/.test(gate.owner)) {
    violations.push(`gate:${gate.id}:owner_invalid`);
  }
  const gatePipelines = new Set();
  for (const pipeline of requiredStrings(
    gate.pipelines,
    `gate:${gate.id}:pipelines`,
    violations,
  )) {
    if (gatePipelines.has(pipeline)) {
      violations.push(`gate:${gate.id}:pipeline:${pipeline}:duplicate`);
    }
    gatePipelines.add(pipeline);
    registeredPipelines.add(pipeline);
  }
  requiredStrings(
    gate.failure_taxonomy,
    `gate:${gate.id}:failure_taxonomy`,
    violations,
  );
  if (
    typeof gate.bypass !== "object" ||
    gate.bypass === null ||
    typeof gate.bypass.allowed !== "boolean" ||
    typeof gate.bypass.audit !== "string" ||
    gate.bypass.audit.trim().length === 0
  ) {
    violations.push(`gate:${gate.id}:bypass_invalid`);
  }
  await validateNegativeControl(gate, root, violations);
}

async function validateClaim(claim, root, ids, violations) {
  if (
    typeof claim.source !== "string" ||
    typeof claim.evidence !== "string" ||
    claim.evidence.trim().length === 0 ||
    typeof claim.gate !== "string" ||
    !ids.has(claim.gate) ||
    !["enforced", "advisory"].includes(claim.disposition)
  ) {
    violations.push("claim:invalid");
    return;
  }
  try {
    const source = await readFile(path.join(root, claim.source), "utf8");
    if (!source.includes(claim.evidence)) {
      violations.push(`claim:${claim.source}:evidence_missing`);
    }
  } catch {
    violations.push(`claim:${claim.source}:source_missing`);
  }
}

/** Validate one registry-owned executable without permitting arbitrary programs. */
function validLocalExecutable(executable) {
  return (
    typeof executable === "object" &&
    executable !== null &&
    ["node", "npm", "pnpm"].includes(executable.command) &&
    Array.isArray(executable.args) &&
    executable.args.length > 0 &&
    executable.args.every(
      (argument) =>
        typeof argument === "string" &&
        argument.length > 0 &&
        !argument.match(/\{\{[^a-z0-9_]|[^a-z0-9_]\}\}/u),
    ) &&
    (executable.capture_json === undefined ||
      typeof executable.capture_json === "boolean") &&
    (executable.env === undefined ||
      (typeof executable.env === "object" &&
        executable.env !== null &&
        !Array.isArray(executable.env) &&
        Object.entries(executable.env).every(
          ([key, value]) =>
            /^[A-Z][A-Z0-9_]*$/u.test(key) && typeof value === "string",
        )))
  );
}

/** Validate whether one step forbids skips or names its sole explicit skip flag. */
function validLocalSkipPolicy(step) {
  return step?.skip_policy === "forbidden"
    ? step.optional_flag === undefined
    : step?.skip_policy === "optional" &&
        typeof step.optional_flag === "string" &&
        step.optional_flag.startsWith("--skip-");
}

/** Validate one ordered local-preflight step against gate and execution policy. */
function validLocalPreflightStep(step, gateIds, stepIds) {
  return !(
    typeof step !== "object" ||
    step === null ||
    typeof step.id !== "string" ||
    stepIds.has(step.id) ||
    !Array.isArray(step.gates) ||
    step.gates.length === 0 ||
    step.gates.some((gate) => !gateIds.has(gate)) ||
    !validLocalExecutable(step.executable) ||
    !validLocalSkipPolicy(step)
  );
}

function validHostedOnlyGate(waiver, gateIds, covered) {
  return !(
    typeof waiver !== "object" ||
    waiver === null ||
    typeof waiver.gate !== "string" ||
    !gateIds.has(waiver.gate) ||
    covered.has(waiver.gate) ||
    typeof waiver.reason !== "string" ||
    waiver.reason.trim().length < 20
  );
}

/** Validate the one local preflight selection and every reasoned hosted-only waiver. */
function validateLocalPreflight(localPreflight, gateIds, violations) {
  const invalidDeclaration =
    typeof localPreflight !== "object" ||
    localPreflight === null ||
    localPreflight.command !== "pnpm verify:preflight" ||
    !Array.isArray(localPreflight.steps) ||
    !Array.isArray(localPreflight.hosted_only);
  if (invalidDeclaration) {
    violations.push("local_preflight:invalid");
    return;
  }
  const covered = new Set();
  const stepIds = new Set();
  for (const step of localPreflight.steps) {
    if (!validLocalPreflightStep(step, gateIds, stepIds)) {
      violations.push("local_preflight:step_invalid");
      continue;
    }
    stepIds.add(step.id);
    for (const gate of step.gates) covered.add(gate);
  }
  for (const waiver of localPreflight.hosted_only) {
    if (!validHostedOnlyGate(waiver, gateIds, covered)) {
      violations.push("local_preflight:hosted_only_invalid");
      continue;
    }
    covered.add(waiver.gate);
  }
  for (const gate of gateIds) {
    if (!covered.has(gate))
      violations.push(`local_preflight:gate:${gate}:unmapped`);
  }
}

/** Test whether one gate-script disposition is complete and truthful. */
function validProviderDisposition(entry) {
  const validArguments = (argumentsValue, requireNonEmpty) =>
    argumentsValue === undefined ||
    (Array.isArray(argumentsValue) &&
      (!requireNonEmpty || argumentsValue.length > 0) &&
      argumentsValue.every(
        (argument) => typeof argument === "string" && argument.length > 0,
      ));
  return (
    typeof entry.provider === "string" &&
    /^repository-quality\/[a-z0-9][a-z0-9-]*$/u.test(entry.provider) &&
    validArguments(entry.provider_args, false) &&
    validArguments(entry.provider_negative_args, true) &&
    (entry.provider_timeout_ms === undefined ||
      (Number.isInteger(entry.provider_timeout_ms) &&
        entry.provider_timeout_ms > 0))
  );
}

/** Test whether one gate-script disposition is complete and truthful. */
function validGateScriptDisposition(entry, disposition, discoveredScripts) {
  if (disposition === "migrated") {
    return (
      !discoveredScripts.has(entry.path) &&
      typeof entry.replacement === "string" &&
      entry.replacement.trim().length >= 10
    );
  }
  if (!discoveredScripts.has(entry.path)) return false;
  if (disposition === "reduced_to_provider") {
    return validProviderDisposition(entry);
  }
  return typeof entry.reason === "string" && entry.reason.trim().length >= 20;
}

/** Validate every current and retired release-gate script disposition. */
async function validateGateScriptInventory(
  gateScripts,
  discoveredScripts,
  root,
  providers,
  violations,
) {
  const declaredScripts = new Set();
  const objectEntries = gateScripts.filter(
    (entry) => typeof entry === "object" && entry !== null,
  );
  violations.push(
    ...Array.from(
      { length: gateScripts.length - objectEntries.length },
      () => "automation_inventory:gate_script:invalid",
    ),
  );
  for (const entry of objectEntries) {
    const disposition = entry.disposition;
    const rowValid =
      typeof entry.path === "string" &&
      !declaredScripts.has(entry.path) &&
      ["migrated", "reduced_to_provider", "retained"].includes(disposition) &&
      validGateScriptDisposition(entry, disposition, discoveredScripts);
    if (!rowValid) violations.push("automation_inventory:gate_script:invalid");
    if (typeof entry.path === "string") declaredScripts.add(entry.path);
    await validateNegativeControl(
      {
        id: entry.provider ?? entry.path,
        negative_control: entry.negative_control,
      },
      root,
      violations,
      disposition === "reduced_to_provider",
    );
    if (disposition === "reduced_to_provider") {
      if (providers.has(entry.provider)) {
        violations.push("automation_inventory:provider:duplicate");
      }
      providers.add(entry.provider);
    }
  }
  for (const script of discoveredScripts) {
    if (!declaredScripts.has(script))
      violations.push(`automation_inventory:gate_script:${script}:undeclared`);
  }
  const migratedOrProvider = objectEntries.filter((entry) =>
    ["migrated", "reduced_to_provider"].includes(entry.disposition),
  ).length;
  const retained = objectEntries.filter(
    (entry) => entry.disposition === "retained",
  ).length;
  if (migratedOrProvider <= retained) {
    violations.push("automation_inventory:migration_majority_not_met");
  }
}

/** Validate non-gate executables exposed as repository assurance providers. */
async function validateProviderChecks(
  providerChecks,
  root,
  providers,
  violations,
) {
  if (providerChecks === undefined) return;
  if (!Array.isArray(providerChecks)) {
    violations.push("automation_inventory:provider_checks:invalid");
    return;
  }
  for (const entry of providerChecks) {
    const duplicateProvider = providers.has(entry?.provider);
    if (duplicateProvider) {
      violations.push("automation_inventory:provider:duplicate");
    }
    const valid =
      entry?.kind === "provider_check" &&
      typeof entry.path === "string" &&
      entry.path.startsWith("scripts/") &&
      validProviderDisposition(entry) &&
      !duplicateProvider;
    if (!valid) {
      violations.push("automation_inventory:provider_check:invalid");
      continue;
    }
    providers.add(entry.provider);
    try {
      await readFile(path.join(root, entry.path), "utf8");
    } catch {
      violations.push(
        `automation_inventory:provider_check:${entry.path}:missing`,
      );
    }
    await validateNegativeControl(
      { id: entry.provider, negative_control: entry.negative_control },
      root,
      violations,
    );
  }
}

/** Validate one disposition for every public relationship-graph operation. */
function validateGraphOperationInventory(graphOperations, violations) {
  const declaredOperations = new Set();
  for (const entry of graphOperations) {
    const consumer =
      typeof entry?.automated_consumer === "string" &&
      entry.automated_consumer.trim().length >= 10;
    const interactive =
      typeof entry?.interactive_only_reason === "string" &&
      entry.interactive_only_reason.trim().length >= 20;
    if (
      typeof entry?.operation !== "string" ||
      declaredOperations.has(entry.operation) ||
      !GRAPH_SUBCOMMAND_VALUES.includes(entry.operation) ||
      consumer === interactive
    ) {
      violations.push("automation_inventory:graph_operation:invalid");
    }
    if (typeof entry?.operation === "string")
      declaredOperations.add(entry.operation);
  }
  for (const operation of GRAPH_SUBCOMMAND_VALUES) {
    if (!declaredOperations.has(operation))
      violations.push(
        `automation_inventory:graph_operation:${operation}:undeclared`,
      );
  }
}

/** Validate the exhaustive script-migration and graph-consumer inventory. */
async function validateAutomationInventory(inventory, root, violations) {
  if (
    typeof inventory !== "object" ||
    inventory === null ||
    !Array.isArray(inventory.gate_scripts) ||
    !Array.isArray(inventory.graph_operations)
  ) {
    if (inventory !== undefined)
      violations.push("automation_inventory:invalid");
    return;
  }
  const discoveredScripts = new Set(
    (await readdir(path.join(root, "scripts", "release")))
      .filter((file) =>
        /(?:-gate|flag-invocation-parity|gate-registry)\.(?:[cm]?[jt]s)$/u.test(
          file,
        ),
      )
      .map((file) => `scripts/release/${file}`),
  );
  const providers = new Set();
  await validateGateScriptInventory(
    inventory.gate_scripts,
    discoveredScripts,
    root,
    providers,
    violations,
  );
  await validateProviderChecks(
    inventory.provider_checks,
    root,
    providers,
    violations,
  );
  validateGraphOperationInventory(inventory.graph_operations, violations);
}

/** Validate registry policy and exact parity with enforced workflow steps. */
export async function validateGateRegistry(registry, options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const discovered =
    options.discovered ??
    (await discoverWorkflowGates(path.join(root, ".github", "workflows")));
  const violations = [];
  if (registry.version !== 2 || !Array.isArray(registry.gates)) {
    return ["registry:requires_version_2_gates_array"];
  }
  const ids = new Set();
  const registeredPipelines = new Set();
  for (const gate of registry.gates) {
    await validateGatePolicy(gate, root, ids, registeredPipelines, violations);
  }
  validateLocalPreflight(registry.local_preflight, ids, violations);
  await validateAutomationInventory(
    registry.automation_inventory,
    root,
    violations,
  );
  for (const pipeline of discovered) {
    if (!registeredPipelines.has(pipeline)) {
      violations.push(`pipeline:${pipeline}:unregistered`);
    }
  }
  for (const pipeline of registeredPipelines) {
    if (!discovered.includes(pipeline)) {
      violations.push(`pipeline:${pipeline}:not_enforced`);
    }
  }
  for (const claim of registry.claims ?? []) {
    await validateClaim(claim, root, ids, violations);
  }
  return violations.sort();
}

/** Count migrated, provider-backed, retained, and provider-check entries. */
function automationInventoryCounts(registry) {
  const gateScripts = registry.automation_inventory?.gate_scripts ?? [];
  return {
    migrated_gate_script_count: gateScripts.filter(
      (entry) => entry.disposition === "migrated",
    ).length,
    provider_gate_script_count: gateScripts.filter(
      (entry) => entry.disposition === "reduced_to_provider",
    ).length,
    retained_gate_script_count: gateScripts.filter(
      (entry) => entry.disposition === "retained",
    ).length,
    provider_check_count:
      registry.automation_inventory?.provider_checks?.length ?? 0,
  };
}

/** Print discovered inventory or enforce the committed registry. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const registryFlag = flags.get("registry");
  const registryPath =
    registryFlag === undefined || registryFlag === true
      ? DEFAULT_REGISTRY_PATH
      : path.resolve(String(registryFlag));
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const discovered = await discoverWorkflowGates(
    path.join(repoRoot, ".github", "workflows"),
  );
  const violations = await validateGateRegistry(registry, { discovered });
  if (violations.length > 0) {
    throw new Error(
      `Gate registry validation failed:\n${violations.join("\n")}`,
    );
  }
  const registered = [
    ...new Set(registry.gates.flatMap((gate) => gate.pipelines)),
  ].sort();
  if (flags.has("inventory")) {
    return { registered, workflow_jobs: discovered };
  }
  return {
    ok: true,
    registered_gate_count: registry.gates.length,
    enforced_pipeline_count: discovered.length,
    claim_count: registry.claims?.length ?? 0,
    ...automationInventoryCounts(registry),
    declared_graph_operation_count:
      registry.automation_inventory?.graph_operations.length ?? 0,
  };
}

/** Execute the registry entrypoint without mutating process globals in tests. */
export async function runGateRegistryEntrypoint(options = {}) {
  const argv = options.argv ?? process.argv;
  if (
    argv[1] === undefined ||
    fileURLToPath(import.meta.url) !== path.resolve(argv[1])
  ) {
    return false;
  }
  try {
    const result = await (options.run ?? main)(argv.slice(2));
    (options.write ?? ((output) => process.stdout.write(output)))(
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return true;
  } catch (error) {
    (options.onError ?? ((cause) => fail(String(cause))))(error);
    return false;
  }
}

void runGateRegistryEntrypoint();
