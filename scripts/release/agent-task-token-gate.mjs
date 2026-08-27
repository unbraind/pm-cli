#!/usr/bin/env node
/**
 * Replays versioned multi-step agent tasks against real CLI transports and
 * ratchets output cost, envelope conformance, and executable recovery.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PmClient,
  isPmMutationReceipt,
  parsePmAgentTaskTranscriptCorpus,
  resolvePmCommandOutputEnvelope,
} from "../../dist/cli-bundle/sdk.js";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const BASELINE_PATH = path.join(
  repoRoot,
  "docs",
  "agent-task-token-baseline.json",
);
const TRANSCRIPT_PATH = path.join(
  repoRoot,
  "docs",
  "agent-task-transcripts.json",
);
const CLI_PATH = path.join(repoRoot, "dist", "cli.js");
const BASELINE_VERSION = 2;

function fixtureId(key) {
  return `pm-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function parseJsonOutput(result, step, label = step.id) {
  const source =
    step.expected_output_kind === "refusal" ? result.stderr : result.stdout;
  try {
    return JSON.parse(source);
  } catch {
    fail(`Agent-task transcript step ${label} did not emit one JSON document`);
  }
}

function runCli(pmRoot, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: path.dirname(path.dirname(pmRoot)),
    encoding: "utf8",
    env: {
      ...process.env,
      PM_PATH: pmRoot,
      PM_GLOBAL_PATH: path.join(path.dirname(pmRoot), ".pm-global"),
      PM_TELEMETRY: "0",
    },
  });
}

function readReceipt(payload, stepId) {
  const receipt = payload?.token_accounting;
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    Array.isArray(receipt)
  ) {
    fail(`Agent-task transcript step ${stepId} omitted token_accounting`);
  }
  return receipt;
}

function assertComplete(payload, requiredFields, stepId) {
  for (const requiredField of requiredFields) {
    let cursor = payload;
    const present = requiredField.split(".").every((segment) => {
      if (
        typeof cursor !== "object" ||
        cursor === null ||
        !Object.hasOwn(cursor, segment)
      ) {
        return false;
      }
      cursor = cursor[segment];
      return true;
    });
    if (!present) {
      fail(
        `Agent-task transcript step ${stepId} omitted required consumed field path ${requiredField}`,
      );
    }
  }
}

function validateRefusalOutput(payload, step) {
  if (payload?.code !== step.expected_error_code) {
    fail(
      `Agent-task transcript step ${step.id} error code mismatch: ${String(payload?.code)} != ${step.expected_error_code}`,
    );
  }
  if (payload?.refusal?.surface !== step.expected_refusal_surface) {
    fail(
      `Agent-task transcript step ${step.id} refusal surface mismatch: ${String(payload?.refusal?.surface)} != ${step.expected_refusal_surface}`,
    );
  }
}

function validateSuccessfulOutput(payload, step) {
  const contract = resolvePmCommandOutputEnvelope(step.args[0]);
  if (contract.kind !== step.expected_output_kind) {
    fail(
      `Agent-task transcript step ${step.id} output contract drift: ${contract.kind} != ${step.expected_output_kind}`,
    );
  }
  if (contract.kind === "mutation_receipt" && !isPmMutationReceipt(payload)) {
    fail(
      `Agent-task transcript step ${step.id} did not emit a mutation receipt`,
    );
  }
  if (
    contract.wrapper_key !== null &&
    (typeof payload !== "object" ||
      payload === null ||
      !(contract.wrapper_key in payload))
  ) {
    fail(
      `Agent-task transcript step ${step.id} omitted ${contract.wrapper_key} envelope`,
    );
  }
}

function validateExpectedOutput(payload, step) {
  if (step.expected_output_kind === "refusal") {
    validateRefusalOutput(payload, step);
  } else {
    validateSuccessfulOutput(payload, step);
  }
}

/** Validate and summarize one pair of independently captured CLI transports. */
export function validateAgentTaskTokenInvocation(baseline, accounted, step) {
  if (
    baseline.status !== step.expected_exit_code ||
    accounted.status !== step.expected_exit_code
  ) {
    fail(
      `Agent-task transcript step ${step.id} exit mismatch: baseline=${baseline.status}, accounted=${accounted.status}, expected=${step.expected_exit_code}`,
    );
  }
  const baselinePayload = parseJsonOutput(
    baseline,
    step,
    `${step.id}:accounting-off`,
  );
  if (baselinePayload.token_accounting !== undefined) {
    fail(
      `Agent-task transcript step ${step.id} paid accounting cost while accounting was disabled`,
    );
  }
  const accountedPayload = parseJsonOutput(accounted, step);
  if (
    step.expected_output_kind === "refusal" &&
    (typeof accountedPayload?.token_accounting !== "object" ||
      accountedPayload.token_accounting === null ||
      Array.isArray(accountedPayload.token_accounting))
  ) {
    const emittedBytes = Buffer.byteLength(accounted.stderr, "utf8");
    assertComplete(accountedPayload, step.required_fields, step.id);
    validateExpectedOutput(accountedPayload, step);
    return {
      id: step.id,
      command: step.args.join(" "),
      exit_code: accounted.status,
      output_kind: step.expected_output_kind,
      emitted_bytes: emittedBytes,
      estimated_tokens: Math.ceil(emittedBytes / 4),
      accounting_receipt_bytes: 0,
      sections: { diagnostics: { bytes: emittedBytes } },
      accounting_mode: "independent_transport",
      completeness: "required_fields_present",
      payload: accountedPayload,
    };
  }
  const receipt = readReceipt(accountedPayload, step.id);
  const {
    token_accounting: _excludedReceipt,
    ...independentlyProjectedPayload
  } = accountedPayload;
  const baselineBytes = Buffer.byteLength(
    `${JSON.stringify(independentlyProjectedPayload, null, 2)}\n`,
    "utf8",
  );
  if (receipt.total_bytes !== baselineBytes) {
    fail(
      `Agent-task transcript step ${step.id} accounting drift: reported=${receipt.total_bytes}, independent=${baselineBytes}`,
    );
  }
  const expectedEstimatedTokens = Math.ceil(baselineBytes / 4);
  if (receipt.total_estimated_tokens !== expectedEstimatedTokens) {
    fail(
      `Agent-task transcript step ${step.id} token estimate drift: reported=${String(receipt.total_estimated_tokens)}, expected=${expectedEstimatedTokens}`,
    );
  }
  const sectionBytes = Object.values(receipt.sections ?? {}).reduce(
    (total, section) =>
      total + (Number.isFinite(section?.bytes) ? section.bytes : 0),
    0,
  );
  if (sectionBytes !== baselineBytes) {
    fail(
      `Agent-task transcript step ${step.id} section attribution does not sum to emitted bytes`,
    );
  }
  if (
    !Number.isFinite(receipt.accounting_receipt_bytes) ||
    receipt.accounting_receipt_bytes >= 1_024
  ) {
    fail(
      `Agent-task transcript step ${step.id} accounting receipt exceeded its 1024-byte bound`,
    );
  }
  assertComplete(accountedPayload, step.required_fields, step.id);
  validateExpectedOutput(independentlyProjectedPayload, step);
  return {
    id: step.id,
    command: step.args.join(" "),
    exit_code: accounted.status,
    output_kind: step.expected_output_kind,
    emitted_bytes: receipt.total_bytes,
    estimated_tokens: receipt.total_estimated_tokens,
    accounting_receipt_bytes: receipt.accounting_receipt_bytes,
    sections: receipt.sections,
    accounting_mode: "self_reported",
    completeness: "required_fields_present",
    payload: independentlyProjectedPayload,
  };
}

