/**
 * @module cli/register-operations
 *
 * Provides CLI runtime support for Register Operations.
 */
import type { Command } from "commander";
import {
  resolveRuntimeStatusRegistry,
  setActiveCommandResult,
  EXIT_CODE,
  PmCliError,
  createUnknownSubcommandError,
  resolveAuthor,
  resolvePmRoot,
  readSettings,
} from "../sdk/runtime-primitives.js";
import { resolveStartTaskInProgressStatus } from "../sdk/start-task-status.js";
import { parseStatsAnalyticsJson } from "./stats-analytics-json.js";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  inspectWorkspaceSnapshot,
  listWorkspaceSnapshots,
  planWorkspaceSnapshotRestore,
  restoreWorkspaceSnapshotWithRecovery,
  WORKSPACE_SNAPSHOT_ACTIONS,
} from "../sdk/workspace-snapshot.js";
import { runClaim, runClaimNext, runRelease } from "./commands/claim.js";
import { runClose } from "./commands/close.js";
import { runContracts } from "./commands/contracts.js";
import { runDuplicates } from "./commands/duplicates.js";
import { runGc } from "./commands/gc.js";
import { runHealth } from "./commands/health.js";
import {
  runMeet,
  runEvent,
  runRemind,
} from "./commands/scheduling-shortcuts.js";
import { runStats } from "./commands/stats.js";
import { runTelemetry } from "./commands/telemetry.js";
import { runTest } from "./commands/test.js";
import { runTestAll } from "./commands/test-all.js";
import {
  runStartBackgroundRun,
  runTestRunsWorker,
} from "./commands/test-runs.js";
import { runUpdate } from "./commands/update.js";
import { runValidate } from "./commands/validate.js";
import {
  buildBackgroundTestAllCommandArgs,
  applyActiveCommandResultService,
  buildBackgroundTestCommandArgs,
  addHiddenOption,
  collect,
  getGlobalOptions,
  invalidateSearchCachesForMutation,
  printError,
  printResult,
  readOptionString,
} from "./registration-helpers.js";
import { registerAssuranceCommand } from "./register-assurance.js";

function resolveTelemetrySubcommand(
  namespaceOrSubcommand: string | undefined,
  subcommand: string | undefined,
): string | undefined {
  const normalizedNamespace = namespaceOrSubcommand?.trim().toLowerCase();
  const normalizedSubcommand = subcommand?.trim().toLowerCase();
  if (normalizedNamespace === undefined || normalizedNamespace.length === 0) {
    return normalizedSubcommand;
  }
  if (normalizedNamespace === "local-analytics") {
    return normalizedSubcommand && normalizedSubcommand.length > 0
      ? normalizedSubcommand
      : "status";
  }
  if (normalizedSubcommand !== undefined && normalizedSubcommand.length > 0) {
    throw createUnknownSubcommandError({
      command_path: "telemetry",
      token: `${namespaceOrSubcommand} ${subcommand}`,
      allowed: ["status", "flush", "stats", "clear", "local-analytics"],
      token_kind: "path",
      examples: [
        "pm telemetry stats --limit 10",
        "pm telemetry local-analytics status --json",
      ],
    });
  }
  return normalizedNamespace;
}

function collectTestMutationValues(options: Record<string, unknown>): {
  addValues: string[];
  addJsonValues: string[];
  removeValues: string[];
  removeIndexValues: string[];
} {
  return {
    addValues: Array.isArray(options.add) ? (options.add as string[]) : [],
    addJsonValues: Array.isArray(options.addJson)
      ? (options.addJson as string[])
      : [],
    removeValues: Array.isArray(options.remove)
      ? (options.remove as string[])
      : [],
    removeIndexValues: Array.isArray(options.removeIndex)
      ? (options.removeIndex as string[])
      : [],
  };
}

function validateBackgroundTestOptions(
  options: Record<string, unknown>,
  values: {
    addValues: string[];
    addJsonValues: string[];
    removeValues: string[];
    removeIndexValues: string[];
  },
): void {
  if (options.background !== true) {
    return;
  }
  if (options.run !== true) {
    throw new PmCliError("--background requires --run", EXIT_CODE.USAGE);
  }
  if (options.acknowledgeLinkedTests === true) {
    throw new PmCliError(
      "--background cannot be combined with --acknowledge-linked-tests; acknowledgement is a non-executing foreground operation",
      EXIT_CODE.USAGE,
    );
  }
  if (
    values.addValues.length > 0 ||
    values.addJsonValues.length > 0 ||
    values.removeValues.length > 0 ||
    values.removeIndexValues.length > 0
  ) {
    throw new PmCliError(
      "--background does not support --add/--add-json/--remove/--remove-index; update linked tests first, then run in background",
      EXIT_CODE.USAGE,
    );
  }
}

async function runBackgroundLinkedTests(
  id: string,
  options: Record<string, unknown>,
  globalOptions: ReturnType<typeof getGlobalOptions>,
  values: {
    addValues: string[];
    addJsonValues: string[];
    removeValues: string[];
    removeIndexValues: string[];
  },
): Promise<void> {
  const result = await runStartBackgroundRun(
    {
      kind: "test",
      commandArgs: buildBackgroundTestCommandArgs(id, {
        ...options,
        add: values.addValues,
        addJson: values.addJsonValues,
        remove: values.removeValues,
        removeIndex: values.removeIndexValues,
      }),
      targetId: id,
      author: typeof options.author === "string" ? options.author : undefined,
      noExtensions: globalOptions.noExtensions === true,
    },
    globalOptions,
  );
  printResult(result, globalOptions);
}

