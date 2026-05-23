import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getActiveExtensionRegistrations, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { normalizePrefix } from "../../core/item/id.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { ensureRuntimeSchemaFileScaffold } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE, GOVERNANCE_PRESET_DEFAULTS, PM_REQUIRED_SUBDIRS, SETTINGS_DEFAULTS } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings, writeSettings } from "../../core/store/settings.js";
import type { GovernancePreset, PmSettings } from "../../types/index.js";
import { runExtension, type ExtensionCommandResult } from "./extension.js";
import {
  INIT_AGENT_GUIDANCE_MODE_VALUES,
  runInitAgentGuidance,
  type InitAgentGuidanceMode,
  type InitAgentGuidanceSummary,
} from "./init-agent-guidance.js";

export interface InitInstalledPackagesSummary {
  installed_all: boolean;
  installed_count: number;
  packages: Array<{
    alias: string;
    ok: boolean;
  }>;
}

export interface InitResult {
  ok: boolean;
  path: string;
  settings: PmSettings;
  created_dirs: string[];
  warnings: string[];
  governance_preset: GovernancePreset;
  wizard_used: boolean;
  installed_packages?: InitInstalledPackagesSummary;
  next_steps: string[];
  agent_guidance: InitAgentGuidanceSummary;
}

export interface InitCommandOptions {
  preset?: string;
  defaults?: boolean;
  author?: string;
  withPackages?: boolean;
  agentGuidance?: string;
}

/**
 * Concise projection of an InitResult for the default (toon) renderer. It keeps
 * every piece of information that only init can surface — the resolved path, id
 * prefix, governance preset, telemetry capture level, created-directory count,
 * the full warnings list (including `already_exists:` markers), agent-guidance
 * summary, and next steps — but replaces the verbose full settings tree (~190
 * lines) with a compact `settings` summary. Use --verbose for the full tree.
 */
export interface InitConciseResult {
  ok: boolean;
  path: string;
  id_prefix: string;
  governance_preset: GovernancePreset;
  telemetry: {
    enabled: boolean;
    capture_level: string;
  };
  output_format: string;
  created_dirs_count: number;
  created_dirs: string[];
  warnings: string[];
  wizard_used: boolean;
  installed_packages?: InitInstalledPackagesSummary;
  next_steps: string[];
  agent_guidance: InitAgentGuidanceSummary;
  hint: string;
}

export function summarizeInitResult(result: InitResult): InitConciseResult {
  return {
    ok: result.ok,
    path: result.path,
    id_prefix: result.settings.id_prefix,
    governance_preset: result.governance_preset,
    telemetry: {
      enabled: result.settings.telemetry.enabled,
      capture_level: result.settings.telemetry.capture_level,
    },
    output_format: result.settings.output.default_format,
    created_dirs_count: result.created_dirs.length,
    created_dirs: result.created_dirs,
    warnings: result.warnings,
    wizard_used: result.wizard_used,
    ...(result.installed_packages ? { installed_packages: result.installed_packages } : {}),
    next_steps: result.next_steps,
    agent_guidance: result.agent_guidance,
    hint: "Re-run with --verbose for the full settings tree.",
  };
}

