/**
 * @module sdk/lifecycle/task-composition
 *
 * Composes ownership and lifecycle mutations for CLI, MCP, and SDK callers.
 * Each constituent operation retains its own immutable history event and
 * governance checks; these sequences do not promise cross-operation rollback.
 */
import { PmCliError } from "../../core/shared/errors.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { runClaim, runRelease, type ReleaseMutationOptions } from "./claim.js";
import { resolveReleaseHandoff } from "./release-handoff.js";
import { runClose, type CloseCommandOptions } from "./close.js";
import { runUpdate, type UpdateCommandOptions } from "./update.js";
import { resolveStartTaskInProgressStatus } from "../start-task-status.js";
import { admitStartWithOpenBlockers, isStartTransition } from "./start-blockers.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { mutationOptionsWithOverrides } from "../runtime-input.js";
import type { StartTaskResult, PauseTaskResult, CloseTaskResult } from "../runtime-public-contracts.js";

/** Ownership inputs shared by the explicit-item start and pause compositions. */
export interface TaskCompositionOptions extends ReleaseMutationOptions {
  /** Permit the same ownership and terminal overrides as constituent mutations. */
  force?: boolean;
  /** Ranked selection cannot be combined with an explicit-item composition. */
  next?: boolean;
}

/** Preserve a failed step's diagnostics while reporting the earlier durable mutation, without implying rollback. */
export async function finishComposition<T>(id: string, completed: "claim" | "update" | "close", operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const context = error instanceof PmCliError ? error.context : {};
    const failure = new PmCliError(
      error instanceof Error ? error.message : String(error),
      error instanceof PmCliError ? error.exitCode : EXIT_CODE.GENERIC_FAILURE,
      {
        ...context,
        item_id: id,
        why: `${completed} completed for ${id} before the following step failed. No rollback was performed.${context.why ? ` ${context.why}` : ""}`,
        nextSteps: [`Inspect the persisted state with pm get ${id} and pm history ${id} before retrying the failed step.`, ...(context.nextSteps ?? [])],
      },
    );
    failure.cause = error;
    throw failure;
  }
}

/** Claim explicit work and advance it through the workspace's configured workflow. */
export async function runStartTask(id: string, options: TaskCompositionOptions, global: GlobalOptions): Promise<StartTaskResult> {
  if (options.next === true || options.ifAvailable === true) {
    throw new PmCliError("--start cannot be combined with --next or --if-available for an explicit item", EXIT_CODE.USAGE, {
      code: "invalid_argument_value",
      required: "Remove --next and --if-available when starting an explicit item.",
      nextSteps: ["Remove --next and --if-available, keep the explicit item ID and other supplied arguments, then retry."],
    });
  }
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const registry = resolveRuntimeStatusRegistry(settings.schema);
  const status = resolveStartTaskInProgressStatus(registry);
  // pm-urzubi: refuse before the claim write, so a refused start never leaves a claim behind.
  // The status update re-checks under its own item lock.
  await precheckStartBlockers(pmRoot, settings, id, registry, options.force === true);
  // The explicit composition keeps claim and status as separate audited steps; only claim --next --start shares one write.
  const claim = await runClaim(id, options.force === true, global, mutationOptionsWithOverrides(options, {}, ["start"]));
  const canonicalId = claim.item.id as string;
  const update = await finishComposition(canonicalId, "claim", /** Advance the persisted claim identity using the configured workflow while preserving constituent mutation policy. */ () => runUpdate(canonicalId, mutationOptionsWithOverrides(options, { status }, ["assignee", "start", "next", "ifAvailable", "maxAttempts"]) as UpdateCommandOptions, global));
  return { id: canonicalId, action: "start_task", claim, update };
}

/** Read the item without locking and refuse a start its open blockers would make the update refuse. */
async function precheckStartBlockers(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  id: string,
  registry: ReturnType<typeof resolveRuntimeStatusRegistry>,
  force: boolean,
): Promise<void> {
  const typeToFolder = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).type_to_folder;
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeToFolder);
  if (!located) return;
  const { document } = await readLocatedItem(located, { schema: settings.schema });
  if (!isStartTransition(document.metadata.status, registry.in_progress_status, registry)) return;
  await admitStartWithOpenBlockers({ pmRoot, settings, metadata: document.metadata, force });
}

/** Return work to its configured open status, then release ownership. */
export async function runPauseTask(id: string, options: TaskCompositionOptions, global: GlobalOptions): Promise<PauseTaskResult> {
  const settings = await readSettings(resolvePmRoot(process.cwd(), global.path));
  const registry = resolveRuntimeStatusRegistry(settings.schema);
  resolveReleaseHandoff({ ...options, pause: true }, registry);
  const status = registry.open_status;
  const update = await runUpdate(id, mutationOptionsWithOverrides(options, { status }, ["assignee", "pause"]) as UpdateCommandOptions, global);
  const canonicalId = update.item.id as string;
  const release = await finishComposition(canonicalId, "update", /** Release the persisted update identity only after its open-status mutation succeeds. */ () => runRelease(canonicalId, options.force === true, global, options));
  return { id: canonicalId, action: "pause_task", update, release };
}

/** Record all close evidence before releasing assignment metadata. */
export async function runCloseTask(id: string, reason: string | undefined, options: CloseCommandOptions, global: GlobalOptions): Promise<CloseTaskResult> {
  const close = await runClose(id, reason, options, global);
  const canonicalId = close.item.id as string;
  const release = await finishComposition(canonicalId, "close", /** Release the persisted close identity only after durable closure evidence is recorded. */ () => runRelease(canonicalId, options.force === true, global, options));
  return { id: canonicalId, action: "close_task", close, release };
}
