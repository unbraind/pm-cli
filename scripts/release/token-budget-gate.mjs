#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, repoRoot, runCommand } from "./utils.mjs";
import { cleanupTempRoot } from "../smoke-cleanup.mjs";
import { BUILTIN_HARNESS_SIGNAL_DESCRIPTORS } from "../../dist/cli-bundle/sdk-core.js";

const MANIFEST_VERSION = 3;
const SCALE_FIXTURE_ITEMS = 24;
const COMMENT_FIXTURE_ROWS = 32;
const NOTE_FIXTURE_ROWS = 16;
const DEFAULT_MANIFEST_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "token-budgets.json",
);

/** Every host-owned identity input the deterministic gate must neutralize. */
export const HARNESS_SIGNAL_ENVIRONMENT_KEYS = Object.freeze(
  [
    ...new Set([
      "AI_AGENT",
      "PM_AUTHOR",
      "PM_AGENT_MODEL",
      "PM_AGENT_EFFORT",
      "PM_AGENT_ROLE",
      ...BUILTIN_HARNESS_SIGNAL_DESCRIPTORS.flatMap((descriptor) =>
        [
          descriptor.environment_keys,
          descriptor.model_environment_keys,
          descriptor.session_environment_keys,
          ...Object.values(descriptor.provenance_environment_keys ?? {}),
        ].flatMap((keys) => keys ?? []),
      ),
    ]),
  ].sort((left, right) => left.localeCompare(right)),
);

/** Host variables explicitly required for portable child-process execution. */
export const TOKEN_BUDGET_FIXTURE_ENVIRONMENT_KEYS = Object.freeze([
  "ComSpec",
  "COMSPEC",
  "HOME",
  "Path",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

const OBSERVED_EXCERPT_LIMIT = 1400;

function distCliPath() {
  return path.join(repoRoot, "dist", "cli.js");
}

/** Build a closed fixture environment from declared portability inputs and deterministic overrides. */
export function buildTokenBudgetFixtureEnvironment(
  hostEnvironment,
  overrides,
) {
  const environment = {};
  for (const key of TOKEN_BUDGET_FIXTURE_ENVIRONMENT_KEYS) {
    if (hostEnvironment[key] !== undefined) {
      environment[key] = hostEnvironment[key];
    }
  }
  return {
    ...environment,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ...overrides,
  };
}

function runCli(cliPath, args, options, allowFailure = false) {
  const env = buildTokenBudgetFixtureEnvironment(process.env, {
    PM_AUTHOR: "token-budget-gate",
    PM_PATH: options.pmPath,
    PM_GLOBAL_PATH: options.globalPath,
    PM_NO_TELEMETRY: "1",
    PM_TELEMETRY_DISABLED: "1",
    PM_TELEMETRY_OTEL_DISABLED: "1",
    PM_TELEMETRY_PROMPT: "0",
  });
  return runCommand(process.execPath, [cliPath, ...args], {
    cwd: options.workspaceRoot,
    env,
    inheritEnvironment: false,
    capture: true,
    allowFailure,
  });
}

function parseCliJson(stdout, args) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    /* c8 ignore next -- JSON.parse throws SyntaxError (an Error); the fallback is defensive only */
    const message = error instanceof Error ? error.message : String(error);
    fail(
      `Token budget fixture command did not return JSON: ${args.join(" ")}\n${message}`,
    );
  }
}

function runCliJson(cliPath, args, options) {
  return parseCliJson(runCli(cliPath, args, options).stdout, args);
}

export function mutationId(result, label) {
  const id = result?.id ?? result?.item?.id;
  if (typeof id !== "string" || id.length === 0) {
    fail(`Token budget fixture ${label} mutation did not return an item id`);
  }
  return id;
}

