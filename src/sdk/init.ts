/**
 * @module sdk/init
 *
 * Implements the pm init command surface and its agent-facing runtime behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { hostname, userInfo } from "node:os";
import {
  getActiveExtensionRegistrations,
  runActiveOnWriteHooks,
} from "../core/extensions/index.js";
import {
  pathExists,
  readFileIfExists,
} from "../core/fs/fs-utils.js";
import { writeWorkspaceJsonWithHistory } from "../core/history/workspace-history.js";
import { normalizePrefix } from "../core/item/id.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  ensureRuntimeSchemaFileScaffold,
  filePathForSchemaSection,
  normalizeRuntimeSchemaSettings,
} from "../core/schema/runtime-schema.js";
import {
  parseItemTypesFile,
  serializeItemTypesFile,
  upsertItemType,
} from "../core/schema/item-types-file.js";
import {
  normalizeTypePresetName,
  resolveTypePresetDefinitions,
  TYPE_PRESET_NAMES,
  type TypePresetName,
} from "../core/schema/type-presets.js";
import {
  EXIT_CODE,
  GOVERNANCE_PRESET_DEFAULTS,
  PM_REQUIRED_SUBDIRS,
  SETTINGS_DEFAULTS,
} from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { resolveAuthor } from "../core/shared/author.js";
import { PmCliError } from "../core/shared/errors.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { readSettings, writeSettings } from "../core/store/settings.js";
import { ensurePmGitignore } from "./workspace.js";
import type { GovernancePreset, PmSettings } from "../types/index.js";
import { renderPmCommand } from "./command-line.js";
import {
  runExtension,
  type ExtensionCommandResult,
} from "./extension.js";
import {
  INIT_AGENT_GUIDANCE_MODE_VALUES,
  runInitAgentGuidance,
  type InitAgentGuidanceMode,
  type InitAgentGuidanceSummary,
} from "./init-agent-guidance.js";

/** Documents the init installed packages summary payload exchanged by command, SDK, and package integrations. */
export interface InitInstalledPackagesSummary {
  /** Value that configures or reports installed all for this contract. */
  installed_all: boolean;
  /** Number of installed entries represented by this result. */
  installed_count: number;
  /** Value that configures or reports packages for this contract. */
  packages: Array<{
    alias: string;
    ok: boolean;
  }>;
}

/** Restricts init type preset name values accepted by command, SDK, and storage contracts. */
export type InitTypePresetName = TypePresetName;

/** Documents the init registered type preset summary payload exchanged by command, SDK, and package integrations. */
export interface InitRegisteredTypePresetSummary {
  /** Value that configures or reports name for this contract. */
  name: InitTypePresetName;
  /** Value that configures or reports registered for this contract. */
  registered: string[];
  /** Value that configures or reports updated for this contract. */
  updated: string[];
  /** Value that configures or reports file for this contract. */
  file: string;
}

/** Documents the init agent-guidance summary plus generated next-step hints returned by init. */
export type InitAgentGuidanceResult = InitAgentGuidanceSummary & {
  next_steps: string[];
};

/** Describes how init resolved the tracker and optional workspace target. */
export interface InitTargetResolution {
  /** Value that configures or reports mode for this contract. */
  mode: "workspace-discovery" | "tracker-path" | "workspace-path";
  /** Value that configures or reports tracker root for this contract. */
  tracker_root: string;
  /** Value that configures or reports workspace root for this contract. */
  workspace_root?: string;
}

/** Documents the init result payload exchanged by command, SDK, and package integrations. */
export interface InitResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports target for this contract. */
  target: InitTargetResolution;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  /** Value that configures or reports created dirs for this contract. */
  created_dirs: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports governance preset for this contract. */
  governance_preset: GovernancePreset;
  /** Value that configures or reports wizard used for this contract. */
  wizard_used: boolean;
  /** Value that configures or reports registered type preset for this contract. */
  registered_type_preset?: InitRegisteredTypePresetSummary;
  /** Value that configures or reports installed packages for this contract. */
  installed_packages?: InitInstalledPackagesSummary;
  /** Value that configures or reports next steps for this contract. */
  next_steps: string[];
  /** Value that configures or reports agent guidance for this contract. */
  agent_guidance: InitAgentGuidanceResult;
}

/** Documents the init command options payload exchanged by command, SDK, and package integrations. */
export interface InitCommandOptions {
  /** Item-id prefix supplied through the flag-oriented SDK/CLI input surface. */
  idPrefix?: string;
  /** Value that configures or reports preset for this contract. */
  preset?: string;
  /** Value that configures or reports defaults for this contract. */
  defaults?: boolean;
  /** Value that configures or reports author for this contract. */
  author?: string;
  /** Value that configures or reports with packages for this contract. */
  withPackages?: boolean;
  /** Value that configures or reports agent guidance for this contract. */
  agentGuidance?: string;
  /** Value that configures or reports type preset for this contract. */
  typePreset?: string;
  /** Value that configures or reports force for this contract. */
  force?: boolean;
  /** Value that configures or reports workspace for this contract. */
  workspace?: string;
}

