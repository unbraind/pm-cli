/**
 * @module core/schema/type-workflows
 *
 * Resolves configurable schema, fields, statuses, and workflows for Type Workflows.
 */
import type {
  RuntimeSchemaSettings,
  TypeWorkflowDefinition,
} from "../../types/index.js";

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
  /** Value that configures or reports alias to id for this contract. */
  alias_to_id: Map<string, string>;
}

/** Documents the evaluate transition input payload exchanged by command, SDK, and package integrations. */
export interface EvaluateTransitionInput {
  /** Value that configures or reports type name for this contract. */
  typeName: string;
  /** Lifecycle state reported for fromthe record. */
  fromStatus: string;
  /** Lifecycle state reported for tothe record. */
  toStatus: string;
  /** Value that configures or reports type workflows for this contract. */
  typeWorkflows: NormalizedTypeWorkflow[];
  /** Value that configures or reports status registry for this contract. */
  statusRegistry?: StatusTokenResolver;
}

/** Documents the evaluate transition result payload exchanged by command, SDK, and package integrations. */
export interface EvaluateTransitionResult {
  /** Whether the transition is permitted. */
  allowed: boolean;
  /** Whether a matching per-type rule constrained the transition. */
  hasRule: boolean;
  /** Allowed [from, to] pairs for the matched type (normalized ids). Empty when the type is unrestricted. */
  allowedTransitions: [string, string][];
}

/** Normalize a status token the same way runtime-schema statuses are normalized. */
export function normalizeStatusToken(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replaceAll(/[\s-]+/g, "_")
    : "";
}

function normalizeTypeName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveStatusId(
  value: string,
  statusRegistry: StatusTokenResolver | undefined,
): string {
  const token = normalizeStatusToken(value);
  if (token.length === 0) {
    return "";
  }
  return statusRegistry?.alias_to_id?.get(token) ?? token;
}

/**
 * Normalize the raw type_workflows from a runtime schema into a deduped,
 * lower-cased-type list with normalized status tokens.
 *
 * An entry is kept when it has a valid (non-empty) `type` AND its
 * `allowed_transitions` is an ARRAY — even when that array is empty. An explicit
 * empty array is a deliberate DENY-ALL rule (only same-status no-ops are
 * permitted, see evaluateTransition), so it must NOT collapse into "no rule"
 * (which would leave the type unrestricted). Entries with a missing/empty type
 * or a non-array `allowed_transitions` are dropped, as are malformed/short pairs.
 */
export function resolveTypeWorkflows(
  schema: Pick<RuntimeSchemaSettings, "type_workflows"> | undefined,
): NormalizedTypeWorkflow[] {
  const rawWorkflows: TypeWorkflowDefinition[] = Array.isArray(
    schema?.type_workflows,
  )
    ? schema!.type_workflows!
    : [];
  const byType = new Map<
    string,
    { pairs: [string, string][]; denyAll: boolean }
  >();
  for (const entry of rawWorkflows) {
    const type = normalizeTypeName(entry?.type);
    if (type.length === 0) {
      continue;
    }
    if (!Array.isArray(entry?.allowed_transitions)) {
      continue;
    }
    const pairs = entry.allowed_transitions;
    const record = byType.get(type) ?? { pairs: [], denyAll: false };
    // Only an explicitly empty array is an intentional deny-all; a nonempty array
    // whose pairs are all malformed is a typo and must be dropped (not deny-all).
    if (pairs.length === 0) {
      record.denyAll = true;
    }
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        continue;
      }
      const from = normalizeStatusToken(pair[0]);
      const to = normalizeStatusToken(pair[1]);
      if (from.length === 0 || to.length === 0) {
        continue;
      }
      if (
        record.pairs.some(
          (candidate) => candidate[0] === from && candidate[1] === to,
        )
      ) {
        continue;
      }
      record.pairs.push([from, to]);
    }
    byType.set(type, record);
  }
  return [...byType.entries()]
    .filter(([, record]) => record.pairs.length > 0 || record.denyAll)
    .map(([type, record]) => ({ type, allowed_transitions: record.pairs }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

/** Evaluate whether a status transition is allowed for the given item type. Returns hasRule=false (allowed) when the type is unrestricted. */
export function evaluateTransition(
  input: EvaluateTransitionInput,
): EvaluateTransitionResult {
  const typeName = normalizeTypeName(input.typeName);
  const matched = input.typeWorkflows.find(
    (workflow) => workflow.type === typeName,
  );
  if (!matched) {
    return { allowed: true, hasRule: false, allowedTransitions: [] };
  }
  const from = resolveStatusId(input.fromStatus, input.statusRegistry);
  const to = resolveStatusId(input.toStatus, input.statusRegistry);
  // A no-op self-transition is always permitted, even under a restricting rule.
  if (from.length > 0 && from === to) {
    return {
      allowed: true,
      hasRule: true,
      allowedTransitions: matched.allowed_transitions,
    };
  }
  const allowed = matched.allowed_transitions.some((pair) => {
    const ruleFrom = resolveStatusId(pair[0], input.statusRegistry);
    const ruleTo = resolveStatusId(pair[1], input.statusRegistry);
    return ruleFrom === from && ruleTo === to;
  });
  return {
    allowed,
    hasRule: true,
    allowedTransitions: matched.allowed_transitions,
  };
}

/** Render the allowed transitions for an error/warning hint. */
export function describeAllowedTransitions(
  allowedTransitions: [string, string][],
): string {
  if (allowedTransitions.length === 0) {
    return "(no transitions allowed)";
  }
  return allowedTransitions
    .map((pair) => `${pair[0]} -> ${pair[1]}`)
    .join(", ");
}
