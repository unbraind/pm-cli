/**
 * @module cli/register-setup
 *
 * Provides CLI runtime support for Register Setup.
 */
import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  collect,
  getGlobalOptions,
  printError,
  printResult,
  writeStdout,
} from "./registration-helpers.js";
import { SCAFFOLD_CAPABILITIES } from "./commands/extension/scaffold.js";
import { renderExtensionDescribeMarkdown, type ExtensionDescribeResult } from "./commands/extension/describe.js";



type ExtensionSubcommandAction =
  | "init"
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "describe"
  | "reload"
  | "doctor"
  | "catalog"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate";

type LifecycleCommandVocabulary = "extension" | "package";

function normalizeExtensionOptions(
  options: Record<string, unknown>,
  forcedAction?: ExtensionSubcommandAction,
  vocabulary: LifecycleCommandVocabulary = "extension",
): Record<string, unknown> {
  const isForcedAction = (action: ExtensionSubcommandAction): boolean => forcedAction === action;
  const readBoolean = (...keys: string[]): boolean => keys.some((key) => options[key] === true);
  const readString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof options[key] === "string") {
        return options[key] as string;
      }
    }
    return undefined;
  };
  return {
    init: isForcedAction("init") || readBoolean("init"),
    scaffold: readBoolean("scaffold"),
    install: isForcedAction("install") || readBoolean("install"),
    uninstall: isForcedAction("uninstall") || readBoolean("uninstall"),
    explore: isForcedAction("explore") || readBoolean("explore", "list"),
    manage: isForcedAction("manage") || readBoolean("manage"),
    describe: isForcedAction("describe") || readBoolean("describe"),
    markdown: readBoolean("markdown"),
    reload: isForcedAction("reload") || readBoolean("reload"),
    doctor: isForcedAction("doctor") || readBoolean("doctor"),
    catalog: isForcedAction("catalog") || readBoolean("catalog"),
    adopt: isForcedAction("adopt") || readBoolean("adopt"),
    adoptAll: isForcedAction("adopt-all") || readBoolean("adoptAll", "adopt_all", "adopt-all"),
    activate: isForcedAction("activate") || readBoolean("activate"),
    deactivate: isForcedAction("deactivate") || readBoolean("deactivate"),
    project: readBoolean("project"),
    local: readBoolean("local"),
    global: readBoolean("global"),
    gh: readString("gh"),
    github: readString("github"),
    ref: readString("ref"),
    capability: readString("capability"),
    declarative: readBoolean("declarative"),
    fields: readString("fields"),
    detail: readString("detail"),
    output: readString("output"),
    trace: readBoolean("trace"),
    watch: readBoolean("watch"),
    runtimeProbe: readBoolean("runtimeProbe", "runtime_probe", "runtime-probe"),
    fixManagedState: readBoolean("fixManagedState", "fix_managed_state", "fix-managed-state"),
    strictExit: readBoolean("strictExit", "strict_exit", "strict-exit"),
    failOnWarn: readBoolean("failOnWarn", "fail_on_warn", "fail-on-warn"),
    vocabulary,
  };
}

async function looksLikeShellExpandedWildcard(targets: string[]): Promise<boolean> {
  // Only ever called by normalizeInstallTargets after it has already returned
  // early for length <= 1, so targets always has more than one entry here.
  const visibleEntries = (await fs.readdir(process.cwd()))
    .filter((entry) => !entry.startsWith("."))
    .sort((left, right) => left.localeCompare(right));
  const normalizedTargets = [...targets].sort((left, right) => left.localeCompare(right));
  return (
    visibleEntries.length === normalizedTargets.length &&
    visibleEntries.every((entry, index) => entry === normalizedTargets[index])
  );
}