function seedFixture(cliPath, options) {
  runCli(cliPath, ["init", "--defaults", "--json"], options);
  runCli(cliPath, ["install", "audit", "--project", "--json"], options);
  const parent = runCliJson(
    cliPath,
    [
      "create",
      "--id",
      "pm-tbp0",
      "--title",
      "Alpha planning context",
      "--description",
      "Parent item for deterministic token budget checks",
      "--type",
      "Feature",
      "--status",
      "open",
      "--tags",
      "context",
      "--json",
    ],
    options,
  );
  const parentId = mutationId(parent, "parent");
  const blocker = runCliJson(
    cliPath,
    [
      "create",
      "--id",
      "pm-tbb0",
      "--title",
      "Beta blocker",
      "--description",
      "Dependency fixture for context graph output",
      "--type",
      "Task",
      "--status",
      "open",
      "--json",
    ],
    options,
  );
  const child = runCliJson(
    cliPath,
    [
      "create",
      "--id",
      "pm-tbc0",
      "--title",
      "Alpha implementation task",
      "--description",
      "Child item with links for compact default output",
      "--type",
      "Task",
      "--status",
      "in_progress",
      "--parent",
      parentId,
      "--blocked-by",
      mutationId(blocker, "blocker"),
      "--tags",
      "agent",
      "--json",
    ],
    options,
  );
  const childId = mutationId(child, "child");
  for (let index = 0; index < COMMENT_FIXTURE_ROWS; index += 1) {
    runCli(
      cliPath,
      [
        "comments",
        childId,
        `Evidence fixture comment ${index + 1}: ${"governance context ".repeat(12)}`,
        "--json",
      ],
      options,
    );
  }
  for (let index = 0; index < NOTE_FIXTURE_ROWS; index += 1) {
    runCli(
      cliPath,
      [
        "notes",
        childId,
        `Merge-safe context note ${index + 1}: ${"decision evidence ".repeat(12)}`,
        "--json",
      ],
      options,
    );
  }
  for (let index = 0; index < SCALE_FIXTURE_ITEMS; index += 1) {
    runCliJson(
      cliPath,
      [
        "create",
        "--id",
        `pm-tb${String(index + 1).padStart(2, "0")}`,
        "--title",
        `Scale fixture ${String(index + 1).padStart(2, "0")} shared planning context`,
        "--description",
        `Representative medium-workspace activity payload ${"context ".repeat(48)}${index}`,
        "--type",
        index % 3 === 0 ? "Issue" : "Task",
        "--status",
        index % 4 === 0 ? "draft" : "open",
        "--parent",
        parentId,
        "--blocked-by",
        mutationId(blocker, "blocker"),
        "--tags",
        "token-budget,representative-scale",
        "--json",
      ],
      options,
    );
  }
  runCli(
    cliPath,
    ["assurance", "apply", "operations", "--owner", parentId, "--json"],
    options,
  );
  return {
    parentId,
    blockerId: mutationId(blocker, "blocker"),
    childId,
  };
}

