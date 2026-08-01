#!/usr/bin/env node
/**
 * Measures real CLI bytes per completed representative agent task and verifies
 * the self-reported accounting receipt against an independent transport count.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PmClient } from "../../dist/cli-bundle/sdk.js";
import { fail, parseFlags, repoRoot } from "./utils.mjs";

const BASELINE_PATH = path.join(
  repoRoot,
  "docs",
  "agent-task-token-baseline.json",
);
const CLI_PATH = path.join(repoRoot, "dist", "cli.js");
const BASELINE_VERSION = 1;

function fixtureId(key) {
  return `pm-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function parseJsonOutput(result, scenarioId) {
  const source = result.status === 0 ? result.stdout : result.stderr;
  try {
    return JSON.parse(source);
  } catch {
    fail(
      `Agent-task token scenario ${scenarioId} did not emit one JSON document`,
    );
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

function readReceipt(payload, scenarioId) {
  const receipt = payload?.token_accounting;
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    Array.isArray(receipt)
  ) {
    fail(`Agent-task token scenario ${scenarioId} omitted token_accounting`);
  }
  return receipt;
}

function assertComplete(payload, requiredFields, scenarioId) {
  const serialized = JSON.stringify(payload);
  for (const requiredField of requiredFields) {
    if (!serialized.includes(requiredField)) {
      fail(
        `Agent-task token scenario ${scenarioId} omitted required consumed field ${requiredField}`,
      );
    }
  }
}

/** Validate and summarize one pair of independently captured CLI transports. */
export function validateAgentTaskTokenInvocation(
  baseline,
  accounted,
  scenario,
) {
  if (
    baseline.status !== scenario.expectedStatus ||
    accounted.status !== scenario.expectedStatus
  ) {
    fail(
      `Agent-task token scenario ${scenario.id} exit mismatch: baseline=${baseline.status}, accounted=${accounted.status}, expected=${scenario.expectedStatus}`,
    );
  }
  const baselinePayload = parseJsonOutput(
    baseline,
    `${scenario.id}:accounting-off`,
  );
  if (baselinePayload.token_accounting !== undefined) {
    fail(
      `Agent-task token scenario ${scenario.id} paid accounting cost while accounting was disabled`,
    );
  }
  const accountedPayload = parseJsonOutput(accounted, scenario.id);
  const receipt = readReceipt(accountedPayload, scenario.id);
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
      `Agent-task token scenario ${scenario.id} accounting drift: reported=${receipt.total_bytes}, independent=${baselineBytes}`,
    );
  }
  const sectionBytes = Object.values(receipt.sections ?? {}).reduce(
    (total, section) =>
      total + (Number.isFinite(section?.bytes) ? section.bytes : 0),
    0,
  );
  if (sectionBytes !== baselineBytes) {
    fail(
      `Agent-task token scenario ${scenario.id} section attribution does not sum to emitted bytes`,
    );
  }
  if (
    !Number.isFinite(receipt.accounting_receipt_bytes) ||
    receipt.accounting_receipt_bytes >= 1_024
  ) {
    fail(
      `Agent-task token scenario ${scenario.id} accounting receipt exceeded its 1024-byte bound`,
    );
  }
  assertComplete(accountedPayload, scenario.requiredFields, scenario.id);
  return {
    id: scenario.id,
    command: scenario.args.join(" "),
    exit_code: accounted.status,
    emitted_bytes: receipt.total_bytes,
    estimated_tokens: receipt.total_estimated_tokens,
    accounting_receipt_bytes: receipt.accounting_receipt_bytes,
    sections: receipt.sections,
    completeness: "required_fields_present",
  };
}

function measureInvocation(pmRoot, scenario) {
  const baseArgs = [...scenario.args, "--json"];
  return validateAgentTaskTokenInvocation(
    runCli(pmRoot, baseArgs),
    runCli(pmRoot, [...baseArgs, "--token-accounting"]),
    scenario,
  );
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

/** Return token regressions against the externally published release baseline. */
export function compareAgentTaskTokenBaseline(report, baseline) {
  const failures = [];
  if (baseline.version !== BASELINE_VERSION)
    failures.push(`baseline_version:${baseline.version}`);
  const limits = new Map(
    (baseline.scenarios ?? []).map((scenario) => [
      scenario.id,
      scenario.max_estimated_tokens,
    ]),
  );
  for (const scenario of report.scenarios) {
    const limit = limits.get(scenario.id);
    if (!Number.isFinite(limit))
      failures.push(`scenario:${scenario.id}:missing_baseline`);
    else if (scenario.estimated_tokens > limit) {
      failures.push(
        `scenario:${scenario.id}:${scenario.estimated_tokens}>baseline:${limit}`,
      );
    }
  }
  if (limits.size !== report.scenarios.length)
    failures.push(`scenario_count:${report.scenarios.length}!=${limits.size}`);
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
    estimator: "ceil(utf8_bytes / 4)",
    measurement_scope: "output_before_token_accounting",
    published_with_release: true,
    scenarios: report.scenarios.map((scenario) => ({
      id: scenario.id,
      max_estimated_tokens: scenario.estimated_tokens,
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
        scenarios: report.scenarios.map((scenario, index) =>
          index === 0
            ? {
                ...scenario,
                estimated_tokens: scenario.estimated_tokens + 1_000_000,
              }
            : scenario,
        ),
      }
    : report;
  const failures = compareAgentTaskTokenBaseline(evaluatedReport, baseline);
  if (negativeControl) {
    if (failures.length === 0)
      fail("Agent-task token negative control escaped detection");
    return {
      ok: true,
      negative_control: "seeded_per_task_token_regression",
      failures,
    };
  }
  if (failures.length > 0)
    fail(`Agent-task token gate failed: ${failures.join(", ")}`);
  return report;
}

/** Persist or evaluate a measured report according to parsed release-gate flags. */
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

/** Run, refresh, or negatively control the real-transport agent-task token gate. */
export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseFlags(argv);
  const baselinePath = resolveAgentTaskTokenBaselinePath(flags.get("baseline"));
  const workspaceRoot = mkdtempSync(
    path.join(tmpdir(), "pm-agent-task-token-"),
  );
  try {
    const { pmRoot, anchorId } = await seedWorkspace(workspaceRoot);
    const scenarios = [
      {
        id: "small-workspace",
        args: ["list", "--for", "triage", "--limit", "2"],
        expectedStatus: 0,
        requiredFields: ["items"],
      },
      {
        id: "large-workspace",
        args: ["context", "--for", "orient", "--limit", "5"],
        expectedStatus: 0,
        requiredFields: ["items"],
      },
      {
        id: "returning-agent",
        args: ["get", anchorId, "--for", "inspect"],
        expectedStatus: 0,
        requiredFields: [anchorId],
      },
      {
        id: "failing-command",
        args: ["get", "pm-does-not-exist"],
        expectedStatus: 3,
        requiredFields: ["code", "recovery"],
      },
    ];
    const measured = scenarios.map((scenario) =>
      measureInvocation(pmRoot, scenario),
    );
    const report = {
      version: BASELINE_VERSION,
      estimator: "ceil(utf8_bytes / 4)",
      scenario_count: measured.length,
      composite_estimated_tokens: measured.reduce(
        (total, scenario) => total + scenario.estimated_tokens,
        0,
      ),
      scenarios: measured,
    };
    return finalizeAgentTaskTokenReport(report, flags, baselinePath);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
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
