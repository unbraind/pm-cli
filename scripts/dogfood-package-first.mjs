#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "cli.js");
const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-dogfood-"));
const pmPath = path.join(tempRoot, "project", ".agents", "pm");
const globalPath = path.join(tempRoot, "global");
const markerFile = path.join(tempRoot, "project", "README.md");

const env = {
  ...process.env,
  PM_PATH: pmPath,
  PM_GLOBAL_PATH: globalPath,
  PM_AUTHOR: "dogfood-agent",
};

const timings = [];

function run(label, args, options = {}) {
  const startedAt = Date.now();
  const completed = spawnSync(process.execPath, [cliPath, "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const tookMs = Date.now() - startedAt;
  timings.push({ label, took_ms: tookMs, code: completed.status ?? 1 });
  if (completed.status !== 0) {
    throw new Error(
      [
        `${label} failed with exit ${completed.status ?? "unknown"}`,
        `command: pm --json ${args.join(" ")}`,
        completed.stdout.trim() ? `stdout:\n${completed.stdout.trim()}` : "",
        completed.stderr.trim() ? `stderr:\n${completed.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (options.parseJson === false) {
    return completed.stdout;
  }
  try {
    return JSON.parse(completed.stdout);
  } catch (error) {
    throw new Error(`${label} did not emit valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function idFrom(result, label) {
  const id = result?.item?.id ?? result?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} did not return an item id`);
  }
  return id;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  mkdirSync(path.dirname(markerFile), { recursive: true });
  writeFileSync(markerFile, "# Temporary pm dogfood project\n", "utf8");

  run("init", ["init", "--defaults", "--author", "dogfood-agent"]);
  run("config", ["config", "project", "set", "test-result-tracking", "--policy", "enabled"]);

  const created = run("create task", [
    "create",
    "--title",
    "Dogfood package-first workflow",
    "--description",
    "Exercise the current pm CLI in an isolated temporary project.",
    "--type",
    "Task",
    "--status",
    "open",
    "--priority",
    "1",
    "--tags",
    "dogfood,packages,agent-ux",
    "--acceptance-criteria",
    "Core lifecycle, package, search, calendar, SDK, and linked-test paths pass.",
    "--create-mode",
    "progressive",
    "--comment",
    "Temporary dogfood item created by scripts/dogfood-package-first.mjs.",
  ]);
  const id = idFrom(created, "create task");

  run("claim", ["claim", id]);
  run("update", ["update", id, "--status", "in_progress", "--estimate", "15"]);
  run("files", ["files", id, "--add", "path=README.md,scope=project,note=dogfood marker"]);
  run("docs", ["docs", id, "--add", "path=README.md,scope=project,note=dogfood docs marker"]);
  run("comments", ["comments", id, "Dogfood comment shorthand remains accepted."]);
  run("notes", ["notes", id, "--add", "Dogfood note shorthand remains accepted."]);
  run("learnings", ["learnings", id, "--add", "Dogfood learning shorthand remains accepted."]);
  run("calendar event", [
    "create",
    "--title",
    "Dogfood calendar event",
    "--description",
    "Exercise calendar event creation in the temporary dogfood project.",
    "--type",
    "Event",
    "--status",
    "open",
    "--priority",
    "2",
    "--event",
    "date=+1d,duration=30m,timezone=UTC",
    "--create-mode",
    "progressive",
  ]);
  run("calendar", ["calendar", "--view", "week", "--date", "today", "--format", "json"]);
  run("context", ["context", "--limit", "5", "--depth", "standard"]);
  run("search keyword", ["search", "Dogfood package-first workflow", "--mode", "keyword", "--limit", "5"]);
  run("reindex keyword", ["reindex", "--mode", "keyword"]);

  const installAll = run("package install all", ["install", "all", "--project"]);
  assert(installAll?.details?.installed_all === true, "install all did not report installed_all=true");
  run("package explore", ["package", "explore", "--project"]);
  run("package doctor", ["package", "doctor", "--project", "--detail", "summary"]);
  run("upgrade dry-run", ["upgrade", "--dry-run"]);

  run("sdk import", ["contracts", "--availability-only", "--runtime-only"]);
  const sdkSmoke = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import('./dist/sdk/index.js').then((sdk) => { if (!sdk.PM_PROVIDER_TOOL_PARAMETERS_SCHEMA) process.exit(2); })"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    },
  );
  timings.push({ label: "sdk import direct", took_ms: 0, code: sdkSmoke.status ?? 1 });
  if (sdkSmoke.status !== 0) {
    throw new Error(`SDK direct import failed: ${sdkSmoke.stderr.trim() || sdkSmoke.stdout.trim()}`);
  }

  run("linked test add", [
    "test",
    id,
    "--add",
    "command=node scripts/run-tests.mjs test -- tests/unit/parse-utils.spec.ts,scope=project,timeout_seconds=240",
  ]);
  run("linked test run", ["test", id, "--run", "--fail-on-skipped"]);
  run("validate", ["validate", "--check-resolution", "--check-history-drift"]);
  run("health", ["health", "--check-only", "--no-refresh"]);
  run("close", ["close", id, "temporary dogfood workflow passed", "--validate-close", "warn"]);
  run("release", ["release", id]);

  const slowest = [...timings].sort((left, right) => right.took_ms - left.took_ms).slice(0, 8);
  console.log(
    JSON.stringify(
      {
        ok: true,
        temp_root: tempRoot,
        pm_path: pmPath,
        commands: timings.length,
        slowest,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (process.env.PM_DOGFOOD_KEEP_TEMP !== "1") {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
