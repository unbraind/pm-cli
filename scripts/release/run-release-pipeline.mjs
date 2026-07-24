#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  commandFor,
  fail,
  flagBool,
  flagString,
  parseFlags,
  repoRoot,
  runCommand,
  utcDateKey,
} from "./utils.mjs";
import { isReleaseRelevantPath } from "./release-relevance.mjs";

const releasePushToken = process.env.RELEASE_PUSH_TOKEN?.trim() ?? "";
delete process.env.RELEASE_PUSH_TOKEN;

export function usage() {
  console.log(`Usage:
  node scripts/release/run-release-pipeline.mjs [--json]
    [--version <YYYY.M.D>]
    [--dry-run]
    [--push]
    [--author <name>]
    [--telemetry-mode off|best-effort|required]
    [--skip-compatibility]
    [--skip-telemetry-sentry]
    [--release-notes-output <path>]

Runs the end-to-end release preparation pipeline:
1) change detection + one-per-day guard
2) version + changelog preparation
3) strict quality/compatibility/reliability gates
4) release-notes generation
5) commit/tag/push (unless dry-run)

Commits that only update .agents/pm tracker state are ignored for publish
eligibility so post-release item closure does not trigger another package
release.
`);
}

function git(args, options = {}) {
  return runCommand("git", args, { capture: true, ...options });
}

export function getLastTag() {
  const result = git(["describe", "--tags", "--abbrev=0"], { allowFailure: true });
  if (result.status !== 0) {
    return null;
  }
  const tag = result.stdout.trim();
  return tag.length > 0 ? tag : null;
}

export function getCommitCountSince(lastTag) {
  if (!lastTag) {
    const all = git(["rev-list", "--count", "HEAD"]);
    return Number(all.stdout.trim() || "0");
  }
  const result = git(["rev-list", "--count", `${lastTag}..HEAD`]);
  return Number(result.stdout.trim() || "0");
}