async function normalizeInstallTargets(targets: string[] | undefined): Promise<string | undefined> {
  // Commander variadic `[targets...]` always yields an array (empty when no
  // targets are given), so a single nullish coalesce covers every input.
  /* c8 ignore start -- commander variadic `[targets...]` always passes an array; the `?? []` arm is an unreachable nullish guard */
  const normalizedTargets = (targets ?? [])
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
  /* c8 ignore stop */
  if (normalizedTargets.length <= 1) {
    return normalizedTargets[0];
  }
  if (await looksLikeShellExpandedWildcard(normalizedTargets)) {
    return "*";
  }
  throw new PmCliError(
    `Install accepts one package source at a time. To install bundled first-party packages, quote the wildcard: pm install '*'`,
    EXIT_CODE.USAGE,
  );
}

function validateExtensionMarkdownOptions(
  normalizedOptions: Record<string, unknown>,
  globalOptions: GlobalOptions,
  outputPath: string | undefined,
): void {
  const wantsMarkdown = normalizedOptions.markdown === true;
  if (outputPath !== undefined && outputPath === "") {
    throw new PmCliError("--output requires a non-empty file path.", EXIT_CODE.USAGE);
  }
  if (outputPath !== undefined && !wantsMarkdown) {
    throw new PmCliError("--output is only supported with --markdown describe output.", EXIT_CODE.USAGE);
  }
  if (!wantsMarkdown) {
    return;
  }
  if (globalOptions.json) {
    throw new PmCliError("Cannot combine --json with --markdown.", EXIT_CODE.USAGE);
  }
  if (normalizedOptions.describe !== true) {
    throw new PmCliError("--markdown is only supported by the describe action.", EXIT_CODE.USAGE);
  }
}

async function emitExtensionMarkdownResult(params: {
  result: { details?: unknown; warnings: string[] };
  vocabulary: LifecycleCommandVocabulary;
  outputPath: string | undefined;
  globalOptions: GlobalOptions;
}): Promise<void> {
  const markdown = renderExtensionDescribeMarkdown(params.result.details as unknown as ExtensionDescribeResult, params.vocabulary);
  if (params.outputPath !== undefined) {
    const resolvedOutputPath = path.resolve(params.outputPath);
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await fs.writeFile(resolvedOutputPath, markdown, "utf8");
  }
  if (params.globalOptions.quiet) {
    return;
  }
  for (const warning of params.result.warnings) {
    printError(`warning: ${warning}`);
  }
  if (params.outputPath === undefined) {
    writeStdout(markdown);
  }
}

function applyExtensionDoctorStrictExit(
  result: { action: string; details?: unknown; warnings: string[] },
  normalizedOptions: Record<string, unknown>,
): void {
  const strictExit = Boolean(normalizedOptions.strictExit) || Boolean(normalizedOptions.failOnWarn);
  if (result.action !== "doctor" || !strictExit) {
    return;
  }
  const detailsRecord = result.details !== null && typeof result.details === "object"
    ? result.details as Record<string, unknown>
    : {};
  const summary = detailsRecord.summary !== null && typeof detailsRecord.summary === "object"
    ? detailsRecord.summary as Record<string, unknown>
    : null;
  const summaryStatus = summary && typeof summary.status === "string" ? summary.status : undefined;
  const shouldFail = result.warnings.length > 0 || (summaryStatus !== undefined && summaryStatus !== "ok");
  if (shouldFail) {
    process.exitCode = EXIT_CODE.GENERIC_FAILURE;
  }
}

async function executeExtensionCommand(
  target: string | undefined,
  options: Record<string, unknown>,
  command: Command,
  forcedAction?: ExtensionSubcommandAction,
  vocabulary: LifecycleCommandVocabulary = "extension",
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const normalizedOptions = normalizeExtensionOptions(options, forcedAction, vocabulary);
  const outputOption = typeof normalizedOptions.output === "string" ? normalizedOptions.output : undefined;
  const outputPath = outputOption?.trim();
  validateExtensionMarkdownOptions(normalizedOptions, globalOptions, outputPath);
  const { runExtension } = await import("./commands/extension.js");
  const result = await runExtension(target, normalizedOptions, globalOptions);
  if (normalizedOptions.markdown === true) {
    await emitExtensionMarkdownResult({ result, vocabulary, outputPath, globalOptions });
  } else {
    printResult(result, globalOptions);
  }
  applyExtensionDoctorStrictExit(result, normalizedOptions);
  if (globalOptions.profile) {
    printError(`profile:command=extension took_ms=${Date.now() - startedAt}`);
  }
}

