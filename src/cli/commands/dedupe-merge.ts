/**
 * @module cli/commands/dedupe-merge
 *
 * Implements the guided dedupe-merge consolidation workflow (GH-163). Where
 * `pm dedupe-audit` only *detects* likely-duplicate clusters and emits suggested
 * close commands, this module *performs* the merge: it re-parents a duplicate's
 * still-active children onto the canonical item and then closes each duplicate
 * with structured `duplicate_of` metadata. The operation previews by default
 * (dry-run) and only mutates under `--apply`, and it never aborts the whole
 * batch on a single per-item failure — failures are recorded as warnings so an
 * agent can act on a partial result.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { splitCommaList } from "../../core/shared/split-comma-list.js";
import { nowIso } from "../../core/shared/time.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemMetadata } from "../../types/index.js";
import { runClose } from "./close.js";
import { runList } from "./list.js";
import { runUpdate } from "./update.js";

/**
 * Documents the dedupe-merge options payload exchanged by command, SDK, and package integrations.
 */
export interface DedupeMergeOptions {
  /** Canonical item id to keep (children move here, duplicates close against it). */
  keep?: string;
  /** Duplicate item id(s) to consolidate into the canonical item (csv-friendly, repeatable). */
  close?: string | string[];
  /** Apply the merge mutations; omitted/false performs a non-mutating preview. */
  apply?: boolean;
  /** Force a preview even if `apply` is also set (explicit dry-run wins). */
  dryRun?: boolean;
  /** Re-parent each duplicate's still-active children onto the canonical (default true). */
  reparentChildren?: boolean;
  /** Author recorded on every mutation. */
  author?: string;
  /** History message recorded on every mutation. */
  message?: string;
}

/**
 * Documents a single child re-parent action exchanged by command, SDK, and package integrations.
 */
export interface DedupeMergeChildReparent {
  child_id: string;
  child_title: string;
  from_parent: string;
  to_parent: string;
  applied: boolean;
}

/**
 * Documents the close action planned/performed for a duplicate item.
 */
export interface DedupeMergeCloseAction {
  duplicate_of: string;
  reason: string;
  applied: boolean;
  /** When the close was not applied, the reason it was skipped. */
  skipped_reason?: "already_terminal" | "dry_run" | "failed";
}

/**
 * Documents the per-duplicate merge outcome exchanged by command, SDK, and package integrations.
 */
export interface DedupeMergeDuplicateOutcome {
  duplicate_id: string;
  duplicate_title: string;
  canonical_id: string;
  reparented_children: DedupeMergeChildReparent[];
  skipped_children: { child_id: string; child_title: string; reason: "terminal" }[];
  close: DedupeMergeCloseAction;
}

/**
 * Documents the dedupe-merge result payload exchanged by command, SDK, and package integrations.
 */
export interface DedupeMergeResult {
  canonical_id: string;
  canonical_title: string;
  mode: "dry_run" | "apply";
  duplicates: DedupeMergeDuplicateOutcome[];
  totals: {
    duplicates: number;
    children_reparented: number;
    children_skipped: number;
    closed: number;
  };
  warnings: string[];
  now: string;
}

interface ResolvedItem {
  id: string;
  title: string;
  metadata: ItemMetadata;
}

/**
 * Parses a single required item id, rejecting blank input with usage guidance.
 */
function parseRequiredId(raw: string | undefined, flag: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    throw new PmCliError(`pm dedupe-merge requires ${flag} <id>`, EXIT_CODE.USAGE, {
      code: "missing_required_option",
      examples: ['pm dedupe-merge --keep pm-canonical --close pm-dup1 --apply'],
    });
  }
  return trimmed;
}

/**
 * Parses the duplicate id list, splitting csv values and de-duplicating while
 * preserving first-seen order so the result is deterministic.
 */
