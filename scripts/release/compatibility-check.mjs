#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandFor, fail, flagBool, flagString, parseFlags, repoRoot, runCommand } from "./utils.mjs";

function parseJson(stdout, context) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    fail(`Expected JSON output for ${context}, received empty output.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to parse JSON output for ${context}: ${message}\n${trimmed}`);
  }
}

function runJsonCommand(command, args, env, context) {
  const result = runCommand(command, args, {
    env,
    capture: true,
  });
  return parseJson(result.stdout, context);
}

function resolvePublishedVersion(explicitVersion) {
  if (explicitVersion) {
    return explicitVersion;
  }
  const npm = commandFor("npm");
  const result = runCommand(npm, ["view", "@unbrained/pm-cli", "version"], { capture: true });
  const version = result.stdout.trim();
  if (!version) {
    fail("Failed to resolve latest published @unbrained/pm-cli version from npm.");
  }
  return version;
}

async function seedLegacyData(baseVersion, tempRoot, env, author) {
  const npx = commandFor("npx");
  const packageSpec = `@unbrained/pm-cli@${baseVersion}`;
  const legacy = (...args) =>
    runJsonCommand(npx, ["--yes", packageSpec, ...args, "--json"], env, `legacy command: ${args.join(" ")}`);

  legacy("init");

  const taskCreate = legacy(
    "create",
    "--create-mode",
    "progressive",
    "--title",
    "Compatibility release seed",
    "--description",
    "Legacy item generated from the latest published release for migration safety checks.",
    "--type",
    "Task",
    "--status",
    "open",
    "--priority",
    "1",
    "--tags",
    "compatibility,release,migration",
    "--author",
    author,
    "--message",
    "create compatibility seed task",
  );
  const taskId = taskCreate?.item?.id;
  if (typeof taskId !== "string" || taskId.length === 0) {
    fail("Legacy create did not return a valid task id.");
  }

  const issueCreate = legacy(
    "create",
    "--create-mode",
    "progressive",
    "--title",
    "Compatibility closed issue seed",
    "--description",
    "Legacy closed issue with resolution metadata for release migration validation.",
    "--type",
    "Issue",
    "--status",
    "open",
    "--priority",
    "2",
    "--tags",
    "compatibility,release,issue",
    "--author",
    author,
    "--message",
    "create compatibility issue seed",
  );
  const issueId = issueCreate?.item?.id;
  if (typeof issueId !== "string" || issueId.length === 0) {
    fail("Legacy create did not return a valid issue id.");
  }

  const projectRoot = path.join(tempRoot, "project");
  await mkdir(path.join(projectRoot, "docs"), { recursive: true });
  await writeFile(path.join(projectRoot, "README.md"), "# Compatibility Fixture\n", "utf8");
  await writeFile(path.join(projectRoot, "docs", "compat.md"), "Compatibility docs fixture.\n", "utf8");

  legacy(
    "update",
    taskId,
    "--body",
    "Legacy release data body content for migration verification.",
    "--reminder",
    "at=+1d,text=follow-up compatibility check",
    "--dep",
    `id=${issueId},kind=related,author=${author},created_at=now`,
    "--author",
    author,
    "--message",
    "enrich compatibility task metadata",
  );
  legacy(
    "comments",
    taskId,
    "--add",
    "Legacy compatibility comment entry.",
    "--author",
    author,
    "--message",
    "add compatibility comment",
  );
  legacy(
    "notes",
    taskId,
    "--add",
    "Legacy compatibility note entry.",
    "--author",
    author,
    "--message",
    "add compatibility note",
  );
  legacy(
    "learnings",
    taskId,
    "--add",
    "Legacy compatibility learning entry.",
    "--author",
    author,
    "--message",
    "add compatibility learning",
  );
  legacy(
    "files",
    taskId,
    "--add",
    "path=README.md,scope=project,note=compatibility fixture file",
    "--author",
    author,
    "--message",
    "link compatibility fixture file",
  );
  legacy(
    "docs",
    taskId,
    "--add",
    "path=docs/compat.md,scope=project,note=compatibility fixture doc",
    "--author",
    author,
    "--message",
    "link compatibility fixture doc",
  );
  legacy(
    "test",
    taskId,
    "--add",
    "command=node --version,scope=project,timeout_seconds=60,note=compatibility linked test",
    "--author",
    author,
    "--message",
    "add compatibility linked test",
  );
  legacy(
    "update",
    issueId,
    "--resolution",
    "Legacy issue resolution metadata for migration checks.",
    "--expected-result",
    "Legacy issue expected behavior is captured.",
    "--actual-result",
    "Legacy issue actual behavior is captured.",
    "--author",
    author,
    "--message",
    "add issue resolution metadata before close",
  );
  legacy(
    "close",
    issueId,
    "Legacy issue closed for migration checks.",
    "--validate-close",
    "warn",
    "--author",
    author,
    "--message",
    "close compatibility issue seed",
  );

  const before = legacy("list-all", "--limit", "200");
  return {
    baseVersion,
    taskId,
    issueId,
    itemCountBefore: Number(before?.count ?? 0),
  };
}

