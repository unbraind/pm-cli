#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandFor, fail, flagBool, flagString, parseFlags, runCommand } from "./utils.mjs";

function usage() {
  console.log(`Usage:
  node scripts/release/verify-published-release.mjs --version <YYYY.M.D[-N]> [--json]
    [--skip-package]
    [--skip-github-release]
    [--npm-attempts 20]
    [--executor-attempts 10]

Verifies the public release surfaces after publish:
- npm registry metadata
- npx package execution
- bunx package execution
- GitHub Release metadata
`);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseVersionFromFlags(flags) {
  const explicitVersion = flagString(flags, "version", null);
  const tag = flagString(flags, "tag", null);
  const version = explicitVersion ?? (tag ? tag.replace(/^v/u, "") : null);
  if (!version) {
    fail("Missing --version <YYYY.M.D[-N]> or --tag v<YYYY.M.D[-N]>.");
  }
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/u.test(version)) {
    fail(`Invalid release version "${version}".`);
  }
  return version;
}

function parsePositiveInteger(flags, key, fallback) {
  const raw = flagString(flags, key, String(fallback));
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`Invalid --${key} value "${raw}".`);
  }
  return parsed;
}

function lastNonEmptyLine(value) {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

function runWithRetries(label, attempts, delayMs, action) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = action(attempt);
    if (result.ok) {
      return { ...result, attempts: attempt };
    }
    failures.push(result.reason ?? "unknown_failure");
    if (attempt < attempts) {
      console.error(`Waiting for ${label} propagation (attempt ${attempt}/${attempts})...`);
      sleep(delayMs);
    }
  }
  return {
    ok: false,
    attempts,
    reason: failures.at(-1) ?? `${label}_verification_failed`,
  };
}

function verifyNpmMetadata(version, attempts) {
  const npm = commandFor("npm");
  return runWithRetries("npm metadata", attempts, 15000, () => {
    const result = runCommand(
      npm,
      ["view", `@unbrained/pm-cli@${version}`, "version", "dist.integrity", "dist.unpackedSize", "--json"],
      { capture: true, allowFailure: true },
    );
    if (result.status !== 0) {
      return { ok: false, reason: result.stderr.trim() || "npm_view_failed" };
    }
    try {
      const metadata = JSON.parse(result.stdout);
      if (metadata.version !== version) {
        return { ok: false, reason: `npm_version_mismatch:${metadata.version ?? "missing"}` };
      }
      return { ok: true, metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `npm_json_parse_failed:${message}` };
    }
  });
}

function verifyExecutor(name, args, version, attempts, tempRoot) {
  return runWithRetries(name, attempts, 10000, () => {
    const result = runCommand(args[0], args.slice(1), {
      cwd: tempRoot,
      capture: true,
      allowFailure: true,
    });
    const observed = lastNonEmptyLine(result.stdout);
    if (result.status === 0 && observed === version) {
      return { ok: true, version: observed };
    }
    return {
      ok: false,
      reason: `${name}_version_mismatch:${observed || result.stderr.trim() || "no_output"}`,
    };
  });
}

function verifyPackageSurfaces(version, npmAttempts, executorAttempts) {
  const npmMetadata = verifyNpmMetadata(version, npmAttempts);
  if (!npmMetadata.ok) {
    fail(`npm metadata verification failed: ${npmMetadata.reason}`);
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-cli-published-verify-"));
  try {
    const npxDirect = verifyExecutor(
      "npx-direct",
      [commandFor("npx"), "--yes", `@unbrained/pm-cli@${version}`, "--version"],
      version,
      executorAttempts,
      tempRoot,
    );
    if (!npxDirect.ok) {
      fail(`direct npx verification failed: ${npxDirect.reason}`);
    }

    const npxPackage = verifyExecutor(
      "npx-package",
      [commandFor("npx"), "--yes", "--package", `@unbrained/pm-cli@${version}`, "--", "pm", "--version"],
      version,
      executorAttempts,
      tempRoot,
    );
    if (!npxPackage.ok) {
      fail(`explicit npx package verification failed: ${npxPackage.reason}`);
    }

    const bunx = verifyExecutor(
      "bunx",
      [commandFor("bunx"), "--bun", `@unbrained/pm-cli@${version}`, "pm", "--version"],
      version,
      executorAttempts,
      tempRoot,
    );
    if (!bunx.ok) {
      fail(`bunx verification failed: ${bunx.reason}`);
    }

    return { npm: npmMetadata, npx_direct: npxDirect, npx_package: npxPackage, bunx };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function verifyGitHubRelease(version) {
  const tagName = `v${version}`;
  const result = runCommand(
    commandFor("gh"),
    ["release", "view", tagName, "--json", "tagName,name,isDraft,isPrerelease,url"],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) {
    fail(`GitHub release verification failed: ${result.stderr.trim() || "gh_release_view_failed"}`);
  }
  try {
    const metadata = JSON.parse(result.stdout);
    if (metadata.tagName !== tagName) {
      fail(`GitHub release tag mismatch: expected ${tagName}, received ${metadata.tagName ?? "missing"}.`);
    }
    if (metadata.isDraft === true || metadata.isPrerelease === true) {
      fail(`GitHub release ${tagName} must not be draft/prerelease.`);
    }
    return metadata;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`GitHub release JSON parse failed: ${message}`);
  }
}

function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.get("help") || flags.get("h")) {
    usage();
    return;
  }

  const outputJson = flagBool(flags, "json", false);
  const skipPackage = flagBool(flags, "skip-package", false);
  const skipGithubRelease = flagBool(flags, "skip-github-release", false);
  const npmAttempts = parsePositiveInteger(flags, "npm-attempts", 20);
  const executorAttempts = parsePositiveInteger(flags, "executor-attempts", 10);
  const version = parseVersionFromFlags(flags);

  const result = {
    ok: true,
    version,
    package: skipPackage ? { skipped: true } : verifyPackageSurfaces(version, npmAttempts, executorAttempts),
    github_release: skipGithubRelease ? { skipped: true } : verifyGitHubRelease(version),
  };

  if (outputJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`Published release ${version} verified.`);
}

main();
