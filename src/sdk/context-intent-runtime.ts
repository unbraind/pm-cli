/**
 * @module sdk/context-intent-runtime
 *
 * Loads request-scoped context-intent declarations from workspace data and
 * active package modules without adding filesystem work to the contracts-only
 * SDK entrypoint.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isFileAbsentError } from "../core/fs/fs-utils.js";
import { assertReadableTrackerRoot } from "./environment/tracker-preflight.js";
import {
  runWithContextIntentContracts,
  type PmContextIntentContract,
  type PmContextIntentRuntimeLayers,
} from "./context-intent-contracts.js";

/** Conventional workspace declaration file relative to the tracker root. */
export const PM_CONTEXT_INTENTS_FILE = "context-intents.json";

/** Minimal active-package shape needed to discover declarative intent exports. */
export interface PmContextIntentPackageModule {
  /** Stable package name used in diagnostics. */
  name: string;
  /** Loaded extension module, which may export contextIntents. */
  module: unknown;
}

/** Inputs for discovering workspace and active-package intent declarations. */
export interface PmContextIntentDiscoveryOptions {
  /** Resolved .agents/pm tracker root. */
  pmRoot: string;
  /** Active package modules in deterministic activation order. */
  packages?: readonly PmContextIntentPackageModule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeclaration(
  value: unknown,
  sourceLabel: string,
  index: number,
): PmContextIntentContract {
  if (!isRecord(value)) {
    throw new TypeError(
      `${sourceLabel} context intent at index ${String(index)} must be an object`,
    );
  }
  const includedFieldGroups = value.included_field_groups;
  if (
    typeof value.command !== "string" ||
    typeof value.intent !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(includedFieldGroups) ||
    !includedFieldGroups.every((entry) => typeof entry === "string") ||
    typeof value.token_budget !== "number"
  ) {
    throw new TypeError(
      `${sourceLabel} context intent at index ${String(index)} has an invalid contract shape`,
    );
  }
  return {
    command: value.command,
    intent: value.intent,
    description: value.description,
    included_field_groups: includedFieldGroups,
    token_budget: value.token_budget,
  };
}

/** Parse a JSON/module declaration array and reject malformed entries before composition. */
export function parseContextIntentDeclarations(
  value: unknown,
  sourceLabel: string,
): PmContextIntentContract[] {
  const declarations = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.intents)
      ? value.intents
      : undefined;
  if (!declarations) {
    throw new TypeError(
      `${sourceLabel} context intents must be an array or an object with an intents array`,
    );
  }
  return declarations.map((entry, index) =>
    parseDeclaration(entry, sourceLabel, index),
  );
}

/** Read optional workspace declarations from .agents/pm/context-intents.json. */
export async function readWorkspaceContextIntentContracts(
  pmRoot: string,
): Promise<PmContextIntentContract[]> {
  const declarationPath = path.join(pmRoot, PM_CONTEXT_INTENTS_FILE);
  let source: string;
  try {
    source = await readFile(declarationPath, "utf8");
  } catch (error: unknown) {
    // Absent declarations are the norm. `ENOTDIR` counts as absent too: when
    // the tracker root is a regular file the declaration cannot exist, and the
    // authoritative root guard downstream owns that refusal. Other read
    // failures first pass through the same root guard so permissions failures
    // cannot pre-empt it with an unclassified runtime fault.
    if (isFileAbsentError(error)) {
      return [];
    }
    await assertReadableTrackerRoot(pmRoot);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid ${PM_CONTEXT_INTENTS_FILE}: ${detail}`, {
      cause: error,
    });
  }
  return parseContextIntentDeclarations(parsed, PM_CONTEXT_INTENTS_FILE);
}

function packageDeclarationExport(module: unknown): unknown {
  if (!isRecord(module)) return undefined;
  const direct = module.contextIntents ?? module.context_intents;
  if (direct !== undefined) return direct;
  const defaultExport = module.default;
  return isRecord(defaultExport)
    ? (defaultExport.contextIntents ?? defaultExport.context_intents)
    : undefined;
}

/** Collect contextIntents exports from active package modules. */
export function collectPackageContextIntentContracts(
  packages: readonly PmContextIntentPackageModule[],
): PmContextIntentContract[] {
  return packages.flatMap((entry) => {
    const declaration = packageDeclarationExport(entry.module);
    return declaration === undefined
      ? []
      : parseContextIntentDeclarations(declaration, `package ${entry.name}`);
  });
}

/** Load both runtime declaration layers without changing the active request scope. */
export async function loadContextIntentRuntimeLayers(
  options: PmContextIntentDiscoveryOptions,
): Promise<PmContextIntentRuntimeLayers> {
  const workspaceContracts = await readWorkspaceContextIntentContracts(
    options.pmRoot,
  );
  const packageContracts = collectPackageContextIntentContracts(
    options.packages ?? [],
  );
  return { workspaceContracts, packageContracts };
}

/** Discover declarations and execute one request with isolated composed intents. */
export async function runWithDiscoveredContextIntentContracts<T>(
  options: PmContextIntentDiscoveryOptions,
  run: () => T,
): Promise<Awaited<T>> {
  const layers = await loadContextIntentRuntimeLayers(options);
  return await runWithContextIntentContracts(layers, run);
}