/** Require a recovery step to replay the exact shell-free refusal arguments. */
export function assertAdvertisedAgentTaskRecovery(refusal, step) {
  const advertisedArgs = refusal?.recovery?.suggested_retry_args;
  if (
    !Array.isArray(advertisedArgs) ||
    JSON.stringify(advertisedArgs) !== JSON.stringify(step.args)
  ) {
    fail(
      `Agent-task transcript step ${step.id} did not execute the shell-free recovery advertised by ${step.recovery_for}`,
    );
  }
}

function measureTask(baselineRoot, accountedRoot, task) {
  const measuredSteps = [];
  const payloads = new Map();
  for (const step of task.steps) {
    const measured = validateAgentTaskTokenInvocation(
      runCli(baselineRoot, ["--json", ...step.args]),
      runCli(accountedRoot, ["--json", "--token-accounting", ...step.args]),
      step,
    );
    if (step.recovery_for !== undefined) {
      assertAdvertisedAgentTaskRecovery(payloads.get(step.recovery_for), step);
    }
    payloads.set(step.id, measured.payload);
    const { payload: _payload, ...stepReport } = measured;
    measuredSteps.push(stepReport);
  }
  return {
    id: task.id,
    description: task.description,
    completed: true,
    step_count: measuredSteps.length,
    retry_count: task.steps.filter((step) => step.recovery_for !== undefined)
      .length,
    emitted_bytes: measuredSteps.reduce(
      (total, step) => total + step.emitted_bytes,
      0,
    ),
    estimated_tokens: measuredSteps.reduce(
      (total, step) => total + step.estimated_tokens,
      0,
    ),
    steps: measuredSteps,
  };
}

