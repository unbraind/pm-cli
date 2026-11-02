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
import { normalizeItemId } from "../../core/item/id.js";
import { renderPmCommand } from "../../core/shared/command-line.js";
import { normalizeStatusForRegistry } from "../../core/item/status.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import type { RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { GovernanceStartBlockerEnforcement, ItemMetadata, PmSettings } from "../../types/index.js";
import { resolveDeclaredBlockers } from "../query/declared-blockers.js";
import { resolveStartTaskInProgressStatus } from "../start-task-status.js";
import { normalizeItemReference } from "../dependency-provenance.js";

/** Enforcement applied when `governance.start_blocker_enforcement` is unset. */
export const START_BLOCKER_ENFORCEMENT_DEFAULT: GovernanceStartBlockerEnforcement = "strict";

/** Typed refusal for starting an item whose declared blocker is still open. */
export const START_BLOCKED_REFUSAL_CODE = "start_blocked_by_open_dependency";

/**
 * Whether a status change moves an item into the effective start status from
 * another status. The effective status is the one start-task writes, including
 * its registered fallback when the workflow names `open` or a removed status.
 */
export function isStartTransition(fromStatus: string | undefined, toStatus: string | undefined, registry: RuntimeStatusRegistry): boolean {
  if (toStatus === undefined) return false;
  const inProgress = normalizeStatusForRegistry(resolveStartTaskInProgressStatus(registry), registry);
  return normalizeStatusForRegistry(toStatus, registry) === inProgress
    && normalizeStatusForRegistry(fromStatus ?? "", registry) !== inProgress;
}

/** Compare blocker references canonically: a short scalar `a` names the same item as `pm-a`. */
function sameBlocker(reference: string, blockerId: string, idPrefix: string): boolean {
  const canonical = (value: string) => normalizeItemId(value.trim(), idPrefix).toLowerCase();
  return canonical(reference) === canonical(blockerId);
}

/**
 * The exact command that drops one declared blocker, or an inspection step when
 * no single command can. `--unset blocked_by` clears every literal blocked_by
 * edge, so it is advertised only when every such edge is textually the scalar
 * itself: prefix canonicalization cannot prove `a` and `pm-a` are one item,
 * because a tracker may hold both.
 */
function unblockCommand(metadata: ItemMetadata, blockerId: string, idPrefix: string): string {
  const edges = (metadata.dependencies ?? []).filter((dependency) => dependency.kind === "blocked_by");
  const scalar = typeof metadata.blocked_by === "string" && sameBlocker(metadata.blocked_by, blockerId, idPrefix);
  if (!scalar) {
    // --dep-remove normalizes its selector id (normalizeItemReference) and compares kinds literally, so a
    // row is removable by command only when it is a literal blocked_by row whose stored id survives that
    // normalization unchanged; legacy short ids and alias kinds get an inspection step instead.
    const [removable] = edges.filter((dependency) => dependency.id === normalizeItemReference(dependency.id, idPrefix, undefined) && sameBlocker(dependency.id, blockerId, idPrefix));
    return removable === undefined
      ? renderPmCommand(["get", metadata.id, "--fields", "blocked_by,dependencies"])
      : renderPmCommand(["update", metadata.id, "--dep-remove", `id=${removable.id},kind=blocked_by`]);
  }
  const literal = (value: string) => value.trim().toLowerCase();
  return edges.every((dependency) => literal(dependency.id) === literal(String(metadata.blocked_by)))
    ? renderPmCommand(["update", metadata.id, "--unset", "blocked_by"])
    : renderPmCommand(["get", metadata.id, "--fields", "blocked_by,dependencies"]);
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
    `Cannot start ${id}: ${open.length === 1 ? "its blocker" : `${open.length} of its blockers`} ${ids} ${open.length === 1 ? "is" : "are"} still open.`,
    EXIT_CODE.CONFLICT,
    {
      code: START_BLOCKED_REFUSAL_CODE,
      item_id: id,
      required: `Finish or close the open blocker${open.length === 1 ? "" : "s"} first, remove the blocked_by edge if it no longer applies, or start anyway with --force.`,
      why: "Starting work that a declared blocker still gates would leave an in-progress item that validate reports as non_blocked_status_has_blocked_by. governance.start_blocker_enforcement (strict by default) governs this check.",
      nextSteps: [
        // Stored blocker references are unvalidated text: quote them so a pasted step cannot run shell syntax.
        ...open.filter((blocker) => blocker.external !== true).slice(0, 3).map((blocker) => renderPmCommand(["get", blocker.id])),
        unblockCommand(params.metadata, open[0]!.id, params.settings.id_prefix),
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
  if (params.requested === false || !isStartTransition(params.fromStatus, params.metadata.status, params.registry)) return [];
  // Always re-judged under this write's own lock: a blocker opened after an explicit start's claim still refuses.
  const warnings = await admitStartWithOpenBlockers(params);
  // Drop only the exact warnings the explicit start's claim already recorded; a newly found blocker still warns.
  const recorded = explicitStarts.getStore()?.warnings ?? new Set<string>();
  return warnings.filter((warning) => !recorded.has(warning));
}

/** Pending explicit `claim <id> --start` composition: the warnings its claim already recorded under the item lock. */
const explicitStarts = new AsyncLocalStorage<{ warnings: Set<string> }>();

/**
 * Run an explicit claim-then-update start composition. Its claim judges the
 * start under the claim's own item lock, before writing ownership; the status
 * update judges again under its own lock, so a blocker opened in between still
 * refuses (the composition then releases the claim it took).
 */
export function runAsExplicitStart<T>(operation: () => Promise<T>): Promise<T> {
  return explicitStarts.run({ warnings: new Set() }, operation);
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
  const warnings = isStartTransition(params.metadata.status, resolveStartTaskInProgressStatus(params.registry), params.registry)
    ? await admitStartWithOpenBlockers(params)
    : [];
  for (const warning of warnings) pending.warnings.add(warning);
  return warnings;
}