/** Concise projection of an InitResult for the default (toon) renderer. It keeps every piece of information that only init can surface — the resolved path, id prefix, governance preset, telemetry capture level, created-directory count, the full warnings list (including `already_exists:` markers), agent-guidance summary, and next steps — but replaces the verbose full settings tree (~190 lines) with a compact `settings` summary. Use --verbose for the full tree. */
export interface InitConciseResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports target for this contract. */
  target: InitTargetResolution;
  /** Value that configures or reports id prefix for this contract. */
  id_prefix: string;
  /** Value that configures or reports governance preset for this contract. */
  governance_preset: GovernancePreset;
  /** Value that configures or reports telemetry for this contract. */
  telemetry: {
    enabled: boolean;
    capture_level: string;
  };
  /** Value that configures or reports output format for this contract. */
  output_format: string;
  /** Number of created dirs entries represented by this result. */
  created_dirs_count: number;
  /** Value that configures or reports created dirs for this contract. */
  created_dirs: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports wizard used for this contract. */
  wizard_used: boolean;
  /** Value that configures or reports registered type preset for this contract. */
  registered_type_preset?: InitRegisteredTypePresetSummary;
  /** Value that configures or reports installed packages for this contract. */
  installed_packages?: InitInstalledPackagesSummary;
  /** Value that configures or reports next steps for this contract. */
  next_steps: string[];
  /** Value that configures or reports agent guidance for this contract. */
  agent_guidance: InitAgentGuidanceResult;
  /** Value that configures or reports hint for this contract. */
  hint: string;
}

/** Implements summarize init result for the public runtime surface of this module. */
export function summarizeInitResult(result: InitResult): InitConciseResult {
  return {
    ok: result.ok,
    path: result.path,
    target: result.target,
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
    ...(result.registered_type_preset
      ? { registered_type_preset: result.registered_type_preset }
      : {}),
    ...(result.installed_packages
      ? { installed_packages: result.installed_packages }
      : {}),
    next_steps: result.next_steps,
    agent_guidance: result.agent_guidance,
    hint: "Re-run with --verbose for the full settings tree.",
  };
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  normalizeInitGovernancePreset,
  normalizeInitTypePreset,
  normalizeOptionalInitAuthor,
  normalizeInitAgentGuidanceMode,
  isPathLikeInitTarget,
  resolveInitInvocation,
  resolveInitPrefixInput,
  parseYesNoChoice,
  applyGovernancePreset,
  runInitWizard,
  setInitReadlineFactoryForTests,
  summarizeInstalledPackages,
  buildInitNextSteps,
  registerInitTypePreset,
  assertExplicitTrackerPathIsNotWorkspaceRoot,
  isLikelyWorkspaceRoot,
};

type InitReadlineInterface = ReturnType<typeof readline.createInterface>;
let createInitReadlineInterface = (): InitReadlineInterface =>
  readline.createInterface({ input, output });

interface InitNormalizedOptions {
  presetFromOption: BuiltinGovernancePreset | undefined;
  useDefaults: boolean;
  authorFromOption: string | undefined;
  installBundledPackages: boolean;
  agentGuidanceMode: InitAgentGuidanceMode;
  typePreset: InitTypePresetName | undefined;
}

interface InitSettingsResolution {
  settings: PmSettings;
  normalizedPrefix: string;
  chosenPreset: BuiltinGovernancePreset | undefined;
  wizardUsed: boolean;
}

function setInitReadlineFactoryForTests(
  factory: (() => InitReadlineInterface) | undefined,
): void {
  createInitReadlineInterface =
    factory ?? (() => readline.createInterface({ input, output }));
}