function buildRunTestOptions(
  options: Record<string, unknown>,
  values: {
    addValues: string[];
    addJsonValues: string[];
    removeValues: string[];
    removeIndexValues: string[];
  },
) {
  return {
    add: values.addValues,
    addJson: values.addJsonValues,
    remove: values.removeValues,
    removeIndex: values.removeIndexValues,
    list: Boolean(options.list),
    run: Boolean(options.run),
    match: typeof options.match === "string" ? options.match : undefined,
    onlyIndex:
      typeof options.onlyIndex === "string" ||
      typeof options.onlyIndex === "number"
        ? options.onlyIndex
        : undefined,
    onlyLast: Boolean(options.onlyLast),
    timeout: typeof options.timeout === "string" ? options.timeout : undefined,
    progress: Boolean(options.progress),
    envSet: Array.isArray(options.envSet) ? (options.envSet as string[]) : [],
    envClear: Array.isArray(options.envClear)
      ? (options.envClear as string[])
      : [],
    sharedHostSafe: Boolean(options.sharedHostSafe),
    pmContext:
      typeof options.pmContext === "string" ? options.pmContext : undefined,
    overrideLinkedPmContext: Boolean(options.overrideLinkedPmContext),
    workspaceContext:
      typeof options.workspaceContext === "string"
        ? options.workspaceContext
        : undefined,
    overrideLinkedWorkspaceContext: Boolean(
      options.overrideLinkedWorkspaceContext,
    ),
    allowUntrustedLinkedTests: Boolean(options.allowUntrustedLinkedTests),
    acknowledgeLinkedTests: Boolean(options.acknowledgeLinkedTests),
    failOnContextMismatch: Boolean(options.failOnContextMismatch),
    failOnSkipped: Boolean(options.failOnSkipped),
    failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
    requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
    checkContext: Boolean(options.checkContext),
    autoPmContext: Boolean(options.autoPmContext),
    author: typeof options.author === "string" ? options.author : undefined,
    message: typeof options.message === "string" ? options.message : undefined,
    force: Boolean(options.force),
    measure: Array.isArray(options.measure)
      ? (options.measure as string[])
      : [],
    metricBelow:
      typeof options.metricBelow === "string" ? options.metricBelow : undefined,
    metricDiff:
      typeof options.metricDiff === "string" ? options.metricDiff : undefined,
  };
}

/** Public contract for test-only operation adapter coverage. */
export const _testOnlyRegisterOperations = {
  buildRunTestOptions,
  buildRunTestAllOptions,
  validateBackgroundTestOptions,
};

async function runForegroundLinkedTests(
  id: string,
  options: Record<string, unknown>,
  globalOptions: ReturnType<typeof getGlobalOptions>,
  values: {
    addValues: string[];
    addJsonValues: string[];
    removeValues: string[];
    removeIndexValues: string[];
  },
): Promise<void> {
  const result = await runTest(
    id,
    buildRunTestOptions(options, values),
    globalOptions,
  );
  if (
    values.addValues.length > 0 ||
    values.addJsonValues.length > 0 ||
    values.removeValues.length > 0 ||
    options.run === true ||
    values.removeIndexValues.length > 0
  ) {
    await invalidateSearchCachesForMutation(globalOptions, result);
  }
  printResult(result, globalOptions);
  if (
    result.run_results.some((entry) => entry.status === "failed") ||
    result.fail_on_skipped_triggered === true
  ) {
    process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
  }
}

async function runTestCommandAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const values = collectTestMutationValues(options);
  validateBackgroundTestOptions(options, values);
  if (options.background === true) {
    await runBackgroundLinkedTests(id, options, globalOptions, values);
  } else {
    await runForegroundLinkedTests(id, options, globalOptions, values);
  }
  if (globalOptions.profile) {
    printError(`profile:command=test took_ms=${Date.now() - startedAt}`);
  }
}

function buildLifecycleMutationOptions(options: Record<string, unknown>): {
  author: string | undefined;
  message: string | undefined;
} {
  const author = readOptionString(options, "author");
  const assignee = readOptionString(options, "assignee");
  if (author !== undefined && assignee !== undefined && author !== assignee) {
    throw new PmCliError(
      "Lifecycle ownership received conflicting --author and --assignee values; use one actor value for both aliases.",
      EXIT_CODE.USAGE,
      {
        code: "conflicting_lifecycle_owner",
        examples: [
          "pm claim pm-123",
          "pm start-task pm-123",
          "pm release pm-123",
        ],
      },
    );
  }
  return {
    author: author ?? assignee,
    message: readOptionString(options, "message"),
  };
}

async function runTestAllAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const runInBackground = options.background === true;
  if (runInBackground) {
    const result = await runStartBackgroundRun(
      {
        kind: "test-all",
        commandArgs: buildBackgroundTestAllCommandArgs(options),
        statusFilter: readOptionString(options, "status"),
        noExtensions: globalOptions.noExtensions === true,
      },
      globalOptions,
    );
    printResult(result, globalOptions);
    if (globalOptions.profile) {
      printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
    }
    return;
  }
  const result = await runTestAll(
    buildRunTestAllOptions(options),
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, {
    ids: result.results.map((entry) => entry.id),
  });
  printResult(result, globalOptions);
  if (result.failed > 0 || result.fail_on_skipped_triggered === true) {
    process.exitCode = EXIT_CODE.DEPENDENCY_FAILED;
  }
  if (globalOptions.profile) {
    printError(`profile:command=test-all took_ms=${Date.now() - startedAt}`);
  }
}

