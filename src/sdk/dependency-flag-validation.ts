/** @module cli/commands/dependency-flag-validation */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { toErrorMessage } from "../core/shared/primitives.js";
import type {
  Dependency,
  ItemFormat,
  RuntimeSchemaSettings,
} from "../types/index.js";
import {
  locateItem,
  readLocatedItem,
  type LocatedItem,
} from "../core/store/item-store.js";
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

interface DependencyResolutionContext {
  pmRoot: string;
  idPrefix: string;
  itemFormat: ItemFormat;
  typeToFolder: Record<string, string>;
  schema?: RuntimeSchemaSettings;
}

async function readDependencyEndpointCreatedAt(
  located: LocatedItem,
  schema: RuntimeSchemaSettings | undefined,
): Promise<string | undefined> {
  return (await readLocatedItem(located, { schema })).document.metadata
    .created_at;
}

async function resolveDependencyHolderCreatedAt(
  holder: { id: string; createdAt?: string },
  context: DependencyResolutionContext,
): Promise<string | undefined> {
  if (holder.createdAt !== undefined) return holder.createdAt;
  const located = await locateItem(
    context.pmRoot,
    holder.id,
    context.idPrefix,
    context.itemFormat,
    context.typeToFolder,
  );
  return located === null
    ? undefined
    : readDependencyEndpointCreatedAt(located, context.schema);
}

function dependencyTemporalOrderError(params: {
  holder: { id: string; createdAt?: string };
  dependency: Dependency;
  sourceCreatedAt: string | undefined;
  targetCreatedAt: string | undefined;
  registry: RelationshipKindRegistry;
}): PmCliError {
  const definition = params.registry.require(params.dependency.kind);
  return new PmCliError(
    `${definition.kind} requires source ${params.holder.id} to be created after target ${params.dependency.id}`,
    EXIT_CODE.USAGE,
    {
      code: "dependency_temporal_order_invalid",
      reason: "source_not_after_target",
      required: `${params.holder.id}.created_at must be later than ${params.dependency.id}.created_at for ${definition.kind}.`,
      why: "Chronological recurrence direction must be validated before the relationship is persisted.",
      source_id: params.holder.id,
      source_created_at: params.sourceCreatedAt,
      target_id: params.dependency.id,
      target_created_at: params.targetCreatedAt,
      temporal_order: definition.temporalOrder,
    },
  );
}

async function assertTemporalDependencyChronology(params: {
  dependencies: readonly Dependency[];
  missingTargets: readonly string[];
  resolutions: readonly { target: string; located: LocatedItem | null }[];
  holders: readonly { id: string; createdAt?: string }[];
  registry: RelationshipKindRegistry;
  context: DependencyResolutionContext;
}): Promise<void> {
  const temporalDependencies = params.dependencies.filter(
    (dependency) =>
      params.registry.resolve(dependency.kind)?.temporalOrder ===
        "source_after_target" &&
      !params.missingTargets.includes(dependency.id),
  );
  if (temporalDependencies.length === 0 || params.holders.length === 0) return;
  const locatedTargets = new Map(
    params.resolutions.flatMap(({ target, located }) =>
      located === null ? [] : ([[target, located]] as const),
    ),
  );
  const targetCreatedAt = new Map(
    await Promise.all(
      [...new Set(temporalDependencies.map(({ id }) => id))].map(
        async (target) => [
          target,
          await readDependencyEndpointCreatedAt(
            locatedTargets.get(target)!,
            params.context.schema,
          ),
        ] as const,
      ),
    ),
  );
  for (const holder of params.holders) {
    const sourceCreatedAt = await resolveDependencyHolderCreatedAt(
      holder,
      params.context,
    );
    if (sourceCreatedAt === undefined) continue;
    for (const dependency of temporalDependencies) {
      const targetTimestamp = targetCreatedAt.get(dependency.id)!;
      const sourceTime = Date.parse(sourceCreatedAt);
      const targetTime = Date.parse(targetTimestamp);
      if (
        Number.isFinite(sourceTime) &&
        Number.isFinite(targetTime) &&
        sourceTime > targetTime
      ) {
        continue;
      }
      throw dependencyTemporalOrderError({
        holder,
        dependency,
        sourceCreatedAt,
        targetCreatedAt: targetTimestamp,
        registry: params.registry,
      });
    }
  }
}

/**
 * Resolve every newly supplied local dependency and enforce declared endpoint
 * chronology before a mutation commits.
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
  holders?: readonly { id: string; createdAt?: string }[];
  schema?: RuntimeSchemaSettings;
  registry?: RelationshipKindRegistry;
}): Promise<string[]> {
  const registry =
    params.registry ?? resolveWorkspaceRelationshipKindRegistry();
  const localDependencies = (params.dependencies ?? []).filter(
    (dependency) =>
      !isExternalDependencySourceKind(dependency.source_kind),
  );
  const localTargets = [
    ...new Set(
      localDependencies.map((dependency) => dependency.id),
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
  const missingTargets = resolutions
    .filter(({ located }) => located === null)
    .map(({ target }) => target)
    .sort((left, right) => (left < right ? -1 : 1));
  if (missingTargets.length > 0 && params.allowUnresolved !== true) {
    throw new PmCliError(
      `Dependency target${missingTargets.length === 1 ? "" : "s"} not found: ${missingTargets.join(", ")}`,
      EXIT_CODE.NOT_FOUND,
      {
        code: "dependency_target_not_found",
        reason: "unresolved_local_dependency",
        required:
          "Every local dependency target must exist before the edge is committed.",
        why: "Fail-fast target resolution prevents dangling graph nodes and preserves reliable traversal semantics.",
        unresolved_targets: missingTargets,
        examples: [
          "--dep id=<existing-item-id>,kind=related",
          "--dep id=<external-id>,kind=related,source_kind=external",
          "--allow-unresolved-deps --dep id=<future-item-id>,kind=related",
        ],
        nextSteps: [
          `Create or correct ${missingTargets.length === 1 ? "the target" : "the targets"}, then retry the mutation.`,
          "Use source_kind=external for a cross-workspace reference.",
          "Use --allow-unresolved-deps only when the dangling local edge is intentional.",
        ],
        recovery: {
          recovery_mode: "compact",
          missing: missingTargets,
          suggested_flags: ["--allow-unresolved-deps"],
          suggested_retry: `pm search "${missingTargets[0]}" --limit 10`,
        },
      },
    );
  }
  await assertTemporalDependencyChronology({
    dependencies: localDependencies,
    missingTargets,
    resolutions,
    holders: params.holders ?? [],
    registry,
    context: params,
  });
  return missingTargets.map(
    (target) => `dependency_target_unresolved:${target}`,
  );
}
