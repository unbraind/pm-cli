/** @module cli/commands/dependency-flag-validation */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { toErrorMessage } from "../core/shared/primitives.js";
import type { Dependency, ItemFormat } from "../types/index.js";
import { locateItem } from "../core/store/item-store.js";
import { isExternalDependencySourceKind } from "./dependency-provenance.js";
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

/**
 * Resolve every newly supplied local dependency before a mutation commits.
 * Explicit external provenance bypasses workspace lookup, while the opt-in
 * unresolved mode returns durable warning tokens instead of pretending that
 * the graph edge resolved successfully.
 */
export async function assertDependencyTargetsResolvable(params: {
  pmRoot: string;
  dependencies: readonly Dependency[] | undefined;
  idPrefix: string;
  itemFormat: ItemFormat;
  typeToFolder: Record<string, string>;
  allowUnresolved?: boolean;
}): Promise<string[]> {
  const localTargets = [
    ...new Set(
      (params.dependencies ?? [])
        .filter(
          (dependency) =>
            !isExternalDependencySourceKind(dependency.source_kind),
        )
        .map((dependency) => dependency.id),
    ),
  ];
  const resolutions = await Promise.all(
    localTargets.map(async (target) => ({
      target,
      located: await locateItem(
        params.pmRoot,
        target,
        params.idPrefix,
        params.itemFormat,
        params.typeToFolder,
      ),
    })),
  );
  const targets = resolutions
    .filter(({ located }) => located === null)
    .map(({ target }) => target)
    .sort((left, right) => (left < right ? -1 : 1));
  if (targets.length === 0) {
    return [];
  }
  if (params.allowUnresolved === true) {
    return targets.map((target) => `dependency_target_unresolved:${target}`);
  }
  throw new PmCliError(
    `Dependency target${targets.length === 1 ? "" : "s"} not found: ${targets.join(", ")}`,
    EXIT_CODE.NOT_FOUND,
    {
      code: "dependency_target_not_found",
      reason: "unresolved_local_dependency",
      required:
        "Every local dependency target must exist before the edge is committed.",
      why: "Fail-fast target resolution prevents dangling graph nodes and preserves reliable traversal semantics.",
      unresolved_targets: targets,
      examples: [
        "--dep id=<existing-item-id>,kind=related",
        "--dep id=<external-id>,kind=related,source_kind=external",
        "--allow-unresolved-deps --dep id=<future-item-id>,kind=related",
      ],
      nextSteps: [
        `Create or correct ${targets.length === 1 ? "the target" : "the targets"}, then retry the mutation.`,
        "Use source_kind=external for a cross-workspace reference.",
        "Use --allow-unresolved-deps only when the dangling local edge is intentional.",
      ],
      recovery: {
        recovery_mode: "compact",
        missing: targets,
        suggested_flags: ["--allow-unresolved-deps"],
        suggested_retry: `pm search "${targets[0]}" --limit 10`,
      },
    },
  );
}
