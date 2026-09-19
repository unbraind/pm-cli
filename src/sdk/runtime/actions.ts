/**
 * @module sdk/runtime/actions
 * Dispatches built-in SDK actions through shared domain operations.
 */
import { projectMutationResult } from "../../core/output/mutation-projection.js";
import { withQuerySummary } from "../../core/output/query-summary.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { createUnknownSubcommandError } from "../agent/subcommand-recovery.js";
import { normalizeAnnotationTransportOptions } from "../annotations.js";
import {
  acknowledgeUnknownAuthorHistoryEventsFromTransport
} from "../author-attribution.js";
import {
  runContracts
} from "../cli-contracts/runtime-contracts.js";
import { runComments } from "../comments.js";
import { runConfig } from "../config.js";
import {
  applyContextIntentProjection
} from "../context-intent-contracts.js";
import { runDeps } from "../dependencies.js";
import { runDocs } from "../docs.js";
import {
  runDuplicates
} from "../duplicates.js";
import {
  runExtension
} from "../extension.js";
import type {
  FilesLookupResult
} from "../files.js";
import { runFiles,runFilesDiscover,runFilesLookup } from "../files.js";
import { runAssuranceDispatch } from "../governance/assurance-action.js";
import {
  runGc
} from "../governance/gc.js";
import {
  runHealth
} from "../governance/health.js";
import {
  runUpgrade
} from "../governance/upgrade.js";
import {
  runValidate
} from "../governance/validate.js";
import {
  runGraph
} from "../graph/run.js";
import {
  runMcpHistoryCompactAction,
  runMcpHistoryRepairAction,
} from "../history-mcp.js";
import {
  runHistoryRedact
} from "../history-redact.js";
import { runHistoryAttest } from "../history/attestation-command.js";
import { runInit } from "../init.js";
import { runLearnings } from "../learnings.js";
import { runAppend } from "../lifecycle/append.js";
import { runCloseMany } from "../lifecycle/close-many.js";
import { runCopy } from "../lifecycle/copy.js";
import { runCreate } from "../lifecycle/create.js";
import { runDelete } from "../lifecycle/delete.js";
import { runFocus } from "../lifecycle/focus.js";
import { runMcpClaimAction,runMcpCloseAction,runMcpReleaseAction,runMcpReopenAction,runMcpTaskCompositionAction } from "../lifecycle/mcp-actions.js";
import {
  runPlan
} from "../lifecycle/plan.js";
import { runRestore } from "../lifecycle/restore.js";
import { runUpdateMany } from "../lifecycle/update-many.js";
import { runUpdate } from "../lifecycle/update.js";
import { runNotes } from "../notes.js";
import {
  PROFILE_SUBCOMMANDS,
  runProfileApply,
  runProfileLint,
  runProfileList,
  runProfileShow,
} from "../profile.js";
import {
  normalizeActivityProjectionOptions,
  runActivity,
  type ActivityCommandOptions,
} from "../query/activity.js";
import {
  runAggregate
} from "../query/aggregate.js";
import {
  runContext
} from "../query/context.js";
import { runGet } from "../query/get.js";
import { runHistory } from "../query/history.js";
import { runList } from "../query/list.js";
import { runNext } from "../query/next.js";
import {
  runSearch
} from "../query/search.js";
import {
  runRuntimeEvalAction,
  runRuntimeEventsAction,
  runRuntimeMergeAction,
  runRuntimeSchedulingAction,
  runRuntimeWorkspaceAction,
} from "../runtime-extended-actions.js";
import {
  closeManyOptionsFromFlat,
  graphOptionsFromFlat,
  parseRuntimeInteger as parseMcpInteger,
  readRuntimeString as readString,
  readRuntimeStringArray as readStringArray,
  resolveRuntimeLimit,
  updateManyOptionsFromFlat,
  withAddNoteOption,
  withFilesDiscoveryOptions,
  withMutationCompaction
} from "../runtime-input.js";
import { statsCommandOptionsFromRuntime } from "../runtime-stats-options.js";
import {
  runStats
} from "../stats.js";
import { runTelemetry } from "../telemetry.js";
import { runTestAll } from "../test/batch.js";
import { runTest } from "../test/execution.js";
import { runtimeFilesLookupOptions } from "../traceability/runtime-files-lookup.js";
import type { McpActionDispatchContext,McpActionHandler } from "./context.js";
import { getOwnHandler,readRequiredString } from "./context.js";
import { runMcpSchemaAction } from "./schema.js";

