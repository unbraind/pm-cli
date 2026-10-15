/** @module sdk/lifecycle/workflow-transition Shared per-type workflow enforcement for lifecycle writers. */
import { describeAllowedTransitions, evaluateTransition, type NormalizedTypeWorkflow } from "../../core/schema/type-workflows.js";
import { normalizeStatusInputWithRegistry as normalizeStatusInput, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { PmCliError } from "../../core/shared/errors.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GovernanceWorkflowEnforcement } from "../../types/index.js";

/** Enforce per-type allowed-transition rules (governance.workflow_enforcement). `off` (default) or an unrestricted type is a no-op. `strict` throws on a disallowed transition; `warn` returns a warning string surfaced on the update result. The target status is the raw `--status` value (resolved case-insensitively through the registry inside evaluateTransition). */
export function enforceTypeWorkflowTransition(params: {
  enforcement: GovernanceWorkflowEnforcement;
  typeWorkflows: NormalizedTypeWorkflow[];
  statusRegistry: RuntimeStatusRegistry;
  typeName: string;
  fromStatus: string;
  toStatus: string;
}): string | undefined {
  if (params.enforcement === "off" || params.typeWorkflows.length === 0) {
    return undefined;
  }
  const result = evaluateTransition({
    typeName: params.typeName,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    typeWorkflows: params.typeWorkflows,
    statusRegistry: params.statusRegistry,
  });
  if (!result.hasRule || result.allowed) {
    return undefined;
  }
  const normalizedFrom =
    normalizeStatusInput(params.fromStatus, params.statusRegistry) ??
    params.fromStatus;
  const normalizedTo =
    normalizeStatusInput(params.toStatus, params.statusRegistry) ??
    params.toStatus;
  const message =
    `Disallowed transition for type "${params.typeName}": ${normalizedFrom} -> ${normalizedTo}. ` +
    `Allowed transitions: ${describeAllowedTransitions(result.allowedTransitions)}.`;
  if (params.enforcement === "strict") {
    throw new PmCliError(message, EXIT_CODE.USAGE);
  }
  return `workflow_transition_not_allowed: ${message}`;
}