async function seedWorkspace(workspaceRoot) {
  const pmRoot = path.join(workspaceRoot, ".agents", "pm");
  const client = new PmClient({
    pmRoot,
    cwd: workspaceRoot,
    author: "agent-task-token-gate",
    noExtensions: true,
  });
  await client.init(undefined, { defaults: true });
  const anchorId = fixtureId("agent-task-token-anchor");
  await client.create({
    id: anchorId,
    title: "Token accounting anchor",
    description:
      "Required context for the returning-agent completeness assertion.",
    type: "Task",
    status: "open",
    priority: 1,
  });
  for (let index = 0; index < 100; index += 1) {
    const suffix = String(index).padStart(3, "0");
    await client.create({
      id: fixtureId(`agent-task-token-scale-${suffix}`),
      title: `Scaled context row ${suffix}`,
      description: "Deterministic scaled-workspace context fixture.",
      type: "Task",
      status: "open",
      priority: (index % 4) + 1,
    });
  }
  return { pmRoot, anchorId };
}

function listTaskTokenBaselineFailures(task, taskLimit) {
  const failures = [];
  if (!Number.isFinite(taskLimit.max_estimated_tokens)) {
    failures.push(`task:${task.id}:missing_baseline_limit`);
  } else if (task.estimated_tokens > taskLimit.max_estimated_tokens) {
    failures.push(
      `task:${task.id}:${task.estimated_tokens}>baseline:${taskLimit.max_estimated_tokens}`,
    );
  }
  const stepLimits = new Map(
    (taskLimit.steps ?? []).map((step) => [step.id, step.max_estimated_tokens]),
  );
  for (const step of task.steps) {
    const limit = stepLimits.get(step.id);
    if (!Number.isFinite(limit))
      failures.push(`task:${task.id}:step:${step.id}:missing_baseline`);
    else if (step.estimated_tokens > limit) {
      failures.push(
        `task:${task.id}:step:${step.id}:${step.estimated_tokens}>baseline:${limit}`,
      );
    }
  }
  if (stepLimits.size !== task.steps.length) {
    failures.push(
      `task:${task.id}:step_count:${task.steps.length}!=${stepLimits.size}`,
    );
  }
  return failures;
}

/** Return task and step regressions against the published transcript baseline. */
export function compareAgentTaskTokenBaseline(report, baseline) {
  const failures = [];
  if (baseline.version !== BASELINE_VERSION)
    failures.push(`baseline_version:${baseline.version}`);
  if (baseline.transcript_digest !== report.transcript_digest)
    failures.push("transcript_digest:mismatch");
  const taskLimits = new Map(
    (baseline.tasks ?? []).map((task) => [task.id, task]),
  );
  for (const task of report.tasks) {
    const taskLimit = taskLimits.get(task.id);
    if (!taskLimit) {
      failures.push(`task:${task.id}:missing_baseline`);
      continue;
    }
    failures.push(...listTaskTokenBaselineFailures(task, taskLimit));
  }
  if (taskLimits.size !== report.tasks.length)
    failures.push(`task_count:${report.tasks.length}!=${taskLimits.size}`);
  if (!Number.isFinite(baseline.composite_max_estimated_tokens)) {
    failures.push("composite:missing_baseline_limit");
  } else if (
    report.composite_estimated_tokens > baseline.composite_max_estimated_tokens
  ) {
    failures.push(
      `composite:${report.composite_estimated_tokens}>baseline:${baseline.composite_max_estimated_tokens}`,
    );
  }
  return failures;
}

/** Resolve the default or explicitly overridden published baseline path. */
export function resolveAgentTaskTokenBaselinePath(baselineFlag) {
  return baselineFlag === undefined || baselineFlag === true
    ? BASELINE_PATH
    : path.resolve(String(baselineFlag));
}

function buildBaseline(report) {
  return {
    version: BASELINE_VERSION,
    transcript_version: report.transcript_version,
    transcript_digest: report.transcript_digest,
    estimator: "ceil(utf8_bytes / 4)",
    measurement_scope: "output_before_token_accounting",
    published_with_release: true,
    tasks: report.tasks.map((task) => ({
      id: task.id,
      max_estimated_tokens: task.estimated_tokens,
      steps: task.steps.map((step) => ({
        id: step.id,
        max_estimated_tokens: step.estimated_tokens,
      })),
    })),
    composite_max_estimated_tokens: report.composite_estimated_tokens,
  };
}