/** Resolve a target argument with top-level transport arguments taking precedence over normalized options. */
function readMcpTarget(ctx: McpActionDispatchContext): string | undefined {
  return readString(ctx.args, "target") ?? readString(ctx.options, "target");
}

/** Return the dispatch context item ID or require an ID from the selected mutation option record. */
function requireMcpItemId(
  ctx: McpActionDispatchContext,
  source: Record<string, unknown> = ctx.options,
): string {
  return ctx.id ?? readRequiredString(source, "id");
}

/** Apply list context projection and a compact default before invoking the SDK and attaching the applied query summary. */
async function runMcpListAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const listOptions = applyContextIntentProjection("list", ctx.options);
  if (
    listOptions.compact === undefined &&
    listOptions.brief === undefined &&
    listOptions.full === undefined &&
    listOptions.fields === undefined &&
    listOptions.includeBody === undefined
  ) {
    listOptions.compact = true;
  }
  // pm-rmjy: echo applied filters + projection mode so agents get structured confirmation.
  return withQuerySummary(
    (await runList(
      readString(ctx.args, "status") ?? readString(listOptions, "status"),
      listOptions as never,
      ctx.global,
    )) as unknown as Record<string, unknown>,
    listOptions,
  );
}

/** Require the search query, apply context projection and compact defaults, and return the SDK result with its query summary. */
async function runMcpSearchAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const query = readRequiredString(ctx.args, "query");
  const searchOptions = applyContextIntentProjection(
    "search",
    ctx.options,
    [query],
  ) as Parameters<typeof runSearch>[1];
  if (
    searchOptions.compact === undefined &&
    searchOptions.full === undefined &&
    searchOptions.fields === undefined
  ) {
    searchOptions.compact = true;
  }
  return withQuerySummary(
    (await runSearch(
      query,
      searchOptions,
      ctx.global,
    )) as unknown as Record<string, unknown>,
    searchOptions as Record<string, unknown>,
  );
}

/** Run SDK item creation with normalized transport options and project the requested mutation receipt size. */
async function runMcpCreateAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runCreate(runnerOptions as never, ctx.global),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

/** Preserve top-level copy title and message fallbacks while applying shared mutation receipt projection. */
async function runMcpCopyAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  const copyOptions: Record<string, unknown> = {
    ...runnerOptions,
    ...(runnerOptions.title === undefined && typeof ctx.args.title === "string"
      ? { title: ctx.args.title }
      : {}),
    ...(runnerOptions.message === undefined &&
    typeof ctx.args.message === "string"
      ? { message: ctx.args.message }
      : {}),
  };
  return projectMutationResult(
    await runCopy(
      requireMcpItemId(ctx, copyOptions),
      copyOptions as never,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

/** Resolve the target item, invoke SDK update and project compact, full or ID-only mutation evidence. */
async function runMcpUpdateAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runUpdate(
      requireMcpItemId(ctx, runnerOptions),
      runnerOptions as never,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

/** Normalize annotation transport options and bound comment listings to twenty entries unless full history or a limit is requested. */
function runMcpCommentsAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const commentOptions = normalizeAnnotationTransportOptions(ctx.options);
  const isListing =
    commentOptions.add === undefined &&
    commentOptions.stdin === undefined &&
    commentOptions.file === undefined &&
    commentOptions.edit === undefined &&
    commentOptions.delete === undefined;
  if (isListing) {
    commentOptions.includeMeta = true;
    if (
      commentOptions.limit === undefined &&
      commentOptions.fullHistory !== true
    ) {
      commentOptions.limit = "20";
    }
  }
  return runComments(requireMcpItemId(ctx), commentOptions, ctx.global);
}

/** Translate transport lookup options and paths into the SDK file provenance lookup request. */
function runMcpFilesLookupAction(
  ctx: McpActionDispatchContext,
  paths: string[],
): Promise<FilesLookupResult> {
  return runFilesLookup(
    runtimeFilesLookupOptions(ctx.options, paths, parseMcpInteger),
    ctx.global,
  );
}

/** Route file requests to path lookup, item discovery or linked-file mutation according to the normalized options. */
function runMcpFilesAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const lookupPaths = readStringArray(ctx.options.lookupPath);
  if (lookupPaths && lookupPaths.length > 0) {
    return runMcpFilesLookupAction(ctx, lookupPaths);
  }
  const fileId = requireMcpItemId(ctx);
  return ctx.options.discover === true
    ? runFilesDiscover(
        fileId,
        withFilesDiscoveryOptions(ctx.options),
        ctx.global,
      )
    : runFiles(fileId, withAddNoteOption(ctx.options), ctx.global);
}

/** Resolve telemetry subcommand and limit precedence before calling the shared SDK telemetry handler. */
function runMcpTelemetryAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  return runTelemetry(
    {
      subcommand:
        readString(ctx.args, "subcommand") ??
        readString(ctx.options, "subcommand"),
      limit: resolveRuntimeLimit(ctx.args, ctx.options),
    },
    ctx.global,
  );
}