function commandCorpus(ids) {
  return [
    {
      id: "root-help",
      kind: "discovery",
      scale_tier: "static",
      args: ["--help"],
    },
    {
      id: "search-help",
      kind: "discovery",
      scale_tier: "static",
      args: ["search", "--help"],
    },
    {
      id: "create-help",
      kind: "discovery",
      scale_tier: "static",
      args: ["create", "--help"],
    },
    {
      id: "update-help",
      kind: "discovery",
      scale_tier: "static",
      args: ["update", "--help"],
    },
    {
      id: "contracts-summary-json",
      kind: "discovery",
      scale_tier: "static",
      args: ["contracts", "--summary", "--json"],
    },
    {
      id: "contracts-flags-json",
      kind: "discovery",
      scale_tier: "static",
      args: ["contracts", "--flags-only", "--json"],
    },
    {
      id: "list-default",
      kind: "answer",
      command: "list",
      scale_tier: "medium",
      args: ["list"],
    },
    {
      id: "list-open-default",
      kind: "answer",
      command: "list",
      scale_tier: "medium",
      args: ["list-open"],
    },
    {
      id: "list-json",
      kind: "answer",
      command: "list",
      scale_tier: "medium",
      args: ["list", "--json"],
    },
    {
      id: "comments-audit-full-history",
      kind: "answer",
      command: "comments-audit",
      scale_tier: "depth-heavy",
      args: ["comments-audit", "--full-history", "--json"],
    },
    {
      id: "notes-depth-heavy",
      kind: "answer",
      command: "notes",
      scale_tier: "depth-heavy",
      args: ["notes", ids.childId, "--json"],
    },
    {
      id: "assurance-run-depth-heavy",
      kind: "answer",
      command: "assurance",
      scale_tier: "depth-heavy",
      allow_failure: true,
      expected_exit_statuses: [0, 1],
      args: [
        "assurance",
        "run",
        "preset-operations-readiness",
        "--trigger",
        "ci",
        "--dry-run",
        "--json",
      ],
    },
    {
      id: "get-default",
      kind: "answer",
      command: "get",
      scale_tier: "linked",
      args: ["get", ids.childId],
    },
    {
      id: "get-json-compact-fields",
      kind: "answer",
      command: "get",
      scale_tier: "linked",
      args: [
        "get",
        ids.childId,
        "--json",
        "--fields",
        "id,title,status,type,priority,tags,dependencies",
      ],
    },
    {
      id: "context-default",
      kind: "answer",
      command: "context",
      scale_tier: "medium",
      args: ["context"],
    },
    {
      id: "next-default",
      kind: "answer",
      command: "next",
      scale_tier: "medium",
      args: ["next"],
    },
    {
      id: "activity-default",
      kind: "answer",
      command: "activity",
      scale_tier: "medium",
      args: ["activity"],
    },
    {
      id: "stats-default",
      kind: "answer",
      command: "stats",
      scale_tier: "medium",
      max_lines: 22,
      args: ["stats"],
    },
    {
      id: "deps-tree-default",
      kind: "answer",
      command: "deps",
      scale_tier: "linked",
      args: ["deps", ids.parentId],
    },
    {
      id: "deps-tree-json",
      kind: "answer",
      command: "deps",
      scale_tier: "linked",
      args: ["deps", ids.parentId, "--json"],
    },
    {
      id: "graph-audit-summary",
      kind: "answer",
      command: "graph",
      scale_tier: "medium",
      args: ["graph", "audit", "--summary", "--json"],
    },
    {
      id: "duplicates-default",
      kind: "answer",
      command: "duplicates",
      scale_tier: "medium",
      args: ["duplicates", "--limit", "20", "--json"],
    },
    {
      id: "events-default",
      kind: "answer",
      command: "events",
      scale_tier: "medium",
      args: ["events", "--limit", "20"],
    },
    {
      id: "health-default",
      kind: "answer",
      command: "health",
      scale_tier: "medium",
      args: ["health", "--check-only"],
    },
    {
      id: "validate-counts",
      kind: "answer",
      command: "validate",
      scale_tier: "medium",
      args: ["validate", "--counts"],
    },
    {
      id: "search-inline-default",
      kind: "answer",
      command: "search",
      scale_tier: "medium",
      args: ["search", "status:all Alpha"],
    },
    {
      id: "search-inline-json",
      kind: "answer",
      command: "search",
      scale_tier: "medium",
      args: ["search", "status:all Alpha", "--json"],
    },
    {
      id: "context-intent-orient",
      kind: "answer",
      command: "context",
      intent: true,
      scale_tier: "medium",
      args: ["context", "--for", "orient", "--json"],
    },
    {
      id: "get-intent-inspect",
      kind: "answer",
      command: "get",
      intent: true,
      scale_tier: "linked",
      args: ["get", ids.childId, "--for", "inspect", "--json"],
    },
    {
      id: "list-intent-triage",
      kind: "answer",
      command: "list",
      intent: true,
      scale_tier: "medium",
      args: ["list", "--for", "triage", "--json"],
    },
    {
      id: "next-intent-execute",
      kind: "answer",
      command: "next",
      intent: true,
      scale_tier: "medium",
      args: ["next", "--for", "execute", "--json"],
    },
    {
      id: "search-intent-discover",
      kind: "answer",
      command: "search",
      intent: true,
      scale_tier: "medium",
      args: ["search", "Alpha", "--for", "discover", "--json"],
    },
  ];
}