function parseDuplicateIds(raw: string | string[] | undefined, keep: string): string[] {
  const collected = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of collected) {
    for (const id of splitCommaList(entry, { unique: false })) {
      const trimmed = id.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      ids.push(trimmed);
    }
  }
  if (ids.length === 0) {
    throw new PmCliError("pm dedupe-merge requires at least one --close <id> duplicate", EXIT_CODE.USAGE, {
      code: "missing_required_option",
      examples: ['pm dedupe-merge --keep pm-canonical --close pm-dup1,pm-dup2 --apply'],
    });
  }
  if (seen.has(keep)) {
    throw new PmCliError(`Cannot close the canonical item ${keep} as a duplicate of itself`, EXIT_CODE.USAGE, {
      code: "invalid_option_combination",
      nextSteps: ["Pass distinct ids: --keep <canonical> and --close <duplicate>."],
    });
  }
  return ids;
}

async function loadItem(
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  id: string,
): Promise<ResolvedItem | null> {
  const typeToFolder = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).type_to_folder;
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeToFolder);
  if (!located) {
    return null;
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  return { id: located.id, title: loaded.document.metadata.title, metadata: loaded.document.metadata };
}

function buildChildrenByParentForDedupeMerge(
  items: Awaited<ReturnType<typeof runList>>["items"],
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>,
): Map<string, { id: string; title: string; terminal: boolean }[]> {
  const childrenByParent = new Map<string, { id: string; title: string; terminal: boolean }[]>();
  for (const item of items) {
    const parent = item.parent?.trim();
    if (!parent) {
      continue;
    }
    const bucket = childrenByParent.get(parent) ?? [];
    bucket.push({ id: item.id, title: item.title, terminal: isTerminalStatus(item.status, statusRegistry) });
    childrenByParent.set(parent, bucket);
  }
  return childrenByParent;
}