export function getChangedFilesSince(lastTag) {
  if (!lastTag) {
    const result = git(["ls-files"]);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  const result = git(["diff", "--name-only", `${lastTag}..HEAD`]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function listTodayTags(todayKey) {
  const result = git(["tag", "--list", `v${todayKey}*`]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ensureCleanWorkingTree() {
  const status = git(["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    fail("Release pipeline requires a clean working tree.");
  }
}

export function resolveVersion(explicitVersion, todayKey) {
  const targetVersion = explicitVersion ?? todayKey;
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(targetVersion)) {
    fail(
      `Unsupported target version "${targetVersion}": expected YYYY.M.D because the release pipeline permits only one production version per UTC day.`,
    );
  }
  if (targetVersion !== todayKey) {
    fail(
      `Unsupported target version "${targetVersion}": the release pipeline target must equal the current UTC date (${todayKey}).`,
    );
  }
  return targetVersion;
}

export function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return packageJson.version;
}

export function extractGeneratedChangelogSection(changelog, heading) {
  const lines = changelog.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith(`## [${heading}]`) || line.startsWith(`## ${heading}`)
  );
  if (start === -1) {
    return null;
  }
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

export function ensureGeneratedReleaseSectionHasContent(version, changelogPath = path.join(repoRoot, "CHANGELOG.md")) {
  const changelog = readFileSync(changelogPath, "utf8");
  const section = extractGeneratedChangelogSection(changelog, version);
  return Boolean(section);
}

export function runReleaseGates(options) {
  const args = ["scripts/release/run-gates.mjs", "--telemetry-mode", options.telemetryMode];
  if (options.skipCompatibility) {
    args.push("--skip-compatibility");
  }
  if (options.skipTelemetrySentry) {
    args.push("--skip-telemetry-sentry");
  }
  runCommand(process.execPath, args);
  return {
    ok: true,
    telemetry_mode: options.telemetryMode,
    skip_compatibility: options.skipCompatibility,
    skip_telemetry_sentry: options.skipTelemetrySentry,
  };
}

function isBranchBehindPushFailure(result) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("fetch first") ||
    output.includes("non-fast-forward") ||
    output.includes("tip of your current branch is behind")
  );
}

export function pushReleaseRefs(tagName, gitOptions = {}) {
  const pushGitOptions = withReleasePushCredentials(gitOptions);
  const firstPush = git(["push", "--atomic", "origin", "HEAD", tagName], { ...pushGitOptions, allowFailure: true });
  if (firstPush.status === 0) {
    return { retried: false };
  }
  if (!isBranchBehindPushFailure(firstPush)) {
    const detail = `${firstPush.stderr.trim()}\n${firstPush.stdout.trim()}`.trim();
    fail(`Command failed: git push --atomic origin HEAD ${tagName}\n${detail}`);
  }

  console.warn("Release branch push was rejected because origin/main advanced; fetching and rebasing before retry.");
  git(["fetch", "origin", "main"], gitOptions);
  const rebaseResult = git(["rebase", "origin/main"], { ...gitOptions, allowFailure: true });
  if (rebaseResult.status !== 0) {
    git(["rebase", "--abort"], gitOptions);
    const detail = `${rebaseResult.stderr.trim()}\n${rebaseResult.stdout.trim()}`.trim();
    fail(`Command failed: git rebase origin/main\n${detail}`);
  }
  git(["tag", "-f", tagName, "HEAD"], gitOptions);
  const retryPush = git(["push", "--atomic", "origin", "HEAD", tagName], { ...pushGitOptions, allowFailure: true });
  if (retryPush.status !== 0) {
    const detail = `${retryPush.stderr.trim()}\n${retryPush.stdout.trim()}`.trim();
    fail(`Command failed: git push --atomic origin HEAD ${tagName}\n${detail}`);
  }
  return { retried: true };
}

export function withReleasePushCredentials(gitOptions = {}, token = releasePushToken) {
  const options = gitOptions ?? {};
  if (!token) {
    return options;
  }
  const baseEnv = options.env ?? {};
  const existingGitConfigCount = Number.parseInt(baseEnv.GIT_CONFIG_COUNT ?? "0", 10);
  const gitConfigIndex = Number.isInteger(existingGitConfigCount) && existingGitConfigCount >= 0
    ? existingGitConfigCount
    : 0;
  const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
  return {
    ...options,
    env: {
      ...baseEnv,
      GIT_CONFIG_COUNT: String(gitConfigIndex + 1),
      [`GIT_CONFIG_KEY_${gitConfigIndex}`]: "http.https://github.com/.extraheader",
      [`GIT_CONFIG_VALUE_${gitConfigIndex}`]: authHeader,
    },
  };
}

function writePipelineResult(result, outputJson, text) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(text);
}

function maybeSkipForNoChanges(commitsSinceLastTag, lastTag, outputJson) {
  if (commitsSinceLastTag !== 0) {
    return false;
  }
  writePipelineResult(
    {
      ok: true,
      skipped: true,
      reason: "no_changes_since_last_tag",
      last_tag: lastTag,
    },
    outputJson,
    "No changes since the last release tag. Skipping release pipeline.",
  );
  return true;
}

function maybeSkipForTrackerOnlyChanges(lastTag, commitsSinceLastTag, changedFilesSinceLastTag, releaseRelevantFiles, outputJson) {
  if (releaseRelevantFiles.length > 0) {
    return false;
  }
  writePipelineResult(
    {
      ok: true,
      skipped: true,
      reason: "tracker_only_changes_since_last_tag",
      last_tag: lastTag,
      commits_since_last_tag: commitsSinceLastTag,
      ignored_change_paths: changedFilesSinceLastTag,
    },
    outputJson,
    "Only .agents/pm tracker changes exist since the last release tag. Skipping release pipeline.",
  );
  return true;
}

function maybeSkipForSameDayRelease(tagsToday, todayKey, outputJson) {
  if (tagsToday.length === 0) {
    return false;
  }
  writePipelineResult(
    {
      ok: true,
      skipped: true,
      reason: "release_already_cut_today",
      tags_today: tagsToday,
      date_key: todayKey,
    },
    outputJson,
    `Release already exists for ${todayKey}: ${tagsToday.join(", ")}. Skipping.`,
  );
  return true;
}

function prepareReleaseChangelog(params) {
  const generatedChangelogDir = mkdtempSync(path.join(tmpdir(), "pm-cli-release-"));
  const generatedChangelogPath = path.join(generatedChangelogDir, `changelog-${params.targetVersion.replaceAll(".", "-")}.md`);
  try {
    runCommand(process.execPath, ["dist/cli.js", "install", "npm:pm-changelog", "--project"]);
    runCommand(process.execPath, [
      "dist/cli.js",
      "changelog",
      "generate",
      "--output",
      generatedChangelogPath,
      "--title",
      "Changelog",
      "--mode",
      "replace",
      "--release-version",
      params.targetVersion,
      "--all-release-tags",
      "--status",
      "closed",
      "--item-url-base",
      "https://github.com/unbraind/pm-cli/blob/main/.agents/pm",
    ]);
    if (!ensureGeneratedReleaseSectionHasContent(params.targetVersion, generatedChangelogPath)) {
      const retainedChangelogPath = path.join(tmpdir(), `pm-cli-empty-release-changelog-${params.targetVersion.replaceAll(".", "-")}.md`);
      writeFileSync(retainedChangelogPath, readFileSync(generatedChangelogPath, "utf8"), "utf8");
      return { prepared: false, generatedChangelogPath: retainedChangelogPath };
    }
    const npm = commandFor("npm");
    runCommand(npm, ["version", "--no-git-tag-version", params.targetVersion]);
    // Keep every distribution-facing manifest (workspace packages, plugin
    // manifests, marketplace catalogs) on the same date-based version as the
    // root package; `pnpm version:check` in the CI static gate rejects drift.
    runCommand(process.execPath, ["scripts/sync-versions.mjs", "apply"]);
    writeFileSync(path.join(repoRoot, "CHANGELOG.md"), readFileSync(generatedChangelogPath, "utf8"), "utf8");
    return { prepared: true, generatedChangelogPath };
  } finally {
    rmSync(generatedChangelogDir, { recursive: true, force: true });
  }
}

function maybeSkipForEmptyGeneratedChangelog(params) {
  if (params.prepared) {
    return false;
  }
  if (params.explicitVersion) {
    fail(`Generated changelog file ${params.generatedChangelogPath} is missing a non-empty section for ${params.targetVersion}.`);
  }
  writePipelineResult(
    {
      ok: true,
      skipped: true,
      reason: "empty_generated_changelog_section_for_target_version",
      last_tag: params.lastTag,
      target_version: params.targetVersion,
      commits_since_last_tag: params.commitsSinceLastTag,
      release_relevant_files: params.releaseRelevantFiles,
    },
    params.outputJson,
    `Generated changelog has no non-empty section for ${params.targetVersion}. Skipping release pipeline.`,
  );
  return true;
}

function commitAndMaybePushRelease(targetVersion, tagName, author, push) {
  const authorSlug = author.toLowerCase().replaceAll(/[^a-z0-9._-]/g, "-");
  /* c8 ignore next -- author always defaults to a non-empty slug; `|| "release-bot"` is a defensive fallback (parseFlags maps `--author ""` to the default) */
  const authorEmail = `${authorSlug || "release-bot"}@users.noreply.github.com`;
  const gitIdentityEnv = {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: authorEmail,
  };
  git([
    "add",
    "package.json",
    "CHANGELOG.md",
    // Manifests stamped by scripts/sync-versions.mjs during release preparation.
    "packages/*/package.json",
    "plugins/pm-claude/.claude-plugin/plugin.json",
    "plugins/pm-codex/.codex-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "marketplace.json",
    ".agents/plugins/marketplace.json",
  ]);
  runCommand("git", [
    "commit",
    "-m",
    `chore(release): cut ${targetVersion}\n\nAutomate daily release preparation with strict quality, compatibility, and reliability gates.`,
  ], { env: gitIdentityEnv });
  git(["tag", tagName]);
  if (push) {
    pushReleaseRefs(tagName, { env: gitIdentityEnv });
  }
}

export function runPipeline() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }
  if (flags.has("allow-same-day-release")) {
    fail(
      "--allow-same-day-release was removed; retry the existing tag through the Release workflow after a partial failure.",
    );
  }

  const outputJson = flagBool(flags, "json", false);
  const dryRun = flagBool(flags, "dry-run", false);
  const push = flagBool(flags, "push", false);
  const telemetryMode = flagString(flags, "telemetry-mode", "best-effort");
  const skipCompatibility = flagBool(flags, "skip-compatibility", false);
  const skipTelemetrySentry = flagBool(flags, "skip-telemetry-sentry", false);
  const explicitVersion = flagString(flags, "version", null);
  const todayKey = utcDateKey();
  const targetVersion = resolveVersion(explicitVersion, todayKey);
  const author = flagString(flags, "author", "release-automation");
  const releaseNotesOutput = flagString(
    flags,
    "release-notes-output",
    path.join(tmpdir(), "pm-cli-release-notes.md"),
  );

  if (!["off", "best-effort", "required"].includes(telemetryMode)) {
    fail(`Unsupported --telemetry-mode "${telemetryMode}".`);
  }

  ensureCleanWorkingTree();
  const lastTag = getLastTag();
  const commitsSinceLastTag = getCommitCountSince(lastTag);
  if (maybeSkipForNoChanges(commitsSinceLastTag, lastTag, outputJson)) {
    return;
  }

  const changedFilesSinceLastTag = getChangedFilesSince(lastTag);
  const releaseRelevantFiles = changedFilesSinceLastTag.filter(isReleaseRelevantPath);
  if (maybeSkipForTrackerOnlyChanges(lastTag, commitsSinceLastTag, changedFilesSinceLastTag, releaseRelevantFiles, outputJson)) {
    return;
  }

  const tagsToday = listTodayTags(todayKey);
  if (maybeSkipForSameDayRelease(tagsToday, todayKey, outputJson)) {
    return;
  }

  const previousVersion = readPackageVersion();

  if (!dryRun) {
    const changelogPreparation = prepareReleaseChangelog({ targetVersion });
    if (maybeSkipForEmptyGeneratedChangelog({
      ...changelogPreparation,
      explicitVersion,
      targetVersion,
      lastTag,
      commitsSinceLastTag,
      releaseRelevantFiles,
      outputJson,
    })) return;
  }

  const gates = runReleaseGates({
    telemetryMode,
    skipCompatibility,
    skipTelemetrySentry,
  });
  /* c8 ignore start -- defensive guard: runReleaseGates always returns ok:true or throws via runCommand */
  if (gates.ok !== true) {
    fail("Release gates did not report ok=true.");
  }
  /* c8 ignore stop */

  const releaseNotesAbsolute = path.resolve(releaseNotesOutput);
  mkdirSync(path.dirname(releaseNotesAbsolute), { recursive: true });
  runCommand(process.execPath, [
    "scripts/generate-release-notes.mjs",
    "--version",
    targetVersion,
    "--output",
    releaseNotesOutput,
  ]);

  const tagName = `v${targetVersion}`;
  if (!dryRun) {
    commitAndMaybePushRelease(targetVersion, tagName, author, push);
  }

  const result = {
    ok: true,
    skipped: false,
    dry_run: dryRun,
    pushed: push && !dryRun,
    previous_version: previousVersion,
    target_version: targetVersion,
    tag: tagName,
    commits_since_last_tag: commitsSinceLastTag,
    release_relevant_files: releaseRelevantFiles,
    last_tag: lastTag,
    release_notes_output: path.relative(repoRoot, path.resolve(releaseNotesOutput)),
    gates,
    author,
  };

  if (outputJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`Release pipeline completed for ${targetVersion}${dryRun ? " (dry run)" : ""}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPipeline();
}
