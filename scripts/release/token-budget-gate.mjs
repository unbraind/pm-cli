#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, repoRoot, runCommand } from "./utils.mjs";
import { cleanupTempRoot } from "../smoke-cleanup.mjs";

const MANIFEST_VERSION = 2;
const SCALE_FIXTURE_ITEMS = 24;
const DEFAULT_MANIFEST_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "token-budgets.json",
);

function distCliPath() {
  return path.join(repoRoot, "dist", "cli.js");
}

function runCli(cliPath, args, options) {
  const env = {
    ...process.env,
    PM_AUTHOR: "token-budget-gate",
    PM_PATH: options.pmPath,
    PM_GLOBAL_PATH: options.globalPath,
  };
  const result = runCommand(process.execPath, [cliPath, ...args], {
    cwd: options.workspaceRoot,
    env,
    capture: true,
  });
  return result.stdout;
}

function runCliJson(cliPath, args, options) {
  const stdout = runCli(cliPath, args, options);
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

export function mutationId(result, label) {
  const id = result?.id ?? result?.item?.id;
  if (typeof id !== "string" || id.length === 0) {
    fail(`Token budget fixture ${label} mutation did not return an item id`);
  }
  return id;
}

function seedFixture(cliPath, options) {
  runCli(cliPath, ["init", "--defaults", "--json"], options);
  const parent = runCliJson(
    cliPath,
    [
      "create",
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
  runCli(
    cliPath,
    [
      "comments",
      mutationId(child, "child"),
      "Evidence fixture comment for token budget output",
      "--json",
    ],
    options,
  );
  for (let index = 0; index < SCALE_FIXTURE_ITEMS; index += 1) {
    runCliJson(
      cliPath,
      [
        "create",
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
  return {
    parentId,
    blockerId: mutationId(blocker, "blocker"),
    childId: mutationId(child, "child"),
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
      args: ["activity", "--json"],
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
  ];
}

export function measureOutput(stdout) {
  const bytes = Buffer.byteLength(stdout, "utf8");
  return {
    bytes,
    estimated_tokens: Math.ceil(bytes / 4),
  };
}

function resolveDeclaredBudget(cliPath, command, options) {
  const result = runCliJson(
    cliPath,
    ["contracts", "--command", command, "--summary", "--json"],
    options,
  );
  const budget = result?.command_summaries?.[0]?.default_max_estimated_tokens;
  if (!Number.isFinite(budget) || budget <= 0) {
    fail(`Token budget contract missing for answer command: ${command}`);
  }
  return budget;
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
      const stdout = runCli(cliPath, entry.args, options);
      const contractMaxEstimatedTokens =
        entry.kind === "answer"
          ? (contractBudgets.get(entry.command) ??
            resolveDeclaredBudget(cliPath, entry.command, options))
          : undefined;
      if (entry.kind === "answer") {
        contractBudgets.set(entry.command, contractMaxEstimatedTokens);
      }
      return {
        ...entry,
        ...(contractMaxEstimatedTokens === undefined
          ? {}
          : { contract_max_estimated_tokens: contractMaxEstimatedTokens }),
        ...measureOutput(stdout),
      };
    });
    const negativeControl = {
      command: "activity",
      args: ["activity", "--json", "--full", "--unbounded"],
      ...measureOutput(
        runCli(
          cliPath,
          ["activity", "--json", "--full", "--unbounded"],
          options,
        ),
      ),
      contract_max_estimated_tokens: contractBudgets.get("activity"),
    };
    return { measurements, negativeControl };
  } finally {
    cleanupTempRoot(workspaceRoot);
  }
}

export function budgetForMeasurement(measurement, multiplier) {
  return {
    id: measurement.id,
    args: measurement.args,
    kind: measurement.kind ?? "discovery",
    scale_tier: measurement.scale_tier ?? "static",
    baseline_bytes: measurement.bytes,
    baseline_estimated_tokens: measurement.estimated_tokens,
    ...(measurement.kind === "answer"
      ? {
          command: measurement.command,
          contract_max_estimated_tokens:
            measurement.contract_max_estimated_tokens,
        }
      : {
          max_bytes: Math.ceil(measurement.bytes * multiplier),
          max_estimated_tokens: Math.ceil(
            measurement.estimated_tokens * multiplier,
          ),
        }),
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
    fixture: `isolated PM_PATH and PM_GLOBAL_PATH with ${SCALE_FIXTURE_ITEMS + 3} deterministic linked items`,
    policy:
      "discovery surfaces use ratcheted byte ceilings; answer surfaces use live command contracts",
    budgets: measurements.map((measurement) =>
      budgetForMeasurement(measurement, multiplier),
    ),
  };
}

function isMalformedBudget(budget) {
  if (
    typeof budget !== "object" ||
    budget === null ||
    typeof budget.id !== "string" ||
    budget.id.trim().length === 0 ||
    !["discovery", "answer"].includes(budget.kind)
  ) {
    return true;
  }
  return budget.kind === "discovery"
    ? !Number.isFinite(budget.max_bytes) || budget.max_bytes < 0
    : typeof budget.command !== "string" ||
        !Number.isFinite(budget.contract_max_estimated_tokens);
}

function measurementViolation(measurement, budget) {
  if (
    measurement.kind === "answer" &&
    measurement.estimated_tokens > measurement.contract_max_estimated_tokens
  ) {
    return `${measurement.id}: ${measurement.estimated_tokens} estimated tokens exceeds ${measurement.command} contract ${measurement.contract_max_estimated_tokens} tokens (${measurement.args.join(" ")})`;
  }
  if (
    measurement.kind === "discovery" &&
    measurement.bytes > budget.max_bytes
  ) {
    return `${measurement.id}: ${measurement.bytes} bytes exceeds budget ${budget.max_bytes} bytes (${measurement.args.join(" ")})`;
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
    if (isMalformedBudget(budget)) {
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
  const { measurements, negativeControl } = measureCorpus(cliPath);
  if (update) {
    const nextManifest = buildManifest(measurements, multiplier);
    writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    console.log(
      `Updated token budget manifest: ${path.relative(repoRoot, manifestPath)}`,
    );
    return;
  }
  const violations = compareBudgets(measurements, manifest);
  if (
    negativeControl.estimated_tokens <=
    negativeControl.contract_max_estimated_tokens
  ) {
    violations.push(
      `negative-control: explicit unbounded activity produced ${negativeControl.estimated_tokens} estimated tokens, expected more than its ${negativeControl.contract_max_estimated_tokens}-token default contract`,
    );
  }
  if (violations.length > 0) {
    fail(
      `Token budget gate failed:\n${violations.join("\n")}\nRun node scripts/release/token-budget-gate.mjs --update after intentional output changes.`,
    );
  }
  console.log(
    `Token budget gate passed (${measurements.length} surfaces checked; unbounded negative control ${negativeControl.estimated_tokens} tokens).`,
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
