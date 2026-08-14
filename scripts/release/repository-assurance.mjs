#!/usr/bin/env node

/**
 * Execute repository-owned quality adapters through the public assurance SDK.
 *
 * The assurance registry owns policy and composition. This host only maps a
 * declared provider key onto the existing deterministic process-boundary gate.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAssuranceAction } from "../../dist/sdk/governance.js";
import {
  commandFor,
  fail,
  flagBool,
  flagString,
  parseFlags,
  repoRoot,
  runCommand,
} from "./utils.mjs";

/** Stable provider id declared by repository assurance measurements. */
export const REPOSITORY_QUALITY_PROVIDER = "repository-quality";

/** Default wall-clock bound for one repository quality adapter process. */
const DEFAULT_ADAPTER_TIMEOUT_MS = 300_000;

const DEFAULT_REGISTRY_PATH = path.join(
  repoRoot,
  "scripts",
  "release",
  "gate-registry.json",
);

/** Read the provider migration inventory keyed by provider-owned measurement. */
export async function readRepositoryProviderEntries(
  registryPath = DEFAULT_REGISTRY_PATH,
) {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const entries = new Map();
  for (const entry of [
    ...(registry.automation_inventory?.gate_scripts ?? []),
    ...(registry.automation_inventory?.provider_checks ?? []),
  ]) {
    if (
      entry.disposition !== "reduced_to_provider" &&
      entry.kind !== "provider_check"
    ) {
      continue;
    }
    if (typeof entry.provider !== "string") {
      throw new TypeError(
        `Repository assurance inventory ${String(entry.path)} has no string provider`,
      );
    }
    if (!entry.provider.startsWith(`${REPOSITORY_QUALITY_PROVIDER}/`)) {
      continue;
    }
    const key = entry.provider.slice(REPOSITORY_QUALITY_PROVIDER.length + 1);
    const existing = entries.get(key);
    if (existing) {
      throw new TypeError(
        `Repository assurance provider ${entry.provider} is duplicated by ${String(existing.path)} and ${String(entry.path)}`,
      );
    }
    entries.set(key, entry);
  }
  return entries;
}

/** Resolve one provider measurement by executing its inventoried adapter. */
export async function resolveRepositoryQualityMeasurement(
  source,
  { entries, registryPath = DEFAULT_REGISTRY_PATH, execute = runCommand } = {},
) {
  if (source.provider !== REPOSITORY_QUALITY_PROVIDER) {
    throw new TypeError(
      `Unsupported repository assurance provider ${source.provider}`,
    );
  }
  const providerEntries =
    entries ?? (await readRepositoryProviderEntries(registryPath));
  const entry = providerEntries.get(source.key);
  if (!entry) {
    throw new TypeError(
      `Repository assurance key ${source.key} is not declared`,
    );
  }
  const scriptPath = path.join(repoRoot, entry.path);
  const prefix = entry.path.endsWith(".mts")
    ? { command: commandFor("pnpm"), args: ["exec", "tsx", scriptPath] }
    : { command: process.execPath, args: [scriptPath] };
  const executable = {
    command: prefix.command,
    args: [...prefix.args, ...(entry.provider_args ?? [])],
  };
  const timeout = entry.provider_timeout_ms ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const timeoutIsValid = [Number.isInteger(timeout), timeout > 0].every(
    Boolean,
  );
  if (!timeoutIsValid) {
    throw new TypeError(
      `Repository assurance key ${source.key} has invalid provider_timeout_ms ${String(timeout)}`,
    );
  }
  if (entry.provider_negative_args) {
    const negativeResult = execute(
      executable.command,
      [...prefix.args, ...entry.provider_negative_args],
      { allowFailure: true, capture: true, timeout },
    );
    if (negativeResult.status !== 0) {
      return {
        value: 0,
        population_size: 1,
        cost: 1,
        contributors: [
          `${entry.path}:negative-control:exit:${negativeResult.status}`,
        ],
      };
    }
  }
  const result = execute(executable.command, executable.args, {
    allowFailure: true,
    capture: true,
    timeout,
  });
  const detail = [result.stderr, result.stdout]
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return {
    value: result.status === 0 ? 1 : 0,
    population_size: 1,
    cost: 1,
    contributors:
      result.status === 0
        ? []
        : [
            `${entry.path}:exit:${result.status}${detail ? `:${detail.slice(0, 500)}` : ""}`,
          ],
  };
}

/** Evaluate one repository assurance gate through the public action transport. */
export async function main(
  argv = process.argv.slice(2),
  {
    registryPath = DEFAULT_REGISTRY_PATH,
    execute = runCommand,
    runAction = runAssuranceAction,
  } = {},
) {
  const { flags, positionals } = parseFlags(argv);
  if (flags.has("help") || flags.has("h")) {
    return {
      usage:
        "node scripts/release/repository-assurance.mjs <gate-id> [--trigger ci] [--json]",
    };
  }
  const gateId = positionals[0];
  if (!gateId) throw new TypeError("Repository assurance requires a gate id");
  const entries = await readRepositoryProviderEntries(registryPath);
  const result = await runAction(
    {
      action: "run",
      id: gateId,
      trigger: flagString(flags, "trigger", "ci"),
      dry_run: true,
    },
    { path: path.join(repoRoot, ".agents", "pm") },
    {
      workspace: {
        include_history: false,
        providers: {
          [REPOSITORY_QUALITY_PROVIDER]: (source) =>
            resolveRepositoryQualityMeasurement(source, {
              entries,
              execute,
            }),
        },
        provider_capabilities: {
          [REPOSITORY_QUALITY_PROVIDER]: {
            cost_class: "high",
            network: false,
          },
        },
      },
    },
  );
  if (result.verdict === "block") {
    throw new Error(
      `Repository assurance gate ${gateId} blocked: ${JSON.stringify(result.assertions)}`,
    );
  }
  return flagBool(flags, "json", false)
    ? result
    : {
        gate_id: result.gate_id,
        verdict: result.verdict,
        assertions_total: result.assertions_total,
      };
}

/** Run the executable entrypoint without making imports exit the test process. */
export async function runRepositoryAssuranceEntrypoint(options = {}) {
  const argv = options.argv ?? process.argv;
  if (
    argv[1] === undefined ||
    fileURLToPath(import.meta.url) !== path.resolve(argv[1])
  ) {
    return false;
  }
  try {
    const result = await (options.run ?? main)(argv.slice(2));
    (options.write ?? ((output) => process.stdout.write(output)))(
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return true;
  } catch (error) {
    (options.onError ?? ((cause) => fail(String(cause))))(error);
    return false;
  }
}

void runRepositoryAssuranceEntrypoint();