async function applyDedupeMergeReparents(params: {
  children: { id: string; title: string; terminal: boolean }[];
  duplicateId: string;
  keep: string;
  apply: boolean;
  options: DedupeMergeOptions;
  global: GlobalOptions;
  warnings: string[];
}): Promise<{
  reparented: DedupeMergeChildReparent[];
  skippedChildren: { child_id: string; child_title: string; reason: "terminal" }[];
}> {
  const reparentEnabled = params.options.reparentChildren !== false;
  const reparentTargets = reparentEnabled ? params.children.filter((child) => !child.terminal) : [];
  const skippedChildren = (reparentEnabled ? params.children.filter((child) => child.terminal) : []).map((child) => ({
    child_id: child.id,
    child_title: child.title,
    reason: "terminal" as const,
  }));
  const reparented: DedupeMergeChildReparent[] = [];
  for (const child of reparentTargets) {
    const record: DedupeMergeChildReparent = {
      child_id: child.id,
      child_title: child.title,
      from_parent: params.duplicateId,
      to_parent: params.keep,
      applied: false,
    };
    if (params.apply) {
      try {
        await runUpdate(
          child.id,
          {
            parent: params.keep,
            author: params.options.author,
            message: params.options.message ?? `dedupe-merge: re-parent from ${params.duplicateId} to ${params.keep}`,
          },
          params.global,
        );
        record.applied = true;
      } catch (error) {
        params.warnings.push(`reparent_failed:${child.id}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    reparented.push(record);
  }
  return { reparented, skippedChildren };
}

async function applyDedupeMergeClose(params: {
  duplicate: ResolvedItem;
  keep: string;
  apply: boolean;
  options: DedupeMergeOptions;
  global: GlobalOptions;
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>;
  warnings: string[];
}): Promise<DedupeMergeCloseAction> {
  const reason = `Duplicate of ${params.keep}`;
  const close: DedupeMergeCloseAction = { duplicate_of: params.keep, reason, applied: false };
  if (isTerminalStatus(params.duplicate.metadata.status, params.statusRegistry)) {
    close.skipped_reason = "already_terminal";
    if (params.duplicate.metadata.duplicate_of?.trim() !== params.keep) {
      params.warnings.push(`close_skipped_terminal:${params.duplicate.id}:already_closed`);
    }
    return close;
  }
  if (!params.apply) {
    close.skipped_reason = "dry_run";
    return close;
  }
  try {
    await runClose(
      params.duplicate.id,
      undefined,
      {
        duplicateOf: params.keep,
        author: params.options.author,
        message: params.options.message ?? `dedupe-merge: close ${params.duplicate.id} as duplicate of ${params.keep}`,
      },
      params.global,
    );
    close.applied = true;
  } catch (error) {
    close.skipped_reason = "failed";
    params.warnings.push(`close_failed:${params.duplicate.id}:${error instanceof Error ? error.message : String(error)}`);
  }
  return close;
}

/**
 * Implements run dedupe merge for the public runtime surface of this module.
 */
export async function runDedupeMerge(options: DedupeMergeOptions, global: GlobalOptions): Promise<DedupeMergeResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const keep = parseRequiredId(options.keep, "--keep");
  const duplicateIds = parseDuplicateIds(options.close, keep);
  // Explicit dry-run always wins over apply so a preview can be forced safely.
  const apply = options.apply === true && options.dryRun !== true;

  const canonical = await loadItem(pmRoot, settings, keep);
  if (!canonical) {
    throw new PmCliError(`Canonical item ${keep} not found`, EXIT_CODE.NOT_FOUND, {
      code: "item_not_found",
      nextSteps: [`Verify the canonical id with: pm get ${keep}`],
    });
  }

  // A single full listing supplies every child lookup without re-reading the
  // corpus per duplicate.
  const corpus = await runList(undefined, {}, global);
  const childrenByParent = buildChildrenByParentForDedupeMerge(corpus.items, statusRegistry);

  const warnings: string[] = [];
  const outcomes: DedupeMergeDuplicateOutcome[] = [];
  for (const duplicateId of duplicateIds) {
    const duplicate = await loadItem(pmRoot, settings, duplicateId);
    if (!duplicate) {
      throw new PmCliError(`Duplicate item ${duplicateId} not found`, EXIT_CODE.NOT_FOUND, {
        code: "item_not_found",
        nextSteps: [`Verify the duplicate id with: pm get ${duplicateId}`],
      });
    }
    if (duplicate.id === canonical.id) {
      throw new PmCliError(`Cannot close the canonical item ${canonical.id} as a duplicate of itself`, EXIT_CODE.USAGE, {
        code: "invalid_option_combination",
        nextSteps: ["Pass distinct ids: --keep <canonical> and --close <duplicate>."],
      });
    }
    // The canonical can never be re-parented onto itself; terminal children are
    // historical and keep their frozen parent link, so only active children move.
    const children = (childrenByParent.get(duplicate.id) ?? []).filter((child) => child.id !== keep);
    const { reparented, skippedChildren } = await applyDedupeMergeReparents({
      children,
      duplicateId: duplicate.id,
      keep,
      apply,
      options,
      global,
      warnings,
    });
    const close = await applyDedupeMergeClose({ duplicate, keep, apply, options, global, statusRegistry, warnings });

    outcomes.push({
      duplicate_id: duplicate.id,
      duplicate_title: duplicate.title,
      canonical_id: keep,
      reparented_children: reparented,
      skipped_children: skippedChildren,
      close,
    });
  }

  const childrenReparented = outcomes.reduce(
    (total, outcome) => total + outcome.reparented_children.filter((child) => child.applied).length,
    0,
  );
  const childrenSkipped = outcomes.reduce((total, outcome) => total + outcome.skipped_children.length, 0);
  const closed = outcomes.reduce((total, outcome) => total + (outcome.close.applied ? 1 : 0), 0);

  return {
    canonical_id: canonical.id,
    canonical_title: canonical.title,
    mode: apply ? "apply" : "dry_run",
    duplicates: outcomes,
    totals: {
      duplicates: outcomes.length,
      children_reparented: childrenReparented,
      children_skipped: childrenSkipped,
      closed,
    },
    warnings,
    now: nowIso(),
  };
}

export const _testOnly = {
  parseRequiredId,
  parseDuplicateIds,
};
