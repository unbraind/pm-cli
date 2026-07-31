/**
 * @module sdk/lifecycle-policy
 *
 * Defines the public, presentation-independent policy primitives used when an
 * item enters a terminal lifecycle state.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import type { ItemMetadata } from "../types/index.js";

/** The author-controlled field from which a terminal reason was derived. */
export type TerminalReasonSource =
  | "explicit"
  | "duplicate"
  | "resolution"
  | "message"
  | "none";

/** Controls lifecycle semantics independently of CLI flag parsing. */
export interface TerminalTransitionPolicy {
  /** Refuse terminal transitions that do not carry an author-controlled reason. */
  requireCloseReason: boolean;
  /** Decide whether predecessor edges remain queryable after terminal transition. */
  orderingEdges: "preserve" | "remove";
}

/** Presentation-independent options for the public close-item operation. */
export interface CloseOperationOptions {
  /** Author recorded in immutable history. */
  author?: string;
  /** Human-readable history message. */
  message?: string;
  /** Closure validation mode. */
  validateClose?: string;
  /** Permit an intentional repeat terminal transition. */
  force?: boolean;
  /** Structured resolution evidence. */
  resolution?: string;
  /** Expected outcome evidence. */
  expectedResult?: string;
  /** Actual outcome evidence. */
  actualResult?: string;
  /** Canonical item when closing a duplicate. */
  duplicateOf?: string;
  /** Actual completion time, distinct from tracker mutation time. */
  completedAt?: string;
  /** SDK-only lifecycle overrides; CLI and MCP use workspace defaults. */
  lifecyclePolicy?: Partial<TerminalTransitionPolicy>;
}

/** Result returned by the public close-item operation. */
export interface CloseOperationResult {
  /** Closed item projected as a stable record. */
  item: Record<string, unknown>;
  /** Metadata fields changed by the transition. */
  changed_fields: string[];
  /** Validation and lifecycle policy receipts. */
  warnings: string[];
}

/** Candidate author-controlled sources for one terminal transition reason. */
export interface TerminalReasonInput {
  /** Explicit reason supplied by the operation caller. */
  explicit?: string;
  /** Canonical item id when this transition closes a duplicate. */
  duplicateOf?: string;
  /** Structured resolution supplied by the caller. */
  resolution?: string;
  /** History message supplied by the caller. */
  message?: string;
}

/** Resolved terminal reason together with durable source provenance. */
export interface TerminalReasonResolution {
  /** Normalized author-controlled reason, if one was supplied. */
  closeReason?: string;
  /** Field that supplied the resolved reason. */
  source: TerminalReasonSource;
}

/** Result of applying ordering-edge lifecycle policy to mutable item metadata. */
export interface TerminalOrderingMutation {
  /** Metadata fields changed by the policy. */
  changedFields: string[];
  /** Agent-readable policy receipts emitted by the operation. */
  warnings: string[];
}

/** Default terminal policy shared by CLI, SDK, and MCP operations. */
export const DEFAULT_TERMINAL_TRANSITION_POLICY: Readonly<TerminalTransitionPolicy> =
  Object.freeze({
    requireCloseReason: true,
    orderingEdges: "preserve",
  });

/** Resolve the first author-controlled terminal reason in canonical precedence order. */
export function resolveTerminalReason(
  input: TerminalReasonInput,
): TerminalReasonResolution {
  const candidates: ReadonlyArray<{
    source: Exclude<TerminalReasonSource, "none">;
    value: string | undefined;
  }> = [
    { source: "explicit", value: input.explicit },
    {
      source: "duplicate",
      value:
        input.duplicateOf === undefined
          ? undefined
          : `Duplicate of ${input.duplicateOf}`,
    },
    { source: "resolution", value: input.resolution },
    { source: "message", value: input.message },
  ];
  for (const candidate of candidates) {
    const normalized = candidate.value?.trim();
    if (normalized) {
      return { closeReason: normalized, source: candidate.source };
    }
  }
  return { source: "none" };
}

/** Enforce close-reason governance without inventing immutable history content. */
export function requireTerminalReason(
  input: TerminalReasonInput,
  required: boolean,
): TerminalReasonResolution {
  const resolution = resolveTerminalReason(input);
  if (!required || resolution.closeReason !== undefined) {
    return resolution;
  }
  throw new PmCliError(
    "Close reason text is required because governance.require_close_reason is enabled",
    EXIT_CODE.USAGE,
    {
      code: "close_reason_required",
      required:
        "Provide an author-controlled closing summary as the reason, message, resolution, or duplicate target.",
      why: "governance.require_close_reason is enabled, so tools must not invent immutable closure evidence.",
      examples: [
        'pm close <id> "Done: <what changed and why>"',
        'pm close <id> --reason "<closing summary>"',
        'pm close <id> -m "<closing summary>"',
        "pm close <id> --duplicate-of <canonical-id>",
      ],
      nextSteps: [
        "Re-run the terminal transition with a closing summary.",
        "To stop requiring reasons, run: pm config set governance-require-close-reason --policy disabled",
      ],
    },
  );
}

/**
 * Apply terminal ordering policy while clearing only transient blocked-state
 * scalars. Preserving `blocked_by` dependency rows keeps predecessor history
 * available to graph traversal after the dependent item closes.
 */
export function applyTerminalOrderingPolicy(
  metadata: ItemMetadata,
  policy: Pick<TerminalTransitionPolicy, "orderingEdges">,
): TerminalOrderingMutation {
  const previousBlockedBy =
    typeof metadata.blocked_by === "string" ? metadata.blocked_by.trim() : "";
  const dependencies = metadata.dependencies ?? [];
  const predecessorEdges = dependencies.filter(
    (dependency) => dependency.kind === "blocked_by",
  );
  const hadBlockedReason = metadata.blocked_reason !== undefined;
  const changedFields: string[] = [];

  if (previousBlockedBy) {
    delete metadata.blocked_by;
    changedFields.push("blocked_by");
  }
  if (hadBlockedReason) {
    delete metadata.blocked_reason;
    changedFields.push("blocked_reason");
  }
  if (policy.orderingEdges === "remove" && predecessorEdges.length > 0) {
    const retained = dependencies.filter(
      (dependency) => dependency.kind !== "blocked_by",
    );
    if (retained.length > 0) {
      metadata.dependencies = retained;
    } else {
      delete metadata.dependencies;
    }
    changedFields.push("dependencies");
  }

  const blockerIds = [
    ...new Set([
      ...(previousBlockedBy ? [previousBlockedBy] : []),
      ...predecessorEdges.map((dependency) => dependency.id),
    ]),
  ];
  if (blockerIds.length === 0) {
    return { changedFields, warnings: [] };
  }
  return {
    changedFields,
    warnings: [
      policy.orderingEdges === "preserve"
        ? `closed_preserved_predecessors:${metadata.id}:${blockerIds.join(",")}`
        : `closed_removed_predecessors:${metadata.id}:${blockerIds.join(",")}`,
    ],
  };
}
