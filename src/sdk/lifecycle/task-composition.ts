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
import { runClaim, runRelease, type ClaimMutationOptions } from "./claim.js";
import { runClose, type CloseCommandOptions } from "./close.js";
import { runUpdate, type UpdateCommandOptions } from "./update.js";
import { resolveStartTaskInProgressStatus } from "../start-task-status.js";
import { mutationOptionsWithOverrides } from "../runtime-input.js";
import type { StartTaskResult, PauseTaskResult, CloseTaskResult } from "../runtime-public-contracts.js";

/** Ownership inputs shared by the explicit-item start and pause compositions. */
export interface TaskCompositionOptions extends ClaimMutationOptions {
  /** Permit the same ownership and terminal overrides as constituent mutations. */
  force?: boolean;
  /** Ranked selection cannot be combined with an explicit-item composition. */
  next?: boolean;
}

/** Claim explicit work and advance it through the workspace's configured workflow. */
export async function runStartTask(id: string, options: TaskCompositionOptions, global: GlobalOptions): Promise<StartTaskResult> {
  if (options.next === true || options.ifAvailable === true) {
    throw new PmCliError("--start requires an explicit item id and cannot be combined with --next or --if-available", EXIT_CODE.USAGE);
  }
  const settings = await readSettings(resolvePmRoot(process.cwd(), global.path));
  const status = resolveStartTaskInProgressStatus(resolveRuntimeStatusRegistry(settings.schema));
  const claim = await runClaim(id, options.force === true, global, options);
  const update = await runUpdate(id, mutationOptionsWithOverrides(options, { status }, ["assignee", "start", "next", "ifAvailable", "maxAttempts"]) as UpdateCommandOptions, global);
  return { id, action: "start_task", claim, update };
}

/** Return work to its configured open status, then release ownership. */
export async function runPauseTask(id: string, options: TaskCompositionOptions, global: GlobalOptions): Promise<PauseTaskResult> {
  const settings = await readSettings(resolvePmRoot(process.cwd(), global.path));
  const status = resolveRuntimeStatusRegistry(settings.schema).open_status;
  const update = await runUpdate(id, mutationOptionsWithOverrides(options, { status }, ["assignee", "pause"]) as UpdateCommandOptions, global);
  const release = await runRelease(id, options.force === true, global, options);
  return { id, action: "pause_task", update, release };
}

/** Record all close evidence before releasing assignment metadata. */
export async function runCloseTask(id: string, reason: string | undefined, options: CloseCommandOptions, global: GlobalOptions): Promise<CloseTaskResult> {
  const close = await runClose(id, reason, options, global);
  const release = await runRelease(id, options.force === true, global, options);
  return { id, action: "close_task", close, release };
}
