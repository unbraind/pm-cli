import type { Command } from "commander";
import { pathExists } from "../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { normalizeStatusInput } from "../core/item/status.js";
import { resolveRuntimeFieldRegistry, resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { listAllFrontMatter } from "../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import {
  runClaim,
  runClose,
  runCompletion,
  runContracts,
  runGc,
  runHealth,
  runRelease,
  runStartBackgroundRun,
  runStats,
  runTest,
  runTestAll,
  runTestRunsList,
  runTestRunsLogs,
  runTestRunsResume,
  runTestRunsStatus,
  runTestRunsStop,
  runTestRunsWorker,
  runUpdate,
  runValidate,
} from "./commands/index.js";
import {
  buildBackgroundTestAllCommandArgs,
  buildBackgroundTestCommandArgs,
  collect,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  printError,
  printResult,
  writeStdout,
} from "./registration-helpers.js";

export function registerOperationCommands(program: Command): void {
  program
    .command("test")
    .argument("<id>", "Item id")
    .option("--add <value>", "Add linked test entry (CSV/markdown pairs or - for stdin)", collect)
    .option("--remove <value>", "Remove linked test entry by command/path (command=<value>, path=<value>, markdown pairs, plain value, or - for stdin)", collect)
    .option("--run", "Run linked test commands")
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
      const removeValues = Array.isArray(options.remove) ? (options.remove as string[]) : [];
      const runInBackground = options.background === true;
      if (runInBackground && options.run !== true) {
        throw new PmCliError("--background requires --run", EXIT_CODE.USAGE);
      }
      if (runInBackground && (addValues.length > 0 || removeValues.length > 0)) {
        throw new PmCliError("--background does not support --add/--remove; update linked tests first, then run in background", EXIT_CODE.USAGE);
      }
      if (runInBackground) {
        const result = await runStartBackgroundRun({
          kind: "test",
          commandArgs: buildBackgroundTestCommandArgs(id, { ...options, add: addValues, remove: removeValues }),
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
      const result = await runTest(id, {
        add: addValues,
        remove: removeValues,
        run: Boolean(options.run),
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
      if (addValues.length > 0 || removeValues.length > 0 || options.run === true) {
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

  const testRunsCommand = program
    .command("test-runs")
    .description("Manage background linked-test runs.")
    .action(async (_options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTestRunsList({}, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test-runs took_ms=${Date.now() - startedAt}`);
      }
    });

  testRunsCommand
    .command("list")
    .option("--status <value>", "Filter by background run status")
    .option("--limit <value>", "Limit number of runs returned")
    .description("List background test runs.")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTestRunsList({
        status: typeof options.status === "string" ? options.status : undefined,
        limit: typeof options.limit === "string" ? options.limit : undefined,
      }, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test-runs list took_ms=${Date.now() - startedAt}`);
      }
    });

  testRunsCommand
    .command("status")
    .argument("<runId>", "Background run id")
    .description("Show status, health, and resource snapshot for a background run.")
    .action(async (runId: string, _options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTestRunsStatus(runId, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test-runs status took_ms=${Date.now() - startedAt}`);
      }
    });

  testRunsCommand
    .command("logs")
    .argument("<runId>", "Background run id")
    .option("--stream <value>", "Log stream selector: stdout|stderr|both")
    .option("--tail <value>", "Tail number of lines per selected stream")
    .description("Show tailed logs for a background run.")
    .action(async (runId: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTestRunsLogs(runId, {
        stream: typeof options.stream === "string" ? options.stream : undefined,
        tail: typeof options.tail === "string" ? options.tail : undefined,
      }, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test-runs logs took_ms=${Date.now() - startedAt}`);
      }
    });

  testRunsCommand
    .command("stop")
    .argument("<runId>", "Background run id")
    .option("--force", "Force-stop via SIGKILL")
    .description("Stop a running background test run.")
    .action(async (runId: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTestRunsStop(runId, { force: options.force === true }, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test-runs stop took_ms=${Date.now() - startedAt}`);
      }
    });

  testRunsCommand
    .command("resume")
    .argument("<runId>", "Background run id")
    .option("--author <value>", "Resume author (falls back to PM_AUTHOR/settings)")
    .description("Resume a previously terminal background test run by starting a new attempt.")
    .action(async (runId: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runTestRunsResume(runId, {
        author: typeof options.author === "string" ? options.author : undefined,
        noExtensions: globalOptions.noExtensions === true,
      }, globalOptions);
      printResult(result, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=test-runs resume took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("test-runs-worker", { hidden: true })
    .argument("<runId>", "Background run id")
    .description("Internal background worker command.")
    .action(async (runId: string, _options: Record<string, unknown>, command: Command) => {
      const globalOptions = getGlobalOptions(command);
      await runTestRunsWorker(runId, globalOptions);
    });

  program
    .command("stats")
    .description("Show project tracker statistics.")
    .action(async (_options: unknown, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runStats(globalOptions);
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
    .option("--strict-exit", "Return non-zero exit when health warnings are present (ok=false)")
    .option("--fail-on-warn", "Alias for --strict-exit")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runHealth(globalOptions, {
        strictDirectories: Boolean(options.strictDirectories),
        checkOnly: Boolean(options.checkOnly),
        checkTelemetry: Boolean(options.checkTelemetry),
        noRefresh: Boolean(options.noRefresh),
        refreshVectors: Boolean(options.refreshVectors),
        verboseStaleItems: Boolean(options.verboseStaleItems),
      });
      printResult(result, globalOptions);
      const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
      if (strictExit && !result.ok) {
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
    .option("--check-files", "Run linked-file and orphaned-file checks")
    .option("--check-command-references", "Run linked-command PM-ID reference checks")
    .option("--scan-mode <value>", "Select file candidate scan mode for --check-files (default|tracked-all|tracked-all-strict)")
    .option("--include-pm-internals", "Include PM storage internals in tracked-all candidate scans")
    .option("--verbose-file-lists", "Include full file-path lists for validate --check-files details")
    .option("--strict-exit", "Return non-zero exit when validation warnings are present (ok=false)")
    .option("--fail-on-warn", "Alias for --strict-exit")
    .option("--check-history-drift", "Run item/history hash drift checks")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runValidate({
        checkMetadata: Boolean(options.checkMetadata),
        metadataProfile: typeof options.metadataProfile === "string" ? options.metadataProfile : undefined,
        checkResolution: Boolean(options.checkResolution),
        checkLifecycle: Boolean(options.checkLifecycle),
        checkStaleBlockers: Boolean(options.checkStaleBlockers),
        dependencyCycleSeverity: typeof options.dependencyCycleSeverity === "string" ? options.dependencyCycleSeverity : undefined,
        checkFiles: Boolean(options.checkFiles),
        checkCommandReferences: Boolean(options.checkCommandReferences),
        scanMode: typeof options.scanMode === "string" ? options.scanMode : undefined,
        includePmInternals: Boolean(options.includePmInternals),
        verboseFileLists: Boolean(options.verboseFileLists),
        checkHistoryDrift: Boolean(options.checkHistoryDrift),
      }, globalOptions);
      printResult(result, globalOptions);
      const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
      if (strictExit && !result.ok) {
        process.exitCode = EXIT_CODE.GENERIC_FAILURE;
      }
      if (globalOptions.profile) {
        printError(`profile:command=validate took_ms=${Date.now() - startedAt}`);
      }
    });

  program
    .command("gc")
    .option("--dry-run", "Preview cleanup targets without deleting files")
    .option("--scope <value>", "Limit cleanup to one or more scopes (comma-separated or repeatable): index, embeddings, runtime", collect)
    .description("Clean optional cache artifacts and show a summary.")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
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
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runContracts({
        action: typeof options.action === "string" ? options.action : undefined,
        command: typeof options.command === "string" ? options.command : undefined,
        schemaOnly: Boolean(options.schemaOnly),
        flagsOnly: Boolean(options.flagsOnly),
        availabilityOnly: Boolean(options.availabilityOnly),
        runtimeOnly: Boolean(options.runtimeOnly) || Boolean(options.activeOnly),
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
    .description("Claim an item for active work.")
    .action(async (id: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const result = await runClaim(id, Boolean(options.force), globalOptions, {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
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
      const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry) ?? statusRegistry.open_status;
      const force = Boolean(options.force);
      const mutationOptions = {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
      };
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
    .argument("<reason>", "Close reason text")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--validate-close <value>", "Close-time validation mode: off|warn|strict")
    .option("--force", "Force ownership or terminal override when required")
    .description("Lifecycle alias: close an item with reason and release assignment metadata.")
    .action(async (id: string, reason: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const force = Boolean(options.force);
      const mutationOptions = {
        author: typeof options.author === "string" ? options.author : undefined,
        message: typeof options.message === "string" ? options.message : undefined,
      };
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

  program
    .command("completion")
    .argument("<shell>", "Shell type: bash, zsh, or fish")
    .option("--eager-tags", "Embed current tracker tags directly in generated scripts (legacy eager mode)")
    .description("Generate shell completion for pm.")
    .action(async (shell: string, options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
      let completionTypes: string[] | undefined;
      let completionTags: string[] | undefined;
      let completionStatuses: string[] | undefined;
      const completionCommandFlags: Partial<
        Record<"list" | "create" | "update" | "update-many" | "search" | "calendar" | "context", string[]>
      > = {};
      const eagerTags = Boolean(options.eagerTags);
      if (await pathExists(getSettingsPath(pmRoot))) {
        const settings = await readSettings(pmRoot);
        const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
        const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
        const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
        completionTypes = typeRegistry.types;
        completionStatuses = statusRegistry.definitions.map((definition) => definition.id);
        for (const [commandKey, definitions] of runtimeFieldRegistry.command_to_fields.entries()) {
          if (
            commandKey !== "list" &&
            commandKey !== "create" &&
            commandKey !== "update" &&
            commandKey !== "search" &&
            commandKey !== "calendar" &&
            commandKey !== "context"
          ) {
            continue;
          }
          const runtimeFlags = new Set<string>();
          for (const definition of definitions) {
            runtimeFlags.add(`--${definition.cli_flag}`);
            for (const alias of definition.cli_aliases) {
              if (alias.startsWith("--") || (alias.startsWith("-") && !alias.startsWith("--"))) {
                runtimeFlags.add(alias);
              } else {
                runtimeFlags.add(`--${alias}`);
              }
            }
          }
          completionCommandFlags[commandKey] = [...runtimeFlags].sort((left, right) => left.localeCompare(right));
        }
        if (completionCommandFlags.update) {
          completionCommandFlags["update-many"] = [...completionCommandFlags.update];
        }
        if (eagerTags) {
          const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema);
          completionTags = [...new Set(items.flatMap((item) => item.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
            .sort((left, right) => left.localeCompare(right));
        }
      }
      const result = runCompletion(shell, completionTypes, completionTags ?? [], eagerTags, {
        statuses: completionStatuses,
        command_flags: completionCommandFlags,
      });
      if (globalOptions.json) {
        printResult(result, globalOptions);
      } else if (!globalOptions.quiet) {
        writeStdout(`${result.script}\n`);
      }
      if (globalOptions.profile) {
        printError(`profile:command=completion took_ms=0`);
      }
    });

  program
    .command("completion-tags", { hidden: true })
    .description("Internal dynamic completion tag source.")
    .action(async (_options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
      let tags: string[] = [];
      if (await pathExists(getSettingsPath(pmRoot))) {
        const settings = await readSettings(pmRoot);
        const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
        const items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema);
        tags = [...new Set(items.flatMap((item) => item.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))].sort((left, right) =>
          left.localeCompare(right),
        );
      }
      if (globalOptions.json) {
        printResult({ tags, count: tags.length }, globalOptions);
      } else if (!globalOptions.quiet) {
        writeStdout(tags.join("\n"));
        if (tags.length > 0) {
          writeStdout("\n");
        }
      }
      if (globalOptions.profile) {
        printError(`profile:command=completion-tags took_ms=${Date.now() - startedAt}`);
      }
    });
}
