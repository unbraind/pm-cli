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
import { readRuntimeString, withMutationCompaction } from "../runtime-input.js";

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