function addExtensionScopeOptions<T extends Command>(command: T): T {
  return command
    .option("--project", "Use project extension scope (default)")
    .option("--local", "Alias for --project")
    .option("--global", "Use global extension scope");
}

function addPackageScopeOptions<T extends Command>(command: T): T {
  return command
    .option("--project", "Use project package scope (default)")
    .option("--local", "Alias for --project")
    .option("--global", "Use global package scope");
}

function addLifecycleScopeOptions<T extends Command>(command: T, vocabulary: LifecycleCommandVocabulary): T {
  return vocabulary === "package" ? addPackageScopeOptions(command) : addExtensionScopeOptions(command);
}

function registerLifecycleCommand(
  program: Command,
  vocabulary: LifecycleCommandVocabulary,
): void {
  const noun = vocabulary === "package" ? "package" : "extension";
  const plural = vocabulary === "package" ? "packages" : "extensions";
  const commandName = vocabulary;
  const lifecycleCommand = program
    .command(commandName)
    .argument("[target]", `${noun[0]!.toUpperCase()}${noun.slice(1)} source/name or scaffold target path (for --init/--scaffold)`)
    .option("--init", `Generate a starter ${noun} scaffold at target path`)
    .option("--scaffold", "Alias for --init")
    .option("--capability <kind>", `Capability the --init starter targets (${SCAFFOLD_CAPABILITIES.join("|")}; default commands)`)
    .option("--install", `Install ${noun} from local path, bundled alias, npm: source, wildcard, or GitHub source`)
    .option("--uninstall", `Uninstall an installed ${noun}`)
    .option("--explore", `List discovered ${plural} in selected scope`)
    .option("--list", "Alias for --explore")
    .option("--manage", `List managed ${plural} with update-check metadata`)
    .option("--describe", `Map every surface a loaded ${noun} registers (optionally one by name)`)
    .option("--markdown", "Render describe output as a Markdown reference document (describe only)")
    .option("--output <path>", "Write describe Markdown to a file (requires --markdown)")
    .option("--reload", `Reload ${plural} with cache-busted module imports`)
    .option("--watch", "Use watch mode with --reload")
    .option("--doctor", `Run consolidated ${noun} diagnostics (summary/deep modes)`)
    .option("--catalog", `List bundled first-party ${noun} catalog metadata`)
    .option("--adopt", `Adopt an existing unmanaged ${noun} into managed metadata`)
    .option("--adopt-all", `Adopt all unmanaged ${plural} into managed metadata`)
    .option("--activate", `Activate a ${noun} in selected scope settings`)
    .option("--deactivate", `Deactivate a ${noun} in selected scope settings`)
    .option("--project", `Use project ${noun} scope (default)`)
    .option("--local", "Alias for --project")
    .option("--global", `Use global ${noun} scope`)
    .option("--gh <github-source>", "Install from GitHub shorthand source (owner/repo[/path])")
    .option("--github <github-source>", "Alias for --gh")
    .option("--ref <ref>", "Git ref/branch/tag for GitHub install sources")
    .option("--detail <mode>", `${noun[0]!.toUpperCase()}${noun.slice(1)} diagnostics detail mode (summary|deep)`)
    .option("--trace", "Include actionable registration traces in doctor deep diagnostics")
    .option("--runtime-probe", "Opt-in runtime activation probe for manage output parity")
    .option("--fix-managed-state", `Adopt unmanaged ${plural} before diagnostics/update checks`)
    .option("--strict-exit", "Return non-zero exit when doctor warnings are present (ok=false)")
    .option("--fail-on-warn", "Alias for --strict-exit (doctor)")
    .description(
      vocabulary === "package"
        ? "Manage package lifecycle operations for project or global scope. Backward-compatible with extension packages."
        : "Manage extension lifecycle operations for project or global scope.",
    )
    .action(async (target: string | undefined, _options: Record<string, unknown>, command) => {
      await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, undefined, vocabulary);
    });

  if (vocabulary === "package") {
    lifecycleCommand.alias("packages");
    // `--declarative` scaffolds a `composeExtension` blueprint starter, which is a
    // runtime SDK *value* import — only package-mode authoring links the SDK, so the
    // flag is package-only. It is advertised solely on `pm package` (the top-level
    // lifecycle command and its `init` subcommand below); `scaffoldExtensionProject`
    // still rejects extension-mode + declarative as defense-in-depth for the
    // programmatic/MCP path.
    lifecycleCommand.option("--declarative", "Scaffold the composeExtension blueprint starter (any capability)");
  }

  const initCommand = lifecycleCommand
    .command("init")
    .alias("scaffold")
    .argument("<target>", `Scaffold target directory path`)
    .option("--capability <kind>", `Capability the starter targets (${SCAFFOLD_CAPABILITIES.join("|")}; default commands)`)
    .description(
      vocabulary === "package"
        ? "Generate a starter package scaffold with package metadata, manifest, and entrypoint."
        : "Generate a starter extension scaffold with manifest and entrypoint.",
    );
  if (vocabulary === "package") {
    initCommand.option("--declarative", "Scaffold the composeExtension blueprint starter (any capability)");
  }
  addLifecycleScopeOptions(initCommand, vocabulary).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "init", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("install")
      .argument("[targets...]", `${noun[0]!.toUpperCase()}${noun.slice(1)} source (local path, bundled alias, npm: source, wildcard, or GitHub source)`)
      .option("--gh <github-source>", "Install from GitHub shorthand source (owner/repo[/path])")
      .option("--github <github-source>", "Alias for --gh")
      .option("--ref <ref>", "Git ref/branch/tag for GitHub install sources")
      .description(`Install ${noun} from local path, bundled alias, npm: source, wildcard, or GitHub source.`),
    vocabulary,
  ).action(async (targets: string[] | undefined, _options: Record<string, unknown>, command) => {
    const target = await normalizeInstallTargets(targets);
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "install", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("uninstall").argument("<target>", `${noun[0]!.toUpperCase()}${noun.slice(1)} name`).description(`Uninstall an installed ${noun}.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "uninstall", vocabulary);
  });

  addLifecycleScopeOptions(lifecycleCommand.command("explore").description(`List discovered ${plural} in selected scope.`), vocabulary).action(
    async (_options: Record<string, unknown>, command) => {
      await executeExtensionCommand(undefined, command.optsWithGlobals() as Record<string, unknown>, command, "explore", vocabulary);
    },
  );

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("manage")
      .option("--runtime-probe", "Opt-in runtime activation probe for manage output parity")
      .option("--fix-managed-state", `Adopt unmanaged ${plural} before diagnostics/update checks`)
      .description(`List managed ${plural} with update-check metadata.`),
    vocabulary,
  ).action(async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.optsWithGlobals() as Record<string, unknown>, command, "manage", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("describe")
      .argument("[target]", `${noun[0]!.toUpperCase()}${noun.slice(1)} name to describe (omit for every loaded ${noun})`)
      .option("--markdown", "Render the surface map as a Markdown reference document instead of toon/json")
      .option("--output <path>", "Write Markdown output to a file (requires --markdown)")
      .description(`Map every surface a loaded ${noun} registers (commands, hooks, item types, providers, overrides, ...).`),
    vocabulary,
  ).action(async (target: string | undefined, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "describe", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("reload")
      .option("--watch", "Use watch mode for repeated reload checks")
      .description(`Reload ${plural} with cache-busted module imports.`),
    vocabulary,
  ).action(async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.optsWithGlobals() as Record<string, unknown>, command, "reload", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("doctor")
      .option("--detail <mode>", `Detail mode for ${noun} diagnostics (summary|deep)`)
      .option("--trace", "Include actionable registration traces in doctor deep diagnostics")
      .option("--fix-managed-state", `Adopt unmanaged ${plural} before diagnostics/update checks`)
      .option("--strict-exit", "Return non-zero exit when doctor warnings are present (ok=false)")
      .option("--fail-on-warn", "Alias for --strict-exit (doctor)")
      .description(`Run consolidated ${noun} diagnostics (summary/deep modes).`),
    vocabulary,
  ).action(async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.optsWithGlobals() as Record<string, unknown>, command, "doctor", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("catalog")
      .alias("list")
      .option("--fields <value>", "Render compact comma-separated catalog fields, for example: alias,installed,install_command")
      .description(`List bundled first-party ${noun} catalog metadata.`),
    vocabulary,
  ).action(async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.optsWithGlobals() as Record<string, unknown>, command, "catalog", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("adopt")
      .argument("<target>", `${noun[0]!.toUpperCase()}${noun.slice(1)} name`)
      .option("--gh <owner/repo[/path]>", `GitHub provenance shorthand for adopted ${noun}`)
      .option("--github <owner/repo[/path]>", "Alias for --gh")
      .option("--ref <ref>", "Git ref/branch/tag for GitHub shorthand source")
      .description(`Adopt an existing unmanaged ${noun} into managed metadata.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "adopt", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("adopt-all").description(`Adopt all unmanaged ${plural} into managed metadata.`),
    vocabulary,
  ).action(async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.optsWithGlobals() as Record<string, unknown>, command, "adopt-all", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("activate").argument("<target>", `${noun[0]!.toUpperCase()}${noun.slice(1)} name`).description(`Activate a ${noun} in selected scope settings.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "activate", vocabulary);
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("deactivate").argument("<target>", `${noun[0]!.toUpperCase()}${noun.slice(1)} name`).description(`Deactivate a ${noun} in selected scope settings.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "deactivate", vocabulary);
  });
}