function buildRunTestAllOptions(options: Record<string, unknown>) {
  return {
    status: readOptionString(options, "status"),
    limit: readOptionString(options, "limit"),
    offset: readOptionString(options, "offset"),
    timeout: readOptionString(options, "timeout"),
    progress: Boolean(options.progress),
    envSet: Array.isArray(options.envSet) ? (options.envSet as string[]) : [],
    envClear: Array.isArray(options.envClear)
      ? (options.envClear as string[])
      : [],
    sharedHostSafe: Boolean(options.sharedHostSafe),
    pmContext: readOptionString(options, "pmContext"),
    overrideLinkedPmContext: Boolean(options.overrideLinkedPmContext),
    workspaceContext: readOptionString(options, "workspaceContext"),
    overrideLinkedWorkspaceContext: Boolean(
      options.overrideLinkedWorkspaceContext,
    ),
    allowUntrustedLinkedTests: Boolean(options.allowUntrustedLinkedTests),
    failOnContextMismatch: Boolean(options.failOnContextMismatch),
    failOnSkipped: Boolean(options.failOnSkipped),
    failOnEmptyTestRun: Boolean(options.failOnEmptyTestRun),
    requireAssertionsForPm: Boolean(options.requireAssertionsForPm),
    checkContext: Boolean(options.checkContext),
    autoPmContext: Boolean(options.autoPmContext),
  };
}

async function runTelemetryAction(
  namespaceOrSubcommand: string | undefined,
  subcommand: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runTelemetry(
    {
      subcommand: resolveTelemetrySubcommand(namespaceOrSubcommand, subcommand),
      // Commander always parses `--limit <n>` to a string (or leaves it
      // undefined), so a string passthrough covers every CLI-reachable input.
      limit: readOptionString(options, "limit"),
    },
    globalOptions,
  );
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=telemetry took_ms=${Date.now() - startedAt}`);
  }
}

async function runStatsAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const analytics = parseStatsAnalyticsJson(
    readOptionString(options, "analytics"),
  );
  const result = await runStats(globalOptions, {
    includeEmpty: options.includeEmpty === true,
    storage: options.storage === true,
    metadataCoverage: options.metadataCoverage === true,
    byAssignee: options.byAssignee === true,
    byTag: options.byTag === true,
    byPriority: options.byPriority === true,
    tagPrefix: readOptionString(options, "tagPrefix"),
    fieldUtilization: options.fieldUtilization === true,
    ...analytics,
  });
  if (result.recorded_observations?.some((entry) => entry.changed) === true) {
    await invalidateSearchCachesForMutation(globalOptions, {
      ids: result.recorded_observations?.flatMap((entry) =>
        entry.observation.item_id ? [entry.observation.item_id] : [],
      ),
    });
  }
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=stats took_ms=${Date.now() - startedAt}`);
  }
}

