/** @module sdk/lifecycle/release-handoff Validates project-defined handoff queues before ownership changes. */
import { normalizeStatusInputWithRegistry, statusIsTerminal, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolveTypeWorkflows } from "../../core/schema/type-workflows.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { ItemMetadata, PmSettings } from "../../types/index.js";
import type { ReleaseMutationOptions, ReleaseResult } from "./claim.js";
import { enforceTypeWorkflowTransition } from "./workflow-transition.js";

/** Resolve a declared non-terminal queue and evidence without inventing project statuses. */
export function resolveReleaseHandoff(options: ReleaseMutationOptions, registry: RuntimeStatusRegistry): string | undefined {
  if (options.handoff === undefined) return undefined;
  if (options.pause === true) {
    throw new PmCliError("--handoff cannot be combined with --pause. Choose a handoff queue or pause the item.", EXIT_CODE.USAGE);
  }
  const status = typeof options.handoff === "string" ? normalizeStatusInputWithRegistry(options.handoff, registry) : undefined;
  if (status === undefined || statusIsTerminal(status, registry) || status === registry.in_progress_status) {
    throw new PmCliError("--handoff must name a configured non-terminal status distinct from the in-progress status. Inspect pm schema statuses or add a project queue with pm schema add-status <queue> --role active.", EXIT_CODE.USAGE);
  }
  if (typeof options.message !== "string" || options.message.trim().length === 0) {
    throw new PmCliError("--handoff requires --message with implementation evidence and the next verification step.", EXIT_CODE.USAGE);
  }
  return status;
}

/** Enforce the locked source state and configured transition before changing the queue. */
export function applyReleaseHandoff(metadata: ItemMetadata, target: string, settings: PmSettings, registry: RuntimeStatusRegistry, message: string): { receipt: NonNullable<ReleaseResult["handoff"]>; warnings: string[]; changedFields: string[] } {
  if (statusIsTerminal(metadata.status, registry) || !metadata.assignee?.trim()) {
    throw new PmCliError("Handoff requires a claimed, non-terminal item. Claim the active work before handing it off; use pm item reopen for completed work.", EXIT_CODE.CONFLICT);
  }
  const enforcement = settings.governance.workflow_enforcement ?? "off";
  const warning = enforceTypeWorkflowTransition({ enforcement, typeWorkflows: enforcement === "off" ? [] : resolveTypeWorkflows(settings.schema), statusRegistry: registry, typeName: metadata.type, fromStatus: metadata.status, toStatus: target });
  const receipt = { from_status: metadata.status, to_status: target, message };
  const changedFields = metadata.status === target ? [] : ["status"];
  metadata.status = target;
  return { receipt, warnings: warning ? [warning] : [], changedFields };
}
