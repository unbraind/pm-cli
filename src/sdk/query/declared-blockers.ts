/**
 * @module sdk/query/declared-blockers
 *
 * One definition of an item's forward-declared blockers (scalar `blocked_by`
 * plus `blocked_by` edges), resolved against their current targets. Shared by
 * the `pm get` blockers facet and the start-work admission check (pm-urzubi),
 * so the two can never disagree about which blockers are still open.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  isExternalDependencyReference,
  isExternalDependencySourceKind,
} from "../../core/item/dependency-reference.js";
import { collectBlockedByIds, resolveItemBlockers, type ResolvedBlocker } from "../actionability.js";
import { createPmCliExpectedError } from "../errors.js";
import {
  EXIT_CODE,
  PmCliError,
  locateItem,
  readLocatedItem,
  readSettings,
  resolveRuntimeStatusRegistry,
} from "../runtime-primitives.js";
import type { ItemMetadata } from "../../types/index.js";

/** Collapse local short/full aliases onto verified physical identities while preserving exact external locator identity and unresolved references. */
function canonicalizeDeclaredBlockers(
  blockers: readonly ResolvedBlocker[],
  targets: ReadonlyMap<string, ItemMetadata>,
): ResolvedBlocker[] {
  const canonical = new Map<string, ResolvedBlocker>();
  for (const blocker of blockers) {
    const id = blocker.external ? blocker.id : (targets.get(blocker.id.toLowerCase())?.id ?? blocker.id);
    canonical.set(blocker.external ? `external:${id}` : `local:${id.toLowerCase()}`, { ...blocker, id });
  }
  return [...canonical.values()];
}

/** Verify physical leaf spelling even when probe and embedded IDs match; retain exact-leaf precedence, stable ties and typed directory failures with their original cause. */
async function resolvePhysicalBlockerId(itemPath: string, probedId: string): Promise<string> {
  const filename = path.basename(itemPath);
  const physicalIds = (await readdir(path.dirname(itemPath)).catch((error: unknown) => {
    throw createPmCliExpectedError("Cannot verify the blocker's physical file identity", {
      exitCode: EXIT_CODE.GENERIC_FAILURE,
      context: { code: "blocker_identity_read_failed", required: "Restore access to the blocker item directory, then retry the item read." },
      cause: error,
    });
  }))
    .filter((name) => name.toLowerCase() === filename.toLowerCase())
    .sort((left, right) => Number(right === filename) - Number(left === filename) || left.localeCompare(right))
    .map((name) => path.parse(name).name);
  const physicalId = physicalIds[0];
  if (physicalId === undefined) {
    throw new PmCliError(`Blocker canonical file disappeared during identity verification: ${probedId}`, EXIT_CODE.CONFLICT, {
      code: "item_identity_conflict",
      required: "Restore the canonical blocker file and validate storage integrity before retrying the item read.",
    });
  }
  return physicalId;
}

/**
 * Resolve the blockers an item declares against their current targets.
 * Terminal targets resolve; missing, unsafe and external references stay
 * unresolved, because nothing local can prove they no longer gate the work.
 */
export async function resolveDeclaredBlockers(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
  metadata: ItemMetadata;
}): Promise<ResolvedBlocker[]> {
  const ids = collectBlockedByIds(params.metadata);
  if (ids.length === 0) return [];
  // Comparison keys deduplicate references; filesystem probes retain source spelling.
  const declaredIds = new Map<string, string>(
    [
      params.metadata.blocked_by,
      ...(params.metadata.dependencies ?? [])
        .filter((dependency) => dependency.kind === "blocked_by")
        .map((dependency) => dependency.id),
    ]
      .filter((id): id is string => typeof id === "string")
      .map((id) => [id.trim().toLowerCase(), id.trim()]),
  );
  const targets = new Map<string, ItemMetadata>();
  for (const id of ids) {
    if (
      isExternalDependencyReference(id) ||
      !/^(?!\.{1,2}$)[^/\\:\0]+$/u.test(id) ||
      params.metadata.dependencies?.some((dependency) =>
        dependency.id.trim() === id &&
        dependency.kind === "blocked_by" &&
        isExternalDependencySourceKind(dependency.source_kind),
      )
    ) continue;
    const located = await locateItem(
      params.pmRoot,
      declaredIds.get(id)!,
      params.settings.id_prefix,
      params.settings.item_format,
      params.typeToFolder,
    );
    if (located === null) continue;
    const loaded = await readLocatedItem(located, { schema: params.settings.schema });
    located.id = await resolvePhysicalBlockerId(located.itemPath, located.id);
    if (loaded.document.metadata.id !== located.id) {
      throw new PmCliError(`Blocker identity differs from its canonical file: ${located.id}`, EXIT_CODE.CONFLICT, {
        code: "item_identity_conflict",
        required: "Restore the canonical blocker identity and validate storage integrity before retrying the item read.",
      });
    }
    targets.set(id.toLowerCase(), loaded.document.metadata);
  }
  return canonicalizeDeclaredBlockers(resolveItemBlockers(
    {
      blocked_by: params.metadata.blocked_by,
      dependencies: params.metadata.dependencies,
      updated_at: params.metadata.updated_at,
    },
    targets,
    resolveRuntimeStatusRegistry(params.settings.schema),
  ), targets);
}