async function runDuplicatesAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const threshold = readOptionString(options, "threshold");
  const limit = readOptionString(options, "limit");
  const result = await runDuplicates(globalOptions, {
    status:
      Array.isArray(options.status) && options.status.length > 0
        ? (options.status as string[])
        : undefined,
    since: readOptionString(options, "since"),
    ...(threshold === undefined ? {} : { threshold: Number(threshold) }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  });
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=duplicates took_ms=${Date.now() - startedAt}`);
  }
}

async function runHealthAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const strictExit = Boolean(options.strictExit) || Boolean(options.failOnWarn);
  const result = await runHealth(globalOptions, {
    strictDirectories: Boolean(options.strictDirectories),
    requireMergeDrivers: Boolean(options.requireMergeDrivers),
    checkOnly: Boolean(options.checkOnly),
    checkTelemetry: Boolean(options.checkTelemetry),
    noRefresh: Boolean(options.noRefresh),
    refreshVectors: Boolean(options.refreshVectors),
    verboseStaleItems: Boolean(options.verboseStaleItems),
    verboseAuthorEvents: Boolean(options.verboseAuthorEvents),
    brief: Boolean(options.brief),
    summary: Boolean(options.summary) || strictExit,
    skipVectors: Boolean(options.skipVectors),
    skipIntegrity: Boolean(options.skipIntegrity),
    skipDrift: Boolean(options.skipDrift),
    full: Boolean(options.full),
  });
  printResult(result, globalOptions);
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
}

async function runValidateAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runValidate(
    {
      checkMetadata: Boolean(options.checkMetadata),
      metadataProfile: readOptionString(options, "metadataProfile"),
      checkResolution: Boolean(options.checkResolution),
      checkLifecycle: Boolean(options.checkLifecycle),
      checkStaleBlockers: Boolean(options.checkStaleBlockers),
      dependencyCycleSeverity: readOptionString(
        options,
        "dependencyCycleSeverity",
      ),
      parentCycleSeverity: readOptionString(options, "parentCycleSeverity"),
      checkFiles: Boolean(options.checkFiles),
      checkCommandReferences: Boolean(options.checkCommandReferences),
      scanMode: readOptionString(options, "scanMode"),
      includePmInternals: Boolean(options.includePmInternals),
      verboseFileLists: Boolean(options.verboseFileLists),
      verboseDiagnostics: Boolean(options.verboseDiagnostics),
      allAffectedIds: Boolean(options.allAffectedIds),
      checkHistoryDrift: Boolean(options.checkHistoryDrift),
      checkStorageIntegrity: Boolean(options.checkStorageIntegrity),
      fixHints: Boolean(options.fixHints),
      autoFix: Boolean(options.autoFix),
      dryRun: Boolean(options.dryRun),
      fixScope: Array.isArray(options.fixScope)
        ? (options.fixScope as string[])
        : undefined,
      pruneMissing: Boolean(options.pruneMissing),
      counts: Boolean(options.counts),
      full: Boolean(options.full),
    },
    globalOptions,
  );
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
}

async function runGcAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
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
}

async function runWorkspaceSnapshotAction(
  action: string,
  target: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const normalizedAction = action.trim().toLowerCase();
  if (!WORKSPACE_SNAPSHOT_ACTIONS.some((entry) => entry === normalizedAction)) {
    throw createUnknownSubcommandError({
      command_path: "workspace snapshot",
      token: action,
      allowed: WORKSPACE_SNAPSHOT_ACTIONS,
      display_name: "workspace snapshot",
      token_kind: "action",
      examples: [
        "pm workspace snapshot create before-migration",
        "pm workspace snapshot restore before-migration",
      ],
    });
  }
  if (normalizedAction === "list") {
    printResult(await listWorkspaceSnapshots(pmRoot), globalOptions);
    return;
  }
  if (normalizedAction === "create") {
    printResult(
      await createWorkspaceSnapshot(
        pmRoot,
        target === undefined ? {} : { name: target },
      ),
      globalOptions,
    );
    return;
  }
  if (target === undefined) {
    throw new PmCliError(
      `pm workspace snapshot ${normalizedAction} requires a snapshot name or fingerprint`,
      EXIT_CODE.USAGE,
    );
  }
  if (normalizedAction === "inspect") {
    printResult(await inspectWorkspaceSnapshot(pmRoot, target), globalOptions);
    return;
  }
  if (normalizedAction === "restore") {
    if (options.dryRun === true) {
      printResult(
        await planWorkspaceSnapshotRestore(pmRoot, target),
        globalOptions,
      );
      return;
    }
    const settings = await readSettings(pmRoot);
    printResult(
      await restoreWorkspaceSnapshotWithRecovery(pmRoot, target, {
        force: options.force === true,
        author: resolveAuthor(
          readOptionString(options, "author"),
          settings.author_default,
        ),
        message: readOptionString(options, "message"),
        lockTtlSeconds: settings.locks.ttl_seconds,
        lockWaitMs: settings.locks.wait_ms,
      }),
      globalOptions,
    );
    return;
  }
  printResult(await deleteWorkspaceSnapshot(pmRoot, target), globalOptions);
}

async function runContractsAction(
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runContracts(
    {
      action: readOptionString(options, "action"),
      command: readOptionString(options, "command"),
      summary: Boolean(options.summary),
      schemaOnly: Boolean(options.schemaOnly),
      flagsOnly: Boolean(options.flagsOnly),
      availabilityOnly: Boolean(options.availabilityOnly),
      runtimeOnly: Boolean(options.runtimeOnly) || Boolean(options.activeOnly),
      full: Boolean(options.full),
    },
    globalOptions,
  );
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=contracts took_ms=${Date.now() - startedAt}`);
  }
}

async function runClaimAction(
  id: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const lifecycleOptions = {
    ...buildLifecycleMutationOptions(options),
    ifAvailable: options.ifAvailable === true,
    maxAttempts: options.maxAttempts as string | number | undefined,
  };
  requireClaimTarget(id, options.next === true);
  const result =
    options.next === true
      ? await runClaimNext(
          Boolean(options.force),
          globalOptions,
          lifecycleOptions,
          {
            type: typeof options.type === "string" ? options.type : undefined,
            tag: typeof options.tag === "string" ? options.tag : undefined,
            priority: options.priority as string | number | undefined,
            assigneeFilter:
              typeof options.assigneeFilter === "string"
                ? options.assigneeFilter
                : undefined,
            parent:
              typeof options.parent === "string" ? options.parent : undefined,
            sprint:
              typeof options.sprint === "string" ? options.sprint : undefined,
            release:
              typeof options.release === "string" ? options.release : undefined,
            includeDecisions: options.includeDecisions === true,
            tokenBudget: (options.tokenBudget ?? options.token_budget) as
              | string
              | number
              | undefined,
            explainRanking:
              options.explainRanking === true ||
              options.explain_ranking === true,
          },
        )
      : await runClaim(
          id as string,
          Boolean(options.force),
          globalOptions,
          lifecycleOptions,
        );
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(result, globalOptions);
  if (globalOptions.profile) {
    printError(`profile:command=claim took_ms=${Date.now() - startedAt}`);
  }
}

/** Enforces the claim target XOR selection contract before dispatch. */
export function requireClaimTarget(
  id: string | undefined,
  next: boolean,
): void {
  if (!next && !id)
    throw new PmCliError("Specify an item id or pass --next", EXIT_CODE.USAGE);
  if (next && id)
    throw new PmCliError(
      "Specify either an item id or --next, not both",
      EXIT_CODE.USAGE,
    );
}

async function runReleaseAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const result = await runRelease(id, Boolean(options.force), globalOptions, {
    ...buildLifecycleMutationOptions(options),
    ownershipReleaseBypass: options.ownershipReleaseBypass === true,
  } as Parameters<typeof runRelease>[3]);
  await invalidateSearchCachesForMutation(globalOptions, result);
  printResult(
    await applyActiveCommandResultService(
      "release",
      [id],
      options,
      globalOptions,
      result,
    ),
    globalOptions,
  );
  if (globalOptions.profile) {
    printError(`profile:command=release took_ms=${Date.now() - startedAt}`);
  }
}

