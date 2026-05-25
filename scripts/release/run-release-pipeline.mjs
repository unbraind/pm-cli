#!/usr/bin/env node

import { readFileSync } from "node:fs";
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

function usage() {
  console.log(`Usage:
  node scripts/release/run-release-pipeline.mjs [--json]
    [--version <YYYY.M.D[-N]>]
    [--allow-same-day-release]
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

function getLastTag() {
  const result = git(["describe", "--tags", "--abbrev=0"], { allowFailure: true });
  if (result.status !== 0) {
    return null;
  }
  const tag = result.stdout.trim();
  return tag.length > 0 ? tag : null;
}

function getCommitCountSince(lastTag) {
  if (!lastTag) {
    const all = git(["rev-list", "--count", "HEAD"]);
    return Number(all.stdout.trim() || "0");
  }
  const result = git(["rev-list", "--count", `${lastTag}..HEAD`]);
  return Number(result.stdout.trim() || "0");
}

function getChangedFilesSince(lastTag) {
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

function listTodayTags(todayKey) {
  const result = git(["tag", "--list", `v${todayKey}*`]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function ensureCleanWorkingTree() {
  const status = git(["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    fail("Release pipeline requires a clean working tree.");
  }
}

function resolveVersion(explicitVersion, allowSameDayRelease, todayKey) {
  if (explicitVersion) {
    return explicitVersion;
  }
  if (!allowSameDayRelease) {
    return todayKey;
  }
  const next = runCommand(process.execPath, ["scripts/release-version.mjs", "next"], { capture: true });
  const version = next.stdout.trim();
  if (!version) {
    fail("Failed to resolve next release version.");
  }
  return version;
}

function bumpSameDayOrdinal(version, todayKey) {
  const match = version.match(/^(\d{4}\.\d{1,2}\.\d{1,2})(?:-(\d+))?$/);
  if (!match || match[1] !== todayKey) {
    fail(
      `Automatic same-day ordinal bump requires package version to use today's date (${todayKey}); current=${version}.`,
    );
  }
  const currentOrdinal = match[2] ? Number(match[2]) : 1;
  return `${todayKey}-${currentOrdinal + 1}`;
}

function parseCalendarVersion(version) {
  const match = version.match(/^(\d{4}\.\d{1,2}\.\d{1,2})(?:-(\d+))?$/);
  if (!match) {
    return null;
  }
  return {
    dateKey: match[1],
    ordinal: match[2] ? Number(match[2]) : 1,
  };
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return packageJson.version;
}

function extractGeneratedChangelogSection(changelog, heading) {
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

function ensureGeneratedReleaseSectionHasContent(version) {
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  const section = extractGeneratedChangelogSection(changelog, version);
  if (!section) {
    fail(`Generated CHANGELOG.md is missing a non-empty section for ${version}.`);
  }
}

function runReleaseGates(options) {
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

function runPipeline() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const allowSameDayRelease = flagBool(flags, "allow-same-day-release", false);
  const dryRun = flagBool(flags, "dry-run", false);
  const push = flagBool(flags, "push", false);
  const telemetryMode = flagString(flags, "telemetry-mode", "best-effort");
  const skipCompatibility = flagBool(flags, "skip-compatibility", false);
  const skipTelemetrySentry = flagBool(flags, "skip-telemetry-sentry", false);
  const explicitVersion = flagString(flags, "version", null);
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
  if (commitsSinceLastTag === 0) {
    const result = {
      ok: true,
      skipped: true,
      reason: "no_changes_since_last_tag",
      last_tag: lastTag,
    };
    if (outputJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log("No changes since the last release tag. Skipping release pipeline.");
    }
    return;
  }

  const changedFilesSinceLastTag = getChangedFilesSince(lastTag);
  const releaseRelevantFiles = changedFilesSinceLastTag.filter(isReleaseRelevantPath);
  if (releaseRelevantFiles.length === 0) {
    const result = {
      ok: true,
      skipped: true,
      reason: "tracker_only_changes_since_last_tag",
      last_tag: lastTag,
      commits_since_last_tag: commitsSinceLastTag,
      ignored_change_paths: changedFilesSinceLastTag,
    };
    if (outputJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log("Only .agents/pm tracker changes exist since the last release tag. Skipping release pipeline.");
    }
    return;
  }

  const todayKey = utcDateKey();
  const tagsToday = listTodayTags(todayKey);
  if (!allowSameDayRelease && tagsToday.length > 0) {
    const result = {
      ok: true,
      skipped: true,
      reason: "release_already_cut_today",
      tags_today: tagsToday,
      date_key: todayKey,
    };
    if (outputJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(`Release already exists for ${todayKey}: ${tagsToday.join(", ")}. Skipping.`);
    }
    return;
  }

  const previousVersion = readPackageVersion();
  let targetVersion = resolveVersion(explicitVersion, allowSameDayRelease, todayKey);
  if (allowSameDayRelease && !explicitVersion) {
    const previousParsed = parseCalendarVersion(previousVersion);
    const targetParsed = parseCalendarVersion(targetVersion);
    if (
      previousParsed &&
      targetParsed &&
      previousParsed.dateKey === todayKey &&
      targetParsed.dateKey === todayKey &&
      targetParsed.ordinal <= previousParsed.ordinal
    ) {
      targetVersion = bumpSameDayOrdinal(previousVersion, todayKey);
    }
  }
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/.test(targetVersion)) {
    fail(`Unsupported target version "${targetVersion}".`);
  }

  if (!dryRun) {
    const npm = commandFor("npm");
    runCommand(npm, ["version", "--no-git-tag-version", targetVersion]);
    runCommand(process.execPath, ["dist/cli.js", "install", "npm:pm-changelog", "--project"]);
    runCommand(process.execPath, [
      "dist/cli.js",
      "changelog",
      "generate",
      "--output",
      "CHANGELOG.md",
      "--title",
      "Changelog",
      "--mode",
      "replace",
      "--release-version",
      targetVersion,
      "--all-release-tags",
      "--status",
      "closed",
      "--item-url-base",
      "https://github.com/unbraind/pm-cli/blob/main/.agents/pm",
    ]);
    ensureGeneratedReleaseSectionHasContent(targetVersion);
  }

  const gates = runReleaseGates({
    telemetryMode,
    skipCompatibility,
    skipTelemetrySentry,
  });
  if (gates.ok !== true) {
    fail("Release gates did not report ok=true.");
  }

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
    const authorSlug = author.toLowerCase().replaceAll(/[^a-z0-9._-]/g, "-");
    const authorEmail = `${authorSlug || "release-bot"}@users.noreply.github.com`;
    const gitIdentityEnv = {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: authorEmail,
    };
    git(["add", "package.json", "CHANGELOG.md"]);
    runCommand("git", [
      "commit",
      "-m",
      `chore(release): cut ${targetVersion}\n\nAutomate daily release preparation with strict quality, compatibility, and reliability gates.`,
    ], { env: gitIdentityEnv });
    git(["tag", tagName]);
    if (push) {
      git(["push", "origin", "HEAD"]);
      git(["push", "origin", tagName]);
    }
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