async function runInitCommandAction(
  prefix: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runInit, summarizeInitResult } = await import("./commands/init.js");
  const result = await runInit(
    prefix,
    globalOptions,
    {
      preset: typeof options.preset === "string" ? options.preset : undefined,
      defaults: options.defaults === true || options.yes === true,
      author: typeof options.author === "string" ? options.author : undefined,
      agentGuidance: typeof options.agentGuidance === "string" ? options.agentGuidance : undefined,
      typePreset: typeof options.typePreset === "string" ? options.typePreset : undefined,
      withPackages: options.withPackages === true,
      force: options.force === true,
    },
  );
  const verbose = options.verbose === true;
  const emitFullTree = verbose || globalOptions.json === true;
  printResult(emitFullTree ? result : summarizeInitResult(result), globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=init took_ms=${Date.now() - startedAt}`);
  }
}

function resolveConfigPositionals(scope: string | undefined, action: string | undefined, key: string | undefined, value: string | undefined): {
  resolvedScope: string;
  resolvedAction: string;
  resolvedKey: string | undefined;
  resolvedValue: string | undefined;
} {
  const actionShorthands = new Set(["get", "set", "list", "export"]);
  const scopeShorthand = scope !== undefined && actionShorthands.has(scope);
  return {
    resolvedScope: scopeShorthand ? "project" : (scope ?? "project"),
    resolvedAction: scopeShorthand ? scope : (action ?? "list"),
    resolvedKey: scopeShorthand ? action : key,
    resolvedValue: scopeShorthand ? key : value,
  };
}

function buildConfigOptions(options: Record<string, unknown>): Record<string, unknown> {
  return {
    criterion: Array.isArray(options.criterion) ? (options.criterion as string[]) : [],
    format: typeof options.format === "string" ? options.format : undefined,
    policy: typeof options.policy === "string" ? options.policy : undefined,
    value: typeof options.value === "string" ? options.value : undefined,
    clearCriteria: options.clearCriteria === true,
    defaultDepth: typeof options.defaultDepth === "string" ? options.defaultDepth : undefined,
    activityLimit: typeof options.activityLimit === "string" ? options.activityLimit : undefined,
    staleThresholdDays: typeof options.staleThresholdDays === "string" ? options.staleThresholdDays : undefined,
    sectionHierarchy: typeof options.sectionHierarchy === "string" ? options.sectionHierarchy : undefined,
    sectionActivity: typeof options.sectionActivity === "string" ? options.sectionActivity : undefined,
    sectionProgress: typeof options.sectionProgress === "string" ? options.sectionProgress : undefined,
    sectionBlockers: typeof options.sectionBlockers === "string" ? options.sectionBlockers : undefined,
    sectionFiles: typeof options.sectionFiles === "string" ? options.sectionFiles : undefined,
    sectionWorkload: typeof options.sectionWorkload === "string" ? options.sectionWorkload : undefined,
    sectionStaleness: typeof options.sectionStaleness === "string" ? options.sectionStaleness : undefined,
    sectionTests: typeof options.sectionTests === "string" ? options.sectionTests : undefined,
  };
}

async function runConfigCommandAction(
  scope: string | undefined,
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const { runConfig } = await import("./commands/config.js");
  const { resolvedScope, resolvedAction, resolvedKey, resolvedValue } = resolveConfigPositionals(scope, action, key, value);
  const result = await runConfig(
    resolvedScope,
    resolvedAction,
    resolvedKey,
    buildConfigOptions(options),
    globalOptions,
    typeof resolvedValue === "string" ? resolvedValue : undefined,
  );
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=config took_ms=${Date.now() - startedAt}`);
  }
}

