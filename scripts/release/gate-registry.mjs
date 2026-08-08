#!/usr/bin/env node

/**
 * Machine-checkable ownership and negative-control registry for hosted gates.
 *
 * Tracker: pm-k6t4yb. Workflow step discovery is derived from enforced YAML,
 * while ownership, bypass, taxonomy, and negative-control evidence remain
 * explicit reviewable policy.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const DEFAULT_REGISTRY_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "gate-registry.json",
);
const GATE_STEP_PATTERN =
  /\b(build|typecheck|test|gates?|check|scan|analysis|benchmark|verify|dogfood|release pipeline|enforce|coverage|quality)\b/i;
const NON_GATE_STEP_PATTERN =
  /^(setup|install|checkout|download|upload|restore|record|resolve|alert|create github release)/i;

function gateNamesFromWorkflow(source, file) {
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
  const names = [];
  for (const job of Object.values(jobs)) {
    const steps =
      typeof job === "object" && job !== null && Array.isArray(job.steps)
        ? job.steps
        : [];
    for (const step of steps) {
      if (
        typeof step === "object" &&
        step !== null &&
        typeof step.name === "string" &&
        GATE_STEP_PATTERN.test(step.name) &&
        !NON_GATE_STEP_PATTERN.test(step.name)
      ) {
        names.push(step.name);
      }
    }
  }
  return names;
}

/** Discover enforced workflow steps that make a build, quality, or release claim. */
export async function discoverWorkflowGates(workflowsRoot) {
  const files = (await readdir(workflowsRoot))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const discovered = [];
  for (const file of files) {
    const source = await readFile(path.join(workflowsRoot, file), "utf8");
    for (const name of gateNamesFromWorkflow(source, file)) {
      discovered.push(`${file}#${name}`);
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

async function validateNegativeControl(gate, root, violations) {
  const negative = gate.negative_control;
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
  for (const pipeline of requiredStrings(
    gate.pipelines,
    `gate:${gate.id}:pipelines`,
    violations,
  )) {
    if (registeredPipelines.has(pipeline)) {
      violations.push(`pipeline:${pipeline}:duplicate_owner`);
    }
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

/** Validate registry policy and exact parity with enforced workflow steps. */
export async function validateGateRegistry(registry, options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const discovered =
    options.discovered ??
    (await discoverWorkflowGates(path.join(root, ".github", "workflows")));
  const violations = [];
  if (registry.version !== 1 || !Array.isArray(registry.gates)) {
    return ["registry:requires_version_1_gates_array"];
  }
  const ids = new Set();
  const registeredPipelines = new Set();
  for (const gate of registry.gates) {
    await validateGatePolicy(gate, root, ids, registeredPipelines, violations);
  }
  validateLocalPreflight(registry.local_preflight, ids, violations);
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

/** Print discovered inventory or enforce the committed registry. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const discovered = await discoverWorkflowGates(
    path.join(repoRoot, ".github", "workflows"),
  );
  if (flags.has("inventory")) {
    return { discovered };
  }
  const registryFlag = flags.get("registry");
  const registryPath =
    registryFlag === undefined || registryFlag === true
      ? DEFAULT_REGISTRY_PATH
      : path.resolve(String(registryFlag));
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const violations = await validateGateRegistry(registry, { discovered });
  if (violations.length > 0) {
    throw new Error(
      `Gate registry validation failed:\n${violations.join("\n")}`,
    );
  }
  return {
    ok: true,
    registered_gate_count: registry.gates.length,
    enforced_pipeline_count: discovered.length,
    claim_count: registry.claims?.length ?? 0,
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
