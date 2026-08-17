/**
 * @module sdk/runtime-extended-actions
 *
 * Implements native generic-action adapters for cross-cutting SDK operations.
 */
import type { GlobalOptions } from "../core/shared/command-types.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { createUnknownSubcommandError } from "./agent/subcommand-recovery.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { runEval, type EvalOptions } from "./eval.js";
import { runMergeDriver } from "./merge/driver.js";
import { runMergeInstall } from "./merge/install.js";
import { runMergeReconcile } from "./merge/reconcile.js";
import { runMergeReceiptReport } from "./merge/receipts.js";
import { listMutationEvents } from "./mutation-events.js";
import {
  parseRuntimeInteger,
  readRuntimeString,
  readRuntimeStringArray,
} from "./runtime-input.js";
import {
  runEvent,
  runMeet,
  runRemind,
  type MeetingEventShortcutOptions,
  type ReminderShortcutOptions,
} from "./scheduling-shortcuts.js";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  inspectWorkspaceSnapshot,
  listWorkspaceSnapshots,
  planWorkspaceSnapshotRestore,
  restoreWorkspaceSnapshotWithRecovery,
} from "./workspace-snapshot.js";

/** Minimal dispatch context shared with the generic runtime action registry. */
export interface RuntimeExtendedActionContext {
  /** Canonical action selected after alias normalization. */
  action: string;
  /** Complete action request, including transport-level fields. */
  args: Record<string, unknown>;
  /** Normalized command options. */
  options: Record<string, unknown>;
  /** Workspace and rendering controls shared by direct SDK runners. */
  global: GlobalOptions;
}

function mergedInput(
  context: RuntimeExtendedActionContext,
): Record<string, unknown> {
  return { ...context.args, ...context.options };
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = readRuntimeString(input, key);
  if (value !== undefined) return value;
  throw new PmCliError(`Missing required parameter: ${key}`, EXIT_CODE.USAGE);
}

function stringList(value: unknown): string[] {
  return typeof value === "string" ? [value] : readRuntimeStringArray(value);
}

/** Dispatch search relevance evaluation through the public SDK runner. */
export function runRuntimeEvalAction(
  context: RuntimeExtendedActionContext,
): Promise<unknown> {
  return runEval(mergedInput(context) as EvalOptions, context.global);
}

/** Dispatch one bounded mutation-event page through the public SDK runner. */
export function runRuntimeEventsAction(
  context: RuntimeExtendedActionContext,
): Promise<unknown> {
  const input = mergedInput(context);
  const cursorMode = readRuntimeString(input, "cursorMode");
  if (
    cursorMode !== undefined &&
    cursorMode !== "batch" &&
    cursorMode !== "row"
  ) {
    throw new PmCliError(
      "Mutation event cursor mode must be batch or row.",
      EXIT_CODE.USAGE,
      { code: "invalid_event_cursor_mode" },
    );
  }
  return listMutationEvents({
    cwd: readRuntimeString(input, "cwd"),
    pmRoot: readRuntimeString(input, "path"),
    since: readRuntimeString(input, "since"),
    type: stringList(input.type),
    author: stringList(input.author),
    item: stringList(input.item),
    limit:
      input.limit === undefined
        ? undefined
        : parseRuntimeInteger(input.limit, "limit"),
    full: input.full === true,
    cursorMode,
    ...(input.provenance === undefined
      ? {}
      : { provenance: input.provenance === true }),
    ...(input.provenanceSummary === undefined
      ? {}
      : { provenanceSummary: input.provenanceSummary === true }),
    ...(input.harness === undefined
      ? {}
      : { harness: stringList(input.harness) }),
    ...(input.agentInstance === undefined
      ? {}
      : { agentInstance: stringList(input.agentInstance) }),
    ...(input.provenanceFilter === undefined
      ? {}
      : { provenanceFilter: stringList(input.provenanceFilter) }),
  });
}

