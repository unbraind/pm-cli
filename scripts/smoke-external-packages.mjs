#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const defaultQuery = "keywords:pm-package";
const ecosystemMarkers = ["pm-package", "pm-cli", "pm-extension", "pm-cli-extension"];

function parseArgs(argv) {
  const options = {
    query: defaultQuery,
    limit: 10,
    packages: [],
    keepTemp: false,
    discoverOnly: false,
    timeoutMs: 120_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--query") {
      options.query = requireValue(argv, (index += 1), arg);
    } else if (arg === "--limit") {
      options.limit = parsePositiveInteger(requireValue(argv, (index += 1), arg), arg);
    } else if (arg === "--package") {
      options.packages.push(normalizePackageName(requireValue(argv, (index += 1), arg)));
    } else if (arg === "--packages") {
      const value = requireValue(argv, (index += 1), arg);
      options.packages.push(
        ...value
          .split(",")
          .map((entry) => normalizePackageName(entry.trim()))
          .filter(Boolean),
      );
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(requireValue(argv, (index += 1), arg), arg);
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--discover-only") {
      options.discoverOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function normalizePackageName(value) {
  return value.startsWith("npm:") ? value.slice("npm:".length) : value;
}

function printHelp() {
  console.log(`Usage: node scripts/smoke-external-packages.mjs [options]

Discover and smoke-test external npm pm packages in isolated tracker roots.

Options:
  --query <text>        npm search query (default: "${defaultQuery}")
  --limit <n>           maximum discovered packages to test (default: 10)
  --package <name>      test one package; repeatable, accepts optional npm: prefix
  --packages <list>     comma-separated package list
  --timeout-ms <n>      timeout for each pm/npm command (default: 120000)
  --discover-only       print discovered package names without installing
  --keep-temp           keep temp roots for debugging
`);
}

function runCommand(command, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  const tookMs = Date.now() - startedAt;
  return {
    code: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error ? result.error.message : ""),
    took_ms: tookMs,
    command: [command, ...args].join(" "),
  };
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function summarizeFailure(result) {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return [stderr, stdout].filter(Boolean).join("\n").slice(0, 4000);
}

function discoverPackages(options) {
  if (options.packages.length > 0) {
    return [...new Set(options.packages)].slice(0, options.limit);
  }
  const result = runCommand("npm", ["search", options.query, "--json", "--searchlimit", String(options.limit)], {
    timeoutMs: options.timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(`npm search failed: ${summarizeFailure(result)}`);
  }
  const payload = parseJsonOutput(result, "npm search");
  if (!Array.isArray(payload)) {
    throw new Error("npm search returned a non-array payload");
  }
  return [...new Set(payload.filter(isPmPackageSearchResult).map((entry) => entry.name))].slice(0, options.limit);
}

function isPmPackageSearchResult(entry) {
  if (!entry || typeof entry.name !== "string" || entry.name.length === 0) {
    return false;
  }
  const keywords = Array.isArray(entry.keywords)
    ? entry.keywords
    : typeof entry.keywords === "string"
      ? entry.keywords.split(/[\s,]+/)
      : [];
  const haystack = [entry.name, entry.description, ...keywords]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return ecosystemMarkers.some((marker) => haystack.includes(marker));
}

function assertCliBuilt() {
  const result = runCommand(process.execPath, [cliPath, "--version"], { timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(`dist CLI is not runnable; run pnpm build first.\n${summarizeFailure(result)}`);
  }
  return result.stdout.trim();
}

function runPm(label, args, env, options) {
  const result = runCommand(process.execPath, [cliPath, "--json", ...args], {
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs,
  });
  const entry = { label, code: result.code, took_ms: result.took_ms };
  if (result.code !== 0) {
    entry.error = summarizeFailure(result);
    return { entry, payload: null };
  }
  try {
    return { entry, payload: parseJsonOutput(result, label) };
  } catch (error) {
    entry.code = 1;
    entry.error = error instanceof Error ? error.message : String(error);
    return { entry, payload: null };
  }
}

function smokePackage(packageName, options) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pm-external-package-smoke-"));
  const commands = [];
  const startedAt = Date.now();

  try {
    const projectRoot = path.join(tempRoot, "project");
    const pmPath = path.join(projectRoot, ".agents", "pm");
    const globalPath = path.join(tempRoot, "global");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(globalPath, { recursive: true });
    writeFileSync(path.join(projectRoot, "README.md"), "# External package smoke project\n", "utf8");

    const env = {
      ...process.env,
      PM_PATH: pmPath,
      PM_GLOBAL_PATH: globalPath,
      PM_AUTHOR: "external-package-smoke",
      PM_TELEMETRY_SOURCE_CONTEXT: process.env.PM_TELEMETRY_SOURCE_CONTEXT || "external-package-smoke",
    };

    function record(label, args) {
      const result = runPm(label, args, env, {
        cwd: projectRoot,
        timeoutMs: options.timeoutMs,
      });
      commands.push(result.entry);
      if (result.entry.code !== 0) {
        throw new Error(result.entry.error || `${label} failed`);
      }
      return result.payload;
    }

    record("init", ["init", "--defaults", "--author", "external-package-smoke"]);
    const install = record("install", ["install", `npm:${packageName}`, "--project"]);
    const doctor = record("package doctor", ["package", "doctor", "--project", "--detail", "deep", "--trace"]);
    const contracts = record("runtime contracts", ["contracts", "--runtime-only", "--availability-only"]);

    const summary = doctor?.details?.summary ?? {};
    const activationFailures = summary.activation_failure_count ?? 0;
    const blockingFailures = summary.blocking_failure_count ?? 0;
    if (activationFailures > 0 || blockingFailures > 0) {
      throw new Error(`package doctor reported activation=${activationFailures} blocking=${blockingFailures}`);
    }

    const availableActions = Array.isArray(contracts?.action_availability)
      ? contracts.action_availability
          .filter((entry) => entry?.invocable === true && typeof entry.action === "string")
          .map((entry) => entry.action)
      : [];
    return {
      package: packageName,
      ok: true,
      took_ms: Date.now() - startedAt,
      temp_root: options.keepTemp ? tempRoot : undefined,
      installed_count: install?.details?.installed_count ?? null,
      activation_failure_count: activationFailures,
      blocking_failure_count: blockingFailures,
      warning_codes: doctor?.details?.triage?.warning_codes ?? [],
      available_runtime_actions: availableActions,
      commands,
    };
  } catch (error) {
    return {
      package: packageName,
      ok: false,
      took_ms: Date.now() - startedAt,
      temp_root: options.keepTemp ? tempRoot : undefined,
      error: error instanceof Error ? error.message : String(error),
      commands,
    };
  } finally {
    if (!options.keepTemp) {
      try {
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (cleanupError) {
        console.error(
          `Warning: failed to clean up temp directory ${tempRoot}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      }
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = assertCliBuilt();
  const packages = discoverPackages(options);
  if (options.discoverOnly) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "discover",
          query: options.query,
          limit: options.limit,
          filters: { markers: ecosystemMarkers },
          packages,
        },
        null,
        2,
      ),
    );
    return;
  }
  const results = packages.map((packageName) => smokePackage(packageName, options));
  const failed = results.filter((entry) => !entry.ok);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        cli_version: version,
        query: options.packages.length > 0 ? null : options.query,
        limit: options.limit,
        filters: options.packages.length > 0 ? null : { markers: ecosystemMarkers },
        tested: results.length,
        failed: failed.length,
        results,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
