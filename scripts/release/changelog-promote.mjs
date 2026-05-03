#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fail, flagBool, flagString, parseFlags, repoRoot, requireFlag, utcIsoDate } from "./utils.mjs";

export function promoteUnreleasedSection(changelogContent, version, isoDate) {
  const normalized = changelogContent.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const unreleasedIndex = lines.findIndex((line) => line.startsWith("## [Unreleased]"));
  if (unreleasedIndex === -1) {
    fail('CHANGELOG.md is missing the "## [Unreleased]" section.');
  }
  const nextSectionIndex = lines.findIndex((line, index) => index > unreleasedIndex && line.startsWith("## ["));
  const existingVersionIndex = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (existingVersionIndex !== -1) {
    fail(`CHANGELOG.md already contains a section for ${version}.`);
  }

  const unreleasedBodyLines = lines.slice(unreleasedIndex + 1, nextSectionIndex === -1 ? undefined : nextSectionIndex);
  const unreleasedBody = unreleasedBodyLines.join("\n").trim();
  if (unreleasedBody.length === 0) {
    fail("CHANGELOG.md [Unreleased] section is empty; there are no changes to promote.");
  }

  const promotedSection = [`## [${version}] - ${isoDate}`, "", unreleasedBody, ""];
  const newLines = [
    ...lines.slice(0, unreleasedIndex + 1),
    "",
    ...promotedSection,
    ...lines.slice(nextSectionIndex === -1 ? lines.length : nextSectionIndex),
  ];

  const rewritten = `${newLines.join("\n").replaceAll(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  return rewritten;
}

function usage() {
  console.log(`Usage:
  node scripts/release/changelog-promote.mjs --version <version> [--date YYYY-MM-DD] [--file CHANGELOG.md] [--dry-run]

Promotes CHANGELOG [Unreleased] content into a versioned entry and resets [Unreleased].
`);
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const version = requireFlag(flags, "version", "--version is required.");
  const isoDate = flagString(flags, "date", utcIsoDate());
  const relativeFile = flagString(flags, "file", "CHANGELOG.md");
  const dryRun = flagBool(flags, "dry-run", false);
  const outputJson = flagBool(flags, "json", false);

  if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/.test(version)) {
    fail(`Unsupported version format "${version}". Expected YYYY.M.D or YYYY.M.D-N.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    fail(`Unsupported --date value "${isoDate}". Expected YYYY-MM-DD.`);
  }

  const changelogPath = path.resolve(repoRoot, relativeFile);
  const currentContent = readFileSync(changelogPath, "utf8");
  const nextContent = promoteUnreleasedSection(currentContent, version, isoDate);

  if (!dryRun) {
    writeFileSync(changelogPath, nextContent, "utf8");
  }

  if (outputJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          path: path.relative(repoRoot, changelogPath),
          version,
          date: isoDate,
          dry_run: dryRun,
          changed: currentContent !== nextContent,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const mode = dryRun ? "Dry run" : "Updated";
  console.log(`${mode} ${path.relative(repoRoot, changelogPath)} for ${version} (${isoDate}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
