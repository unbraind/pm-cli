/**
 * @module sdk/runtime-mutation-actions
 *
 * Keeps lifecycle-specific MCP mutation adapters outside the generic runtime
 * dispatcher while preserving the shared token-efficient result projection.
 */
import { projectMutationResult } from "../../core/output/mutation-projection.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { runClose } from "./close.js";
import { runReopen } from "./reopen.js";
import { runClaim, runClaimNext, runRelease } from "./claim.js";
import { runStartTask, runPauseTask, runCloseTask } from "./task-composition.js";
import { readRuntimeString, withMutationCompaction, mutationOptionsWithOverrides } from "../runtime-input.js";

/** Minimal generic dispatch context consumed by lifecycle mutation adapters. */
export interface LifecycleMutationActionContext {
  /** Flat MCP/action arguments. */
  args: Record<string, unknown>;
  /** Normalized command option bag. */
  options: Record<string, unknown>;
  /** Item id resolved from flat arguments, when present. */
  id: string | undefined;
  /** Normalized transport-level force override. */
  force?: boolean;
  /** Presentation-neutral global command options. */
  global: GlobalOptions;
}

/** Dispatch explicit and ranked claims through the same compact receipt contract. */
export async function runMcpClaimAction(context: LifecycleMutationActionContext): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(context.args, context.options);
  const force = context.force === true || runnerOptions.force === true;
  const selectionOptions = { ...context.args, ...runnerOptions };
  if (selectionOptions.start === true) {
    return runMcpTaskCompositionAction(context, "start_task");
  }
  const result = context.args.next === true || runnerOptions.next === true
    ? await runClaimNext(force, context.global, selectionOptions, selectionOptions)
    : await runClaim(requireLifecycleItemId(context, runnerOptions), force, context.global, selectionOptions);
  return projectMutationResult(result, {
    changedFields,
    compactEnvelope: changedFields === "compact" && !idOnly,
    idOnly,
  });
}

/** Require the explicit identity shared by each step of a lifecycle mutation. */
function requireLifecycleItemId(
  context: LifecycleMutationActionContext,
  options: Record<string, unknown>,
): string {
  const id = context.id ?? readRuntimeString(options, "id");
  if (!id) {
    throw new PmCliError("Missing required argument: id", 64);
  }
  return id;
}

/** Preserve flat and nested close-reason aliases at the transport boundary. */
function readLifecycleReason(
  context: LifecycleMutationActionContext,
  options: Record<string, unknown>,
): string | undefined {
  return (
    readRuntimeString(context.args, "reason") ??
    readRuntimeString(context.args, "text") ??
    readRuntimeString(options, "reason") ??
    readRuntimeString(options, "text")
  );
}

/** Dispatch close through the shared MCP mutation compaction contract. */
export async function runMcpCloseAction(
  context: LifecycleMutationActionContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    context.args,
    context.options,
  );
  if (runnerOptions.releaseAssignment === true) {
    return runMcpTaskCompositionAction(context, "close_task");
  }
  return projectMutationResult(
    await runClose(
      requireLifecycleItemId(context, runnerOptions),
      readLifecycleReason(context, runnerOptions),
      {
        ...runnerOptions,
        force: context.force === true || runnerOptions.force === true,
      },
      context.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}

/** Apply one shared transport projection to canonical and legacy lifecycle compositions. */
export async function runMcpTaskCompositionAction(
  context: LifecycleMutationActionContext,
  action: "start_task" | "pause_task" | "close_task",
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(context.args, context.options);
  const id = requireLifecycleItemId(context, runnerOptions);
  const options = mutationOptionsWithOverrides(runnerOptions, { force: context.force === true || runnerOptions.force === true });
  const result = action === "start_task"
    ? await runStartTask(id, options, context.global)
    : action === "pause_task"
      ? await runPauseTask(id, options, context.global)
      : await runCloseTask(id, readLifecycleReason(context, runnerOptions), options, context.global);
  return projectMutationResult(result, { changedFields, idOnly, compactEnvelope: changedFields === "compact" && !idOnly });
}

/** Release ownership with the same compact/full controls used by claiming and pausing. */
export async function runMcpReleaseAction(context: LifecycleMutationActionContext): Promise<unknown> {
  if (context.options.pause === true) return runMcpTaskCompositionAction(context, "pause_task");
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(context.args, context.options);
  const result = await runRelease(requireLifecycleItemId(context, runnerOptions), context.force === true, context.global, runnerOptions);
  return projectMutationResult(result, { changedFields, idOnly, compactEnvelope: changedFields === "compact" && !idOnly });
}

/** Dispatch recurrence through the shared MCP mutation compaction contract. */
export async function runMcpReopenAction(
  context: LifecycleMutationActionContext,
): Promise<unknown> {
  const { changedFields, idOnly, runnerOptions } = withMutationCompaction(
    context.args,
    context.options,
  );
  return projectMutationResult(
    await runReopen(
      requireLifecycleItemId(context, runnerOptions),
      readLifecycleReason(context, runnerOptions) ?? "",
      {
        ...runnerOptions,
        force: context.force === true || runnerOptions.force === true,
      },
      context.global,
    ),
    {
      changedFields,
      compactEnvelope: changedFields === "compact" && !idOnly,
      idOnly,
    },
  );
}