function cloneDefaults(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

type BuiltinGovernancePreset = Exclude<GovernancePreset, "custom">;
const BUILTIN_GOVERNANCE_PRESETS: BuiltinGovernancePreset[] = [
  "minimal",
  "default",
  "strict",
];
function normalizeInitGovernancePreset(
  rawValue: string | undefined,
): BuiltinGovernancePreset | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const normalized = rawValue.trim().toLowerCase().replaceAll("-", "_");
  if (normalized.length === 0) {
    throw new PmCliError("--preset must not be empty", EXIT_CODE.USAGE);
  }
  if (
    normalized === "minimal" ||
    normalized === "default" ||
    normalized === "strict"
  ) {
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

function normalizeInitTypePreset(
  rawValue: string | undefined,
): InitTypePresetName | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue.trim().length === 0) {
    throw new PmCliError("--type-preset must not be empty", EXIT_CODE.USAGE);
  }
  try {
    // Non-undefined input never returns undefined; the shared normalizer throws
    // a plain Error for empty/unknown values, which we re-map to init's --type-preset
    // PmCliError wording for a consistent CLI surface.
    return normalizeTypePresetName(rawValue) as InitTypePresetName;
  } catch {
    throw new PmCliError(
      `Invalid --type-preset value "${rawValue}". Allowed: ${TYPE_PRESET_NAMES.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
}

function normalizeOptionalInitAuthor(
  rawValue: string | undefined,
): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const normalized = rawValue.trim();
  if (normalized.length === 0) {
    throw new PmCliError("--author must not be empty", EXIT_CODE.USAGE);
  }
  return normalized;
}

function isPathLikeInitTarget(rawValue: string | undefined): boolean {
  if (rawValue === undefined) {
    return false;
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return (
    path.isAbsolute(trimmed) ||
    /^[a-z]:/iu.test(trimmed) ||
    trimmed.startsWith(".") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  );
}

function resolveInitInvocation(
  cwd: string,
  global: GlobalOptions,
  prefixArg: string | undefined,
  workspaceArg?: string,
): {
  pmRoot: string;
  prefixArg: string | undefined;
  target: InitTargetResolution;
} {
  const normalizedWorkspace = workspaceArg?.trim();
  if (workspaceArg !== undefined && normalizedWorkspace?.length === 0) {
    throw new PmCliError("--workspace must not be empty", EXIT_CODE.USAGE);
  }
  if (normalizedWorkspace !== undefined) {
    if (global.path !== undefined || isPathLikeInitTarget(prefixArg)) {
      throw new PmCliError(
        "--workspace cannot be combined with --pm-path/--path or a path-like positional target.",
        EXIT_CODE.USAGE,
      );
    }
    const workspaceRoot = path.resolve(cwd, normalizedWorkspace);
    const pmRoot = path.join(workspaceRoot, ".agents", "pm");
    return {
      pmRoot,
      prefixArg,
      target: {
        mode: "workspace-path",
        tracker_root: pmRoot,
        workspace_root: workspaceRoot,
      },
    };
  }
  if (global.path === undefined && isPathLikeInitTarget(prefixArg)) {
    const positionalTarget = path.resolve(cwd, prefixArg!.trim());
    return {
      pmRoot: positionalTarget,
      prefixArg: undefined,
      target: { mode: "tracker-path", tracker_root: positionalTarget },
    };
  }
  const pmRoot = resolvePmRoot(cwd, global.path);
  return {
    pmRoot,
    prefixArg,
    target:
      global.path === undefined
        ? {
            mode: "workspace-discovery",
            tracker_root: pmRoot,
            workspace_root: cwd,
          }
        : { mode: "tracker-path", tracker_root: pmRoot },
  };
}

/** Resolves the optional positional and flag-oriented id-prefix inputs, accepting equivalent normalized spellings and rejecting ambiguous conflicts. */
function resolveInitPrefixInput(
  positionalPrefix: string | undefined,
  flaggedPrefix: string | undefined,
): string | undefined {
  if (flaggedPrefix === undefined) {
    return positionalPrefix;
  }
  if (flaggedPrefix.trim().length === 0) {
    throw new PmCliError("--id-prefix must not be empty", EXIT_CODE.USAGE);
  }
  if (isPathLikeInitTarget(flaggedPrefix)) {
    throw new PmCliError(
      `--id-prefix accepts an item ID prefix, not a tracker path: "${flaggedPrefix}".`,
      EXIT_CODE.USAGE,
      {
        code: "init_id_prefix_path_like",
        required:
          "Pass the tracker path positionally or with the global --path option.",
        examples: [
          `pm init ${flaggedPrefix}`,
          `pm --path ${flaggedPrefix} init`,
        ],
      },
    );
  }
  if (
    positionalPrefix !== undefined &&
    normalizePrefix(positionalPrefix) !== normalizePrefix(flaggedPrefix)
  ) {
    throw new PmCliError(
      `Conflicting id prefixes: positional "${positionalPrefix}" and --id-prefix "${flaggedPrefix}".`,
      EXIT_CODE.USAGE,
      {
        code: "init_id_prefix_conflict",
        required:
          "Use either the positional id prefix or --id-prefix with one value.",
        examples: [
          `pm init ${normalizePrefix(positionalPrefix)}`,
          `pm init --id-prefix ${normalizePrefix(flaggedPrefix)}`,
        ],
      },
    );
  }
  return flaggedPrefix;
}

function normalizeInitAgentGuidanceMode(
  rawValue: string | undefined,
): InitAgentGuidanceMode {
  if (rawValue === undefined) {
    return "ask";
  }
  const normalized = rawValue.trim().toLowerCase().replaceAll("-", "_");
  if (normalized.length === 0) {
    throw new PmCliError("--agent-guidance must not be empty", EXIT_CODE.USAGE);
  }
  if (
    normalized === "ask" ||
    normalized === "add" ||
    normalized === "skip" ||
    normalized === "status"
  ) {
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

function applyGovernancePreset(
  settings: PmSettings,
  preset: BuiltinGovernancePreset,
): void {
  const knobs = GOVERNANCE_PRESET_DEFAULTS[preset];
  settings.governance = {
    preset,
    ...knobs,
  };
  settings.validation.parent_reference = knobs.parent_reference;
  settings.validation.metadata_profile = knobs.metadata_profile;
}

function isInstalledPackageEntry(
  value: unknown,
): value is { alias?: unknown; ok?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeInstalledPackages(
  result: ExtensionCommandResult,
): InitInstalledPackagesSummary {
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
    installed_count:
      typeof details.installed_count === "number" ? details.installed_count : 0,
    packages: Array.isArray(details.packages)
      ? details.packages.filter(isInstalledPackageEntry).map((entry) => ({
          alias: typeof entry.alias === "string" ? entry.alias : "",
          ok: entry.ok === true,
        }))
      : [],
  };
}

async function registerInitTypePreset(
  pmRoot: string,
  settings: PmSettings,
  preset: InitTypePresetName,
): Promise<InitRegisteredTypePresetSummary> {
  const schema = normalizeRuntimeSchemaSettings(settings.schema);
  const typesPath = filePathForSchemaSection(
    pmRoot,
    schema.files.types,
    DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types,
  );
  const parsed = parseItemTypesFile(await readFileIfExists(typesPath));
  let nextFile = parsed;
  const registered: string[] = [];
  const updated: string[] = [];
  for (const normalized of resolveTypePresetDefinitions(preset)) {
    const upsert = upsertItemType(nextFile, normalized);
    nextFile = upsert.file;
    (upsert.replaced ? updated : registered).push(upsert.definition.name);
  }
  await writeWorkspaceJsonWithHistory({
    pmRoot,
    filePath: typesPath,
    raw: serializeItemTypesFile(nextFile),
    op: "init:type-preset",
    author: resolveAuthor(undefined, settings.author_default),
    lockTtlSeconds: settings.locks.ttl_seconds,
    lockWaitMs: settings.locks.wait_ms,
  });
  return {
    name: preset,
    registered,
    updated,
    file: typesPath,
  };
}

async function isLikelyWorkspaceRoot(candidate: string): Promise<boolean> {
  const indicators = [
    ".git",
    "package.json",
    "pnpm-workspace.yaml",
    "AGENTS.md",
    path.join(".agents", "pm"),
  ];
  for (const indicator of indicators) {
    if (await pathExists(path.join(candidate, indicator))) {
      return true;
    }
  }
  return false;
}

async function assertExplicitTrackerPathIsNotWorkspaceRoot(
  pmRoot: string,
  explicitTrackerTarget: boolean,
  force: boolean,
): Promise<void> {
  if (!explicitTrackerTarget || force) {
    return;
  }
  if (await pathExists(path.join(pmRoot, "settings.json"))) {
    return;
  }
  if (!(await isLikelyWorkspaceRoot(pmRoot))) {
    return;
  }
  const nestedTracker = path.join(pmRoot, ".agents", "pm");
  throw new PmCliError(
    `Refusing to initialize tracker files directly in workspace root "${pmRoot}".`,
    EXIT_CODE.USAGE,
    {
      code: "workspace_root_pm_path",
      type: "urn:pm-cli:error:workspace_root_pm_path",
      why: "Path-like init targets and --pm-path/--path point at the tracker storage directory itself, not the repository workspace. Point at .agents/pm, use --workspace, or pass --force if you intentionally want root-level tracker files.",
      examples: [
        `pm --pm-path ${nestedTracker} init --yes`,
        "pm init --yes",
        `pm --pm-path ${pmRoot} init --yes --force`,
      ],
      nextSteps: [
        "Use --pm-path <repo>/.agents/pm for repository-local tracker storage.",
        "Use PM_PATH only for sandboxed tests or explicit tracker roots.",
        "Pass --force only when root-level tracker files are intentional.",
      ],
      recovery: {
        next_best_command: `pm --pm-path ${nestedTracker} init --yes`,
      },
    },
  );
}

async function ensureInitDirectories(
  pmRoot: string,
  subdirs: readonly string[],
): Promise<{
  createdDirs: string[];
  warnings: string[];
}> {
  const createdDirs: string[] = [];
  const warnings: string[] = [];
  for (const subdir of subdirs) {
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
  return { createdDirs, warnings };
}

async function runInitWizard(
  initialPrefix: string,
  telemetryDefault: boolean,
): Promise<{
  prefix: string;
  preset: BuiltinGovernancePreset;
  telemetry_enabled: boolean;
}> {
  const rl = createInitReadlineInterface();
  try {
    output.write("pm init setup wizard (agent-optimized)\n");
    output.write(
      "This walkthrough is non-destructive and each choice can be changed later with pm config.\n\n",
    );

    output.write("1/3 Item ID prefix\n");
    output.write(
      "Prefix is prepended to generated IDs (for example pm-a1b2).\n",
    );
    const prefixAnswer = await rl.question(
      `Item ID prefix [${initialPrefix}]: `,
    );
    const resolvedPrefix =
      prefixAnswer.trim().length > 0
        ? normalizePrefix(prefixAnswer)
        : initialPrefix;

    output.write("\n2/3 Governance preset\n");
    output.write(
      "minimal: no ownership blocking, progressive create defaults, close validation off.\n",
    );
    output.write(
      "default: ownership conflict warnings, progressive create defaults, close validation warn.\n",
    );
    output.write(
      "strict: ownership blocking, strict create defaults, close validation strict.\n",
    );
    const presetAnswer = await rl.question(
      "Governance preset [minimal/default/strict] (default: minimal): ",
    );
    const presetChoice =
      presetAnswer.trim().length > 0 ? presetAnswer.trim() : "minimal";
    // The wizard is forgiving: a typo'd/unknown preset defaults to minimal with a
    // notice instead of throwing and aborting an in-progress interactive setup.
    // normalizeInitGovernancePreset returns a concrete preset for valid input and
    // throws (never returns undefined) for invalid non-empty input, so the result is
    // always a BuiltinGovernancePreset on the success path.
    let resolvedPreset: BuiltinGovernancePreset = "minimal";
    try {
      resolvedPreset = normalizeInitGovernancePreset(
        presetChoice,
      ) as BuiltinGovernancePreset;
    } catch {
      output.write(
        `Unrecognized governance preset "${presetChoice}"; using minimal.\n`,
      );
    }

    output.write("\n3/3 Project telemetry\n");
    output.write(
      "Telemetry helps improve reliability and can be disabled anytime via pm config.\n",
    );
    const telemetryLabel = telemetryDefault ? "Y/n" : "y/N";
    const telemetryAnswer = await rl.question(
      `Enable telemetry for this project? [${telemetryLabel}] `,
    );
    const telemetryEnabled = parseYesNoChoice(
      telemetryAnswer,
      telemetryDefault,
    );

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

function normalizeInitCommandOptions(
  options: InitCommandOptions,
): InitNormalizedOptions {
  return {
    presetFromOption: normalizeInitGovernancePreset(options.preset),
    useDefaults: options.defaults === true,
    authorFromOption: normalizeOptionalInitAuthor(options.author),
    installBundledPackages: options.withPackages === true,
    agentGuidanceMode: normalizeInitAgentGuidanceMode(options.agentGuidance),
    typePreset: normalizeInitTypePreset(options.typePreset),
  };
}

function collectExistingSettingsPendingChanges(params: {
  settings: PmSettings;
  normalizedPrefix: string;
  prefixArg: string | undefined;
  presetFromOption: BuiltinGovernancePreset | undefined;
  authorFromOption: string | undefined;
}): string[] {
  const pendingChanges: string[] = [];
  if (
    params.prefixArg !== undefined &&
    params.settings.id_prefix !== params.normalizedPrefix
  ) {
    pendingChanges.push("id_prefix");
  }
  if (
    params.presetFromOption !== undefined &&
    params.settings.governance.preset !== params.presetFromOption
  ) {
    pendingChanges.push("governance_preset");
  }
  if (
    params.authorFromOption !== undefined &&
    params.settings.author_default !== params.authorFromOption
  ) {
    pendingChanges.push("author_default");
  }
  return pendingChanges;
}

function assertExistingSettingsUpdateAllowed(
  settingsPath: string,
  pendingChanges: string[],
  force: boolean,
): void {
  if (pendingChanges.length === 0 || force) {
    return;
  }
  throw new PmCliError(
    `Refusing to update existing tracker settings at ${settingsPath} without --force.`,
    EXIT_CODE.USAGE,
    {
      code: "init_existing_settings_requires_force",
      type: "urn:pm-cli:error:init_existing_settings_requires_force",
      required: `--force for ${pendingChanges.join(", ")}`,
      why: "pm init is safe to rerun, but changing id prefix, governance preset, or default author on an existing tracker can corrupt long-lived project context when an agent meant to initialize a sandbox path.",
      examples: [
        "pm init --yes",
        "pm init ./sandbox-pm --yes",
        "pm init acme --yes --force",
      ],
      nextSteps: [
        "If you meant to initialize a sandbox tracker, pass a path-like positional such as ./sandbox-pm or /tmp/pm-test.",
        "If you intentionally want to rewrite this existing tracker's init-managed settings, rerun with --force.",
      ],
    },
  );
}

function applyExistingSettingsUpdates(params: {
  settings: PmSettings;
  normalizedPrefix: string;
  prefixArg: string | undefined;
  presetFromOption: BuiltinGovernancePreset | undefined;
  authorFromOption: string | undefined;
  warnings: string[];
}): boolean {
  let changed = false;
  if (
    params.prefixArg !== undefined &&
    params.settings.id_prefix !== params.normalizedPrefix
  ) {
    params.settings.id_prefix = params.normalizedPrefix;
    params.warnings.push(`updated:id_prefix:${params.normalizedPrefix}`);
    changed = true;
  }
  if (
    params.presetFromOption !== undefined &&
    params.settings.governance.preset !== params.presetFromOption
  ) {
    applyGovernancePreset(params.settings, params.presetFromOption);
    params.warnings.push(
      `updated:governance_preset:${params.presetFromOption}`,
    );
    changed = true;
  }
  if (
    params.authorFromOption !== undefined &&
    params.settings.author_default !== params.authorFromOption
  ) {
    params.settings.author_default = params.authorFromOption;
    params.warnings.push(`updated:author_default:${params.authorFromOption}`);
    changed = true;
  }
  return changed;
}

async function loadExistingInitSettings(params: {
  pmRoot: string;
  settingsPath: string;
  normalizedPrefix: string;
  prefixArg: string | undefined;
  options: InitCommandOptions;
  normalizedOptions: InitNormalizedOptions;
  warnings: string[];
}): Promise<InitSettingsResolution> {
  const settings = await readSettings(params.pmRoot);
  params.warnings.push(`already_exists:${params.settingsPath}`);
  const pendingChanges = collectExistingSettingsPendingChanges({
    settings,
    normalizedPrefix: params.normalizedPrefix,
    prefixArg: params.prefixArg,
    presetFromOption: params.normalizedOptions.presetFromOption,
    authorFromOption: params.normalizedOptions.authorFromOption,
  });
  assertExistingSettingsUpdateAllowed(
    params.settingsPath,
    pendingChanges,
    params.options.force === true,
  );
  if (
    applyExistingSettingsUpdates({
      settings,
      normalizedPrefix: params.normalizedPrefix,
      prefixArg: params.prefixArg,
      presetFromOption: params.normalizedOptions.presetFromOption,
      authorFromOption: params.normalizedOptions.authorFromOption,
      warnings: params.warnings,
    })
  ) {
    await writeSettings(params.pmRoot, settings);
  }
  return {
    settings,
    normalizedPrefix: params.normalizedPrefix,
    chosenPreset: params.normalizedOptions.presetFromOption,
    wizardUsed: false,
  };
}

async function createNewInitSettings(params: {
  pmRoot: string;
  normalizedPrefix: string;
  normalizedOptions: InitNormalizedOptions;
}): Promise<InitSettingsResolution> {
  let normalizedPrefix = params.normalizedPrefix;
  let chosenPreset = params.normalizedOptions.presetFromOption;
  let chosenTelemetryEnabled: boolean | undefined;
  let wizardUsed = false;
  if (
    params.normalizedOptions.presetFromOption === undefined &&
    !params.normalizedOptions.useDefaults &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  ) {
    const wizardChoices = await runInitWizard(
      normalizedPrefix,
      SETTINGS_DEFAULTS.telemetry.enabled,
    );
    normalizedPrefix = wizardChoices.prefix;
    chosenPreset = wizardChoices.preset;
    chosenTelemetryEnabled = wizardChoices.telemetry_enabled;
    wizardUsed = true;
  }
  const effectivePreset = chosenPreset ?? "minimal";
  const settings = cloneDefaults();
  settings.id_prefix = normalizedPrefix;
  applyGovernancePreset(settings, effectivePreset);
  const environmentAuthor = process.env.PM_AUTHOR?.trim() || undefined;
  settings.author_default =
    params.normalizedOptions.authorFromOption ??
    environmentAuthor ??
    `${userInfo().username}@${hostname()}`;
  if (chosenTelemetryEnabled !== undefined) {
    settings.telemetry.enabled = chosenTelemetryEnabled;
    settings.telemetry.first_run_prompt_completed = true;
  }
  await writeSettings(params.pmRoot, settings);
  return {
    settings,
    normalizedPrefix,
    chosenPreset,
    wizardUsed,
  };
}

async function resolveInitSettings(params: {
  pmRoot: string;
  settingsPath: string;
  settingsExists: boolean;
  normalizedPrefix: string;
  prefixArg: string | undefined;
  options: InitCommandOptions;
  normalizedOptions: InitNormalizedOptions;
  warnings: string[];
}): Promise<InitSettingsResolution> {
  if (params.settingsExists) {
    return await loadExistingInitSettings(params);
  }
  return await createNewInitSettings({
    pmRoot: params.pmRoot,
    normalizedPrefix: params.normalizedPrefix,
    normalizedOptions: params.normalizedOptions,
  });
}

async function applyInitAgentGuidance(params: {
  pmRoot: string;
  cwd: string;
  agentGuidanceMode: InitAgentGuidanceMode;
  settings: PmSettings;
  warnings: string[];
}): Promise<InitAgentGuidanceResult> {
  const agentGuidanceResult = await runInitAgentGuidance({
    pm_root: params.pmRoot,
    cwd: params.cwd,
    mode: params.agentGuidanceMode,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    settings: params.settings,
  });
  params.warnings.push(...agentGuidanceResult.warnings);
  if (agentGuidanceResult.settings_changed) {
    await writeSettings(params.pmRoot, params.settings);
  }
  return {
    ...agentGuidanceResult.summary,
    next_steps: agentGuidanceResult.next_steps,
  };
}

async function ensureInitRuntimeSchemaFiles(
  pmRoot: string,
  settings: PmSettings,
): Promise<{
  createdDirs: string[];
  warnings: string[];
}> {
  const createdDirs: string[] = [];
  const warnings: string[] = [];
  const runtimeSchemaScaffold = await ensureRuntimeSchemaFileScaffold(
    pmRoot,
    settings.schema,
  );
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
  return { createdDirs, warnings };
}

async function maybeRegisterInitTypePreset(params: {
  pmRoot: string;
  settings: PmSettings;
  typePreset: InitTypePresetName | undefined;
  warnings: string[];
}): Promise<InitRegisteredTypePresetSummary | undefined> {
  if (params.typePreset === undefined) {
    return undefined;
  }
  const registeredTypePreset = await registerInitTypePreset(
    params.pmRoot,
    params.settings,
    params.typePreset,
  );
  params.warnings.push(`registered_type_preset:${params.typePreset}`);
  params.warnings.push(
    ...(await runActiveOnWriteHooks({
      path: registeredTypePreset.file,
      scope: "project",
      op: "init:type_preset",
    })),
  );
  return registeredTypePreset;
}

async function ensureInitTypeDirectories(params: {
  pmRoot: string;
  settings: PmSettings;
  createdDirs: string[];
  warnings: string[];
}): Promise<void> {
  const typeRegistry = resolveItemTypeRegistry(
    params.settings,
    getActiveExtensionRegistrations(),
  );
  const customTypeFolders = typeRegistry.folders.filter(
    (folder) => !(PM_REQUIRED_SUBDIRS as readonly string[]).includes(folder),
  );
  const scaffold = await ensureInitDirectories(
    params.pmRoot,
    customTypeFolders,
  );
  params.createdDirs.push(...scaffold.createdDirs);
  params.warnings.push(...scaffold.warnings);
}

function resolveInitWorkspaceRoot(
  target: InitTargetResolution,
): string | undefined {
  const trackerRoot = path.resolve(target.tracker_root);
  const agentsRoot = path.dirname(trackerRoot);
  if (
    path.basename(trackerRoot) === "pm" &&
    path.basename(agentsRoot) === ".agents"
  ) {
    return path.dirname(agentsRoot);
  }
  return target.workspace_root;
}

async function maybeInstallInitBundledPackages(
  installBundledPackages: boolean,
  global: GlobalOptions,
  pmRoot: string,
  warnings: string[],
): Promise<InitInstalledPackagesSummary | undefined> {
  if (!installBundledPackages) {
    return undefined;
  }
  const packageInstallResult = await runExtension(
    "all",
    { install: true, project: true },
    { ...global, path: pmRoot },
  );
  warnings.push(...packageInstallResult.warnings);
  const installedPackages = summarizeInstalledPackages(packageInstallResult);
  const failedAliases = installedPackages.packages
    .filter((entry) => !entry.ok)
    .map((entry) => entry.alias);
  if (!installedPackages.installed_all || failedAliases.length > 0) {
    throw new PmCliError(
      `pm init --with-packages did not install all bundled packages successfully${failedAliases.length > 0 ? `: ${failedAliases.join(", ")}` : "."}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  return installedPackages;
}

function buildInitNextSteps(params: {
  installBundledPackages: boolean;
  registeredTypePreset: InitRegisteredTypePresetSummary | undefined;
  agentGuidanceNextSteps: string[];
  target: InitTargetResolution;
}): string[] {
  const pmCommand = (args: string[]): string =>
    renderPmCommand([
      ...(params.target.mode === "workspace-discovery"
        ? []
        : ["--pm-path", params.target.tracker_root]),
      ...args,
    ]);
  const nextSteps: string[] = [
    `Create your first item: ${pmCommand(["create", "--type", "Task", "--title", "<title>"])}`,
    `List active items: ${pmCommand(["list"])}`,
    `Get agent-friendly project context: ${pmCommand(["context"])}`,
  ];
  if (!params.installBundledPackages) {
    nextSteps.push(
      `Add optional packages for richer workflows: ${pmCommand(["install", "calendar", "--project"])}, ${pmCommand(["install", "templates", "--project"])}, ${pmCommand(["install", "guide-shell", "--project"])}`,
    );
    nextSteps.push(
      `Or install everything bundled: ${pmCommand(["init", "--with-packages"])} (idempotent on re-run)`,
    );
  } else {
    nextSteps.push(
      `Explore newly-available commands: ${pmCommand(["cal"])}, ${pmCommand(["templates"])}, ${pmCommand(["guide"])}`,
    );
  }
  if (params.registeredTypePreset) {
    nextSteps.push(
      `Inspect registered preset types: ${pmCommand(["schema", "list"])}, ${pmCommand(["schema", "show", params.registeredTypePreset.registered[0] ?? params.registeredTypePreset.updated[0]])}`,
    );
  }
  nextSteps.push(
    "Set PM_AUTHOR=<your-agent-id> so mutations attribute to the right caller.",
  );
  for (const guidanceNextStep of params.agentGuidanceNextSteps) {
    const scopedGuidance =
      params.target.mode === "workspace-discovery"
        ? guidanceNextStep
        : guidanceNextStep.replace(
            /\bpm (?=[a-z])/g,
            () => `${pmCommand([])} `,
          );
    if (!nextSteps.includes(scopedGuidance)) {
      nextSteps.push(scopedGuidance);
    }
  }
  return nextSteps;
}

/** Implements run init for the public runtime surface of this module. */
export async function runInit(
  prefixArg: string | undefined,
  global: GlobalOptions,
  options: InitCommandOptions = {},
): Promise<InitResult> {
  const cwd = process.cwd();
  const invocation = resolveInitInvocation(
    cwd,
    global,
    prefixArg,
    options.workspace,
  );
  const pmRoot = invocation.pmRoot;
  prefixArg = resolveInitPrefixInput(invocation.prefixArg, options.idPrefix);
  const normalizedOptions = normalizeInitCommandOptions(options);
  await assertExplicitTrackerPathIsNotWorkspaceRoot(
    pmRoot,
    invocation.target.mode === "tracker-path",
    options.force === true,
  );
  const createdDirs: string[] = [];
  const warnings: string[] = [];
  const baseDirs = await ensureInitDirectories(pmRoot, PM_REQUIRED_SUBDIRS);
  createdDirs.push(...baseDirs.createdDirs);
  warnings.push(...baseDirs.warnings);

  const settingsPath = path.join(pmRoot, "settings.json");
  const settingsExists = await pathExists(settingsPath);
  const settingsResolution = await resolveInitSettings({
    pmRoot,
    settingsPath,
    settingsExists,
    normalizedPrefix: normalizePrefix(prefixArg),
    prefixArg,
    options,
    normalizedOptions,
    warnings,
  });
  let { settings } = settingsResolution;

  const workspaceRoot = resolveInitWorkspaceRoot(invocation.target);
  const agentGuidance = await applyInitAgentGuidance({
    pmRoot,
    cwd: workspaceRoot ?? cwd,
    agentGuidanceMode: normalizedOptions.agentGuidanceMode,
    settings,
    warnings,
  });

  const schemaFiles = await ensureInitRuntimeSchemaFiles(pmRoot, settings);
  createdDirs.push(...schemaFiles.createdDirs);
  warnings.push(...schemaFiles.warnings);

  const registeredTypePreset = await maybeRegisterInitTypePreset({
    pmRoot,
    settings,
    typePreset: normalizedOptions.typePreset,
    warnings,
  });
  if (registeredTypePreset) {
    settings = await readSettings(pmRoot);
  }

  await ensureInitTypeDirectories({ pmRoot, settings, createdDirs, warnings });
  if (workspaceRoot) {
    const gitignore = await ensurePmGitignore(workspaceRoot, { pmRoot });
    if (gitignore.changed) {
      warnings.push(`updated:gitignore:${gitignore.path}`);
    }
  }
  const installedPackages = await maybeInstallInitBundledPackages(
    normalizedOptions.installBundledPackages,
    global,
    pmRoot,
    warnings,
  );

  const nextSteps = buildInitNextSteps({
    installBundledPackages: normalizedOptions.installBundledPackages,
    registeredTypePreset,
    agentGuidanceNextSteps: agentGuidance.next_steps,
    target: invocation.target,
  });

  return {
    ok: true,
    path: pmRoot,
    target: invocation.target,
    settings,
    created_dirs: createdDirs,
    warnings,
    governance_preset: settings.governance.preset,
    wizard_used: settingsResolution.wizardUsed,
    ...(registeredTypePreset
      ? { registered_type_preset: registeredTypePreset }
      : {}),
    ...(installedPackages ? { installed_packages: installedPackages } : {}),
    next_steps: nextSteps,
    agent_guidance: agentGuidance,
  };
}