/** Default health output to a compact summary unless the caller explicitly chooses another detail level. */
function runMcpHealthAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const healthOptions: Record<string, unknown> = { ...ctx.options };
  if (
    healthOptions.brief === undefined &&
    healthOptions.summary === undefined &&
    healthOptions.full === undefined
  ) {
    healthOptions.summary = true;
  }
  return runHealth(ctx.global, healthOptions as never);
}

/** Resolve configuration scope, action and value precedence while preserving the policy-specific value transport contract. */
function runMcpConfigAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const configAction =
    readString(ctx.args, "configAction") ??
    readString(ctx.options, "configAction") ??
    readString(ctx.options, "action");
  if (configAction === undefined)
    throw new PmCliError("Missing required argument: configAction", 64);
  const value = readString(ctx.args, "value") ?? readString(ctx.options, "value");
  const options = readString(ctx.options, "policy") !== undefined && value !== undefined ? { ...ctx.options, value } : ctx.options;
  return runConfig(
    readString(ctx.args, "scope") ??
      readString(ctx.options, "scope") ??
      "project",
    configAction,
    readString(ctx.args, "key") ?? readString(ctx.options, "key"),
    options,
    ctx.global,
    readString(ctx.options, "policy") === undefined ? value : undefined,
  );
}

/** Normalize activity projection options before invoking the SDK activity reader. */
function runMcpActivityAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const options = ctx.options as ActivityCommandOptions & { full?: unknown };
  return runActivity(normalizeActivityProjectionOptions(options), ctx.global);
}

/** Accept finite integers and integer strings with optional ordinal suffixes, rejecting other supplied numeric syntax. */
function parseMcpIntegerPrefix(
  value: unknown,
  label: string,
): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (!/^[+-]?\d+(?:st|nd|rd|th)?$/i.test(trimmed)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed)) {
      throw new PmCliError(`${label} must be a finite integer.`, 64);
    }
    return parsed;
  }
  return undefined;
}

/** Resolve plan subcommand, item, step and reorder position before dispatching the shared plan workflow. */
function runMcpPlanAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const subcommand =
    readString(ctx.args, "subcommand") ??
    readRequiredString(ctx.options, "subcommand");
  const planRecord = ctx.options as Record<string, unknown>;
  return runPlan({
    subcommand: subcommand as never,
    id:
      typeof ctx.id === "string"
        ? ctx.id
        : typeof planRecord.id === "string"
          ? (planRecord.id as string)
          : undefined,
    stepRef: readMcpPlanStepRef(ctx),
    reorderTo: parseMcpIntegerPrefix(
      planRecord.reorderTo ?? ctx.args.reorderTo,
      "plan reorderTo",
    ),
    options: ctx.options as never,
    global: ctx.global,
  });
}

/** Prefer a string step reference from normalized options, then fall back to the top-level argument. */
function readMcpPlanStepRef(ctx: McpActionDispatchContext): string | undefined {
  return typeof ctx.options.stepRef === "string"
    ? (ctx.options.stepRef as string)
    : typeof ctx.args.stepRef === "string"
      ? (ctx.args.stepRef as string)
      : undefined;
}

/** Dispatch supported profile operations with normalized name and mutation options, rejecting unknown subcommands. */
function runMcpProfileAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> | unknown {
  const subcommand =
    readString(ctx.args, "subcommand") ??
    readRequiredString(ctx.options, "subcommand");
  const normalizedSubcommand = subcommand.trim().toLowerCase();
  const profileName =
    readString(ctx.args, "name") ?? readString(ctx.options, "name");
  const handlers: Record<string, () => Promise<unknown> | unknown> = {
    list: () => runProfileList(),
    show: () => runProfileShow(profileName),
    lint: () => runProfileLint(profileName),
    apply: () =>
      runProfileApply(
        profileName,
        {
          dryRun: ctx.args.dryRun === true || ctx.options.dryRun === true,
          author:
            readString(ctx.args, "author") ?? readString(ctx.options, "author"),
          force: ctx.args.force === true || ctx.options.force === true,
        },
        ctx.global,
      ),
  };
  const handler = getOwnHandler(handlers, normalizedSubcommand);
  if (!handler) {
    throw createUnknownSubcommandError({
      command_path: "profile",
      token: subcommand,
      allowed: PROFILE_SUBCOMMANDS,
      exit_code: 64,
    });
  }
  return handler();
}