/**
 * Implements register setup commands for the public runtime surface of this module.
 */
export function registerSetupCommands(program: Command): void {
  program
    .command("init")
    .argument("[prefix-or-path]", "Optional id prefix, or path-like tracker target such as ./pm-sandbox")
    .option("--preset <value>", "Governance preset for new setups: minimal|default|strict")
    .option("--defaults", "Use non-interactive setup defaults without opening the wizard")
    .option("-y, --yes", "Alias for --defaults (non-interactive setup)")
    .option("--author <value>", "Set the default mutation author for this project")
    .option("--agent-guidance <mode>", "Agent guidance mode: ask|add|skip|status")
    .option("--type-preset <name>", "Register domain item types during init: agile|ops|research")
    .option("--with-packages", "Install all bundled first-party packages during initialization")
    .option("--force", "Allow initializing tracker files directly in a directory that looks like a workspace root")
    .option("--verbose", "Include the full resolved settings tree in the output (default output is a concise summary)")
    .description("Initialize pm storage and defaults for the current workspace or a path-like tracker target.")
    .action(async (prefix: string | undefined, options: Record<string, unknown>, command) => {
      await runInitCommandAction(prefix, options, command);
    });

  program
    .command("config")
    .argument("[scope]", "Config scope: project|global, or action shorthand list|export|get|set for project scope")
    .argument("[action]", "Config action: get|set|list|export")
    .argument(
      "[key]",
      "Config key for get|set: definition-of-done|item-format|history-missing-stream-policy|sprint-release-format-policy|parent-reference-policy|metadata-validation-profile|metadata-required-fields|lifecycle-stale-blocker-reason-patterns|lifecycle-closure-like-blocked-reason-patterns|lifecycle-closure-like-resolution-patterns|lifecycle-closure-like-actual-result-patterns|governance-preset|governance-ownership-enforcement|governance-create-mode-default|governance-close-validation-default|governance-require-close-reason|governance-parent-reference-policy|governance-metadata-validation-profile|governance-force-required-for-stale-lock|test-result-tracking|telemetry-tracking|context",
    )
    .argument(
      "[value]",
      "Optional value for set: routed to the right typed flag by key (e.g. config set telemetry-tracking off, config set item-format toon, config set definition-of-done \"Tests pass\"). Equivalent to --policy/--format/--criterion. context keys still require --default-depth/--section-* flags.",
    )
    .option(
      "--criterion <text>",
      "Criteria value for definition-of-done, metadata-required-fields, or lifecycle pattern keys (repeatable for set)",
      collect,
    )
    .option("--clear-criteria", "Clear criteria-list keys for config set operations")
    .option("--format <value>", "Item format for item-format key: toon")
    .option(
      "--policy <value>",
      "Policy key values: history-missing-stream-policy=auto_create|strict_error; sprint-release-format-policy=warn|strict_error; parent-reference-policy=warn|strict_error; governance-preset=minimal|default|strict|custom; governance-ownership-enforcement=none|warn|strict; governance-create-mode-default=progressive|strict; governance-close-validation-default=off|warn|strict; governance-require-close-reason=enabled|disabled; governance-parent-reference-policy=warn|strict_error; governance-metadata-validation-profile=core|strict|custom; governance-force-required-for-stale-lock=enabled|disabled; test-result-tracking=enabled|disabled; telemetry-tracking=enabled|disabled",
    )
    .option(
      "--value <value>",
      "Value for nested leaf settings keys (search_provider, search_mutation_refresh_policy, search_query_expansion_enabled, search_rerank_enabled, openai_base_url, ollama_model, vector_store_adapter, vector_store_collection_name, qdrant_url, lancedb_path, etc.). Equivalent to the positional value.",
    )
    .option("--default-depth <value>", "Context default depth: brief|standard|deep")
    .option("--activity-limit <n>", "Context default activity limit")
    .option("--stale-threshold-days <n>", "Context staleness cutoff in days")
    .option("--section-hierarchy <value>", "Enable/disable context hierarchy section (true|false)")
    .option("--section-activity <value>", "Enable/disable context activity section (true|false)")
    .option("--section-progress <value>", "Enable/disable context progress section (true|false)")
    .option("--section-blockers <value>", "Enable/disable context blockers section (true|false)")
    .option("--section-files <value>", "Enable/disable context files section (true|false)")
    .option("--section-workload <value>", "Enable/disable context workload section (true|false)")
    .option("--section-staleness <value>", "Enable/disable context staleness section (true|false)")
    .option("--section-tests <value>", "Enable/disable context tests section (true|false)")
    .description("Read or update pm settings for the current workspace or global profile.")
    .action(async (scope: string | undefined, action: string | undefined, key: string | undefined, value: string | undefined, options: Record<string, unknown>, command) => {
      await runConfigCommandAction(scope, action, key, value, options, command);
    });

  registerLifecycleCommand(program, "extension");
  registerLifecycleCommand(program, "package");

  addPackageScopeOptions(
    program
      .command("install")
      .argument("[targets...]", "Package source (local path, bundled alias, npm: source, wildcard, or GitHub source)")
      .option("--gh <github-source>", "Install from GitHub shorthand source (owner/repo[/path])")
      .option("--github <github-source>", "Alias for --gh")
      .option("--ref <ref>", "Git ref/branch/tag for GitHub install sources")
      .description("Install a pm package into the project package scope by default."),
  ).action(async (targets: string[] | undefined, _options: Record<string, unknown>, command) => {
    const target = await normalizeInstallTargets(targets);
    await executeExtensionCommand(target, command.optsWithGlobals() as Record<string, unknown>, command, "install", "package");
  });

  addPackageScopeOptions(
    program
      .command("upgrade")
      .argument("[target]", "Optional managed package name/source to upgrade; omit to upgrade pm CLI and all managed packages")
      .option("--dry-run", "Plan CLI/package upgrades without running npm or reinstalling packages")
      .option("--cli-only", "Upgrade only the pm CLI/SDK npm package")
      .option("--packages-only", "Upgrade only managed pm packages")
      .option("--repair", "Force npm global reinstall when upgrading the pm CLI/SDK")
      .option("--tag <value>", "npm dist-tag/version for CLI and registry package upgrades")
      .option("--package-name <value>", "Override the CLI package name for self-upgrade testing")
      .description("Upgrade the pm CLI/SDK and refresh managed installable pm packages."),
  ).action(async (target: string | undefined, _options: Record<string, unknown>, command) => {
    const globalOptions = getGlobalOptions(command);
    const startedAt = Date.now();
    const { runUpgrade } = await import("./commands/upgrade.js");
    const result = await runUpgrade(target, command.opts() as Record<string, unknown>, globalOptions);
    printResult(result, globalOptions);
    if (!result.ok) {
      process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    }
    if (globalOptions.profile) {
      printError(`profile:command=upgrade took_ms=${Date.now() - startedAt}`);
    }
  });
}
