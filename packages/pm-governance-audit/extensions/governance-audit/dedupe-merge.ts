/**
 * @module packages/pm-governance-audit/dedupe-merge
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
import {
  EXIT_CODE,
  PmCliError,
  getActiveExtensionRegistrations,
  getSettingsPath,
  isTerminalStatus,
  locateItem,
  nowIso,
  pathExists,
  readLocatedItem,
  readSettings,
  resolveItemTypeRegistry,
  resolvePmRoot,
  resolveRuntimeStatusRegistry,
  runClose,
  runList,
  runUpdate,
  type GlobalOptions,
  type ItemMetadata,
} from "./sdk.ts";
import { splitCommaList } from "./runtime-utils.ts";

/** Documents the dedupe-merge options payload exchanged by command, SDK, and package integrations. */
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

/** Documents a single child re-parent action exchanged by command, SDK, and package integrations. */
export interface DedupeMergeChildReparent {
  /** Value that configures or reports child id for this contract. */
  child_id: string;
  /** Value that configures or reports child title for this contract. */
  child_title: string;
  /** Value that configures or reports from parent for this contract. */
  from_parent: string;
  /** Value that configures or reports to parent for this contract. */
  to_parent: string;
  /** Value that configures or reports applied for this contract. */
  applied: boolean;
}

/** Documents the close action planned/performed for a duplicate item. */
export interface DedupeMergeCloseAction {
  /** Value that configures or reports duplicate of for this contract. */
  duplicate_of: string;
  /** Value that configures or reports reason for this contract. */
  reason: string;
  /** Value that configures or reports applied for this contract. */
  applied: boolean;
  /** When the close was not applied, the reason it was skipped. */
  skipped_reason?: "already_terminal" | "dry_run" | "failed";
}

/** Documents the per-duplicate merge outcome exchanged by command, SDK, and package integrations. */
export interface DedupeMergeDuplicateOutcome {
  /** Value that configures or reports duplicate id for this contract. */
  duplicate_id: string;
  /** Value that configures or reports duplicate title for this contract. */
  duplicate_title: string;
  /** Value that configures or reports canonical id for this contract. */
  canonical_id: string;
  /** Value that configures or reports reparented children for this contract. */
  reparented_children: DedupeMergeChildReparent[];
  /** Value that configures or reports skipped children for this contract. */
  skipped_children: {
    child_id: string;
    child_title: string;
    reason: "terminal";
  }[];
  /** Value that configures or reports close for this contract. */
  close: DedupeMergeCloseAction;
}

/** Documents the dedupe-merge result payload exchanged by command, SDK, and package integrations. */
export interface DedupeMergeResult {
  /** Value that configures or reports canonical id for this contract. */
  canonical_id: string;
  /** Value that configures or reports canonical title for this contract. */
  canonical_title: string;
  /** Value that configures or reports mode for this contract. */
  mode: "dry_run" | "apply";
  /** Value that configures or reports duplicates for this contract. */
  duplicates: DedupeMergeDuplicateOutcome[];
  /** Value that configures or reports totals for this contract. */
  totals: {
    duplicates: number;
    children_reparented: number;
    children_skipped: number;
    closed: number;
  };
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports now for this contract. */
  now: string;
}

interface ResolvedItem {
  id: string;
  title: string;
  metadata: ItemMetadata;
}

/** Return a defined value or the supplied fallback without truthiness coercion. */
const valueOrDefault = <Value>(
  value: Value | undefined,
  fallback: Value,
): Value => (value === undefined ? fallback : value);

/** Normalize an unknown thrown value into a stable warning message. */
const formatUnknownError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Parses a single required item id, rejecting blank input with usage guidance. */
const parseRequiredId = (raw: string | undefined, flag: string): string => {
  /** Require and normalize one item identity option. */
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    throw new PmCliError(
      `pm dedupe-merge requires ${flag} <id>`,
      EXIT_CODE.USAGE,
      {
        code: "missing_required_option",
        examples: [
          "pm dedupe-merge --keep pm-canonical --close pm-dup1 --apply",
        ],
      },
    );
  }
  return trimmed;
};

