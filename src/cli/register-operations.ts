/**
 * @module cli/register-operations
 *
 * Provides CLI runtime support for Register Operations.
 */
import type { Command } from "commander";
import {
  normalizeStatusInputWithRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../core/schema/runtime-schema.js";
import { setActiveCommandResult } from "../core/extensions/index.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import {
  buildBackgroundTestAllCommandArgs,
  buildBackgroundTestCommandArgs,
  collect,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  printError,
  printResult,
} from "./registration-helpers.js";

/**
 * Resolve the status the `start-task` lifecycle alias should move an item to.
 * Resolves `in_progress` strictly through the workspace registry so a custom
 * workflow that omits in_progress falls back to its open status instead of
 * setting a status the workflow does not define.
 */
export function resolveStartTaskInProgressStatus(statusRegistry: RuntimeStatusRegistry): string {
  return normalizeStatusInputWithRegistry("in_progress", statusRegistry) ?? statusRegistry.open_status;
}

function resolveTelemetrySubcommand(namespaceOrSubcommand: string | undefined, subcommand: string | undefined): string | undefined {
  const normalizedNamespace = namespaceOrSubcommand?.trim().toLowerCase();
  const normalizedSubcommand = subcommand?.trim().toLowerCase();
  if (normalizedNamespace === undefined || normalizedNamespace.length === 0) {
    return normalizedSubcommand;
  }
  if (normalizedNamespace === "local-analytics") {
    return normalizedSubcommand && normalizedSubcommand.length > 0 ? normalizedSubcommand : "status";
  }
  if (normalizedSubcommand !== undefined && normalizedSubcommand.length > 0) {
    throw new PmCliError(
      `Unknown pm telemetry path "${namespaceOrSubcommand} ${subcommand}". Use "pm telemetry ${namespaceOrSubcommand}" or legacy alias "pm telemetry local-analytics ${normalizedSubcommand}".`,
      EXIT_CODE.USAGE,
      {
        code: "unknown_subcommand",
        examples: [
          "pm telemetry status",
          "pm telemetry flush",
          "pm telemetry stats --limit 10",
          "pm telemetry clear",
          "pm telemetry local-analytics status --json",
        ],
      },
    );
  }
  return normalizedNamespace;
}



/**
 * Implements register operation commands for the public runtime surface of this module.
 */