async function runStartTaskAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const inProgressStatus = resolveStartTaskInProgressStatus(statusRegistry);
  const force = Boolean(options.force);
  const mutationOptions = buildLifecycleMutationOptions(options);
  const claimResult = await runClaim(id, force, globalOptions, mutationOptions);
  await invalidateSearchCachesForMutation(globalOptions, claimResult);
  const updateResult = await runUpdate(
    id,
    { ...mutationOptions, status: inProgressStatus, force },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, updateResult);
  printResult(
    { id, action: "start_task", claim: claimResult, update: updateResult },
    globalOptions,
  );
  if (globalOptions.profile) {
    printError(`profile:command=start-task took_ms=${Date.now() - startedAt}`);
  }
}

async function runPauseTaskAction(
  id: string,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const pmRoot = resolvePmRoot(process.cwd(), globalOptions.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const force = Boolean(options.force);
  const mutationOptions = buildLifecycleMutationOptions(options);
  const updateResult = await runUpdate(
    id,
    { ...mutationOptions, status: statusRegistry.open_status, force },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, updateResult);
  const releaseResult = await runRelease(
    id,
    force,
    globalOptions,
    mutationOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, releaseResult);
  printResult(
    { id, action: "pause_task", update: updateResult, release: releaseResult },
    globalOptions,
  );
  if (globalOptions.profile) {
    printError(`profile:command=pause-task took_ms=${Date.now() - startedAt}`);
  }
}

async function runCloseTaskAction(
  id: string,
  reason: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const startedAt = Date.now();
  const force = Boolean(options.force);
  const mutationOptions = buildLifecycleMutationOptions(options);
  const closeResult = await runClose(
    id,
    reason,
    {
      ...mutationOptions,
      validateClose: readOptionString(options, "validateClose"),
      force,
    },
    globalOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, closeResult);
  const releaseResult = await runRelease(
    id,
    force,
    globalOptions,
    mutationOptions,
  );
  await invalidateSearchCachesForMutation(globalOptions, releaseResult);
  printResult(
    { id, action: "close_task", close: closeResult, release: releaseResult },
    globalOptions,
  );
  if (globalOptions.profile) {
    printError(`profile:command=close-task took_ms=${Date.now() - startedAt}`);
  }
}

function addLinkedTestExecutionOptions(command: Command): Command {
  return command
    .option("--background", "Run linked tests in managed background mode")
    .option("--timeout <seconds>", "Default run timeout in seconds")
    .option(
      "--progress",
      "Emit linked-test progress to stderr (always shown in TTY, opt-in for non-TTY)",
    )
    .option(
      "--env-set <value>",
      "Set environment variable(s) for linked-test runs (KEY=VALUE, repeatable)",
      collect,
    )
    .option(
      "--env-clear <value>",
      "Clear environment variable(s) for linked-test runs (NAME, repeatable)",
      collect,
    )
    .option(
      "--shared-host-safe",
      "Apply additive shared-host-safe runtime defaults for linked-test runs",
    )
    .option(
      "--pm-context <mode>",
      "PM linked-test context mode: schema|tracker|auto (default: schema)",
    )
    .option(
      "--override-linked-pm-context",
      "Force run-level --pm-context to override per-linked-test pm_context_mode metadata",
    )
    .option(
      "--workspace-context <mode>",
      "Source-workspace mode: source|isolated|snapshot (default: source)",
    )
    .option(
      "--override-linked-workspace-context",
      "Force run-level --workspace-context over per-linked-test metadata",
    )
    .option(
      "--allow-untrusted-linked-tests",
      "Execute untrusted linked commands when project policy also permits it",
    )
    .option(
      "--fail-on-context-mismatch",
      "Fail linked PM commands when context item counts differ",
    )
    .option(
      "--fail-on-skipped",
      "Treat skipped linked tests as dependency failures",
    )
    .option(
      "--fail-on-empty-test-run",
      "Treat successful linked-test commands that report zero executed tests as failures",
    )
    .option(
      "--require-assertions-for-pm",
      "Require assertion metadata for linked PM command tests",
    )
    .option(
      "--check-context",
      "Preflight linked PM command context diagnostics before executing commands",
    )
    .option(
      "--auto-pm-context",
      "Auto-remediate PM tracker-read context mismatches by routing those linked commands through tracker context",
    );
}

/** Implements register operation commands for the public runtime surface of this module. */
export function registerOperationCommands(program: Command): void {
  registerAssuranceCommand(program);
  const testCommand = program
    .command("test")
    .argument("<id>", "Item id")
    .option(
      "--add <value>",
      "Add verified isolated test (CSV/markdown or stdin)",
      collect,
    )
    .option(
      "--add-json <value>",
      "Add verified isolated test (JSON object/array or stdin)",
      collect,
    )
    .option(
      "--remove <value>",
      "Remove linked test entry by exact command/path (command=<value> and path=<value> preserve commas and equals signs; or - for stdin)",
      collect,
    )
    .option(
      "--remove-index <n>",
      "Remove the 1-based linked-test index from --list order (repeatable)",
      collect,
    )
    .option("--list", "List linked tests without mutating")
    .option("--run", "Run linked test commands")
    .option(
      "--match <value>",
      "Run only linked tests whose command/path contains this substring",
    )
    .option(
      "--only-index <n>",
      "Run only the 1-based linked-test index from --list order",
    )
    .option("--only-last", "Run only the most recently added linked test");
  testCommand.option(
    "--acknowledge-linked-tests",
    "Trust the item's current linked commands in this clone without executing them",
  );
  addLinkedTestExecutionOptions(testCommand)
    .option(
      "--measure <value>",
      "Record name=value[,unit=...][,threshold=...] evidence; repeatable",
      collect,
    )
    .option("--metric-below <value>", "Return evidence below name=value")
    .option("--metric-diff <name>", "Diff the latest two values")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override")
    .description("Manage tests linked to an item and optionally run them.")
    .action(runTestCommandAction);

  const testAllCommand = program
    .command("test-all")
    .description("Run linked tests across matching items.")
    .option("--status <value>", "Filter items by status before running tests")
    .option("--limit <n>", "Limit matching items before running linked tests")
    .option("--offset <n>", "Skip matching items before running linked tests");
  addLinkedTestExecutionOptions(testAllCommand).action(runTestAllAction);

  program
    .command("test-runs-worker", { hidden: true })
    .argument("<runId>", "Background run id")
    .description("Internal background worker command.")
    .action(
      async (
        runId: string,
        _options: Record<string, unknown>,
        command: Command,
      ) => {
        const globalOptions = getGlobalOptions(command);
        await runTestRunsWorker(runId, globalOptions);
      },
    );

  program
    .command("telemetry")
    .argument(
      "[namespace-or-subcommand]",
      "Telemetry subcommand: status, flush, stats, clear (default: status)",
    )
    .argument(
      "[subcommand]",
      "Compatibility alias target for local-analytics: status, flush, stats, clear",
    )
    .option("--limit <n>", "Maximum command groups returned by telemetry stats")
    .description("Inspect and manage local telemetry queue/runtime state.")
    .action(runTelemetryAction);

  program
    .command("duplicates")
    .description(
      "Find existing duplicate clusters across all statuses without creating an item.",
    )
    .option(
      "--status <value>",
      "Lifecycle status to include (repeatable or comma-separated)",
      collect,
      [],
    )
    .option(
      "--since <value>",
      "Only inspect items created at or after this time",
    )
    .option("--threshold <value>", "Minimum similarity score from 0 through 1")
    .option("--limit <n>", "Maximum duplicate clusters to return")
    .action(runDuplicatesAction);

  program
    .command("stats")
    .description("Show project tracker statistics.")
    .option(
      "--include-empty",
      "Restore zero-count registered item-type and lifecycle-status buckets",
    )
    .option(
      "--storage",
      "Include aggregate history-stream storage metrics (total streams/lines/bytes, largest + deepest streams, oldest/newest entries)",
    )
    .option(
      "--metadata-coverage",
      "Include metadata coverage % (acceptance_criteria, estimated_minutes, resolution, tags, parent) overall and by type",
    )
    .option(
      "--by-assignee",
      "Include a lifecycle-bucketed item breakdown grouped by assignee",
    )
    .option(
      "--by-tag",
      "Include a lifecycle-bucketed item breakdown grouped by tag",
    )
    .option(
      "--by-priority",
      "Include a lifecycle-bucketed item breakdown grouped by priority",
    )
    .option(
      "--tag-prefix <value>",
      "With --by-tag: only count tags starting with this prefix (e.g. domain:)",
    )
    .option(
      "--field-utilization",
      "Report content-field utilization rates (notes/learnings/files/docs/tests/comments/deps/body) for governance analysis",
    )
    .option("--analytics <json>", "Improvement ledger/history analytics JSON")
    .action(runStatsAction);

  program
    .command("health")
    .description("Show project tracker health checks.")
    .option(
      "--strict-directories",
      "Treat optional item-type directories as required failures",
    )
    .option(
      "--require-merge-drivers",
      "Treat absent clone-local merge drivers as a required health failure",
    )
    .option(
      "--check-only",
      "Run read-only health diagnostics without refreshing vectors",
    )
    .option(
      "--check-telemetry",
      "Probe telemetry endpoint health and include network diagnostics",
    )
    .option(
      "--no-refresh",
      "Disable automatic vector refresh attempts during health checks",
    )
    .option(
      "--refresh-vectors",
      "Explicitly enable vector refresh attempts during health checks",
    )
    .option(
      "--verbose-stale-items",
      "Include full stale vectorization ID lists in health output",
    )
    .option(
      "--verbose-author-events",
      "Include every actionable unknown-author event coordinate for review or disposition",
    )
    .option("--brief", "Emit compact health details for low-token agent checks")
    .option(
      "--summary",
      "Emit one-line-style health status with check names and warning count",
    )
    .option("--skip-vectors", "Skip vectorization check for a faster run")
    .option(
      "--skip-integrity",
      "Skip item/history file integrity check for a faster run",
    )
    .option("--skip-drift", "Skip history drift hash check for a faster run")
    .option(
      "--full",
      "Run all checks including slow integrity, drift, and vectorization checks",
    )
    .option(
      "--strict-exit",
      "Return non-zero exit when health is not ok and default to actionable summary output; use --full for complete details",
    )
    .option("--fail-on-warn", "Alias for --strict-exit")
    .action(runHealthAction);

  program
    .command("validate")
    .description(
      "Run standalone metadata, resolution, lifecycle, files, linked-command reference, and history drift validation checks.",
    )
    .option("--check-metadata", "Run metadata completeness checks")
    .option(
      "--metadata-profile <value>",
      "Select metadata validation profile for --check-metadata (core|strict|custom)",
    )
    .option("--check-resolution", "Run closed-item resolution metadata checks")
    .option(
      "--check-lifecycle",
      "Run active-item lifecycle governance drift checks",
    )
    .option(
      "--check-stale-blockers",
      "Include stale blocker-pattern diagnostics in lifecycle checks",
    )
    .option(
      "--dependency-cycle-severity <value>",
      "Set dependency-cycle warning policy for lifecycle checks (off|warn|error)",
    )
    .option(
      "--parent-cycle-severity <value>",
      "Set parent-hierarchy cycle warning policy for lifecycle checks (off|warn|error)",
    )
    .option("--check-files", "Run linked-file and orphaned-file checks")
    .option(
      "--check-command-references",
      "Run linked-command PM-ID reference checks",
    )
    .option(
      "--scan-mode <value>",
      "Select file candidate scan mode for --check-files (default|tracked-all|tracked-all-strict)",
    )
    .option(
      "--include-pm-internals",
      "Include PM storage internals in tracked-all candidate scans",
    )
    .option(
      "--verbose-file-lists",
      "Include full file-path lists for validate --check-files details",
    )
    .option(
      "--verbose-diagnostics",
      "Include full validate diagnostic ID lists instead of compact summaries",
    )
    .option(
      "--all-affected-ids",
      "Emit complete missing_* affected-ID lists with no truncation (implied by --json)",
    )
    .option(
      "--strict-exit",
      "Return non-zero exit when validation warnings are present",
    )
    .option("--fail-on-warn", "Alias for --strict-exit")
    .option(
      "--fix-hints",
      "Add a machine-executable fix_hints[] of pm commands to each failing check's details",
    )
    .option(
      "--auto-fix",
      "Apply the safe, deterministic subset of fix-hint remediations (field backfills) automatically",
    )
    .option(
      "--dry-run",
      "Preview planned --auto-fix/--prune-missing fixes without applying them",
    )
    .option(
      "--fix-scope <scope>",
      "Grant --auto-fix scopes (metadata, resolution, lifecycle; comma-separated or repeatable). Default: metadata, resolution; lifecycle must be named explicitly",
      collect,
    )
    .option(
      "--prune-missing",
      "Remove stale linked-file/doc LINKS whose paths classified as deleted (never touches real files)",
    )
    .option("--check-history-drift", "Run item/history hash drift checks")
    .option(
      "--check-storage-integrity",
      "Run the post-merge storage-integrity check (unreadable items, history conflict markers, resurrected deletes, unparseable config/schema)",
    )
    .option(
      "--counts",
      "Keep validation counts and totals while omitting per-item diagnostic arrays",
    )
    .option("--full", "Return the complete validation diagnostic projection")
    .action(runValidateAction);

  program
    .command("gc")
    .option(
      "--dry-run",
      "Preview cleanup targets without deleting files; without this flag, pm gc deletes matched artifacts",
    )
    .option(
      "--scope <value>",
      "Limit cleanup to one or more scopes (comma-separated or repeatable): index, embeddings, runtime, locks, checkpoints, transactions",
      collect,
    )
    .description(
      "Delete optional cache artifacts by default (including expired lock debris) and show a summary.",
    )
    .action(runGcAction);

  program
    .command("workspace")
    .description("Manage portable workspace-level SDK primitives.")
    .command("snapshot")
    .argument(
      "<action>",
      "Snapshot action: create, list, inspect, restore, delete",
    )
    .argument(
      "[target]",
      "Optional name for create; name or fingerprint otherwise",
    )
    .description(
      "Create, inspect, list, restore, or delete content-addressed tracker snapshots.",
    )
    .option(
      "--dry-run",
      "Preview restore file, item, stream, and history-entry impact without mutating state",
    )
    .option("--force", "Explicitly confirm a whole-workspace snapshot restore")
    .option("--author <value>", "Actor recorded on the restore audit event")
    .option("--message <value>", "Human-readable restore rationale")
    .action(runWorkspaceSnapshotAction);

  program
    .command("contracts")
    .description(
      "Show machine-readable command and schema contracts for agents.",
    )
    .option(
      "--action <value>",
      "Filter tool schema branches to a specific action",
    )
    .option(
      "--command <value>",
      "Scope contracts output to one CLI command (narrow-by-default)",
    )
    .option(
      "--summary",
      "Return one command+intent row per top-level command for cheap agent bootstrap",
    )
    .option("--schema-only", "Return schema-focused output only")
    .option("--flags-only", "Return command flag contracts only")
    .option("--availability-only", "Return action availability surface only")
    .option(
      "--runtime-only",
      "Include only actions invocable in the current runtime",
    )
    .option("--active-only", "Alias for --runtime-only")
    .option(
      "--full",
      "Include full schema and command-flag surfaces (large; default brief output omits heavy sections for unfiltered queries)",
    )
    .action(runContractsAction);

  const claimCommand = program
    .command("claim")
    .argument("[id]", "Item id (omit with --next)")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force claim override")
    .option(
      "--if-available",
      "Skip silently when the item is already claimed by another author (returns skipped=true)",
    )
    .option(
      "--next",
      "Atomically claim the next caller-available actionable item",
    )
    .option("--type <value>", "Filter --next candidates by type")
    .option("--tag <value>", "Filter --next candidates by tag")
    .option("--priority <value>", "Filter --next candidates by priority")
    .option(
      "--assignee-filter <value>",
      "Filter --next candidates: assigned|unassigned",
    )
    .option("--parent <id>", "Scope --next candidates to a subtree")
    .option("--sprint <value>", "Filter --next candidates by sprint")
    .option("--release <value>", "Filter --next candidates by release")
    .option(
      "--max-attempts <n>",
      "Bound the --next candidate walk (default 10; maximum 100)",
    )
    .option(
      "--include-decisions",
      "Allow --next to claim human-gated Decision items",
    )
    .option(
      "--token-budget <n>",
      "Bound the estimated tokens used to rank --next candidates",
    )
    .option(
      "--explain-ranking",
      "Include ranking provenance for --next selection",
    )
    .description("Claim an item for active work.")
    .action(runClaimAction);
  addHiddenOption(
    claimCommand,
    "--assignee <value>",
    "Alias for --author on lifecycle ownership commands",
  );
  addHiddenOption(
    claimCommand,
    "--token_budget <n>",
    "Alias for --token-budget",
  );
  addHiddenOption(
    claimCommand,
    "--explain_ranking",
    "Alias for --explain-ranking",
  );

  const releaseCommand = program
    .command("release")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force release override")
    .description("Release an item's active claim.")
    .action(runReleaseAction);
  addHiddenOption(
    releaseCommand,
    "--assignee <value>",
    "Alias for --author on lifecycle ownership commands",
  );

  const startTaskCommand = program
    .command("start-task")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership or terminal override when required")
    .description("Lifecycle alias: claim an item and move it to in_progress.")
    .action(runStartTaskAction);
  addHiddenOption(
    startTaskCommand,
    "--assignee <value>",
    "Alias for --author on lifecycle ownership commands",
  );

  const pauseTaskCommand = program
    .command("pause-task")
    .argument("<id>", "Item id")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option("--force", "Force ownership override when required")
    .description("Lifecycle alias: move an item to open and release its claim.")
    .action(runPauseTaskAction);
  addHiddenOption(
    pauseTaskCommand,
    "--assignee <value>",
    "Alias for --author on lifecycle ownership commands",
  );

  const closeTaskCommand = program
    .command("close-task")
    .argument("<id>", "Item id")
    .argument("[reason]", "Close reason text")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .option(
      "--validate-close <value>",
      "Close-time validation mode: off|warn|strict",
    )
    .option("--force", "Force ownership or terminal override when required")
    .description(
      "Lifecycle alias: close an item and release assignment metadata.",
    )
    .action(runCloseTaskAction);
  addHiddenOption(
    closeTaskCommand,
    "--assignee <value>",
    "Alias for --author on lifecycle ownership commands",
  );

  registerSchedulingShortcutCommands(program);
}

/** Optional string accessor for loosely-typed commander option bags. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Common create-passthrough options shared by every scheduling shortcut. */
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

/** GH-217: register the `pm meet`/`pm event`/`pm remind` scheduling shortcuts. Each is a thin friendly-flag wrapper over `runCreate` for an otherwise-unused scheduling type. */
function registerSchedulingShortcutCommands(program: Command): void {
  for (const { name, describe } of [
    {
      name: "meet",
      describe: "Shortcut: create a Meeting with a start time and duration.",
    },
    {
      name: "event",
      describe: "Shortcut: create an Event with a start time and duration.",
    },
  ] as const) {
    program
      .command(name)
      .argument("<title>", "Item title")
      .option(
        "--start <when>",
        "Start time (ISO, 'now', or relative like +1h/+2d); defaults to now",
      )
      .option(
        "--duration <span>",
        "Duration from start (relative like 1h/2d); defaults to 1h when --end is omitted",
      )
      .option(
        "--end <when>",
        "End time (ISO or relative); overrides --duration",
      )
      .option("--location <value>", "Location")
      .option(
        "--timezone <value>",
        "IANA timezone (for example America/New_York)",
      )
      .option("--all-day", "Mark as an all-day event")
      .option("--parent <id>", "Parent item id")
      .option(
        "--allow-missing-parent",
        "Permit a parent id that does not exist yet",
      )
      .option("--tags <list>", "Comma-separated tags")
      .option("--priority <value>", "Priority")
      .option("--body <text>", "Body/markdown content")
      .option("--description <text>", "Short description")
      .option("--author <value>", "Mutation author")
      .option("--message <value>", "History message")
      .description(describe)
      .action(
        async (title: string, options: Record<string, unknown>, command) => {
          const globalOptions = getGlobalOptions(command);
          const startedAt = Date.now();
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
            printError(
              `profile:command=${name} took_ms=${Date.now() - startedAt}`,
            );
          }
        },
      );
  }

  program
    .command("remind")
    .argument("<title>", "Item title")
    .option(
      "--at <when>",
      "Reminder time (ISO, 'now', or relative like +2d); defaults to +1d",
    )
    .option("--text <value>", "Reminder text; defaults to the title")
    .option("--parent <id>", "Parent item id")
    .option(
      "--allow-missing-parent",
      "Permit a parent id that does not exist yet",
    )
    .option("--tags <list>", "Comma-separated tags")
    .option("--priority <value>", "Priority")
    .option("--body <text>", "Body/markdown content")
    .option("--description <text>", "Short description")
    .option("--author <value>", "Mutation author")
    .option("--message <value>", "History message")
    .description("Shortcut: create a Reminder from a single point in time.")
    .action(
      async (title: string, options: Record<string, unknown>, command) => {
        const globalOptions = getGlobalOptions(command);
        const startedAt = Date.now();
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
          printError(
            `profile:command=remind took_ms=${Date.now() - startedAt}`,
          );
        }
      },
    );
}