/** Parses the duplicate id list, splitting csv values and de-duplicating while preserving first-seen order so the result is deterministic. */
const parseDuplicateIds = (
  raw: string | string[] | undefined,
  keep: string,
): string[] => {
  /** Parse unique duplicate identities while excluding the canonical item. */
  const collected = Array.isArray(raw)
    ? raw
    : Array.of(valueOrDefault(raw, ""));
  const ids = [
    ...new Set(
      collected
        .flatMap((entry) => splitCommaList(entry))
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (ids.length === 0) {
    throw new PmCliError(
      "pm dedupe-merge requires at least one --close <id> duplicate",
      EXIT_CODE.USAGE,
      {
        code: "missing_required_option",
        examples: [
          "pm dedupe-merge --keep pm-canonical --close pm-dup1,pm-dup2 --apply",
        ],
      },
    );
  }
  if (ids.includes(keep)) {
    throw new PmCliError(
      `Cannot close the canonical item ${keep} as a duplicate of itself`,
      EXIT_CODE.USAGE,
      {
        code: "invalid_option_combination",
        nextSteps: [
          "Pass distinct ids: --keep <canonical> and --close <duplicate>.",
        ],
      },
    );
  }
  return ids;
};

const loadItem = async (
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  id: string,
): Promise<ResolvedItem | null> => {
  /** Load one schema-aware item record or report that it is absent. */
  const typeToFolder = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  ).type_to_folder;
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeToFolder,
  );
  if (!located) {
    return null;
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  return {
    id: located.id,
    title: loaded.document.metadata.title,
    metadata: loaded.document.metadata,
  };
};

const buildChildrenByParentForDedupeMerge = (
  items: ItemMetadata[],
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>,
): Map<string, { id: string; title: string; terminal: boolean }[]> => {
  /** Index child identity and terminal state for deterministic merge validation. */
  const childrenByParent = new Map<
    string,
    { id: string; title: string; terminal: boolean }[]
  >();
  for (const item of items) {
    const parent = item.parent?.trim();
    if (!parent) {
      continue;
    }
    const bucket = childrenByParent.get(parent) ?? [];
    bucket.push({
      id: item.id,
      title: item.title,
      terminal: isTerminalStatus(item.status, statusRegistry),
    });
    childrenByParent.set(parent, bucket);
  }
  return childrenByParent;
};

const applyDedupeMergeReparents = async (params: {
  children: { id: string; title: string; terminal: boolean }[];
  duplicateId: string;
  keep: string;
  apply: boolean;
  options: DedupeMergeOptions;
  global: GlobalOptions;
  warnings: string[];
}): Promise<{
  reparented: DedupeMergeChildReparent[];
  skippedChildren: {
    child_id: string;
    child_title: string;
    reason: "terminal";
  }[];
}> => {
  /** Plan or apply active-child reparenting for one duplicate item. */
  const reparentEnabled = params.options.reparentChildren !== false;
  const reparentTargets = params.children.filter(
    (child) => reparentEnabled && !child.terminal,
  );
  const skippedChildren = params.children
    .filter((child) => reparentEnabled && child.terminal)
    .map((child) => ({
      child_id: child.id,
      child_title: child.title,
      reason: "terminal" as const,
    }));
  const reparented: DedupeMergeChildReparent[] = reparentTargets.map(
    (child) => ({
      child_id: child.id,
      child_title: child.title,
      from_parent: params.duplicateId,
      to_parent: params.keep,
      applied: false,
    }),
  );
  if (!params.apply) {
    return { reparented, skippedChildren };
  }
  for (const record of reparented) {
    try {
      await runUpdate(
        record.child_id,
        {
          parent: params.keep,
          author: params.options.author,
          message: valueOrDefault(
            params.options.message,
            `dedupe-merge: re-parent from ${params.duplicateId} to ${params.keep}`,
          ),
        },
        params.global,
      );
      record.applied = true;
    } catch (error) {
      params.warnings.push(
        `reparent_failed:${record.child_id}:${formatUnknownError(error)}`,
      );
    }
  }
  return { reparented, skippedChildren };
};

const applyDedupeMergeClose = async (params: {
  duplicate: ResolvedItem;
  keep: string;
  apply: boolean;
  options: DedupeMergeOptions;
  global: GlobalOptions;
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>;
  warnings: string[];
}): Promise<DedupeMergeCloseAction> => {
  /** Plan, skip, or apply the terminal duplicate close action. */
  const reason = `Duplicate of ${params.keep}`;
  const close: DedupeMergeCloseAction = {
    duplicate_of: params.keep,
    reason,
    applied: false,
  };
  if (
    isTerminalStatus(params.duplicate.metadata.status, params.statusRegistry)
  ) {
    close.skipped_reason = "already_terminal";
    if (params.duplicate.metadata.duplicate_of?.trim() !== params.keep) {
      params.warnings.push(
        `close_skipped_terminal:${params.duplicate.id}:already_closed`,
      );
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
        message: valueOrDefault(
          params.options.message,
          `dedupe-merge: close ${params.duplicate.id} as duplicate of ${params.keep}`,
        ),
      },
      params.global,
    );
    close.applied = true;
  } catch (error) {
    close.skipped_reason = "failed";
    params.warnings.push(
      `close_failed:${params.duplicate.id}:${formatUnknownError(error)}`,
    );
  }
  return close;
};

