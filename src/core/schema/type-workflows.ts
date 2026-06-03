import type { RuntimeSchemaSettings, TypeWorkflowDefinition } from "../../types/index.js";

/**
 * Per-type allowed-transition support (governance.workflow_enforcement).
 *
 * Rule semantics:
 * - A type with NO matching type_workflows entry is UNRESTRICTED (every
 *   transition is allowed).
 * - A type WITH an entry allows only the listed [from, to] pairs. from/to are
 *   compared as normalized status ids (resolved through the status registry's
 *   alias_to_id map when available, otherwise via token normalization).
 * - A same-status no-op (from === to) is ALWAYS allowed.
 *
 * This module is intentionally dependency-light and fully unit-testable; the
 * CLI enforcement point (src/cli/commands/update.ts) is the only consumer.
 */

export interface NormalizedTypeWorkflow {
  /** Lower-cased type name used for case-insensitive matching. */
  type: string;
  /** Allowed [from, to] pairs as normalized status ids. */
  allowed_transitions: [string, string][];
}

/** Minimal status-registry surface needed to resolve a status token to its id. */
export interface StatusTokenResolver {
  alias_to_id: Map<string, string>;
}

export interface EvaluateTransitionInput {
  typeName: string;
  fromStatus: string;
  toStatus: string;
  typeWorkflows: NormalizedTypeWorkflow[];
  statusRegistry?: StatusTokenResolver;
}

export interface EvaluateTransitionResult {
  /** Whether the transition is permitted. */
  allowed: boolean;
  /** Whether a matching per-type rule constrained the transition. */
  hasRule: boolean;
  /**
   * Allowed [from, to] pairs for the matched type (normalized ids). Empty when
   * the type is unrestricted.
   */
  allowedTransitions: [string, string][];
}

/** Normalize a status token the same way runtime-schema statuses are normalized. */
export function normalizeStatusToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_") : "";
}

function normalizeTypeName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveStatusId(value: string, statusRegistry: StatusTokenResolver | undefined): string {
  const token = normalizeStatusToken(value);
  if (token.length === 0) {
    return "";
  }
  return statusRegistry?.alias_to_id.get(token) ?? token;
}

/**
 * Normalize the raw type_workflows from a runtime schema into a deduped,
 * lower-cased-type list with normalized status tokens. Invalid entries (empty
 * type, empty/short pairs) are dropped.
 */
export function resolveTypeWorkflows(
  schema: Pick<RuntimeSchemaSettings, "type_workflows"> | undefined,
): NormalizedTypeWorkflow[] {
  const rawWorkflows: TypeWorkflowDefinition[] = Array.isArray(schema?.type_workflows) ? schema!.type_workflows! : [];
  const byType = new Map<string, [string, string][]>();
  for (const entry of rawWorkflows) {
    const type = normalizeTypeName(entry?.type);
    if (type.length === 0) {
      continue;
    }
    const pairs = Array.isArray(entry?.allowed_transitions) ? entry.allowed_transitions : [];
    const existing = byType.get(type) ?? [];
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        continue;
      }
      const from = normalizeStatusToken(pair[0]);
      const to = normalizeStatusToken(pair[1]);
      if (from.length === 0 || to.length === 0) {
        continue;
      }
      if (existing.some((candidate) => candidate[0] === from && candidate[1] === to)) {
        continue;
      }
      existing.push([from, to]);
    }
    byType.set(type, existing);
  }
  return [...byType.entries()]
    .map(([type, allowed_transitions]) => ({ type, allowed_transitions }))
    .filter((entry) => entry.allowed_transitions.length > 0)
    .sort((left, right) => left.type.localeCompare(right.type));
}

/**
 * Evaluate whether a status transition is allowed for the given item type.
 * Returns hasRule=false (allowed) when the type is unrestricted.
 */
export function evaluateTransition(input: EvaluateTransitionInput): EvaluateTransitionResult {
  const typeName = normalizeTypeName(input.typeName);
  const matched = input.typeWorkflows.find((workflow) => workflow.type === typeName);
  if (!matched) {
    return { allowed: true, hasRule: false, allowedTransitions: [] };
  }
  const from = resolveStatusId(input.fromStatus, input.statusRegistry);
  const to = resolveStatusId(input.toStatus, input.statusRegistry);
  // A no-op self-transition is always permitted, even under a restricting rule.
  if (from.length > 0 && from === to) {
    return { allowed: true, hasRule: true, allowedTransitions: matched.allowed_transitions };
  }
  const allowed = matched.allowed_transitions.some((pair) => {
    const ruleFrom = resolveStatusId(pair[0], input.statusRegistry);
    const ruleTo = resolveStatusId(pair[1], input.statusRegistry);
    return ruleFrom === from && ruleTo === to;
  });
  return { allowed, hasRule: true, allowedTransitions: matched.allowed_transitions };
}

/** Render the allowed transitions for an error/warning hint. */
export function describeAllowedTransitions(allowedTransitions: [string, string][]): string {
  if (allowedTransitions.length === 0) {
    return "(no transitions allowed)";
  }
  return allowedTransitions.map((pair) => `${pair[0]} -> ${pair[1]}`).join(", ");
}