export function registerOperationCommands(program: Command): void {
  program
    .command("test")
    .argument("<id>", "Item id")
    .option("--add <value>", "Add linked test entry (CSV/markdown pairs or - for stdin)", collect)
    .option("--add-json <value>", "Add linked test entry from JSON object/array (or - for stdin)", collect)
    .option("--remove <value>", "Remove linked test entry by command/path (command=<value>, path=<value>, markdown pairs, plain value, or - for stdin)", collect)
    .option("--list", "List linked tests without mutating")
    .option("--run", "Run linked test commands")
    .option("--match <value>", "Run only linked tests whose command/path contains this substring")
    .option("--only-index <n>", "Run only the 1-based linked-test index from --list order")
    .option("--only-last", "Run only the most recently added linked test")
    .option("--background", "Run linked tests in managed background mode")
    .option("--timeout <seconds>", "Default run timeout in seconds")
    .option("--progress", "Emit linked-test progress to stderr (always shown in TTY, opt-in for non-TTY)")
    .option("--env-set <value>", "Set environment variable(s) for linked-test runs (KEY=VALUE, repeatable)", collect)
    .option("--env-clear <value>", "Clear environment variable(s) for linked-test runs (NAME, repeatable)", collect)
    .option("--shared-host-safe", "Apply additive shared-host-safe runtime defaults for linked-test runs")
    .option("--pm-context <mode>", "PM linked-test context mode: schema|tracker|auto (default: schema)")
    .option("--override-linked-pm-context", "Force run-level --pm-context to override per-linked-test pm_context_mode metadata")
    .option("--fail-on-context-mismatch", "Fail linked PM commands when context item counts differ")
    .option("--fail-on-skipped", "Treat skipped linked tests as dependency failures")
    .option("--fail-on-empty-test-run", "Treat successful linked-test commands that report zero executed tests as failures")
    .option("--require-assertions-for-pm", "Require assertion metadata for linked PM command tests")
    .option("--check-context", "Preflight linked PM command context diagnostics before executing commands")
    .option("--auto-pm-context", "Auto-remediate PM tracker-read context mismatches by routing those linked commands through tracker context")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("Manage tests linked to an item and optionally run them.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const addValues = Array.isArray(options.add) ? (options.add as string[]) : [];
      const addJsonValues = Array.isArray(options.addJson) ? (options.addJson as string[]) : [];
      const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
      const runInBackground = options.background === true;
      if (runInBackground && options.run !== true) {
        throw new PmCliError("--background requires --run", EXIT_CODE.USAGE);
      }
      if (runInBackground && (addValues.length > 0 || addJsonValues.length > 0 || removeValues.length > 0)) {
        throw new PmCliError("--background does not support --add/--add-json/--remove; update linked tests first, then run in background", EXIT_CODE.USAGE);
      }
      if (runInBackground) {
        const { runStartBackgroundRun } = await import("./commands/test-runs.js");
        const result = await runStartBackgroundRun({
          kind: "test",
          commandArgs: buildBackgroundTestCommandArgs(id, { ...options, add: addValues, addJson: addJsonValues, remove: removeValues }),
          targetId: id,
          author: typeof options.author === "string" ? options.author : undefined,
          noExtensions: globalOptions.noExtensions === true,
        }, globalOptions);
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=test took_ms=${Date.now() - startedAt}`);
        }
        return;
      }
      const { runTest } = await import("./commands/test.js");
      const result = await runTest(id, {
        add: addValues,
        addJson: addJsonValues,
        remove: removeValues,
        list: Boolean(options.list),
        run: Boolean(options.run),
        match: typeof options.match === "string" ? options.match : undefined,
        onlyIndex: typeof options.onlyIndex === "string" || typeof options.onlyIndex === "number" ? options.onlyIndex : undefined,
        onlyLast: Boolean(options.onlyLast),
        timeout: typeof options.timeout === "string" ? options.timeout : undefined,
        progress: Boolean(options.progress),
        envSet: Array.isArray(options.envSet) ? (options.envSet as string[]) : [],
        envClear: Array.isArray(options.envClear) ? (options.envClear as string[]) : [],
        sharedHostSafe: Boolean(options.sharedHostSafe),
        pmContext: typeof options.pmContext === "string" ? options.pmContext : undefined,
        overrideLinkedPmContext: Boolean(options.overrideLinkedPmContext),
        failOnContextMismatch: Boolean(options.failOnContextMismatch),
        failOnSkipped: Boolean(options.failOnSkipped),
        failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
        requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
        checkContext: Boolean(options.checkContext),
        autoPmContext: Boolean(options.autoPmContext),
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        force: Boolean(options.force),
      }, globalOptions);
      if (addValues.length > 0 || addJsonValues.length > 0 || removeValues.length > 0 || options.run === true) {
        await invalidateSearchCachesForMutation(globalOptions, result);
      }
      printResult(result, globalOptions);
      if (result.run_results.some((entry) => entry.status === "failed") || result.fail_on_skipped_triggered === true) {
        process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
      }
      if (globalOptions.profile) {
        printError(`profile:command=test took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("test-all")
    .description("Run linked tests across matching items.")
    .option("--status <value>", "Filter items by status before running tests")
    .option("--limit <n>", "Limit matching items before running linked tests")
    .option("--offset <n>", "Skip matching items before running linked tests")
    .option("--background", "Run linked tests in managed background mode")
    .option("--timeout <seconds>", "Default run timeout in seconds")
    .option("--progress", "Emit linked-test progress to stderr (always shown in TTY, opt-in for non-TTY)")
    .option("--env-set <value>", "Set environment variable(s) for linked-test runs (KEY=VALUE, repeatable)", collect)
    .option("--env-clear <value>", "Clear environment variable(s) for linked-test runs (NAME, repeatable)", collect)
    .option("--shared-host-safe", "Apply additive shared-host-safe runtime defaults for linked-test runs")
    .option("--pm-context <mode>", "PM linked-test context mode: schema|tracker|auto (default: schema)")
    .option("--override-linked-pm-context", "Force run-level --pm-context to override per-linked-test pm_context_mode metadata")
    .option("--fail-on-context-mismatch", "Fail linked PM commands when context item counts differ")
    .option("--fail-on-skipped", "Treat skipped linked tests as dependency failures")
    .option("--fail-on-empty-test-run", "Treat successful linked-test commands that report zero executed tests as failures")
    .option("--require-assertions-for-pm", "Require assertion metadata for linked PM command tests")
    .option("--check-context", "Preflight linked PM command context diagnostics before executing commands")
    .option("--auto-pm-context", "Auto-remediate PM tracker-read context mismatches by routing those linked commands through tracker context")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const runInBackground = options.background === true;
      if (runInBackground) {
        const { runStartBackgroundRun } = await import("./commands/test-runs.js");
        const result = await runStartBackgroundRun({
          kind: "test-all",
          commandArgs: buildBackgroundTestAllCommandArgs(options),
          statusFilter: typeof options.status === "string" ? options.status : undefined,
          noExtensions: globalOptions.noExtensions === true,
        }, globalOptions);
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
        }
        return;
      }
      const { runTestAll } = await import("./commands/test-all.js");
      const result = await runTestAll({
        status: typeof options.status === "string" ? options.status : undefined,
        limit: typeof options.limit === "string" ? options.limit : undefined,
        offset: typeof options.offset === "string" ? options.offset : undefined,
        timeout: typeof options.timeout === "string" ? options.timeout : undefined,
        progress: Boolean(options.progress),
        envSet: Array.isArray(options.envSet) ? (options.envSet as string[]) : [],
        envClear: Array.isArray(options.envClear) ? (options.envClear as string[]) : [],
        sharedHostSafe: Boolean(options.sharedHostSafe),
        pmContext: typeof options.pmContext === "string" ? options.pmContext : undefined,
        overrideLinkedPmContext: Boolean(options.overrideLinkedPmContext),
        failOnContextMismatch: Boolean(options.failOnContextMismatch),
        failOnSkipped: Boolean(options.failOnSkipped),
        failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
        requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
        checkContext: Boolean(options.checkContext),
        autoPmContext: Boolean(options.autoPmContext),
      }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, { ids: result.results.map((entry) => entry.id) });
      printResult(result, globalOptions);
      if (result.failed > 0 || result.fail_on_skipped_triggered === true) {
        process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
      }
      if (globalOptions.profile) {
        printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("test-runs-worker", { hidden: true })
    .argument("<runId>", "Background run id")
    .description("Internal background worker command.")
    .action(async (runId: string, _options: Record<string, unknown>, command: Command) => {
      const globalOptions = getGlobalOptions(command);
      const { runTestRunsWorker } = await import("./commands/test-runs.js");
      await runTestRunsWorker(runId, globalOptions);
    });

  program
    .command("telemetry")
    .argument("[namespaceOrSubcommand]", "Telemetry subcommand: status, flush, stats, clear (default: status)")
    .argument("[subcommand]", "Compatibility alias target for local-analytics: status, flush, stats, clear")
    .option("--limit <n>", "Maximum command groups returned by telemetry stats")
    .description("Inspect and manage local telemetry queue/runtime state.")
    .action(async (namespaceOrSubcommand: string | undefined, subcommand: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runTelemetry } = await import("./commands/telemetry.js");
      const result = await runTelemetry(
        {
          subcommand: resolveTelemetrySubcommand(namespaceOrSubcommand, subcommand),
          // Commander always parses `--limit <n>` to a string (or leaves it
          // undefined), so a string passthrough covers every CLI-reachable input.
          limit: typeof options.limit === "string" ? options.limit : undefined,
        },
        globalOptions,
      );
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=telemetry took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("stats")
    .description("Show project tracker statistics.")
    .option(
      "--storage",
      "Include aggregate history-stream storage metrics (total streams/lines/bytes, largest + deepest streams, oldest/newest entries)",
    )
    .option(
      "--metadata-coverage",
      "Include metadata coverage % (acceptance_criteria, estimated_minutes, resolution, tags, parent) overall and by type",
    )
    .option("--by-assignee", "Include a lifecycle-bucketed item breakdown grouped by assignee")
    .option("--by-tag", "Include a lifecycle-bucketed item breakdown grouped by tag")
    .option("--by-priority", "Include a lifecycle-bucketed item breakdown grouped by priority")
    .option("--tag-prefix <value>", "With --by-tag: only count tags starting with this prefix (e.g. domain:)")
    .option(
      "--field-utilization",
      "Report content-field utilization rates (notes/learnings/files/docs/tests/comments/deps/body) for governance audits",
    )
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runStats } = await import("./commands/stats.js");
      const result = await runStats(globalOptions, {
        storage: options.storage === true,
        metadataCoverage: options.metadataCoverage === true,
        byAssignee: options.byAssignee === true,
        byTag: options.byTag === true,
        byPriority: options.byPriority === true,
        tagPrefix: typeof options.tagPrefix === "string" ? options.tagPrefix : undefined,
        fieldUtilization: options.fieldUtilization === true,
      });
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=stats took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("health")
    .description("Show project tracker health checks.")
    .option("--strict-directories", "Treat optional item-type directories as required failures")
    .option("--check-only", "Run read-only health diagnostics without refreshing vectors")
    .option("--check-telemetry", "Probe telemetry endpoint health and include network diagnostics")
    .option("--no-refresh", "Disable automatic vector refresh attempts during health checks")
    .option("--refresh-vectors", "Explicitly enable vector refresh attempts during health checks")
    .option("--verbose-stale-items", "Include full stale vectorization ID lists in health output")
    .option("--brief", "Emit compact health details for low-token agent checks")
    .option("--summary", "Emit one-line-style health status with check names and warning count")
    .option("--skip-vectors", "Skip vectorization check for a faster run")
    .option("--skip-integrity", "Skip item/history file integrity check for a faster run")
    .option("--skip-drift", "Skip history drift hash check for a faster run")
    .option("--full", "Run all checks including slow integrity, drift, and vectorization checks")
    .option(
      "--strict-exit",
      "Return non-zero exit when health is not ok (advisory telemetry warnings are excluded; see warnings[])",
    )
    .option("--fail-on-warn", "Alias for --strict-exit")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runHealth } = await import("./commands/health.js");
      const result = await runHealth(globalOptions, {
        strictDirectories: Boolean(options.strictDirectories),
        checkOnly: Boolean(options.checkOnly),
        checkTelemetry: Boolean(options.checkTelemetry),
        noRefresh: Boolean(options.noRefresh),
        refreshVectors: Boolean(options.refreshVectors),
        verboseStaleItems: Boolean(options.verboseStaleItems),
        brief: Boolean(options.brief),
        summary: Boolean(options.summary),
        skipVectors: Boolean(options.skipVectors),
        skipIntegrity: Boolean(options.skipIntegrity),
        skipDrift: Boolean(options.skipDrift),
        full: Boolean(options.full),
      });
      printResult(result, globalOptions);
      const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
      if (strictExit && !result.ok) {
        setActiveCommandResult({
          ...result,
          exit_code: EXIT_CODE.GENERIC_FAILURE,
          error_code: "health_findings",
          error_category: "validation",
          command_resolution: "health_findings",
          resolution_stage: "execute",
        });
        process.exitCode = EXIT_CODE.GENERIC_FAILURE;
      }
      if (globalOptions.profile) {
        printError(`profile:command=health took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("validate")
    .description("Run standalone metadata, resolution, lifecycle, files, linked-command reference, and history drift validation checks.")
    .option("--check-metadata", "Run metadata completeness checks")
    .option("--metadata-profile <value>", "Select metadata validation profile for --check-metadata (core|strict|custom)")
    .option("--check-resolution", "Run closed-item resolution metadata checks")
    .option("--check-lifecycle", "Run active-item lifecycle governance drift checks")
    .option("--check-stale-blockers", "Include stale blocker-pattern diagnostics in lifecycle checks")
    .option("--dependency-cycle-severity <value>", "Set dependency-cycle warning policy for lifecycle checks (off|warn|error)")
    .option("--parent-cycle-severity <value>", "Set parent-hierarchy cycle warning policy for lifecycle checks (off|warn|error)")
    .option("--check-files", "Run linked-file and orphaned-file checks")
    .option("--check-command-references", "Run linked-command PM-ID reference checks")
    .option("--scan-mode <value>", "Select file candidate scan mode for --check-files (default|tracked-all|tracked-all-strict)")
    .option("--include-pm-internals", "Include PM storage internals in tracked-all candidate scans")
    .option("--verbose-file-lists", "Include full file-path lists for validate --check-files details")
    .option("--verbose-diagnostics", "Include full validate diagnostic ID lists instead of compact summaries")
    .option("--all-affected-ids", "Emit complete missing_* affected-ID lists with no truncation (implied by --json)")
    .option("--strict-exit", "Return non-zero exit when validation warnings are present")
    .option("--fail-on-warn", "Alias for --strict-exit")
    .option("--fix-hints", "Add a machine-executable fix_hints[] of pm commands to each failing check's details")
    .option("--auto-fix", "Apply the safe, deterministic subset of fix-hint remediations (field backfills) automatically")
    .option("--dry-run", "Preview planned --auto-fix/--prune-missing fixes without applying them")
    .option("--fix-scope <scope>", "Grant --auto-fix scopes (metadata, resolution, lifecycle; comma-separated or repeatable). Default: metadata, resolution; lifecycle must be named explicitly", collect)
    .option("--prune-missing", "Remove stale linked-file/doc LINKS whose paths classified as deleted (never touches real files)")
    .option("--check-history-drift", "Run item/history hash drift checks")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runValidate } = await import("./commands/validate.js");
      const result = await runValidate({
        checkMetadata: Boolean(options.checkMetadata),
        metadataProfile: typeof options.metadataProfile === "string" ? options.metadataProfile : undefined,
        checkResolution: Boolean(options.checkResolution),
        checkLifecycle: Boolean(options.checkLifecycle),
        checkStaleBlockers: Boolean(options.checkStaleBlockers),
        dependencyCycleSeverity: typeof options.dependencyCycleSeverity === "string" ? options.dependencyCycleSeverity : undefined,
        parentCycleSeverity: typeof options.parentCycleSeverity === "string" ? options.parentCycleSeverity : undefined,
        checkFiles: Boolean(options.checkFiles),
        checkCommandReferences: Boolean(options.checkCommandReferences),
        scanMode: typeof options.scanMode === "string" ? options.scanMode : undefined,
        includePmInternals: Boolean(options.includePmInternals),
        verboseFileLists: Boolean(options.verboseFileLists),
        verboseDiagnostics: Boolean(options.verboseDiagnostics),
        allAffectedIds: Boolean(options.allAffectedIds),
        checkHistoryDrift: Boolean(options.checkHistoryDrift),
        fixHints: Boolean(options.fixHints),
        autoFix: Boolean(options.autoFix),
        dryRun: Boolean(options.dryRun),
        fixScope: Array.isArray(options.fixScope) ? (options.fixScope as string[]) : undefined,
        pruneMissing: Boolean(options.pruneMissing),
      }, globalOptions);
      printResult(result, globalOptions);
      const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
      if (strictExit && (result.has_warnings || !result.ok)) {
        setActiveCommandResult({
          ...result,
          exit_code: EXIT_CODE.GENERIC_FAILURE,
          error_code: "validation_findings",
          error_category: "validation",
          command_resolution: "validation_findings",
          resolution_stage: "execute",
        });
        process.exitCode = EXIT_CODE.GENERIC_FAILURE;
      }
      if (globalOptions.profile) {
        printError(`profile:command=validate took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("gc")
    .option("--dry-run", "Preview cleanup targets without deleting files; without this flag, pm gc deletes matched artifacts")
    .option("--scope <value>", "Limit cleanup to one or more scopes (comma-separated or repeatable): index, embeddings, runtime, locks, checkpoints", collect)
    .description("Delete optional cache artifacts by default (including expired lock debris) and show a summary.")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runGc } = await import("./commands/gc.js");
      const result = await runGc(globalOptions, {
        dryRun: options.dryRun === true,
        scope: Array.isArray(options.scope) ? (options.scope as string[]) : [],
      });
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=gc took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("contracts")
    .description("Show machine-readable command and schema contracts for agents.")
    .option("--action <value>", "Filter tool schema branches to a specific action")
    .option("--command <value>", "Scope contracts output to one CLI command (narrow-by-default)")
    .option("--schema-only", "Return schema-focused output only")
    .option("--flags-only", "Return command flag contracts only")
    .option("--availability-only", "Return action availability surface only")
    .option("--runtime-only", "Include only actions invocable in the current runtime")
    .option("--active-only", "Alias for --runtime-only")
    .option(
      "--full",
      "Include full schema and command-flag surfaces (large; default brief output omits heavy sections for unfiltered queries)",
    )
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runContracts } = await import("./commands/contracts.js");
      const result = await runContracts({
        action: typeof options.action === "string" ? options.action : undefined,
        command: typeof options.command === "string" ? options.command : undefined,
        schemaOnly: Boolean(options.schemaOnly),
        flagsOnly: Boolean(options.flagsOnly),
        availabilityOnly: Boolean(options.availabilityOnly),
        runtimeOnly: Boolean(options.runtimeOnly) || Boolean(options.activeOnly),
        full: Boolean(options.full),
      }, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=contracts took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("claim")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force claim override")
    .option("--if-available", "Skip silently when the item is already claimed by another author (returns skipped=true)")
    .description("Claim an item for active work.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runClaim } = await import("./commands/claim.js");
      const result = await runClaim(id, Boolean(options.force), globalOptions, {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        ifAvailable: options.ifAvailable === true,
      });
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=claim took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("release")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--allow-audit-release", "Allow non-owner release handoffs without requiring --force")
    .option("--force", "Force release override")
    .description("Release an item's active claim.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runRelease } = await import("./commands/claim.js");
      const result = await runRelease(id, Boolean(options.force), globalOptions, {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
        allowAuditRelease: options.allowAuditRelease === true,
      });
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=release took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("start-task")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership or terminal override when required")
    .description("Lifecycle alias: claim an item and move it to in_progress.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
      const settings = await readSettings(pmRoot);
      const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
      const inProgressStatus = resolveStartTaskInProgressStatus(statusRegistry);
      const force = Boolean(options.force);
      const mutationOptions = {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
      };
      const [{ runClaim }, { runUpdate }] = await Promise.all([
        import("./commands/claim.js"),
        import("./commands/update.js"),
      ]);
      const claimResult = await runClaim(id, force, globalOptions, mutationOptions);
      await invalidateSearchCachesForMutation(globalOptions, claimResult);
      const updateResult = await runUpdate(id, { ...mutationOptions, status: inProgressStatus, force }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, updateResult);
      printResult({ id, action: "start_task", claim: claimResult, update: updateResult }, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=start-task took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("pause-task")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override when required")
    .description("Lifecycle alias: move an item to open and release its claim.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
      const settings = await readSettings(pmRoot);
      const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
      const openStatus = statusRegistry.open_status;
      const force = Boolean(options.force);
      const mutationOptions = {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
      };
      const [{ runUpdate }, { runRelease }] = await Promise.all([
        import("./commands/update.js"),
        import("./commands/claim.js"),
      ]);
      const updateResult = await runUpdate(id, { ...mutationOptions, status: openStatus, force }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, updateResult);
      const releaseResult = await runRelease(id, force, globalOptions, mutationOptions);
      await invalidateSearchCachesForMutation(globalOptions, releaseResult);
      printResult({ id, action: "pause_task", update: updateResult, release: releaseResult }, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=pause-task took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("close-task")
    .argument("<id>", "Item id")
    .argument("[reason]", "Close reason text")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--validate-close <value>", "Close-time validation mode: off|warn|strict")
    .option("--force", "Force ownership or terminal override when required")
    .description("Lifecycle alias: close an item and release assignment metadata.")
    .action(async (id: string, reason: string | undefined, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const force = Boolean(options.force);
      const mutationOptions = {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
      };
      const [{ runClose }, { runRelease }] = await Promise.all([
        import("./commands/close.js"),
        import("./commands/claim.js"),
      ]);
      const closeResult = await runClose(id, reason, {
        ...mutationOptions,
        validateClose: typeof options.validateClose === "string" ? options.validateClose : undefined,
        force,
      }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, closeResult);
      const releaseResult = await runRelease(id, force, globalOptions, mutationOptions);
      await invalidateSearchCachesForMutation(globalOptions, releaseResult);
      printResult({ id, action: "close_task", close: closeResult, release: releaseResult }, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=close-task took_ms=${Date.now() - startedAt}`);
      }
    });

  registerSchedulingShortcutCommands(program);
}

/**
 * Optional string accessor for loosely-typed commander option bags.
 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Common create-passthrough options shared by every scheduling shortcut.
 */
function buildShortcutCommonOptions(options: Record<string, unknown>): {
  parent?: string;
  allowMissingParent?: boolean;
  tags?: string;
  priority?: string;
  body?: string;
  description?: string;
  author?: string;
  message?: string;
} {
  return {
    parent: optionalString(options.parent),
    allowMissingParent: options.allowMissingParent === true ? true : undefined,
    tags: optionalString(options.tags),
    priority: optionalString(options.priority),
    body: optionalString(options.body),
    description: optionalString(options.description),
    author: optionalString(options.author),
    message: optionalString(options.message),
  };
}

/**
 * GH-217: register the `pm meet`/`pm event`/`pm remind` scheduling shortcuts.
 * Each is a thin friendly-flag wrapper over `runCreate` for an otherwise-unused
 * scheduling type.
 */
function registerSchedulingShortcutCommands(program: Command): void {
  for (const { name, describe } of [
    { name: "meet", describe: "Shortcut: create a Meeting with a start time and duration." },
    { name: "event", describe: "Shortcut: create an Event with a start time and duration." },
  ] as const) {
    program
      .command(name)
      .argument("<title>", "Item title")
      .option("--start <when>", "Start time (ISO, 'now', or relative like +1h/+2d); defaults to now")
      .option("--duration <span>", "Duration from start (relative like 1h/2d); defaults to 1h when --end is omitted")
      .option("--end <when>", "End time (ISO or relative); overrides --duration")
      .option("--location <value>", "Location")
      .option("--timezone <value>", "IANA timezone (for example America/New_York)")
      .option("--all-day", "Mark as an all-day event")
      .option("--parent <id>", "Parent item id")
      .option("--allow-missing-parent", "Permit a parent id that does not exist yet")
      .option("--tags <list>", "Comma-separated tags")
      .option("--priority <value>", "Priority")
      .option("--body <text>", "Body/markdown content")
      .option("--description <text>", "Short description")
      .option("--author <value>", "Mutation author")
      .option("--message <value>", "History message")
      .description(describe)
      .action(async (title: string, options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
        const { runMeet, runEvent } = await import("./commands/scheduling-shortcuts.js");
        const run = name === "meet" ? runMeet : runEvent;
        const result = await run(
          title,
          {
            ...buildShortcutCommonOptions(options),
            start: optionalString(options.start),
            duration: optionalString(options.duration),
            end: optionalString(options.end),
            location: optionalString(options.location),
            timezone: optionalString(options.timezone),
            allDay: options.allDay === true ? true : undefined,
          },
          globalOptions,
        );
        await invalidateSearchCachesForMutation(globalOptions, result);
        printResult(result, globalOptions);
        if (globalOptions.profile) {
          printError(`profile:command=${name} took_ms=${Date.now() - startedAt}`);
        }
      });
  }

  program
    .command("remind")
    .argument("<title>", "Item title")
    .option("--at <when>", "Reminder time (ISO, 'now', or relative like +2d); defaults to +1d")
    .option("--text <value>", "Reminder text; defaults to the title")
    .option("--parent <id>", "Parent item id")
    .option("--allow-missing-parent", "Permit a parent id that does not exist yet")
    .option("--tags <list>", "Comma-separated tags")
    .option("--priority <value>", "Priority")
    .option("--body <text>", "Body/markdown content")
    .option("--description <text>", "Short description")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .description("Shortcut: create a Reminder from a single point in time.")
    .action(async (title: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runRemind } = await import("./commands/scheduling-shortcuts.js");
      const result = await runRemind(
        title,
        {
          ...buildShortcutCommonOptions(options),
          at: optionalString(options.at),
          text: optionalString(options.text),
        },
        globalOptions,
      );
      await invalidateSearchCachesForMutation(globalOptions, result);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=remind took_ms=${Date.now() - startedAt}`);
      }
    });
}
