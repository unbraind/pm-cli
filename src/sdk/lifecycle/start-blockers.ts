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
import { isPmCliExpectedError } from "../errors.js";
import type { GovernanceStartBlockerEnforcement, ItemMetadata, PmSettings } from "../../types/index.js";
import { resolveDeclaredBlockers } from "../query/declared-blockers.js";
import { resolveStartTaskInProgressStatus } from "../start-task-status.js";
import { normalizeItemReference } from "../dependency-provenance.js";
import { resolveCanonicalRelationshipKind } from "../relationships.js";

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

/** Source kinds of the blocked_by rows a `--blocked-by` scalar write derives (create and update). */
const SCALAR_DERIVED_BLOCKED_BY_SOURCE_KINDS: ReadonlySet<string> = new Set(["cli:create:blocked_by", "cli:update:blocked_by"]);

/**
 * Whether clearing the blocked_by scalar removes this dependency row (pm-4yxzvd).
 * It removes a literal blocked_by row whose stored id is the scalar's own text,
 * or the canonical id a scalar write derived for it (`--blocked-by a` stores the
 * row `pm-a` with a blocked_by source kind). An independent prerequisite, even
 * one whose prefixed id a short scalar could name, keeps its own edge, because
 * prefix canonicalization alone cannot prove `a` and `pm-a` are one item.
 */
export function scalarClearRemovesDependency(
  dependency: { id: string; kind: string; source_kind?: string },
  scalar: unknown,
  idPrefix: string,
): boolean {
  if (dependency.kind !== "blocked_by" || typeof scalar !== "string" || scalar.trim().length === 0) return false;
  const stored = dependency.id.trim().toLowerCase();
  if (stored === scalar.trim().toLowerCase()) return true;
  return stored === normalizeItemId(scalar.trim(), idPrefix).toLowerCase()
    && SCALAR_DERIVED_BLOCKED_BY_SOURCE_KINDS.has(dependency.source_kind?.trim().toLowerCase() ?? "");
}

/**
 * The exact command that drops one declared blocker, or an inspection step when
 * no single command can. `--unset blocked_by` removes only the rows
 * {@link scalarClearRemovesDependency} accepts, so it is advertised when every
 * literal blocked_by row naming this blocker is one of them; independent
 * prerequisites keep blocking and get their own step on the next refusal.
 */
function unblockCommand(metadata: ItemMetadata, blockerId: string, idPrefix: string): string {
  const dependencies = metadata.dependencies ?? [];
  const edges = dependencies.filter((dependency) => dependency.kind === "blocked_by");
  // An alias-kind edge (depends_on) naming this blocker survives both removals below, so only inspection is honest.
  if (dependencies.some((dependency) => dependency.kind !== "blocked_by" && resolveCanonicalRelationshipKind(dependency.kind) === "blocked_by" && sameBlocker(dependency.id, blockerId, idPrefix))) {
    return renderPmCommand(["get", metadata.id, "--fields", "blocked_by,dependencies"]);
  }
  const scalar = typeof metadata.blocked_by === "string" && sameBlocker(metadata.blocked_by, blockerId, idPrefix);
  if (!scalar) {
    // --dep-remove normalizes its selector id (normalizeItemReference) and compares kinds literally, so a
    // row is removable by command only when it is a literal blocked_by row whose stored id survives that
    // normalization unchanged; legacy short ids and alias kinds get an inspection step instead.
    // One selector removes one row, so every row naming this blocker must be that single removable row.
    const matching = edges.filter((dependency) => sameBlocker(dependency.id, blockerId, idPrefix));
    return matching.length === 1 && matching.every((dependency) => dependency.id === normalizeItemReference(dependency.id, idPrefix, undefined))
      ? renderPmCommand(["update", metadata.id, "--dep-remove", `id=${matching[0]!.id},kind=blocked_by`])
      : renderPmCommand(["get", metadata.id, "--fields", "blocked_by,dependencies"]);
  }
  return edges
    .filter((dependency) => sameBlocker(dependency.id, blockerId, idPrefix))
    .every((dependency) => scalarClearRemovesDependency(dependency, metadata.blocked_by, idPrefix))
    ? renderPmCommand(["update", metadata.id, "--unset", "blocked_by"])
    : renderPmCommand(["get", metadata.id, "--fields", "blocked_by,dependencies"]);
}

/**
 * Typed integrity refusals a blocker read raises when its record cannot be
 * judged. They fail closed under `strict`, but `warn` and `--force` still admit
 * the start. Filesystem failures keep propagating with their cause.
 */
const UNVERIFIABLE_BLOCKER_CODES: ReadonlySet<string> = new Set([
  "item_document_invalid",
  "item_document_encoding_invalid",
  "item_format_version_unsupported",
  "item_identity_ambiguous",
  "item_identity_conflict",
]);

/** Open declared blockers, or, when the caller admits it, the integrity code that left them unverifiable. */
async function readOpenBlockers(
  params: Parameters<typeof resolveDeclaredBlockers>[0],
  admitUnverifiable: boolean,
): Promise<Awaited<ReturnType<typeof resolveDeclaredBlockers>> | string> {
  try {
    return (await resolveDeclaredBlockers(params)).filter((blocker) => !blocker.resolved);
  } catch (error: unknown) {
    const code = isPmCliExpectedError(error) ? error.context.code : undefined;
    if (!admitUnverifiable || typeof code !== "string" || !UNVERIFIABLE_BLOCKER_CODES.has(code)) throw error;
    return code;
  }
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
  const id = params.metadata.id;
  const open = await readOpenBlockers({ pmRoot: params.pmRoot, settings: params.settings, typeToFolder, metadata: params.metadata }, enforcement === "warn" || params.force === true);
  if (typeof open === "string") return [`start_blocker_unverifiable:${id}:${open}`];
  if (open.length === 0) return [];
  const ids = open.map((blocker) => blocker.id).join(",");
  if (enforcement === "warn") return [`start_with_open_blockers:${id}:${ids}`];
  if (params.force === true) return [`start_blocker_override:${id}:${ids}`];
  throw new PmCliError(
    `Cannot start ${id}: ${open.length === 1 ? "its blocker" : `${open.length} of its blockers`} ${ids} ${open.length === 1 ? "is" : "are"} still open.`,
    EXIT_CODE.CONFLICT,
    {
      // A string literal, so the error-code catalog generator discovers it (it equals START_BLOCKED_REFUSAL_CODE).
      code: "start_blocked_by_open_dependency",
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