const loadRequiredDedupeItem = async (
  pmRoot: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  id: string,
  role: "Canonical" | "Duplicate",
): Promise<ResolvedItem> => {
  /** Load one required merge participant with role-specific recovery guidance. */
  const item = await loadItem(pmRoot, settings, id);
  if (item) return item;
  throw new PmCliError(`${role} item ${id} not found`, EXIT_CODE.NOT_FOUND, {
    code: "item_not_found",
    nextSteps: [`Verify the ${role.toLowerCase()} id with: pm get ${id}`],
  });
};

const buildDedupeMergeOutcome = async (params: {
  duplicateId: string;
  canonical: ResolvedItem;
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  childrenByParent: Map<
    string,
    { id: string; title: string; terminal: boolean }[]
  >;
  apply: boolean;
  options: DedupeMergeOptions;
  global: GlobalOptions;
  statusRegistry: ReturnType<typeof resolveRuntimeStatusRegistry>;
  warnings: string[];
}): Promise<DedupeMergeDuplicateOutcome> => {
  /** Build and optionally apply every mutation for one duplicate participant. */
  const duplicate = await loadRequiredDedupeItem(
    params.pmRoot,
    params.settings,
    params.duplicateId,
    "Duplicate",
  );
  if (duplicate.id === params.canonical.id) {
    throw new PmCliError(
      `Cannot close the canonical item ${params.canonical.id} as a duplicate of itself`,
      EXIT_CODE.USAGE,
      {
        code: "invalid_option_combination",
        nextSteps: [
          "Pass distinct ids: --keep <canonical> and --close <duplicate>.",
        ],
      },
    );
  }
  const children = (params.childrenByParent.get(duplicate.id) ?? []).filter(
    (child) => child.id !== params.canonical.id,
  );
  const { reparented, skippedChildren } = await applyDedupeMergeReparents({
    children,
    duplicateId: duplicate.id,
    keep: params.canonical.id,
    apply: params.apply,
    options: params.options,
    global: params.global,
    warnings: params.warnings,
  });
  const close = await applyDedupeMergeClose({
    duplicate,
    keep: params.canonical.id,
    apply: params.apply,
    options: params.options,
    global: params.global,
    statusRegistry: params.statusRegistry,
    warnings: params.warnings,
  });
  return {
    duplicate_id: duplicate.id,
    duplicate_title: duplicate.title,
    canonical_id: params.canonical.id,
    reparented_children: reparented,
    skipped_children: skippedChildren,
    close,
  };
};

/** Implements run dedupe merge for the public runtime surface of this module. */
export const runDedupeMerge = async (
  options: DedupeMergeOptions,
  global: GlobalOptions,
): Promise<DedupeMergeResult> => {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const keep = parseRequiredId(options.keep, "--keep");
  const duplicateIds = parseDuplicateIds(options.close, keep);
  // Explicit dry-run always wins over apply so a preview can be forced safely.
  const apply = options.apply === true && options.dryRun !== true;

  const canonical = await loadRequiredDedupeItem(
    pmRoot,
    settings,
    keep,
    "Canonical",
  );

  // A single full listing supplies every child lookup without re-reading the
  // corpus per duplicate.
  const corpus = await runList(undefined, { full: true as const }, global);
  const childrenByParent = buildChildrenByParentForDedupeMerge(
    corpus.items,
    statusRegistry,
  );

  const warnings: string[] = [];
  const outcomes: DedupeMergeDuplicateOutcome[] = [];
  for (const duplicateId of duplicateIds) {
    outcomes.push(
      await buildDedupeMergeOutcome({
        duplicateId,
        canonical,
        pmRoot,
        settings,
        childrenByParent,
        apply,
        options,
        global,
        statusRegistry,
        warnings,
      }),
    );
  }

  const childrenReparented = outcomes.reduce(
    (total, outcome) =>
      total +
      outcome.reparented_children.filter((child) => child.applied).length,
    0,
  );
  const childrenSkipped = outcomes.reduce(
    (total, outcome) => total + outcome.skipped_children.length,
    0,
  );
  const closed = outcomes.filter((outcome) => outcome.close.applied).length;

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
};

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  parseRequiredId,
  parseDuplicateIds,
};
