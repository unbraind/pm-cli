#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^([1-9]\d{3})\.([1-9]\d*)\.([1-9]\d*)(?:-([1-9]\d*))?$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/release-version.mjs check [--tag <vX.Y.Z>] [--verify-next] [--date <YYYY.M.D>]
  node scripts/release-version.mjs next [--date <YYYY.M.D>]

Rules:
  - Version format: YYYY.M.D or YYYY.M.D-N
  - N is the release number for that day and must be >= 2 when present
  - Month/day must be valid calendar values
`);
}

function parseDateKey(input) {
  const match = input.match(VERSION_PATTERN);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return `${year}.${month}.${day}`;
}

function parseVersion(version) {
  const match = version.match(VERSION_PATTERN);
  if (!match) {
    fail(
      `Invalid version "${version}". Expected YYYY.M.D or YYYY.M.D-N (SemVer compatible, no zero padding).`,
    );
  }

  const dateKey = parseDateKey(`${match[1]}.${match[2]}.${match[3]}`);
  if (!dateKey) {
    fail(`Version "${version}" uses an invalid calendar date.`);
  }

  const ordinal = match[4] ? Number(match[4]) : null;
  if (ordinal === 1) {
    fail(`Version "${version}" is invalid: omit suffix for first release of a day (use YYYY.M.D).`);
  }

  return {
    version,
    dateKey,
    ordinal,
  };
}

function readPackageJson() {
  const currentFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(currentFile), "..");
  const raw = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    fail("package.json is missing a valid \"name\".");
  }
  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    fail("package.json is missing a valid \"version\".");
  }
  return parsed;
}

function getUtcDateKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
}

function resolveDateKey(flagValue) {
  if (!flagValue) {
    return getUtcDateKey();
  }
  const dateKey = parseDateKey(flagValue);
  if (!dateKey) {
    fail(`Invalid --date value "${flagValue}". Expected YYYY.M.D with a valid calendar date.`);
  }
  return dateKey;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function listPublishedVersions(packageName) {
  let output = "";
  try {
    output = execFileSync(npmCommand(), ["view", packageName, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderrRaw = typeof error === "object" && error !== null && "stderr" in error ? error.stderr : "";
    const stderr =
      typeof stderrRaw === "string"
        ? stderrRaw
        : stderrRaw instanceof Buffer
          ? stderrRaw.toString("utf8")
          : "";
    if (stderr.includes("E404") || stderr.includes("404 Not Found")) {
      return [];
    }
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to query npm registry for ${packageName}: ${message}`);
  }

  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to parse npm versions JSON: ${message}`);
  }

  if (Array.isArray(parsed)) {
    return parsed.filter((entry) => typeof entry === "string");
  }
  if (typeof parsed === "string") {
    return [parsed];
  }
  return [];
}

function nextVersionForDate(packageName, dateKey) {
  const publishedVersions = listPublishedVersions(packageName);
  const releasesOnDate = publishedVersions.filter((version) => {
    const match = version.match(VERSION_PATTERN);
    if (!match) {
      return false;
    }
    const candidateDate = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
    return candidateDate === dateKey;
  });

  if (releasesOnDate.length === 0) {
    return dateKey;
  }
  return `${dateKey}-${releasesOnDate.length + 1}`;
}

function parseFlags(args) {
  const flags = {
    tag: null,
    verifyNext: false,
    date: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--verify-next") {
      flags.verifyNext = true;
      continue;
    }
    if (arg === "--tag") {
      const value = args[i + 1];
      if (!value) {
        fail("--tag requires a value.");
      }
      flags.tag = value;
      i += 1;
      continue;
    }
    if (arg === "--date") {
      const value = args[i + 1];
      if (!value) {
        fail("--date requires a value.");
      }
      flags.date = value;
      i += 1;
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

function runCheck(flags) {
  const pkg = readPackageJson();
  const parsedVersion = parseVersion(pkg.version);

  if (flags.tag) {
    const expectedTag = `v${pkg.version}`;
    if (flags.tag !== expectedTag) {
      fail(`Tag/version mismatch: tag=${flags.tag}, expected=${expectedTag}.`);
    }
  }

  if (flags.verifyNext) {
    const expectedDate = resolveDateKey(flags.date);
    if (parsedVersion.dateKey !== expectedDate) {
      fail(
        `Version date mismatch: package version date is ${parsedVersion.dateKey}, expected ${expectedDate}.`,
      );
    }

    const expectedNext = nextVersionForDate(pkg.name, expectedDate);
    if (pkg.version !== expectedNext) {
      fail(
        `Version sequencing mismatch: package.json has ${pkg.version}, expected next release version ${expectedNext}.`,
      );
    }
  }

  console.log(`Version policy check passed (${pkg.version}).`);
}

function runNext(flags) {
  const pkg = readPackageJson();
  const dateKey = resolveDateKey(flags.date);
  const next = nextVersionForDate(pkg.name, dateKey);
  console.log(next);
}

const command = process.argv[2] ?? "check";
const flags = parseFlags(process.argv.slice(3));

if (command === "check") {
  runCheck(flags);
} else if (command === "next") {
  runNext(flags);
} else if (command === "-h" || command === "--help") {
  usage();
} else {
  fail(`Unknown command "${command}". Use "check" or "next".`);
}