export function measureOutput(stdout) {
  const bytes = Buffer.byteLength(stdout, "utf8");
  return {
    bytes,
    estimated_tokens: Math.ceil(bytes / 4),
    lines: stdout.length === 0 ? 0 : stdout.trimEnd().split(/\r?\n/u).length,
  };
}

/**
 * Resolve the SDK-owned estimate that a JSON answer receipt proves, falling
 * back to rendered transport bytes for unchanged or non-JSON results.
 *
 * Pretty-print whitespace is governed by the independent byte ratchet. It is
 * not useful-result data and must not make a truthful `within_budget` receipt
 * fail the command contract that produced it.
 */
export function readOutputContractEstimate(stdout, format, fallback) {
  if (format !== "json") return fallback;
  try {
    const parsed = JSON.parse(stdout);
    const estimate = parsed?.read_output?.estimated_tokens;
    return Number.isFinite(estimate) && estimate >= 0 ? estimate : fallback;
  } catch {
    return fallback;
  }
}

function resolveDeclaredBudget(cliPath, command, format, options) {
  const result = runCliJson(
    cliPath,
    [
      "contracts",
      "--command",
      command,
      "--summary",
      "--json",
      "--output-budget",
      "unbounded",
    ],
    options,
  );
  const budget =
    result?.command_summaries?.[0]?.default_max_estimated_tokens_by_format?.[
      format
    ] ?? result?.command_summaries?.[0]?.default_max_estimated_tokens;
  if (!Number.isFinite(budget) || budget <= 0) {
    fail(`Token budget contract missing for answer command: ${command}`);
  }
  return budget;
}

function validateToleratedCommandResult(entry, result) {
  if (!entry.expected_exit_statuses.includes(result.status)) {
    fail(
      `Token budget fixture command returned unexpected exit status ${result.status}; expected ${entry.expected_exit_statuses.join(" or ")}: ${entry.args.join(" ")}\n${result.stderr.trim()}`,
    );
  }
  const report = parseCliJson(result.stdout, entry.args);
  if (
    typeof report !== "object" ||
    report === null ||
    report.gate_id !== entry.args[2] ||
    report.trigger !== "ci" ||
    report.dry_run !== true ||
    report.exit_code !== result.status ||
    !["pass", "warn", "fail"].includes(report.verdict) ||
    !Array.isArray(report.assertions)
  ) {
    fail(
      `Token budget fixture command did not return the expected assurance gate report: ${entry.args.join(" ")}`,
    );
  }
}