/** Dispatch merge install, reconciliation, receipt, or driver operations. */
export function runRuntimeMergeAction(
  context: RuntimeExtendedActionContext,
): Promise<unknown> {
  const input = mergedInput(context);
  const subcommand = requiredString(input, "subcommand");
  if (subcommand === "install") {
    return runMergeInstall({ dryRun: input.dryRun === true }, context.global);
  }
  if (subcommand === "reconcile") {
    return runMergeReconcile(
      {
        dryRun: input.dryRun === true,
        author: readRuntimeString(input, "author"),
        message: readRuntimeString(input, "message"),
        force: input.force === true,
      },
      context.global,
    );
  }
  if (subcommand === "report") {
    return runMergeReceiptReport({
      includeReconciled: input.includeReconciled === true,
      cwd: readRuntimeString(input, "cwd"),
    });
  }
  if (subcommand === "driver") {
    return runMergeDriver(
      {
        artifact: requiredString(input, "artifact"),
        basePath: requiredString(input, "basePath"),
        oursPath: requiredString(input, "oursPath"),
        theirsPath: requiredString(input, "theirsPath"),
        outputPath:
          readRuntimeString(input, "outputPath") ??
          readRuntimeString(input, "output"),
        itemPath: readRuntimeString(input, "itemPath"),
        prefer: readRuntimeString(input, "prefer"),
      },
      context.global,
    );
  }
  throw createUnknownSubcommandError({
    command_path: "merge",
    token: subcommand,
    allowed: ["install", "reconcile", "report", "driver"],
    display_name: "merge",
  });
}

/** Dispatch guarded workspace snapshot operations. */
export function runRuntimeWorkspaceAction(
  context: RuntimeExtendedActionContext,
): Promise<unknown> {
  const input = mergedInput(context);
  const subcommand = requiredString(input, "subcommand");
  if (subcommand !== "snapshot") {
    throw createUnknownSubcommandError({
    command_path: "workspace",
    token: subcommand,
    allowed: ["snapshot"],
    display_name: "workspace",
    });
  }
  const snapshotAction =
    readRuntimeString(input, "snapshotAction") ??
    requiredString(input, "snapshot_action");
  const pmRoot = resolvePmRoot(process.cwd(), context.global.path);
  if (snapshotAction === "create") {
    return createWorkspaceSnapshot(pmRoot, {
      name: readRuntimeString(input, "name"),
    });
  }
  if (snapshotAction === "list") return listWorkspaceSnapshots(pmRoot);
  const target = requiredString(input, "target");
  if (snapshotAction === "inspect") {
    return inspectWorkspaceSnapshot(pmRoot, target);
  }
  if (snapshotAction === "delete") {
    return deleteWorkspaceSnapshot(pmRoot, target);
  }
  if (snapshotAction === "restore") {
    return input.dryRun === true
      ? planWorkspaceSnapshotRestore(pmRoot, target)
      : restoreWorkspaceSnapshotWithRecovery(pmRoot, target, {
          force: input.force === true,
          author: readRuntimeString(input, "author"),
          message: readRuntimeString(input, "message"),
          lockTtlSeconds: parseRuntimeInteger(
            input.lockTtlSeconds,
            "lockTtlSeconds",
          ),
          lockWaitMs: parseRuntimeInteger(input.lockWaitMs, "lockWaitMs"),
        });
  }
  throw createUnknownSubcommandError({
    command_path: "workspace snapshot",
    token: snapshotAction,
    allowed: ["create", "list", "inspect", "restore", "delete"],
    display_name: "workspace snapshot",
    token_kind: "action",
  });
}

/** Dispatch meeting, event, and reminder shortcuts through SDK-owned creation. */
export function runRuntimeSchedulingAction(
  context: RuntimeExtendedActionContext,
): Promise<unknown> {
  const input = mergedInput(context);
  const title = requiredString(input, "title");
  if (context.action === "meet") {
    return runMeet(title, input as MeetingEventShortcutOptions, context.global);
  }
  if (context.action === "event") {
    return runEvent(
      title,
      input as MeetingEventShortcutOptions,
      context.global,
    );
  }
  return runRemind(title, input as ReminderShortcutOptions, context.global);
}