/** Append item content through the SDK and preserve the requested mutation receipt projection. */
async function runMcpAppendAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runAppend(
      requireMcpItemId(ctx, runnerOptions),
      runnerOptions as never,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

/** Translate flat bulk-update options and project the resulting mutation evidence according to caller preferences. */
async function runMcpUpdateManyAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  return projectMutationResult(
    await runUpdateMany(updateManyOptionsFromFlat(runnerOptions), ctx.global),
    { changedFields },
  );
}

/** Merge top-level closure reason and force defaults into bulk options before executing and projecting the close result. */
async function runMcpCloseManyAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  const topLevelReason = readString(ctx.args, "reason");
  const closeManyRunnerOptions: Record<string, unknown> =
    topLevelReason !== undefined && runnerOptions.reason === undefined
      ? { ...runnerOptions, reason: topLevelReason }
      : { ...runnerOptions };
  if (ctx.force && closeManyRunnerOptions.force === undefined) {
    closeManyRunnerOptions.force = true;
  }
  return projectMutationResult(
    await runCloseMany(
      closeManyOptionsFromFlat(closeManyRunnerOptions),
      ctx.global,
    ),
    { changedFields },
  );
}

/** Require the historical restore target and item ID, then apply shared mutation receipt projection to the SDK result. */
async function runMcpRestoreAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    ctx.args,
    ctx.options,
  );
  const target =
    readString(runnerOptions, "target") ??
    readRequiredString(ctx.args, "target");
  return projectMutationResult(
    await runRestore(
      requireMcpItemId(ctx, runnerOptions),
      target,
      runnerOptions,
      ctx.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

/** Dispatch the graph action merging flat MCP parameters onto runner options. */
function runMcpGraphAction(ctx: McpActionDispatchContext): Promise<unknown> {
  const merged = { ...ctx.args, ...ctx.options };
  return runGraph(
    readRequiredString(merged, "subcommand"),
    readString(merged, "id") ?? ctx.id,
    readString(merged, "target"),
    graphOptionsFromFlat(merged),
    ctx.global,
  );
}

/** Resolve the workspace tracker and delegate merged transport arguments to canonical history author acknowledgement. */
function runMcpHistoryAuthorAcknowledgeAction(
  ctx: McpActionDispatchContext,
): Promise<unknown> {
  return acknowledgeUnknownAuthorHistoryEventsFromTransport(
    resolvePmRoot(process.cwd(), ctx.global.path),
    { ...ctx.args, ...ctx.options },
  );
}

/** Built-in action dispatch registry; each entry delegates behavior to its owning SDK operation. */
const SDK_ACTION_HANDLERS: Record<string, McpActionHandler> = {
  init: (ctx) =>
    runInit(
      readString(ctx.args, "prefix"),
      ctx.global,
      ctx.options,
    ),
  context: (ctx) =>
    runContext(
      applyContextIntentProjection("context", ctx.options),
      ctx.global,
    ),
  next: (ctx) =>
    runNext(applyContextIntentProjection("next", ctx.options), ctx.global),
  eval: runRuntimeEvalAction,
  events: runRuntimeEventsAction,
  merge: runRuntimeMergeAction,
  workspace: runRuntimeWorkspaceAction,
  meet: runRuntimeSchedulingAction,
  event: runRuntimeSchedulingAction,
  remind: runRuntimeSchedulingAction,
  list: runMcpListAction,
  get: (ctx) => {
    const id = requireMcpItemId(ctx);
    return runGet(
      id,
      ctx.global,
      applyContextIntentProjection("get", ctx.options, [id]),
    );
  },
  search: runMcpSearchAction,
  /** Normalize MCP duplicate controls before delegating to the shared SDK action. */
  duplicates: (ctx) => {
    const status =
      typeof ctx.options.status === "string"
        ? [ctx.options.status]
        : readStringArray(ctx.options.status);
    return runDuplicates(ctx.global, {
      exhaustive: ctx.options.exhaustive === true,
      ...(status.length === 0 ? {} : { status }),
      since: readString(ctx.options, "since"),
      threshold:
        typeof ctx.options.threshold === "number"
          ? ctx.options.threshold
          : undefined,
      limit:
        ctx.options.limit === "default"
          ? undefined
          : parseMcpInteger(ctx.options.limit, "limit"),
    });
  },
  create: runMcpCreateAction,
  copy: runMcpCopyAction,
  focus: (ctx) =>
    runFocus(
      ctx.id,
      { clear: ctx.options.clear === true || ctx.args.clear === true },
      ctx.global,
    ),
  update: runMcpUpdateAction,
  "item-reopen": runMcpReopenAction,
  restore: runMcpRestoreAction,
  claim: runMcpClaimAction,
  release: runMcpReleaseAction,
  "start-task": (ctx) => runMcpTaskCompositionAction(ctx, "start_task"),
  "pause-task": (ctx) => runMcpTaskCompositionAction(ctx, "pause_task"),
  "close-task": (ctx) => runMcpTaskCompositionAction(ctx, "close_task"),
  close: runMcpCloseAction,
  comments: runMcpCommentsAction,
  notes: (ctx) =>
    runNotes(
      requireMcpItemId(ctx),
      normalizeAnnotationTransportOptions(ctx.options),
      ctx.global,
    ),
  learnings: (ctx) =>
    runLearnings(
      requireMcpItemId(ctx),
      normalizeAnnotationTransportOptions(ctx.options),
      ctx.global,
    ),
  files: runMcpFilesAction,
  docs: (ctx) =>
    runDocs(requireMcpItemId(ctx), withAddNoteOption(ctx.options), ctx.global),
  test: (ctx) => runTest(requireMcpItemId(ctx), ctx.options, ctx.global),
  "test-all": (ctx) => runTestAll(ctx.options, ctx.global),
  telemetry: runMcpTelemetryAction,
  validate: (ctx) =>
    runValidate(ctx.options, ctx.global, {
      runUpdate: (id, options, global) => runUpdate(id, options, global),
    }),
  health: runMcpHealthAction,
  assurance: (ctx) => runAssuranceDispatch(ctx.args, ctx.options, ctx.global),
  contracts: (ctx) => runContracts(ctx.options, ctx.global),
  config: runMcpConfigAction,
  activity: runMcpActivityAction,
  aggregate: (ctx) => runAggregate(ctx.options, ctx.global),
  extension: (ctx) => runExtension(readMcpTarget(ctx), ctx.options, ctx.global),
  package: (ctx) => runExtension(readMcpTarget(ctx), ctx.options, ctx.global),
  install: (ctx) =>
    runExtension(
      readMcpTarget(ctx),
      { ...ctx.options, install: true },
      ctx.global,
    ),
  upgrade: (ctx) => runUpgrade(readMcpTarget(ctx), ctx.options, ctx.global),
  delete: (ctx) => runDelete(requireMcpItemId(ctx), ctx.options, ctx.global),
  deps: (ctx) => runDeps(requireMcpItemId(ctx), ctx.options, ctx.global),
  graph: runMcpGraphAction,
  "files-discover": (ctx) =>
    runFilesDiscover(requireMcpItemId(ctx), ctx.options, ctx.global),
  "files-lookup": (ctx) =>
    runMcpFilesLookupAction(ctx, readStringArray(ctx.options.paths)),
  history: (ctx) => runHistory(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-redact": (ctx) =>
    runHistoryRedact(requireMcpItemId(ctx), ctx.options, ctx.global),
  "history-repair": runMcpHistoryRepairAction,
  "history-compact": runMcpHistoryCompactAction,
  "history-attest": (ctx) => runHistoryAttest(ctx.options, ctx.global),
  "history-author-acknowledge": runMcpHistoryAuthorAcknowledgeAction,
  plan: runMcpPlanAction,
  schema: runMcpSchemaAction,
  profile: runMcpProfileAction,
  stats: (ctx) =>
    runStats(ctx.global, statsCommandOptionsFromRuntime(ctx.options)),
  append: runMcpAppendAction,
  "update-many": runMcpUpdateManyAction,
  "close-many": runMcpCloseManyAction,
  gc: (ctx) => runGc(ctx.global, ctx.options),
};

export { SDK_ACTION_HANDLERS };