function measureCorpus(cliPath) {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "pm-token-budget-"));
  const options = {
    workspaceRoot,
    pmPath: path.join(workspaceRoot, ".agents", "pm"),
    globalPath: path.join(workspaceRoot, ".global-pm"),
  };
  try {
    const ids = seedFixture(cliPath, options);
    const contractBudgets = new Map();
    const measurements = commandCorpus(ids).map((entry) => {
      const result = runCli(
        cliPath,
        entry.args,
        options,
        entry.allow_failure === true,
      );
      if (entry.allow_failure === true) {
        validateToleratedCommandResult(entry, result);
      }
      const stdout = result.stdout;
      const format = entry.args.includes("--json") ? "json" : "toon";
      const renderedMeasurement = measureOutput(stdout);
      const contractBudgetKey = `${entry.command}:${format}`;
      const contractMaxEstimatedTokens =
        entry.kind === "answer"
          ? (contractBudgets.get(contractBudgetKey) ??
            resolveDeclaredBudget(cliPath, entry.command, format, options))
          : undefined;
      if (entry.kind === "answer") {
        contractBudgets.set(contractBudgetKey, contractMaxEstimatedTokens);
      }
      return {
        ...entry,
        ...(contractMaxEstimatedTokens === undefined
          ? {}
          : { contract_max_estimated_tokens: contractMaxEstimatedTokens }),
        ...renderedMeasurement,
        // A size verdict that names no content cannot be acted on: the failure
        // says a number grew but not which rows grew it. Carried in memory only;
        // budgetForMeasurement never persists it into the manifest.
        observed_excerpt: stdout.slice(0, OBSERVED_EXCERPT_LIMIT),
        ...(entry.kind === "answer"
          ? {
              contract_estimated_tokens: readOutputContractEstimate(
                stdout,
                format,
                renderedMeasurement.estimated_tokens,
              ),
            }
          : {}),
        ...(entry.intent
          ? { intent_receipt: JSON.parse(stdout).context_intent }
          : {}),
      };
    });
    const negativeControl = {
      command: "comments-audit",
      args: [
        "comments-audit",
        "--full-history",
        "--json",
        "--output-budget",
        "unbounded",
      ],
      ...measureOutput(
        runCli(
          cliPath,
          [
            "comments-audit",
            "--full-history",
            "--json",
            "--output-budget",
            "unbounded",
          ],
          options,
        ).stdout,
      ),
      contract_max_estimated_tokens: resolveDeclaredBudget(
        cliPath,
        "comments-audit",
        "json",
        options,
      ),
    };
    const intentNegativeControl = runCliJson(
      cliPath,
      ["list", "--for", "triage", "--token-budget", "256", "--json"],
      options,
    ).context_intent;
    return { measurements, negativeControl, intentNegativeControl };
  } finally {
    cleanupTempRoot(workspaceRoot);
  }
}

/**
 * Render the bounded observed output behind a size violation.
 *
 * Without it the verdict reports only that a number moved, so a maintainer has
 * to reconstruct the fixture by hand to learn which rows grew — which is how a
 * host-dependent row in a supposedly isolated fixture stays undiagnosed.
 */
export function describeObservedOutput(measurement) {
  const excerpt = measurement.observed_excerpt;
  if (typeof excerpt !== "string" || excerpt.length === 0) return "";
  const truncated = measurement.bytes > OBSERVED_EXCERPT_LIMIT;
  return `\nObserved output${truncated ? ` (first ${OBSERVED_EXCERPT_LIMIT} bytes)` : ""}:\n${excerpt}`;
}

export function budgetForMeasurement(measurement, multiplier) {
  const maxBytes = Math.ceil(measurement.bytes * multiplier);
  return {
    id: measurement.id,
    args: measurement.args.map((argument) =>
      /^pm-[a-z0-9]+$/u.test(argument) ? "<fixture-item>" : argument,
    ),
    kind: measurement.kind ?? "discovery",
    scale_tier: measurement.scale_tier ?? "static",
    baseline_bytes: measurement.bytes,
    baseline_estimated_tokens: measurement.estimated_tokens,
    ...(Number.isInteger(measurement.lines)
      ? { baseline_lines: measurement.lines }
      : {}),
    ...(Number.isInteger(measurement.max_lines)
      ? { max_lines: measurement.max_lines }
      : {}),
    max_bytes: maxBytes,
    max_estimated_tokens: Math.ceil(maxBytes / 4),
    ...(measurement.kind === "answer"
      ? {
          command: measurement.command,
          contract_max_estimated_tokens:
            measurement.contract_max_estimated_tokens,
        }
      : {}),
  };
}

