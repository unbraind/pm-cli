/**
 * @module sdk/semantic-session-attribution
 *
 * Maintains bounded claimed/focused lineage evidence used by automatic
 * mutation provenance without scanning history or retaining prompt content.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import {
  type AgentSemanticAttribution,
  recordClaimedWorkAttribution,
  recordFocusedWorkAttribution,
  releaseClaimedWorkAttribution,
} from "../../core/session/session-state.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { readSettings } from "../../core/store/settings.js";

const MAX_SEMANTIC_LINEAGE_DEPTH = 16;

/** Resolve an item's canonical parent lineage under a strict depth bound. */
export async function resolveSemanticLineageIds(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  itemId: string,
): Promise<string[]> {
  const typeToFolder = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  ).type_to_folder;
  const lineage: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = itemId;
  while (cursor && lineage.length < MAX_SEMANTIC_LINEAGE_DEPTH) {
    const normalized = cursor.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) break;
    seen.add(normalized);
    const located = await locateItem(
      pmRoot,
      cursor,
      settings.id_prefix,
      settings.item_format,
      typeToFolder,
    );
    if (!located) break;
    const loaded = await readLocatedItem(located, { schema: settings.schema });
    lineage.push(loaded.document.metadata.id);
    cursor = loaded.document.metadata.parent;
  }
  return lineage;
}

/** Record one successful claim and its bounded canonical lineage. */
export async function recordClaimSemanticAttribution(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  principal: string;
  itemId: string;
}): Promise<void> {
  await recordClaimedWorkAttribution({
    pmRoot: params.pmRoot,
    principal: params.principal,
    itemId: params.itemId,
    lineageIds: await resolveSemanticLineageIds(
      params.pmRoot,
      params.settings,
      params.itemId,
    ),
  });
}

/** Remove one released claim from the active semantic workset. */
export async function recordReleaseSemanticAttribution(params: {
  pmRoot: string;
  principal: string;
  itemId: string;
}): Promise<void> {
  await releaseClaimedWorkAttribution(params);
}

/** Set or clear focused semantic work with canonical lineage evidence. */
export async function recordFocusSemanticAttribution(params: {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  principal: string;
  itemId?: string;
}): Promise<void> {
  await recordFocusedWorkAttribution({
    pmRoot: params.pmRoot,
    principal: params.principal,
    ...(params.itemId
      ? {
          itemId: params.itemId,
          lineageIds: await resolveSemanticLineageIds(
            params.pmRoot,
            params.settings,
            params.itemId,
          ),
        }
      : {}),
  });
}

/** Public constants used by scale and negative-control tests. */
export const SEMANTIC_ATTRIBUTION_LIMITS = {
  lineage_depth: MAX_SEMANTIC_LINEAGE_DEPTH,
  active_items: 64,
  evidence_rows: 32,
} as const;

/** Convert bounded claim/focus evidence into normalized context affinity. */
export function semanticAttributionAffinity(
  attribution: AgentSemanticAttribution | undefined,
): Readonly<Record<string, number>> | undefined {
  if (!attribution) return undefined;
  const affinity: Record<string, number> = {};
  for (const itemId of attribution.active_item_ids) affinity[itemId] = 1;
  if (attribution.focused_item_id) affinity[attribution.focused_item_id] = 1;
  for (const evidence of attribution.evidence) {
    const lineage = /^lineage:(.+)$/u.exec(evidence)?.[1];
    if (lineage && affinity[lineage] === undefined) affinity[lineage] = 0.75;
  }
  return Object.keys(affinity).length > 0 ? affinity : undefined;
}
