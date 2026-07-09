#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, parseFlags, repoRoot, runCommand } from "./utils.mjs";

const MANIFEST_VERSION = 1;
const DEFAULT_MANIFEST_PATH = path.join(repoRoot, "scripts", "release", "token-budgets.json");

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
    fail(`Token budget fixture command did not return JSON: ${args.join(" ")}\n${message}`);
  }
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
  const parentId = parent.item.id;
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
      blocker.item.id,
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
      child.item.id,
      "Evidence fixture comment for token budget output",
      "--json",
    ],
    options,
  );
  return {
    parentId,
    blockerId: blocker.item.id,
    childId: child.item.id,
  };
}

function commandCorpus(ids) {
  return [
    { id: "root-help", args: ["--help"] },
    { id: "search-help", args: ["search", "--help"] },
    { id: "create-help", args: ["create", "--help"] },
    { id: "update-help", args: ["update", "--help"] },
    { id: "contracts-summary-json", args: ["contracts", "--summary", "--json"] },
    { id: "contracts-flags-json", args: ["contracts", "--flags-only", "--json"] },
    { id: "list-default", args: ["list"] },
    { id: "list-json", args: ["list", "--json"] },
    { id: "get-default", args: ["get", ids.childId] },
    { id: "get-json-compact-fields", args: ["get", ids.childId, "--json", "--fields", "id,title,status,type,priority,tags,dependencies"] },
    { id: "context-default", args: ["context", "--limit", "5"] },
    { id: "next-default", args: ["next", "--limit", "5"] },
    { id: "search-inline-default", args: ["search", "status:all Alpha"] },
    { id: "search-inline-json", args: ["search", "status:all Alpha", "--json"] },
  ];
}

export function measureOutput(stdout) {
  const bytes = Buffer.byteLength(stdout, "utf8");
  return {
    bytes,
    estimated_tokens: Math.ceil(bytes / 4),
  };
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
    return commandCorpus(ids).map((entry) => {
      const stdout = runCli(cliPath, entry.args, options);
      return {
        id: entry.id,
        args: entry.args,
        ...measureOutput(stdout),
      };
    });
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

export function budgetForMeasurement(measurement, multiplier) {
  return {
    id: measurement.id,
    args: measurement.args,
    max_bytes: Math.ceil(measurement.bytes * multiplier),
    max_estimated_tokens: Math.ceil(measurement.estimated_tokens * multiplier),
  };
}

function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    fail(`Token budget manifest missing: ${manifestPath}\nRun node scripts/release/token-budget-gate.mjs --update`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function buildManifest(measurements, multiplier) {
  return {
    version: MANIFEST_VERSION,
    metric: "utf8_bytes",
    token_estimate: "ceil(bytes / 4)",
    fixture: "isolated PM_PATH and PM_GLOBAL_PATH with deterministic seeded items",
    budgets: measurements.map((measurement) => budgetForMeasurement(measurement, multiplier)),
  };
}

export function compareBudgets(measurements, manifest) {
  if (!manifest || !Array.isArray(manifest.budgets)) {
    fail("Token budget manifest is malformed: expected a top-level budgets array");
  }
  const budgetById = new Map(manifest.budgets.map((budget) => [budget.id, budget]));
  const violations = [];
  for (const measurement of measurements) {
    const budget = budgetById.get(measurement.id);
    if (!budget) {
      violations.push(`${measurement.id}: missing budget entry`);
      continue;
    }
    if (measurement.bytes > budget.max_bytes) {
      violations.push(
        `${measurement.id}: ${measurement.bytes} bytes exceeds budget ${budget.max_bytes} bytes (${measurement.args.join(" ")})`,
      );
    }
  }
  return violations;
}

export function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  const update = flags.has("update");
  const manifestValue = flags.get("manifest");
  const manifestPath =
    manifestValue === undefined || manifestValue === true ? DEFAULT_MANIFEST_PATH : path.resolve(String(manifestValue));
  const multiplierValue = flags.get("headroom");
  const multiplier = multiplierValue === undefined || multiplierValue === true ? 1.1 : Number(multiplierValue);
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    fail("--headroom must be a finite number >= 1");
  }
  const cliPath = distCliPath();
  if (!existsSync(cliPath)) {
    fail(`Built CLI not found at ${cliPath}; run pnpm build before the token budget gate`);
  }
  const manifest = update ? undefined : readManifest(manifestPath);
  const measurements = measureCorpus(cliPath);
  if (update) {
    const nextManifest = buildManifest(measurements, multiplier);
    writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    console.log(`Updated token budget manifest: ${path.relative(repoRoot, manifestPath)}`);
    return;
  }
  const violations = compareBudgets(measurements, manifest);
  if (violations.length > 0) {
    fail(`Token budget gate failed:\n${violations.join("\n")}\nRun node scripts/release/token-budget-gate.mjs --update after intentional output changes.`);
  }
  console.log(`Token budget gate passed (${measurements.length} surfaces checked).`);
}

function isMainModule() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main();
}