function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    fail(
      `Token budget manifest missing: ${manifestPath}\nRun node scripts/release/token-budget-gate.mjs --update`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function buildManifest(measurements, multiplier) {
  return {
    version: MANIFEST_VERSION,
    metric: "utf8_bytes",
    token_estimate: "ceil(bytes / 4)",
    fixture: `isolated PM_PATH and PM_GLOBAL_PATH with ${SCALE_FIXTURE_ITEMS + 3} deterministic linked items, ${COMMENT_FIXTURE_ROWS} comments, ${NOTE_FIXTURE_ROWS} notes, governance audit, and an assurance gate`,
    policy:
      "all surfaces use ratcheted byte ceilings; answer surfaces also use live command contracts",
    budgets: measurements.map((measurement) =>
      budgetForMeasurement(measurement, multiplier),
    ),
  };
}

/** Return whether a manifest ceiling is finite and cannot disable enforcement through a negative value. */
function isNonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function isMalformedBudget(budget, requireAnswerRatchet) {
  if (Object(budget) !== budget) {
    return true;
  }
  if (
    [
      typeof budget.id !== "string",
      typeof budget.id === "string" && budget.id.trim().length === 0,
      !["discovery", "answer"].includes(budget.kind),
    ].includes(true)
  ) {
    return true;
  }
  if (
    budget.max_lines !== undefined &&
    (!Number.isInteger(budget.max_lines) || budget.max_lines < 1)
  ) {
    return true;
  }
  if (
    requireAnswerRatchet &&
    budget.kind === "answer" &&
    (!isNonNegativeFinite(budget.max_bytes) ||
      !isNonNegativeFinite(budget.max_estimated_tokens) ||
      budget.max_estimated_tokens !== Math.ceil(budget.max_bytes / 4))
  ) {
    return true;
  }
  if (budget.kind === "discovery") {
    return (
      !isNonNegativeFinite(budget.max_bytes) ||
      !isNonNegativeFinite(budget.max_estimated_tokens)
    );
  }
  if (
    typeof budget.command !== "string" ||
    !isNonNegativeFinite(budget.contract_max_estimated_tokens)
  ) {
    return true;
  }
  return false;
}

function measurementViolation(measurement, budget) {
  const {
    contract_estimated_tokens: contractEstimate = measurement.estimated_tokens,
  } = measurement;
  if (measurement.intent) {
    const receipt = measurement.intent_receipt;
    if (!receipt) {
      return `${measurement.id}: intent receipt did not prove a feasible delivered result (${measurement.args.join(" ")})`;
    }
    if (
      [
        receipt.declaration_feasible !== true,
        receipt.result_omitted !== false,
        receipt.within_budget !== true,
        !Number.isFinite(receipt.estimated_tokens),
        !Number.isFinite(receipt.token_budget),
        measurement.estimated_tokens > receipt.token_budget,
        receipt.estimated_tokens > receipt.token_budget,
      ].includes(true)
    ) {
      return `${measurement.id}: intent receipt did not prove a feasible delivered result (${measurement.args.join(" ")})`;
    }
  }
  if (
    Number.isInteger(budget.max_lines) &&
    measurement.lines > budget.max_lines
  ) {
    return `${measurement.id}: ${measurement.lines} lines exceeds screen ceiling ${budget.max_lines} lines (${measurement.args.join(" ")})`;
  }
  if (
    measurement.kind === "answer" &&
    contractEstimate > measurement.contract_max_estimated_tokens
  ) {
    return `${measurement.id}: ${contractEstimate} contract-estimated tokens exceeds ${measurement.command} contract ${measurement.contract_max_estimated_tokens} tokens (${measurement.args.join(" ")})`;
  }
  if (measurement.estimated_tokens > budget.max_estimated_tokens) {
    return `${measurement.id}: ${measurement.estimated_tokens} estimated tokens exceeds budget ${budget.max_estimated_tokens} tokens (${measurement.args.join(" ")})${describeObservedOutput(measurement)}`;
  }
  if (measurement.bytes > budget.max_bytes) {
    return `${measurement.id}: ${measurement.bytes} bytes exceeds budget ${budget.max_bytes} bytes (${measurement.args.join(" ")})${describeObservedOutput(measurement)}`;
  }
  return undefined;
}

export function compareBudgets(measurements, manifest) {
  if (!manifest || !Array.isArray(manifest.budgets)) {
    fail(
      "Token budget manifest is malformed: expected a top-level budgets array",
    );
  }
  const budgetById = new Map();
  for (const budget of manifest.budgets) {
    if (isMalformedBudget(budget, manifest.version >= MANIFEST_VERSION)) {
      fail(
        "Token budget manifest is malformed: each entry requires an id, kind, and its discovery or answer ceiling",
      );
    }
    budgetById.set(budget.id, budget);
  }
  const violations = [];
  for (const measurement of measurements) {
    const budget = budgetById.get(measurement.id);
    if (!budget) {
      violations.push(`${measurement.id}: missing budget entry`);
      continue;
    }
    const violation = measurementViolation(measurement, budget);
    if (violation) violations.push(violation);
  }
  return violations;
}

/** Verify controls that prove bounded defaults differ from escape hatches and infeasible effective overrides remain truthful. */
function compareNegativeControls(negativeControl, intentNegativeControl) {
  const violations = [];
  if (
    negativeControl.estimated_tokens <=
    negativeControl.contract_max_estimated_tokens
  ) {
    violations.push(
      `negative-control: explicit unbounded ${negativeControl.command} produced ${negativeControl.estimated_tokens} estimated tokens, expected more than its ${negativeControl.contract_max_estimated_tokens}-token default contract`,
    );
  }
  if (
    intentNegativeControl?.declaration_feasible !== true ||
    intentNegativeControl?.result_omitted !== true ||
    intentNegativeControl?.within_budget !== false ||
    intentNegativeControl?.token_budget !== 256 ||
    !Number.isFinite(intentNegativeControl?.estimated_tokens) ||
    intentNegativeControl.estimated_tokens <=
      intentNegativeControl.token_budget
  ) {
    violations.push(
      "intent-negative-control: infeasible 256-token list override did not return an explicit omitted-result receipt",
    );
  }
  return violations;
}

export function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  const update = flags.has("update");
  const manifestValue = flags.get("manifest");
  const manifestPath =
    manifestValue === undefined || manifestValue === true
      ? DEFAULT_MANIFEST_PATH
      : path.resolve(String(manifestValue));
  const multiplierValue = flags.get("headroom");
  const multiplier =
    multiplierValue === undefined || multiplierValue === true
      ? 1.1
      : Number(multiplierValue);
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    fail("--headroom must be a finite number >= 1");
  }
  const cliPath = distCliPath();
  if (!existsSync(cliPath)) {
    fail(
      `Built CLI not found at ${cliPath}; run pnpm build before the token budget gate`,
    );
  }
  const manifest = update ? undefined : readManifest(manifestPath);
  const { measurements, negativeControl, intentNegativeControl } =
    measureCorpus(cliPath);
  if (update) {
    const nextManifest = buildManifest(measurements, multiplier);
    writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    console.log(
      `Updated token budget manifest: ${path.relative(repoRoot, manifestPath)}`,
    );
    return;
  }
  const violations = [
    ...compareBudgets(measurements, manifest),
    ...compareNegativeControls(negativeControl, intentNegativeControl),
  ];
  if (violations.length > 0) {
    fail(
      `Token budget gate failed:\n${violations.join("\n")}\nRun node scripts/release/token-budget-gate.mjs --update after intentional output changes.`,
    );
  }
  console.log(
    `Token budget gate passed (${measurements.length} surfaces checked; unbounded negative control ${negativeControl.estimated_tokens} tokens; infeasible effective intent receipt verified).`,
  );
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  main();
}
