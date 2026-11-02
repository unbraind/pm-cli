/**
 * @module sdk/lifecycle/start-blockers
 *
 * Start-work admission (pm-urzubi). Moving an item into the configured
 * in-progress status while one of its declared blockers is still open is
 * governed by `governance.start_blocker_enforcement`: `strict` (default)
 * refuses unless `--force`, `warn` admits with a warning, and `off` admits
 * silently. `update --status`, `claim --start`, `claim --next --start` and the
 * SDK/MCP `start-task` action share this one check, and each runs it before
 * the write that would start the item.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { normalizeStatusForRegistry } from "../../core/item/status.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import type { RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { GovernanceStartBlockerEnforcement, ItemMetadata, PmSettings } from "../../types/index.js";
import { resolveDeclaredBlockers } from "../query/declared-blockers.js";

/** Enforcement applied when `governance.start_blocker_enforcement` is unset. */
export const START_BLOCKER_ENFORCEMENT_DEFAULT: GovernanceStartBlockerEnforcement = "strict";

/** Typed refusal for starting an item whose declared blocker is still open. */
export const START_BLOCKED_REFUSAL_CODE = "start_blocked_by_open_dependency";

/** Whether a status change moves an item into the in-progress status from another status. */
export function isStartTransition(fromStatus: string | undefined, toStatus: string | undefined, registry: RuntimeStatusRegistry): boolean {
  if (toStatus === undefined) return false;
  const inProgress = normalizeStatusForRegistry(registry.in_progress_status, registry);
  return normalizeStatusForRegistry(toStatus, registry) === inProgress
    && normalizeStatusForRegistry(fromStatus ?? "", registry) !== inProgress;
}

/** The exact command that drops one declared blocker from every place the item declares it. */
function unblockCommand(metadata: ItemMetadata, blockerId: string): string {
  const key = blockerId.toLowerCase();
  const scalar = typeof metadata.blocked_by === "string" && metadata.blocked_by.trim().toLowerCase() === key;
  const edge = (metadata.dependencies ?? []).some((dependency) => dependency.kind === "blocked_by" && dependency.id.trim().toLowerCase() === key);
  return [
    `pm update ${metadata.id}`,
    ...(scalar ? ["--unset blocked_by"] : []),
    ...(edge || !scalar ? [`--dep-remove "id=${blockerId},kind=blocked_by"`] : []),
  ].join(" ");
}

/**
 * Admit or refuse starting `metadata` against its currently open declared
 * blockers. Returns warnings for admitted starts; throws the typed refusal
 * under `strict` enforcement without `force`.
 */
export async function admitStartWithOpenBlockers(params: {
  pmRoot: string;
  settings: PmSettings;
  metadata: ItemMetadata;
  force?: boolean;
}): Promise<string[]> {
  const enforcement = params.settings.governance.start_blocker_enforcement ?? START_BLOCKER_ENFORCEMENT_DEFAULT;
  if (enforcement === "off") return [];
  const typeToFolder = resolveItemTypeRegistry(params.settings, getActiveExtensionRegistrations()).type_to_folder;
  const open = (await resolveDeclaredBlockers({ pmRoot: params.pmRoot, settings: params.settings, typeToFolder, metadata: params.metadata }))
    .filter((blocker) => !blocker.resolved);
  if (open.length === 0) return [];
  const id = params.metadata.id;
  const ids = open.map((blocker) => blocker.id).join(",");
  if (enforcement === "warn") return [`start_with_open_blockers:${id}:${ids}`];
  if (params.force === true) return [`start_blocker_override:${id}:${ids}`];
  throw new PmCliError(
    `Cannot start ${id}: ${open.length === 1 ? "its blocker" : `${open.length} of its blockers`} ${ids} ${open.length === 1 ? "is" : "are"} still open. Nothing was written.`,
    EXIT_CODE.CONFLICT,
    {
      code: START_BLOCKED_REFUSAL_CODE,
      item_id: id,
      required: `Finish or close the open blocker${open.length === 1 ? "" : "s"} first, remove the blocked_by edge if it no longer applies, or start anyway with --force.`,
      why: "Starting work that a declared blocker still gates would leave an in-progress item that validate reports as non_blocked_status_has_blocked_by. governance.start_blocker_enforcement (strict by default) governs this check.",
      nextSteps: [
        ...open.filter((blocker) => blocker.external !== true).slice(0, 3).map((blocker) => `pm get ${blocker.id}`),
        unblockCommand(params.metadata, open[0]!.id),
        "pm next",
      ],
      details: {
        enforcement,
        open_blockers: open.map((blocker) => ({
          id: blocker.id,
          title: blocker.title,
          status: blocker.status,
          external: blocker.external === true,
        })),
      },
    },
  );
}

/**
 * Judge a status change already applied to `metadata`: a move into progress
 * from `fromStatus` goes through {@link admitStartWithOpenBlockers}; any other
 * change, or a caller that did not request a start, is admitted without a read.
 */
export async function admitStartTransition(params: {
  pmRoot: string;
  settings: PmSettings;
  metadata: ItemMetadata;
  fromStatus: string | undefined;
  registry: RuntimeStatusRegistry;
  force?: boolean;
  requested?: boolean;
}): Promise<string[]> {
  if (params.requested === false || explicitStarts.getStore()?.admitted === true) return [];
  if (!isStartTransition(params.fromStatus, params.metadata.status, params.registry)) return [];
  return admitStartWithOpenBlockers(params);
}

/** Pending explicit `claim <id> --start` composition: admitted once its claim judged the start under the item lock. */
const explicitStarts = new AsyncLocalStorage<{ admitted: boolean }>();

/**
 * Run an explicit claim-then-update start composition. Its claim judges the
 * start under the claim's own item lock, before writing ownership, and the
 * composition's status update reuses that decision, so a refused start never
 * leaves a claim behind and the two steps cannot disagree.
 */
export function runAsExplicitStart<T>(operation: () => Promise<T>): Promise<T> {
  return explicitStarts.run({ admitted: false }, operation);
}

/** Judge the start an enclosing explicit start composition will make, inside the claim's locked mutation. */
export async function admitExplicitStartClaim(params: {
  pmRoot: string;
  settings: PmSettings;
  metadata: ItemMetadata;
  registry: RuntimeStatusRegistry;
  force?: boolean;
}): Promise<string[]> {
  const pending = explicitStarts.getStore();
  if (pending === undefined) return [];
  const warnings = isStartTransition(params.metadata.status, params.registry.in_progress_status, params.registry)
    ? await admitStartWithOpenBlockers(params)
    : [];
  pending.admitted = true;
  return warnings;
}
