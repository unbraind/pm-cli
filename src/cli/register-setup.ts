import type { Command } from "commander";
import type { GlobalOptions } from "../core/shared/command-types.js";
import {
  runConfig,
  runExtension,
  runInit,
  runTemplatesList,
  runTemplatesSave,
  runTemplatesShow,
} from "./commands/index.js";
import {
  collect,
  getGlobalOptions,
  normalizeCreateOptions,
  printError,
  printResult,
} from "./registration-helpers.js";

type ExtensionSubcommandAction =
  | "init"
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "reload"
  | "doctor"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate";

type LifecycleCommandVocabulary = "extension" | "package";

function normalizeExtensionOptions(
  options: Record<string, unknown>,
  forcedAction?: ExtensionSubcommandAction,
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
    explore: isForcedAction("explore") || readBoolean("explore"),
    manage: isForcedAction("manage") || readBoolean("manage"),
    reload: isForcedAction("reload") || readBoolean("reload"),
    doctor: isForcedAction("doctor") || readBoolean("doctor"),
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
    detail: readString("detail"),
    trace: readBoolean("trace"),
    watch: readBoolean("watch"),
    runtimeProbe: readBoolean("runtimeProbe", "runtime_probe", "runtime-probe"),
    fixManagedState: readBoolean("fixManagedState", "fix_managed_state", "fix-managed-state"),
    strictExit: readBoolean("strictExit", "strict_exit", "strict-exit"),
    failOnWarn: readBoolean("failOnWarn", "fail_on_warn", "fail-on-warn"),
  };
}

import { EXIT_CODE } from "../core/shared/constants.js";

