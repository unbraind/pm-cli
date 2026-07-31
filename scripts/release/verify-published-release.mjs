#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandFor, fail, flagBool, flagString, parseFlags, runCommand } from "./utils.mjs";

const NPM_PACKAGE =
  process.env.NPM_PACKAGE?.trim() ||
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).name;
const PACKAGE_BINS = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).bin;
const INITIALIZE_REQUEST = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "published-artifact-verifier", version: "1.0.0" },
  },
})}\n`;

function usage() {
  console.log(`Usage:
  node scripts/release/verify-published-release.mjs --version <YYYY.M.D[-N]> [--json]
    [--skip-package]
    [--skip-github-release]
    [--npm-attempts 20]
    [--executor-attempts 10]

Verifies the public release surfaces after publish:
- npm registry metadata
- npx and bunx real CLI command dispatch
- npx and bunx pm-mcp JSON-RPC initialization
- package bin-to-entrypoint coverage and missing-bin negative controls
- GitHub Release metadata
`);
}

function sleep(milliseconds) {
  // Test seam: PM_VERIFY_SLEEP_MS lets the unit suite cap the synchronous
  // retry backoff so it can exercise the multi-attempt path without blocking
  // the worker thread for the production 10–15s propagation delays.
  const override = Number(process.env.PM_VERIFY_SLEEP_MS);
  /* c8 ignore next -- the fallback uses the real 10-15s production backoff; the unit suite always sets PM_VERIFY_SLEEP_MS so exercising it would block the worker thread */
  const effective = Number.isFinite(override) && override >= 0 ? override : milliseconds;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, effective);
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

function runWithRetries(label, attempts, delayMs, action) {
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = action(attempt);
    if (result.ok) {
      return { ...result, attempts: attempt };
    }
    /* c8 ignore next -- every action returns an explicit reason on failure; the "unknown_failure" fallback is defensive */
    failures.push(result.reason ?? "unknown_failure");
    if (attempt < attempts) {
      console.error(`Waiting for ${label} propagation (attempt ${attempt}/${attempts})...`);
      sleep(delayMs);
    }
  }
  return {
    ok: false,
    attempts,
    /* c8 ignore next -- the loop runs at least once and always pushes a failure before this return, so failures.at(-1) is defined */
    reason: failures.at(-1) ?? `${label}_verification_failed`,
  };
}

function verifyNpmMetadata(version, attempts, publicRegistryEnv) {
  const npm = commandFor("npm");
  return runWithRetries("npm metadata", attempts, 15000, () => {
    const result = runCommand(
      npm,
      ["view", `${NPM_PACKAGE}@${version}`, "version", "dist.integrity", "dist.unpackedSize", "--json"],
      { capture: true, allowFailure: true, env: publicRegistryEnv },
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
      /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(error) fallback is unreachable */
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `npm_json_parse_failed:${message}` };
    }
  });
}

function verifyExecutor(name, args, attempts, tempRoot, publicRegistryEnv, assertion, input) {
  return runWithRetries(name, attempts, 10000, () => {
    const result = runCommand(args[0], args.slice(1), {
      cwd: tempRoot,
      capture: true,
      allowFailure: true,
      env: publicRegistryEnv,
      input,
    });
    if (result.status !== 0) {
      return {
        ok: false,
        reason: `${name}_execution_failed:${result.stderr.trim() || "no_output"}`,
      };
    }
    try {
      return assertion(result.stdout);
    } catch (error) {
      /* c8 ignore next -- native JSON parsing/assertions throw Error instances; the String(error) fallback is defensive */
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `${name}_invalid_output:${message}` };
    }
  });
}

function verifyRequiredExecutor(label, args, attempts, tempRoot, publicRegistryEnv, assertion, input) {
  const result = verifyExecutor(
    label,
    args,
    attempts,
    tempRoot,
    publicRegistryEnv,
    assertion,
    input,
  );
  if (!result.ok) {
    fail(`${label} verification failed: ${result.reason}`);
  }
  return result;
}

function assertCliDispatch(stdout) {
  const parsed = JSON.parse(stdout.trim());
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "cli_dispatch_not_an_object" };
  }
  return { ok: true, command: "contracts", output: "json" };
}

function assertMcpInitialize(stdout) {
  const response = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.id === 1);
  if (
    response?.result?.serverInfo?.name !== "pm-mcp" ||
    typeof response.result.protocolVersion !== "string"
  ) {
    return { ok: false, reason: "mcp_initialize_response_invalid" };
  }
  return {
    ok: true,
    server_name: response.result.serverInfo.name,
    protocol_version: response.result.protocolVersion,
  };
}

function verifyMissingBinControl(label, args, tempRoot, publicRegistryEnv) {
  const result = runCommand(args[0], args.slice(1), {
    cwd: tempRoot,
    capture: true,
    allowFailure: true,
    env: publicRegistryEnv,
  });
  if (result.status === 0) {
    fail(`${label} negative control failed: a missing executable exited zero.`);
  }
  return { ok: true, observed_nonzero_status: result.status };
}

function verifyPackageSurfaces(version, npmAttempts, executorAttempts) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-cli-published-verify-"));
  try {
    const npmUserConfig = path.join(tempRoot, "npmrc-public");
    writeFileSync(npmUserConfig, "", "utf8");
    const publicRegistryEnv = {
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
      npm_config_cache: path.join(tempRoot, "npm-cache"),
      npm_config_userconfig: npmUserConfig,
      BUN_INSTALL_CACHE_DIR: path.join(tempRoot, "bun-cache"),
    };
    const npmMetadata = verifyNpmMetadata(
      version,
      npmAttempts,
      publicRegistryEnv,
    );
    if (!npmMetadata.ok) {
      fail(`npm metadata verification failed: ${npmMetadata.reason}`);
    }

    const packageSpec = `${NPM_PACKAGE}@${version}`;
    const npxPm = verifyRequiredExecutor(
      "npx-pm",
      [commandFor("npx"), "--yes", "--package", packageSpec, "--", "pm", "--json", "--no-extensions", "contracts", "--summary"],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertCliDispatch,
    );
    const npxMcp = verifyRequiredExecutor(
      "npx-pm-mcp",
      [commandFor("npx"), "--yes", "--package", packageSpec, "--", "pm-mcp"],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertMcpInitialize,
      INITIALIZE_REQUEST,
    );
    const bunxPm = verifyRequiredExecutor(
      "bunx-pm",
      [commandFor("bunx"), "--silent", "--bun", "--package", packageSpec, "pm", "--json", "--no-extensions", "contracts", "--summary"],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertCliDispatch,
    );
    const bunxMcp = verifyRequiredExecutor(
      "bunx-pm-mcp",
      [commandFor("bunx"), "--silent", "--bun", "--package", packageSpec, "pm-mcp"],
      executorAttempts,
      tempRoot,
      publicRegistryEnv,
      assertMcpInitialize,
      INITIALIZE_REQUEST,
    );
    const negativeControls = {
      npx: verifyMissingBinControl(
        "npx-missing-bin",
        [commandFor("npx"), "--yes", "--package", packageSpec, "--", "pm-definitely-missing"],
        tempRoot,
        publicRegistryEnv,
      ),
      bunx: verifyMissingBinControl(
        "bunx-missing-bin",
        [commandFor("bunx"), "--silent", "--bun", "--package", packageSpec, "pm-definitely-missing"],
        tempRoot,
        publicRegistryEnv,
      ),
    };
    const binEntries = Object.entries(PACKAGE_BINS);
    const coveredEntrypoints = new Set([PACKAGE_BINS.pm, PACKAGE_BINS["pm-mcp"]]);
    const uncoveredBins = binEntries
      .filter(([, entrypoint]) => !coveredEntrypoints.has(entrypoint))
      .map(([bin]) => bin);
    if (uncoveredBins.length > 0) {
      fail(`Published package bins lack executable coverage: ${uncoveredBins.join(", ")}`);
    }
    return {
      npm: npmMetadata,
      executors: {
        npx: { pm: npxPm, "pm-mcp": npxMcp },
        bunx: { pm: bunxPm, "pm-mcp": bunxMcp },
      },
      negative_controls: negativeControls,
      bin_coverage: {
        covered_bins: binEntries.map(([bin]) => bin).sort(),
        distinct_entrypoints: [...new Set(binEntries.map(([, entrypoint]) => entrypoint))].sort(),
        uncovered_bins: uncoveredBins,
      },
    };
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
    /* c8 ignore next -- JSON.parse only throws SyntaxError (an Error); the String(error) fallback is unreachable */
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
