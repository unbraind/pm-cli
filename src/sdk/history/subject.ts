/**
 * @module sdk/history/subject
 *
 * Resolves live and deleted item identities consistently for history reads,
 * maintenance transforms, and restoration without importing a mutation command.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { normalizeItemId, normalizeRawItemId } from "../../core/item/id.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { locateItem } from "../../core/store/item-store.js";
import { getHistoryPath } from "../../core/store/paths.js";
import type { PmSettings } from "../../types/index.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { assertInitializedTracker } from "../environment/tracker-preflight.js";

/** Resolve initialized workspace policy once for single-stream and bulk maintenance. */
export async function resolveHistoryWorkspace(pmPath: string | undefined) {
  const pmRoot = resolvePmRoot(process.cwd(), pmPath);
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  return { pmRoot, settings, typeRegistry };
}

/** Canonical stream address, retaining item location only when the current item exists. */
export interface HistorySubject {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Filesystem path used for history resolution. */
  historyPath: string;
  /** Current item location, or null when only a deleted item's history remains. */
  located: Awaited<ReturnType<typeof locateItem>>;
}

/** Resolve a current item first, then retained streams under normalized and raw legacy IDs. */
export async function resolveHistorySubject(
  pmRoot: string,
  id: string,
  settings: PmSettings,
  typeToFolder: Record<string, string>,
): Promise<HistorySubject> {
  // Validate before locateItem probes paths as well as before retained-stream reads.
  getHistoryPath(pmRoot, normalizeRawItemId(id));
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeToFolder,
  );
  if (located) {
    return {
      id: located.id,
      historyPath: getHistoryPath(pmRoot, located.id),
      located,
    };
  }

  const normalizedId = normalizeItemId(id, settings.id_prefix);
  const rawNormalizedId = normalizeRawItemId(id);
  const candidateIds =
    normalizedId === rawNormalizedId
      ? [normalizedId]
      : [normalizedId, rawNormalizedId];
  for (const candidateId of candidateIds) {
    const historyPath = getHistoryPath(pmRoot, candidateId);
    if (await pathExists(historyPath)) {
      return {
        id: candidateId,
        historyPath,
        located: null,
      };
    }
  }
  throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
}