async function executeExtensionCommand(
  target: string | undefined,
  options: Record<string, unknown>,
  command: Command,
  forcedAction?: ExtensionSubcommandAction,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const normalizedOptions = normalizeExtensionOptions(options, forcedAction);
  const result = await runExtension(target, normalizedOptions, globalOptions);
  printResult(result, globalOptions);
  const strictExit = Boolean(normalizedOptions.strictExit) || Boolean(normalizedOptions.failOnWarn);
  if (result.action === "doctor" && strictExit) {
    const detailsRecord = result.details as Record<string, unknown>;
    const summary = (detailsRecord.summary ?? null) as Record<string, unknown> | null;
    const summaryStatus = summary && typeof summary.status === "string" ? summary.status : undefined;
    const shouldFail = summaryStatus ? summaryStatus !== "ok" : result.warnings.length > 0;
    if (shouldFail) {
      process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    }
  }
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
    .option("--install", `Install ${noun} from local path or GitHub source`)
    .option("--uninstall", `Uninstall an installed ${noun}`)
    .option("--explore", `List discovered ${plural} in selected scope`)
    .option("--manage", `List managed ${plural} with update-check metadata`)
    .option("--reload", `Reload ${plural} with cache-busted module imports`)
    .option("--watch", "Use watch mode with --reload")
    .option("--doctor", `Run consolidated ${noun} diagnostics (summary/deep modes)`)
    .option("--adopt", `Adopt an existing unmanaged ${noun} into managed metadata`)
    .option("--adopt-all", `Adopt all unmanaged ${plural} into managed metadata`)
    .option("--activate", `Activate a ${noun} in selected scope settings`)
    .option("--deactivate", `Deactivate a ${noun} in selected scope settings`)
    .option("--project", `Use project ${noun} scope (default)`)
    .option("--local", "Alias for --project")
    .option("--global", `Use global ${noun} scope`)
    .option("--gh <owner/repo[/path]>", "Install from GitHub shorthand source")
    .option("--github <owner/repo[/path]>", "Alias for --gh")
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
      await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command);
    });

  if (vocabulary === "package") {
    lifecycleCommand.alias("packages");
  }

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("init")
      .alias("scaffold")
      .argument("<target>", `Scaffold target directory path`)
      .description(`Generate a starter ${noun} scaffold with manifest and entrypoint.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "init");
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("install")
      .argument("[target]", `${noun[0]!.toUpperCase()}${noun.slice(1)} source (local path or GitHub source)`)
      .option("--gh <owner/repo[/path]>", "Install from GitHub shorthand source")
      .option("--github <owner/repo[/path]>", "Alias for --gh")
      .option("--ref <ref>", "Git ref/branch/tag for GitHub install sources")
      .description(`Install ${noun} from local path or GitHub source.`),
    vocabulary,
  ).action(async (target: string | undefined, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "install");
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("uninstall").argument("<target>", `${noun[0]!.toUpperCase()}${noun.slice(1)} name`).description(`Uninstall an installed ${noun}.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "uninstall");
  });

  addLifecycleScopeOptions(lifecycleCommand.command("explore").description(`List discovered ${plural} in selected scope.`), vocabulary).action(
    async (_options: Record<string, unknown>, command) => {
      await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "explore");
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
    await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "manage");
  });

  addLifecycleScopeOptions(
    lifecycleCommand
      .command("reload")
      .option("--watch", "Use watch mode for repeated reload checks")
      .description(`Reload ${plural} with cache-busted module imports.`),
    vocabulary,
  ).action(async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "reload");
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
    await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "doctor");
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
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "adopt");
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("adopt-all").description(`Adopt all unmanaged ${plural} into managed metadata.`),
    vocabulary,
  ).action(async (_options: Record<string, unknown>, command) => {
    await executeExtensionCommand(undefined, command.opts() as Record<string, unknown>, command, "adopt-all");
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("activate").argument("<target>", `${noun[0]!.toUpperCase()}${noun.slice(1)} name`).description(`Activate a ${noun} in selected scope settings.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "activate");
  });

  addLifecycleScopeOptions(
    lifecycleCommand.command("deactivate").argument("<target>", `${noun[0]!.toUpperCase()}${noun.slice(1)} name`).description(`Deactivate a ${noun} in selected scope settings.`),
    vocabulary,
  ).action(async (target: string, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "deactivate");
  });
}

export function registerSetupCommands(program: Command): void {
  program
    .command("init")
    .argument("[prefix]", "Optional id prefix")
    .option("--preset <value>", "Governance preset for new setups: minimal|default|strict")
    .option("--defaults", "Use non-interactive setup defaults without opening the wizard")
    .option("--author <value>", "Set the default mutation author for this project")
    .description("Initialize pm storage and defaults for the current workspace.")
    .action(async (prefix: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runInit(
        prefix,
        globalOptions,
        {
          preset: typeof options.preset === "string" ? options.preset : undefined,
          defaults: options.defaults === true,
          author: typeof options.author === "string" ? options.author : undefined,
        },
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=init took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("config")
    .argument("<scope>", "Config scope: project|global")
    .argument("<action>", "Config action: get|set|list|export")
    .argument(
      "[key]",
      "Config key for get|set: definition-of-done|item-format|history-missing-stream-policy|sprint-release-format-policy|parent-reference-policy|metadata-validation-profile|metadata-required-fields|lifecycle-stale-blocker-reason-patterns|lifecycle-closure-like-blocked-reason-patterns|lifecycle-closure-like-resolution-patterns|lifecycle-closure-like-actual-result-patterns|governance-preset|governance-ownership-enforcement|governance-create-mode-default|governance-close-validation-default|governance-parent-reference-policy|governance-metadata-validation-profile|governance-force-required-for-stale-lock|test-result-tracking|telemetry-tracking|context",
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
      "Policy key values: history-missing-stream-policy=auto_create|strict_error; sprint-release-format-policy=warn|strict_error; parent-reference-policy=warn|strict_error; governance-preset=minimal|default|strict|custom; governance-ownership-enforcement=none|warn|strict; governance-create-mode-default=progressive|strict; governance-close-validation-default=off|warn|strict; governance-parent-reference-policy=warn|strict_error; governance-metadata-validation-profile=core|strict|custom; governance-force-required-for-stale-lock=enabled|disabled; test-result-tracking=enabled|disabled; telemetry-tracking=enabled|disabled",
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
    .action(async (scope: string, action: string, key: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const criteria = Array.isArray(options.criterion) ? (options.criterion as string[]) : [];
      const result = await runConfig(
        scope,
        action,
        key,
        {
          criterion: criteria,
          format: typeof options.format === "string" ? options.format : undefined,
          policy: typeof options.policy === "string" ? options.policy : undefined,
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
        },
        globalOptions,
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=config took_ms=${Date.now() - startedAt}`);
      }
    });

  registerLifecycleCommand(program, "extension");
  registerLifecycleCommand(program, "package");

  addPackageScopeOptions(
    program
      .command("install")
      .argument("[target]", "Package source (local path, bundled alias, or GitHub source)")
      .option("--gh <owner/repo[/path]>", "Install from GitHub shorthand source")
      .option("--github <owner/repo[/path]>", "Alias for --gh")
      .option("--ref <ref>", "Git ref/branch/tag for GitHub install sources")
      .description("Install a pm package into the project package scope by default."),
  ).action(async (target: string | undefined, _options: Record<string, unknown>, command) => {
    await executeExtensionCommand(target, command.opts() as Record<string, unknown>, command, "install");
  });

  const templatesCommand = program
    .command("templates")
    .description("Manage reusable create templates.")
    .action(async () => {
      const globalOptions = program.opts<GlobalOptions>();
      const result = await runTemplatesList(globalOptions);
      printResult(result, globalOptions);
    });

  templatesCommand
    .command("save")
    .argument("<name>", "Template name")
    .option("--title, -t <value>", "Template default item title")
    .option("--description, -d <value>", "Template default item description")
    .option("--type <value>", "Template default item type")
    .option("--status, -s <value>", "Template default item status")
    .option("--priority, -p <value>", "Template default priority 0..4")
    .option("--tags <value>", "Template default comma-separated tags")
    .option("--body, -b <value>", "Template default item markdown body")
    .option("--deadline <value>", "Template default deadline")
    .option("--estimate, --estimated-minutes <value>", "Template default estimated minutes")
    .option("--estimated_minutes <value>", "Alias for --estimated-minutes")
    .option("--acceptance-criteria <value>", "Template default acceptance criteria")
    .option("--acceptance_criteria <value>", "Alias for --acceptance-criteria")
    .option("--ac <value>", "Alias for --acceptance-criteria")
    .option("--definition-of-ready <value>", "Template default definition of ready")
    .option("--definition_of_ready <value>", "Alias for --definition-of-ready")
    .option("--order <value>", "Template default planning order/rank integer")
    .option("--rank <value>", "Alias for --order")
    .option("--goal <value>", "Template default goal identifier")
    .option("--objective <value>", "Template default objective identifier")
    .option("--value <value>", "Template default business value summary")
    .option("--impact <value>", "Template default business impact summary")
    .option("--outcome <value>", "Template default expected outcome summary")
    .option("--why-now <value>", "Template default why-now rationale")
    .option("--why_now <value>", "Alias for --why-now")
    .option("--author <value>", "Template default mutation author")
    .option("--message <value>", "Template default history message")
    .option("--assignee <value>", "Template default assignee")
    .option("--parent <value>", "Template default parent item ID")
    .option("--reviewer <value>", "Template default reviewer")
    .option("--risk <value>", "Template default risk level")
    .option("--confidence <value>", "Template default confidence")
    .option("--sprint <value>", "Template default sprint identifier")
    .option("--release <value>", "Template default release identifier")
    .option("--blocked-by <value>", "Template default blocked-by item ID or reason")
    .option("--blocked_by <value>", "Alias for --blocked-by")
    .option("--blocked-reason <value>", "Template default blocked reason")
    .option("--blocked_reason <value>", "Alias for --blocked-reason")
    .option("--unblock-note <value>", "Template default unblock rationale note")
    .option("--unblock_note <value>", "Alias for --unblock-note")
    .option("--reporter <value>", "Template default issue reporter")
    .option("--severity <value>", "Template default issue severity")
    .option("--environment <value>", "Template default issue environment context")
    .option("--repro-steps <value>", "Template default issue reproduction steps")
    .option("--repro_steps <value>", "Alias for --repro-steps")
    .option("--resolution <value>", "Template default issue resolution summary")
    .option("--expected-result <value>", "Template default issue expected behavior")
    .option("--expected_result <value>", "Alias for --expected-result")
    .option("--actual-result <value>", "Template default issue observed behavior")
    .option("--actual_result <value>", "Alias for --actual-result")
    .option("--affected-version <value>", "Template default affected version identifier")
    .option("--affected_version <value>", "Alias for --affected-version")
    .option("--fixed-version <value>", "Template default fixed version identifier")
    .option("--fixed_version <value>", "Alias for --fixed-version")
    .option("--component <value>", "Template default issue component ownership")
    .option("--regression <value>", "Template default regression marker")
    .option("--customer-impact <value>", "Template default customer impact summary")
    .option("--customer_impact <value>", "Alias for --customer-impact")
    .option(
      "--dep <value>",
      "Template default dependency entry (repeatable; CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--type-option <value>",
      "Template default type option entry (repeatable; key=value or markdown pairs; use - for stdin)",
      collect,
    )
    .option("--type_option <value>", "Alias for --type-option", collect)
    .option(
      "--reminder <value>",
      "Template default reminder entry (repeatable; at=<iso|relative>,text=<text>)",
      collect,
    )
    .option(
      "--event <value>",
      "Template default event entry (repeatable; start/end/title/recur_* fields)",
      collect,
    )
    .option(
      "--comment <value>",
      "Template default comment seed entry (repeatable; text=<value> CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--note <value>",
      "Template default note seed entry (repeatable; text=<value> CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--learning <value>",
      "Template default learning seed entry (repeatable; text=<value> CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--file <value>",
      "Template default linked file entry (repeatable; CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--test <value>",
      "Template default linked test entry (repeatable; CSV/markdown pairs or - for stdin)",
      collect,
    )
    .option(
      "--doc <value>",
      "Template default linked doc entry (repeatable; CSV/markdown pairs or - for stdin)",
      collect,
    )
    .description("Save or update a named create template.")
    .action(async (name: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const normalized = normalizeCreateOptions(options, { requireType: false }) as unknown as Record<string, unknown>;
      const result = await runTemplatesSave(name, normalized, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=templates save took_ms=${Date.now() - startedAt}`);
      }
    });

  templatesCommand
    .command("list")
    .description("List saved create templates.")
    .action(async (_options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTemplatesList(globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=templates list took_ms=${Date.now() - startedAt}`);
      }
    });

  templatesCommand
    .command("show")
    .argument("<name>", "Template name")
    .description("Show saved create template details.")
    .action(async (name: string, _options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTemplatesShow(name, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=templates show took_ms=${Date.now() - startedAt}`);
      }
    });
}