/** Evaluate a measured report, including the executable seeded regression. */
export function evaluateAgentTaskTokenReport(
  report,
  baseline,
  negativeControl = false,
) {
  const evaluatedReport = negativeControl
    ? {
        ...report,
        tasks: report.tasks.map((task, index) =>
          index === 0
            ? { ...task, estimated_tokens: task.estimated_tokens + 1_000_000 }
            : task,
        ),
      }
    : report;
  const failures = compareAgentTaskTokenBaseline(evaluatedReport, baseline);
  if (negativeControl) {
    if (failures.length === 0)
      fail("Agent-task token negative control escaped detection");
    return {
      ok: true,
      negative_control: "seeded_completed_task_token_regression",
      failures,
    };
  }
  if (failures.length > 0)
    fail(`Agent-task token gate failed: ${failures.join(", ")}`);
  return report;
}

/** Persist or evaluate a measured report according to release-gate flags. */
export function finalizeAgentTaskTokenReport(report, flags, baselinePath) {
  if (flags.has("update")) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify(buildBaseline(report), null, 2)}\n`,
    );
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const evaluated = evaluateAgentTaskTokenReport(
      report,
      baseline,
      flags.has("negative-control"),
    );
    if (flags.has("negative-control")) return evaluated;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** Require independently seeded transcript workspaces to share fixture ids. */
export function assertMatchingAgentTaskFixtureAnchors(
  baselineFixture,
  accountedFixture,
) {
  if (baselineFixture.anchorId !== accountedFixture.anchorId) {
    fail("Agent-task transcript fixtures produced different anchor ids");
  }
}

/** Run, refresh, or negatively control the real-transport transcript gate. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const baselinePath = resolveAgentTaskTokenBaselinePath(flags.get("baseline"));
  const transcriptSource = readFileSync(TRANSCRIPT_PATH, "utf8");
  const corpus = parsePmAgentTaskTranscriptCorpus(JSON.parse(transcriptSource));
  const baselineWorkspace = mkdtempSync(
    path.join(tmpdir(), "pm-agent-task-baseline-"),
  );
  const accountedWorkspace = mkdtempSync(
    path.join(tmpdir(), "pm-agent-task-accounted-"),
  );
  try {
    const baselineFixture = await seedWorkspace(baselineWorkspace);
    const accountedFixture = await seedWorkspace(accountedWorkspace);
    assertMatchingAgentTaskFixtureAnchors(baselineFixture, accountedFixture);
    const replacements = new Map([
      ["$ANCHOR_ID", baselineFixture.anchorId],
      ["$LIFECYCLE_ID", fixtureId("agent-task-transcript-lifecycle")],
      ["$BULK_ID", fixtureId("agent-task-transcript-bulk-effects")],
    ]);
    const tasks = corpus.tasks.map((task) => ({
      ...task,
      steps: task.steps.map((step) => ({
        ...step,
        args: step.args.map((argument) =>
          [...replacements].reduce(
            (expanded, [token, replacement]) =>
              expanded.replaceAll(token, replacement),
            argument,
          ),
        ),
      })),
    }));
    const measured = tasks.map((task) =>
      measureTask(baselineFixture.pmRoot, accountedFixture.pmRoot, task),
    );
    const report = {
      version: BASELINE_VERSION,
      transcript_version: corpus.version,
      transcript_digest: `sha256:${createHash("sha256").update(transcriptSource).digest("hex")}`,
      estimator: "ceil(utf8_bytes / 4)",
      task_count: measured.length,
      completed_task_count: measured.filter((task) => task.completed).length,
      step_count: measured.reduce((total, task) => total + task.step_count, 0),
      retry_count: measured.reduce(
        (total, task) => total + task.retry_count,
        0,
      ),
      composite_estimated_tokens: measured.reduce(
        (total, task) => total + task.estimated_tokens,
        0,
      ),
      tasks: measured,
    };
    return finalizeAgentTaskTokenReport(report, flags, baselinePath);
  } finally {
    rmSync(baselineWorkspace, { recursive: true, force: true });
    rmSync(accountedWorkspace, { recursive: true, force: true });
  }
}

/* c8 ignore start -- unit tests call main directly. */
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
/* c8 ignore stop */
