#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/generate-release-notes.mjs [--version <version>] [--from <tag>] [--output <path>]

Builds GitHub release notes from CHANGELOG.md plus sanitized pm tracker metadata.
`);
}

function parseArgs(argv) {
  const flags = {
    version: null,
    from: null,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--version") {
      flags.version = argv[index + 1] ?? null;
      if (!flags.version) fail("--version requires a value.");
      index += 1;
      continue;
    }
    if (arg === "--from") {
      flags.from = argv[index + 1] ?? null;
      if (!flags.from) fail("--from requires a value.");
      index += 1;
      continue;
    }
    if (arg === "--output") {
      flags.output = argv[index + 1] ?? null;
      if (!flags.output) fail("--output requires a value.");
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    fail(`Unknown flag "${arg}". Use --help for usage.`);
  }
  return flags;
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
    fail("package.json is missing a valid version.");
  }
  return packageJson.version;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function resolvePreviousTag(currentTag) {
  try {
    const tags = git(["tag", "--merged", "HEAD", "--sort=-v:refname"])
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && tag !== currentTag);
    return tags[0] ?? null;
  } catch {
    return null;
  }
}

function resolveTagDate(tag) {
  if (!tag) {
    return null;
  }
  try {
    return git(["log", "-1", "--format=%cI", tag]);
  } catch {
    return null;
  }
}

function extractChangelogSection(changelog, heading) {
  const lines = changelog.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${heading}]`));
  if (start === -1) {
    return null;
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

function extractUnreleasedSection(changelog) {
  return extractChangelogSection(changelog, "Unreleased");
}

function loadPmItems() {
  const cliPath = path.join(repoRoot, "dist", "cli.js");
  if (!existsSync(cliPath)) {
    return { items: [], warning: "dist/cli.js is not built; pm tracker summary skipped." };
  }
  try {
    const output = execFileSync(process.execPath, [cliPath, "list-all", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PM_AUTHOR: process.env.PM_AUTHOR || "release-notes",
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(output);
    return { items: Array.isArray(parsed.items) ? parsed.items : [], warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { items: [], warning: `pm tracker summary skipped: ${message}` };
  }
}

function formatPmSummary(items, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
  const changed = items
    .filter((item) => {
      const updated = typeof item.updated_at === "string" ? Date.parse(item.updated_at) : Number.NaN;
      return Number.isFinite(updated) && updated >= since;
    })
    .sort((left, right) => {
      const priorityDelta = Number(left.priority ?? 99) - Number(right.priority ?? 99);
      if (priorityDelta !== 0) return priorityDelta;
      return String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
    });

  if (changed.length === 0) {
    return ["No pm tracker items were updated in the selected release window."];
  }

  const byType = new Map();
  const byStatus = new Map();
  for (const item of changed) {
    byType.set(item.type ?? "Unknown", (byType.get(item.type ?? "Unknown") ?? 0) + 1);
    byStatus.set(item.status ?? "unknown", (byStatus.get(item.status ?? "unknown") ?? 0) + 1);
  }

  const lines = [
    `Updated pm items in release window: ${changed.length}`,
    `By type: ${[...byType.entries()].map(([key, value]) => `${key}=${value}`).join(", ")}`,
    `By status: ${[...byStatus.entries()].map(([key, value]) => `${key}=${value}`).join(", ")}`,
    "",
    "Selected release-related tracker items:",
  ];

  const releaseRelated = changed.filter((item) => {
    const title = typeof item.title === "string" ? item.title.toLowerCase() : "";
    const status = typeof item.status === "string" ? item.status : "unknown";
    const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).toLowerCase()) : [];
    if (status === "canceled") {
      return false;
    }
    return (
      title.includes("release") ||
      title.includes("compatib") ||
      tags.some((tag) => ["release", "compatibility", "migration", "changelog", "publishing"].includes(tag))
    );
  });

  if (releaseRelated.length === 0) {
    lines.push("- No release-tagged pm items found in the selected window.");
    return lines;
  }

  for (const item of releaseRelated.slice(0, 20)) {
    const id = typeof item.id === "string" ? item.id : "unknown";
    const title = typeof item.title === "string" ? item.title : "Untitled";
    const type = typeof item.type === "string" ? item.type : "Unknown";
    const status = typeof item.status === "string" ? item.status : "unknown";
    lines.push(`- ${id} [${type}/${status}] ${title}`);
  }
  if (releaseRelated.length > 20) {
    lines.push(`- ... ${releaseRelated.length - 20} more release-related tracker items omitted from release notes.`);
  }
  return lines;
}

function buildNotes({ version, previousTag }) {
  const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const changelogSection = extractChangelogSection(changelog, version) ?? extractUnreleasedSection(changelog);
  if (!changelogSection) {
    fail(`Could not find CHANGELOG.md section for ${version} or [Unreleased].`);
  }

  const currentTag = `v${version}`;
  const resolvedPreviousTag = previousTag ?? resolvePreviousTag(currentTag);
  const previousDate = resolveTagDate(resolvedPreviousTag);
  const { items, warning } = loadPmItems();
  const pmLines = warning ? [warning] : formatPmSummary(items, previousDate);

  return [
    `# @unbrained/pm-cli ${version}`,
    "",
    `Source range: ${resolvedPreviousTag ?? "initial"}...${currentTag}`,
    "",
    "## Changelog",
    "",
    changelogSection,
    "",
    "## PM Tracker Evidence",
    "",
    ...pmLines,
    "",
  ].join("\n");
}

const flags = parseArgs(process.argv.slice(2));
const version = flags.version ?? readPackageVersion();
const notes = buildNotes({ version, previousTag: flags.from });

if (flags.output) {
  const outputPath = path.resolve(repoRoot, flags.output);
  writeFileSync(outputPath, notes, "utf8");
  console.log(`Wrote release notes to ${path.relative(repoRoot, outputPath)}`);
} else {
  process.stdout.write(notes);
}
