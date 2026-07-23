/** @module cli/commands/dependency-flag-validation */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { toErrorMessage } from "../core/shared/primitives.js";
import type { Dependency } from "../types/index.js";
import { resolveWorkspaceRelationshipKindRegistry } from "./graph/assembly.js";
import {
  assertRelationshipEdgeAllowed,
  type RelationshipKindRegistry,
} from "./relationships.js";

/** Reject malformed shorthand before item-id prefix normalization can create a dangling graph node. */
export function assertValidBareDependencyFlagValue(
  value: string,
  structured: boolean,
): void {
  if (!structured && /[:,=]/.test(value)) {
    throw new PmCliError(
      `Invalid --dep value "${value}". Use a bare item id or id=<id>,kind=<kind>.`,
      EXIT_CODE.USAGE,
    );
  }
}

/**
 * Validate prospective stored dependencies against the active relationship
 * ontology before a create or update mutation writes item or history state.
 */
export function assertDependencyEdgesAllowed(
  holderId: string,
  dependencies: readonly Dependency[] | undefined,
  registry: RelationshipKindRegistry = resolveWorkspaceRelationshipKindRegistry(),
): void {
  for (const dependency of dependencies ?? []) {
    try {
      assertRelationshipEdgeAllowed(
        holderId,
        dependency.id,
        dependency.kind,
        registry,
      );
    } catch (error: unknown) {
      throw new PmCliError(toErrorMessage(error), EXIT_CODE.USAGE, {
        code: "dependency_edge_not_allowed",
        why: `${holderId} -> ${dependency.id} (${dependency.kind}) violates the active relationship-kind policy`,
      });
    }
  }
}