function runCurrentChecks(seedState, env, author) {
  const distCli = path.join(repoRoot, "dist", "cli.js");
  const current = (...args) => runJsonCommand(process.execPath, [distCli, ...args, "--json"], env, args.join(" "));

  const commentsBefore = current("comments", seedState.taskId);
  if (!Array.isArray(commentsBefore?.comments) || commentsBefore.comments.length === 0) {
    fail("Compatibility gate failed: expected legacy comments to survive current build read path.");
  }
  const notesBefore = current("notes", seedState.taskId);
  if (!Array.isArray(notesBefore?.notes) || notesBefore.notes.length === 0) {
    fail("Compatibility gate failed: expected legacy notes to survive current build read path.");
  }
  const learningsBefore = current("learnings", seedState.taskId);
  if (!Array.isArray(learningsBefore?.learnings) || learningsBefore.learnings.length === 0) {
    fail("Compatibility gate failed: expected legacy learnings to survive current build read path.");
  }
  const testsBefore = current("test", seedState.taskId);
  if (!Array.isArray(testsBefore?.tests) || testsBefore.tests.length === 0) {
    fail("Compatibility gate failed: expected legacy linked tests to survive current build read path.");
  }

  current(
    "update",
    seedState.taskId,
    "--status",
    "in_progress",
    "--author",
    author,
    "--message",
    "current-build compatibility mutation",
  );
  current(
    "comments",
    seedState.taskId,
    "--add",
    "Current build mutation after legacy seed.",
    "--author",
    author,
    "--message",
    "append post-migration compatibility comment",
  );
  current("test", seedState.taskId, "--run", "--timeout", "60");
  const validation = current("validate", "--check-resolution", "--check-history-drift");
  if (validation?.ok === false) {
    fail("Compatibility gate failed: validate --check-resolution --check-history-drift returned ok=false.");
  }
  const health = current("health", "--check-only");
  if (health?.ok === false) {
    fail("Compatibility gate failed: health --check-only returned ok=false.");
  }

  const afterList = current("list-all", "--limit", "200");
  const itemCountAfter = Number(afterList?.count ?? 0);
  if (itemCountAfter !== seedState.itemCountBefore) {
    fail(
      `Compatibility gate failed: item count drift detected (before=${seedState.itemCountBefore}, after=${itemCountAfter}).`,
    );
  }

  return {
    itemCountAfter,
    validationOk: validation?.ok !== false,
    healthOk: health?.ok !== false,
  };
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    console.log(`Usage:
  node scripts/release/compatibility-check.mjs [--base-version <version>] [--author <name>] [--keep-temp] [--json]

Creates representative legacy tracker data with the latest published pm-cli version in a temp sandbox,
then validates migration/read/write compatibility with the current local build.
`);
    return;
  }

  const keepTemp = flagBool(flags, "keep-temp", false);
  const outputJson = flagBool(flags, "json", false);
  const author = flagString(flags, "author", "release-compatibility-gate");
  const baseVersion = resolvePublishedVersion(flagString(flags, "base-version", null));
  const tempRoot = await mkdtemp(path.join(tmpdir(), "pm-cli-compat-"));
  const pmPath = path.join(tempRoot, "project", ".agents", "pm");
  const pmGlobalPath = path.join(tempRoot, "global");
  const env = {
    PM_PATH: pmPath,
    PM_GLOBAL_PATH: pmGlobalPath,
    PM_AUTHOR: author,
  };

  try {
    const seedState = await seedLegacyData(baseVersion, tempRoot, env, author);
    const currentSummary = runCurrentChecks(seedState, env, author);
    const summary = {
      ok: true,
      base_version: baseVersion,
      temp_root: tempRoot,
      task_id: seedState.taskId,
      issue_id: seedState.issueId,
      item_count_before: seedState.itemCountBefore,
      item_count_after: currentSummary.itemCountAfter,
      validation_ok: currentSummary.validationOk,
      health_ok: currentSummary.healthOk,
      keep_temp: keepTemp,
    };

    if (outputJson) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      console.log(
        `Compatibility gate passed: base=${baseVersion}, items=${seedState.itemCountBefore}, temp=${tempRoot}`,
      );
    }
  } finally {
    if (!keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

await main();
