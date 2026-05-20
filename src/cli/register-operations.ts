import type { Command } from "commander";
import { normalizeStatusInput } from "../core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
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

type OperationCommandsModule = typeof import("./commands/index.js");

let operationCommandsModulePromise: Promise<OperationCommandsModule> | null = null;

async function loadOperationCommandsModule(): Promise<OperationCommandsModule> {
  operationCommandsModulePromise ??= import("./commands/index.js");
  return operationCommandsModulePromise;
}

export function registerOperationCommands(program: Command): void {
  program
    .command("test")
    .argument("<id>", "Item id")
    .option("--add <value>", "Add linked test entry (CSV/markdown pairs or - for stdin)", collect)
    .option("--remove <value>", "Remove linked test entry by command/path (command=<value>, path=<value>, markdown pairs, plain value, or - for stdin)", collect)
    .option("--list", "List linked tests without mutating")
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
        const { runStartBackgroundRun } = await loadOperationCommandsModule();
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
      const { runTest } = await loadOperationCommandsModule();
      const result = await runTest(id, {
        add: addValues,
        remove: removeValues,
        list: Boolean(options.list),
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
        const { runStartBackgroundRun } = await loadOperationCommandsModule();
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
      const { runTestAll } = await loadOperationCommandsModule();
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
      const { runTestRunsWorker } = await loadOperationCommandsModule();
      await runTestRunsWorker(runId, globalOptions);
    });

  program
    .command("stats")
    .description("Show project tracker statistics.")
    .action(async (_options: unknown, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runStats } = await loadOperationCommandsModule();
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
    .option("--brief", "Emit compact health details for low-token agent checks")
    .option("--skip-vectors", "Skip vectorization check for a faster run")
    .option("--skip-integrity", "Skip item/history file integrity check for a faster run")
    .option("--skip-drift", "Skip history drift hash check for a faster run")
    .option("--full", "Run all checks including slow integrity, drift, and vectorization checks")
    .option("--strict-exit", "Return non-zero exit when health warnings are present (ok=false)")
    .option("--fail-on-warn", "Alias for --strict-exit")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runHealth } = await loadOperationCommandsModule();
      const result = await runHealth(globalOptions, {
        strictDirectories: Boolean(options.strictDirectories),
        checkOnly: Boolean(options.checkOnly),
        checkTelemetry: Boolean(options.checkTelemetry),
        noRefresh: Boolean(options.noRefresh),
        refreshVectors: Boolean(options.refreshVectors),
        verboseStaleItems: Boolean(options.verboseStaleItems),
        brief: Boolean(options.brief),
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
      const { runValidate } = await loadOperationCommandsModule();
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
    .option("--dry-run", "Preview cleanup targets without deleting files")
    .option("--scope <value>", "Limit cleanup to one or more scopes (comma-separated or repeatable): index, embeddings, runtime", collect)
    .description("Clean optional cache artifacts and show a summary.")
    .action(async (options: Record<string, unknown>, command) => {
      const globalOptions = getGlobalOptions(command);
      const startedAt = Date.now();
      const { runGc } = await loadOperationCommandsModule();
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
      const { runContracts } = await loadOperationCommandsModule();
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
      const { runClaim } = await loadOperationCommandsModule();
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
      const { runRelease } = await loadOperationCommandsModule();
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
      const commands = await loadOperationCommandsModule();
      const claimResult = await commands.runClaim(id, force, globalOptions, mutationOptions);
      await invalidateSearchCachesForMutation(globalOptions, claimResult);
      const updateResult = await commands.runUpdate(id, { ...mutationOptions, status: inProgressStatus, force }, globalOptions);
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
      const commands = await loadOperationCommandsModule();
      const updateResult = await commands.runUpdate(id, { ...mutationOptions, status: openStatus, force }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, updateResult);
      const releaseResult = await commands.runRelease(id, force, globalOptions, mutationOptions);
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
      const commands = await loadOperationCommandsModule();
      const closeResult = await commands.runClose(id, reason, {
        ...mutationOptions,
        validateClose: typeof options.validateClose === "string" ? options.validateClose : undefined,
        force,
      }, globalOptions);
      await invalidateSearchCachesForMutation(globalOptions, closeResult);
      const releaseResult = await commands.runRelease(id, force, globalOptions, mutationOptions);
      await invalidateSearchCachesForMutation(globalOptions, releaseResult);
      printResult({ id, action: "close_task", close: closeResult, release: releaseResult }, globalOptions);
      if (globalOptions.profile) {
        printError(`profile:command=close-task took_ms=${Date.now() - startedAt}`);
      }
    });

}