function cloneDefaults(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

type BuiltinGovernancePreset = Exclude<GovernancePreset, "custom">;
const BUILTIN_GOVERNANCE_PRESETS: BuiltinGovernancePreset[] = ["minimal", "default", "strict"];

function normalizeInitGovernancePreset(rawValue: string | undefined): BuiltinGovernancePreset | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const normalized = rawValue.trim().toLowerCase().replaceAll("-", "_");
  if (normalized.length === 0) {
    throw new PmCliError("--preset must not be empty", EXIT_CODE.USAGE);
  }
  if (normalized === "minimal" || normalized === "default" || normalized === "strict") {
    return normalized;
  }
  if (normalized === "lite" || normalized === "minimum") {
    return "minimal";
  }
  throw new PmCliError(
    `Invalid --preset value "${rawValue}". Allowed: ${BUILTIN_GOVERNANCE_PRESETS.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function normalizeOptionalInitAuthor(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const normalized = rawValue.trim();
  if (normalized.length === 0) {
    throw new PmCliError("--author must not be empty", EXIT_CODE.USAGE);
  }
  return normalized;
}

function normalizeInitAgentGuidanceMode(rawValue: string | undefined): InitAgentGuidanceMode {
  if (rawValue === undefined) {
    return "ask";
  }
  const normalized = rawValue.trim().toLowerCase().replaceAll("-", "_");
  if (normalized.length === 0) {
    throw new PmCliError("--agent-guidance must not be empty", EXIT_CODE.USAGE);
  }
  if (normalized === "ask" || normalized === "add" || normalized === "skip" || normalized === "status") {
    return normalized;
  }
  throw new PmCliError(
    `Invalid --agent-guidance value "${rawValue}". Allowed: ${INIT_AGENT_GUIDANCE_MODE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function parseYesNoChoice(answer: string, currentDefault: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (normalized.length === 0) {
    return currentDefault;
  }
  if (normalized === "y" || normalized === "yes") {
    return true;
  }
  if (normalized === "n" || normalized === "no") {
    return false;
  }
  return currentDefault;
}

function applyGovernancePreset(settings: PmSettings, preset: BuiltinGovernancePreset): void {
  const knobs = GOVERNANCE_PRESET_DEFAULTS[preset];
  settings.governance = {
    preset,
    ...knobs,
  };
  settings.validation.parent_reference = knobs.parent_reference;
  settings.validation.metadata_profile = knobs.metadata_profile;
}

function summarizeInstalledPackages(result: ExtensionCommandResult): InitInstalledPackagesSummary {
  const details = result.details as {
    installed_all?: unknown;
    installed_count?: unknown;
    packages?: Array<{
      alias?: unknown;
      ok?: unknown;
    }>;
  };
  return {
    installed_all: details.installed_all === true,
    installed_count: typeof details.installed_count === "number" ? details.installed_count : 0,
    packages: Array.isArray(details.packages)
      ? details.packages.map((entry) => ({
          alias: typeof entry.alias === "string" ? entry.alias : "",
          ok: entry.ok === true,
        }))
      : [],
  };
}

async function runInitWizard(initialPrefix: string, telemetryDefault: boolean): Promise<{
  prefix: string;
  preset: BuiltinGovernancePreset;
  telemetry_enabled: boolean;
}> {
  const rl = readline.createInterface({ input, output });
  try {
    output.write("pm init setup wizard (agent-optimized)\n");
    output.write("This walkthrough is non-destructive and each choice can be changed later with pm config.\n\n");

    output.write("1/3 Item ID prefix\n");
    output.write("Prefix is prepended to generated IDs (for example pm-a1b2).\n");
    const prefixAnswer = await rl.question(`Item ID prefix [${initialPrefix}]: `);
    const resolvedPrefix = prefixAnswer.trim().length > 0 ? normalizePrefix(prefixAnswer) : initialPrefix;

    output.write("\n2/3 Governance preset\n");
    output.write("minimal: no ownership blocking, progressive create defaults, close validation off.\n");
    output.write("default: ownership conflict warnings, progressive create defaults, close validation warn.\n");
    output.write("strict: ownership blocking, strict create defaults, close validation strict.\n");
    const presetAnswer = await rl.question("Governance preset [minimal/default/strict] (default: minimal): ");
    const resolvedPreset = normalizeInitGovernancePreset(presetAnswer.trim().length > 0 ? presetAnswer : "minimal") ?? "minimal";

    output.write("\n3/3 Project telemetry\n");
    output.write("Telemetry helps improve reliability and can be disabled anytime via pm config.\n");
    const telemetryLabel = telemetryDefault ? "Y/n" : "y/N";
    const telemetryAnswer = await rl.question(`Enable telemetry for this project? [${telemetryLabel}] `);
    const telemetryEnabled = parseYesNoChoice(telemetryAnswer, telemetryDefault);

    output.write("\n");
    return {
      prefix: resolvedPrefix,
      preset: resolvedPreset,
      telemetry_enabled: telemetryEnabled,
    };
  } finally {
    rl.close();
  }
}

export async function runInit(
  prefixArg: string | undefined,
  global: GlobalOptions,
  options: InitCommandOptions = {},
): Promise<InitResult> {
  const cwd = process.cwd();
  const pmRoot = resolvePmRoot(cwd, global.path);
  const createdDirs: string[] = [];
  const warnings: string[] = [];
  let wizardUsed = false;

  for (const subdir of PM_REQUIRED_SUBDIRS) {
    const target = subdir ? path.join(pmRoot, subdir) : pmRoot;
    const existed = await pathExists(target);
    await fs.mkdir(target, { recursive: true });
    if (existed) {
      warnings.push(`already_exists:${target}`);
    } else {
      createdDirs.push(target);
    }
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: target,
        scope: "project",
        op: "init:ensure_dir",
      })),
    );
  }

  const settingsPath = path.join(pmRoot, "settings.json");
  const settingsExists = await pathExists(settingsPath);
  let normalizedPrefix = normalizePrefix(prefixArg);
  const presetFromOption = normalizeInitGovernancePreset(options.preset);
  const useDefaults = options.defaults === true;
  const authorFromOption = normalizeOptionalInitAuthor(options.author);
  const installBundledPackages = options.withPackages === true;
  const agentGuidanceMode = normalizeInitAgentGuidanceMode(options.agentGuidance);
  let chosenPreset = presetFromOption;
  let chosenTelemetryEnabled: boolean | undefined;

  let settings: PmSettings;
  if (settingsExists) {
    settings = await readSettings(pmRoot);
    warnings.push(`already_exists:${settingsPath}`);
    let changed = false;
    if (prefixArg !== undefined && settings.id_prefix !== normalizedPrefix) {
      settings.id_prefix = normalizedPrefix;
      warnings.push(`updated:id_prefix:${normalizedPrefix}`);
      changed = true;
    }
    if (presetFromOption !== undefined && settings.governance.preset !== presetFromOption) {
      applyGovernancePreset(settings, presetFromOption);
      warnings.push(`updated:governance_preset:${presetFromOption}`);
      changed = true;
    }
    if (authorFromOption !== undefined && settings.author_default !== authorFromOption) {
      settings.author_default = authorFromOption;
      warnings.push(`updated:author_default:${authorFromOption}`);
      changed = true;
    }
    if (changed) {
      await writeSettings(pmRoot, settings);
    }
  } else {
    if (presetFromOption === undefined && !useDefaults && process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const wizardChoices = await runInitWizard(normalizedPrefix, SETTINGS_DEFAULTS.telemetry.enabled);
      normalizedPrefix = wizardChoices.prefix;
      chosenPreset = wizardChoices.preset;
      chosenTelemetryEnabled = wizardChoices.telemetry_enabled;
      wizardUsed = true;
    }
    const effectivePreset = chosenPreset ?? "minimal";
    settings = cloneDefaults();
    settings.id_prefix = normalizedPrefix;
    applyGovernancePreset(settings, effectivePreset);
    if (authorFromOption !== undefined) {
      settings.author_default = authorFromOption;
    }
    if (chosenTelemetryEnabled !== undefined) {
      settings.telemetry.enabled = chosenTelemetryEnabled;
      settings.telemetry.first_run_prompt_completed = true;
    }
    await writeSettings(pmRoot, settings);
  }

  const agentGuidanceResult = await runInitAgentGuidance({
    pm_root: pmRoot,
    cwd,
    mode: agentGuidanceMode,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    settings,
  });
  warnings.push(...agentGuidanceResult.warnings);
  if (agentGuidanceResult.settings_changed) {
    await writeSettings(pmRoot, settings);
  }

  const runtimeSchemaScaffold = await ensureRuntimeSchemaFileScaffold(pmRoot, settings.schema);
  for (const createdPath of runtimeSchemaScaffold.created_paths) {
    createdDirs.push(createdPath);
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: createdPath,
        scope: "project",
        op: "init:runtime_schema_file",
      })),
    );
  }

  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  for (const typeFolder of typeRegistry.folders) {
    if ((PM_REQUIRED_SUBDIRS as readonly string[]).includes(typeFolder)) {
      continue;
    }
    const target = path.join(pmRoot, typeFolder);
    const existed = await pathExists(target);
    await fs.mkdir(target, { recursive: true });
    if (existed) {
      warnings.push(`already_exists:${target}`);
    } else {
      createdDirs.push(target);
    }
    warnings.push(
      ...(await runActiveOnWriteHooks({
        path: target,
        scope: "project",
        op: "init:ensure_dir",
      })),
    );
  }

  let installedPackages: InitInstalledPackagesSummary | undefined;
  if (installBundledPackages) {
    const packageInstallResult = await runExtension("all", { install: true, project: true }, global);
    warnings.push(...packageInstallResult.warnings);
    installedPackages = summarizeInstalledPackages(packageInstallResult);
    if (!installedPackages.installed_all || installedPackages.packages.some((entry) => !entry.ok)) {
      throw new PmCliError("pm init --with-packages did not install all bundled packages successfully.", EXIT_CODE.GENERIC_FAILURE);
    }
  }

  const nextSteps: string[] = [
    'Create your first item: pm create --type Task --title "<title>"',
    'List active items: pm list',
    'Get agent-friendly project context: pm context',
  ];
  if (!installBundledPackages) {
    nextSteps.push(
      "Add optional packages for richer workflows: pm install calendar --project, pm install templates --project, pm install guide-shell --project",
    );
    nextSteps.push("Or install everything bundled: pm init --with-packages (idempotent on re-run)");
  } else {
    nextSteps.push("Explore newly-available commands: pm cal, pm templates, pm guide");
  }
  nextSteps.push("Set PM_AUTHOR=<your-agent-id> so mutations attribute to the right caller.");
  for (const guidanceNextStep of agentGuidanceResult.next_steps) {
    if (!nextSteps.includes(guidanceNextStep)) {
      nextSteps.push(guidanceNextStep);
    }
  }

  return {
    ok: true,
    path: pmRoot,
    settings,
    created_dirs: createdDirs,
    warnings,
    governance_preset: settings.governance.preset,
    wizard_used: wizardUsed,
    ...(installedPackages ? { installed_packages: installedPackages } : {}),
    next_steps: nextSteps,
    agent_guidance: agentGuidanceResult.summary,
  };
}
