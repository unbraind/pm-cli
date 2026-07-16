/**
 * @module packages/pm-governance-audit/dedupe-audit
 *
 * Implements the pm dedupe audit command surface and its agent-facing runtime behavior.
 */
import {
  EXIT_CODE,
  PmCliError,
  isTerminalStatus,
  normalizeStatusInput,
  nowIso,
  readSettings,
  resolvePmRoot,
  resolveRuntimeStatusRegistry,
  runList,
  type GlobalOptions,
  type ItemStatus,
  type ListedItem,
  type RuntimeStatusRegistry,
} from "./sdk.ts";
import {
  buildListQueryFilters,
  compareTimestampStrings,
  jaccardSimilarity,
  normalizeLowercaseWhitespace,
  parseIntegerLimit,
  tokenizeAlphaNumeric,
} from "./runtime-utils.ts";

/** Public contract for dedupe audit modes, shared by SDK and presentation-layer consumers. */
export const DEDUPE_AUDIT_MODES = [
  "title_exact",
  "title_fuzzy",
  "parent_scope",
] as const;

/** Restricts dedupe audit mode values accepted by command, SDK, and storage contracts. */
export type DedupeAuditMode = (typeof DEDUPE_AUDIT_MODES)[number];

interface DedupeAuditPreparedCandidate {
  id: string;
  title: string;
  type: string;
  status: ItemStatus;
  parent: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
  normalized_title: string;
  title_tokens: string[];
}

/** Documents the dedupe audit candidate payload exchanged by command, SDK, and package integrations. */
export interface DedupeAuditCandidate {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Lifecycle state reported for status. */
  status: ItemStatus;
  /** Value that configures or reports parent for this contract. */
  parent: string | null;
  /** Value that configures or reports priority for this contract. */
  priority: number;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
}

/** Documents the dedupe merge suggestion payload exchanged by command, SDK, and package integrations. */
export interface DedupeMergeSuggestion {
  /** Value that configures or reports duplicate id for this contract. */
  duplicate_id: string;
  /** Value that configures or reports canonical id for this contract. */
  canonical_id: string;
  /** Value that configures or reports suggested close reason for this contract. */
  suggested_close_reason: string;
  /** Value that configures or reports suggested message for this contract. */
  suggested_message: string;
  /** Value that configures or reports suggested command for this contract. */
  suggested_command: string;
}

/** Documents the dedupe audit cluster payload exchanged by command, SDK, and package integrations. */
export interface DedupeAuditCluster {
  /** Value that configures or reports mode for this contract. */
  mode: DedupeAuditMode;
  /** Value that configures or reports key for this contract. */
  key: string;
  /** Value that configures or reports match reason for this contract. */
  match_reason: string;
  /** Value that configures or reports cluster size for this contract. */
  cluster_size: number;
  /** Value that configures or reports canonical for this contract. */
  canonical: DedupeAuditCandidate;
  /** Value that configures or reports duplicates for this contract. */
  duplicates: DedupeAuditCandidate[];
  /** Value that configures or reports merge suggestions for this contract. */
  merge_suggestions: DedupeMergeSuggestion[];
  /** Value that configures or reports similarity for this contract. */
  similarity?: {
    metric: "token_jaccard";
    threshold: number;
    min: number;
    max: number;
  };
}

/** Documents the dedupe audit options payload exchanged by command, SDK, and package integrations. */
export interface DedupeAuditOptions {
  /** Value that configures or reports mode for this contract. */
  mode?: string;
  /** Lifecycle state reported for status. */
  status?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Value that configures or reports deadline before for this contract. */
  deadlineBefore?: string;
  /** Value that configures or reports deadline after for this contract. */
  deadlineAfter?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports assignee filter for this contract. */
  assigneeFilter?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports threshold for this contract. */
  threshold?: string;
}

/** Documents the dedupe audit result payload exchanged by command, SDK, and package integrations. */
export interface DedupeAuditResult {
  /** Value that configures or reports mode for this contract. */
  mode: DedupeAuditMode;
  /** Value that configures or reports clusters for this contract. */
  clusters: DedupeAuditCluster[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports totals for this contract. */
  totals: {
    items_considered: number;
    duplicate_candidates: number;
    merge_suggestions: number;
  };
  /** Value that configures or reports filters for this contract. */
  filters: {
    mode: DedupeAuditMode;
    status: ItemStatus | null;
    type: string | null;
    tag: string | null;
    priority: string | null;
    deadline_before: string | null;
    deadline_after: string | null;
    assignee: string | null;
    assignee_filter: string | null;
    parent: string | null;
    sprint: string | null;
    release: string | null;
    limit: number | null;
    threshold: number | null;
  };
  /** Value that configures or reports now for this contract. */
  now: string;
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
}

function parseMode(raw: string | undefined): DedupeAuditMode {
  const normalized = (raw ?? "title_exact").trim().toLowerCase();
  if (!DEDUPE_AUDIT_MODES.includes(normalized as DedupeAuditMode)) {
    throw new PmCliError(
      `Dedupe audit mode must be one of ${DEDUPE_AUDIT_MODES.join("|")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized as DedupeAuditMode;
}

let dedupeAllowedStatuses = new Set<string>([
  "draft",
  "open",
  "in_progress",
  "blocked",
  "closed",
  "canceled",
]);
let dedupeTerminalStatuses = new Set<string>(["closed", "canceled"]);
let dedupeStatusRegistry: RuntimeStatusRegistry | null = null;

function parseStatus(raw: string | undefined): ItemStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase().replaceAll("-", "_");
  if (!dedupeAllowedStatuses.has(normalized)) {
    throw new PmCliError(
      `Status filter must be one of ${[...dedupeAllowedStatuses].join("|")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized as ItemStatus;
}

function parseThreshold(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new PmCliError(
      "--threshold must be a number between 0 and 1",
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

function isTerminal(status: ItemStatus): boolean {
  if (dedupeStatusRegistry) {
    return isTerminalStatus(status, dedupeStatusRegistry);
  }
  const normalized = normalizeStatusInput(status) ?? status;
  return dedupeTerminalStatuses.has(normalized);
}

function compareCandidates(
  left: DedupeAuditPreparedCandidate,
  right: DedupeAuditPreparedCandidate,
): number {
  const leftTerminal = isTerminal(left.status);
  const rightTerminal = isTerminal(right.status);
  if (leftTerminal !== rightTerminal) {
    return leftTerminal ? 1 : -1;
  }
  const byPriority = left.priority - right.priority;
  if (byPriority !== 0) {
    return byPriority;
  }
  const byUpdated = compareTimestampStrings(right.updated_at, left.updated_at);
  if (byUpdated !== 0) {
    return byUpdated;
  }
  return left.id.localeCompare(right.id);
}

function toCandidate(
  candidate: DedupeAuditPreparedCandidate,
): DedupeAuditCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    type: candidate.type,
    status: candidate.status,
    parent: candidate.parent,
    priority: candidate.priority,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
}

function toMergeSuggestion(
  duplicate: DedupeAuditPreparedCandidate,
  canonical: DedupeAuditPreparedCandidate,
  mode: DedupeAuditMode,
): DedupeMergeSuggestion {
  const closeReason = `Duplicate of ${canonical.id}`;
  const message = `Close ${duplicate.id} as duplicate of ${canonical.id} from pm dedupe-audit (${mode}).`;
  const escapedReason = closeReason.replaceAll('"', '\\"');
  const escapedMessage = message.replaceAll('"', '\\"');
  return {
    duplicate_id: duplicate.id,
    canonical_id: canonical.id,
    suggested_close_reason: closeReason,
    suggested_message: message,
    suggested_command: `pm close ${duplicate.id} "${escapedReason}" --message "${escapedMessage}"`,
  };
}

function clusterFromMembers(
  mode: DedupeAuditMode,
  key: string,
  members: DedupeAuditPreparedCandidate[],
  matchReason: string,
  threshold: number | undefined,
): DedupeAuditCluster {
  const sortedMembers = [...members].sort(compareCandidates);
  const canonical = sortedMembers[0];
  const duplicates = sortedMembers.slice(1);
  const mergeSuggestions = duplicates.map((candidate) =>
    toMergeSuggestion(candidate, canonical, mode),
  );
  const cluster: DedupeAuditCluster = {
    mode,
    key,
    match_reason: matchReason,
    cluster_size: sortedMembers.length,
    canonical: toCandidate(canonical),
    duplicates: duplicates.map((candidate) => toCandidate(candidate)),
    merge_suggestions: mergeSuggestions,
  };
  if (mode === "title_fuzzy") {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let leftIndex = 0; leftIndex < sortedMembers.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < sortedMembers.length;
        rightIndex += 1
      ) {
        const score = similarityScore(
          sortedMembers[leftIndex],
          sortedMembers[rightIndex],
        );
        min = Math.min(min, score);
        max = Math.max(max, score);
      }
    }
    if (!Number.isFinite(min)) {
      min = 1;
    }
    if (!Number.isFinite(max)) {
      max = 1;
    }
    cluster.similarity = {
      metric: "token_jaccard",
      threshold: threshold ?? 0.8,
      min,
      max,
    };
  }
  return cluster;
}

function similarityScore(
  left: DedupeAuditPreparedCandidate,
  right: DedupeAuditPreparedCandidate,
): number {
  if (left.normalized_title === right.normalized_title) {
    return 1;
  }
  return jaccardSimilarity(left.title_tokens, right.title_tokens);
}

function collectExactTitleClusters(
  items: DedupeAuditPreparedCandidate[],
): DedupeAuditCluster[] {
  const byTitle = new Map<string, DedupeAuditPreparedCandidate[]>();
  for (const item of items) {
    if (item.normalized_title.length === 0) {
      continue;
    }
    const existing = byTitle.get(item.normalized_title);
    if (existing) {
      existing.push(item);
    } else {
      byTitle.set(item.normalized_title, [item]);
    }
  }
  const clusters: DedupeAuditCluster[] = [];
  for (const [title, members] of byTitle.entries()) {
    if (members.length <= 1) {
      continue;
    }
    clusters.push(
      clusterFromMembers(
        "title_exact",
        title,
        members,
        "exact_normalized_title_match",
        undefined,
      ),
    );
  }
  return clusters;
}

function collectParentScopedClusters(
  items: DedupeAuditPreparedCandidate[],
): DedupeAuditCluster[] {
  const byParentAndTitle = new Map<string, DedupeAuditPreparedCandidate[]>();
  for (const item of items) {
    if (!item.parent || item.normalized_title.length === 0) {
      continue;
    }
    const key = `${item.parent}|${item.normalized_title}`;
    const existing = byParentAndTitle.get(key);
    if (existing) {
      existing.push(item);
    } else {
      byParentAndTitle.set(key, [item]);
    }
  }
  const clusters: DedupeAuditCluster[] = [];
  for (const [key, members] of byParentAndTitle.entries()) {
    if (members.length <= 1) {
      continue;
    }
    clusters.push(
      clusterFromMembers(
        "parent_scope",
        key,
        members,
        "same_parent_and_exact_normalized_title",
        undefined,
      ),
    );
  }
  return clusters;
}

function findRoot(parents: number[], index: number): number {
  let current = index;
  while (parents[current] !== current) {
    parents[current] = parents[parents[current]];
    current = parents[current];
  }
  return current;
}

function unionRoots(parents: number[], left: number, right: number): void {
  const leftRoot = findRoot(parents, left);
  const rightRoot = findRoot(parents, right);
  if (leftRoot === rightRoot) {
    return;
  }
  if (leftRoot < rightRoot) {
    parents[rightRoot] = leftRoot;
  } else {
    parents[leftRoot] = rightRoot;
  }
}

function collectFuzzyTitleClusters(
  items: DedupeAuditPreparedCandidate[],
  threshold: number,
): DedupeAuditCluster[] {
  if (items.length <= 1) {
    return [];
  }
  const parents = items.map((_item, index) => index);
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < items.length;
      rightIndex += 1
    ) {
      const score = similarityScore(items[leftIndex], items[rightIndex]);
      if (score >= threshold) {
        unionRoots(parents, leftIndex, rightIndex);
      }
    }
  }
  const groupedIndices = new Map<number, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const root = findRoot(parents, index);
    const existing = groupedIndices.get(root);
    if (existing) {
      existing.push(index);
    } else {
      groupedIndices.set(root, [index]);
    }
  }
  const clusters: DedupeAuditCluster[] = [];
  for (const indices of groupedIndices.values()) {
    if (indices.length <= 1) {
      continue;
    }
    const members = indices.map((index) => items[index]);
    /* c8 ignore next -- clusters with indices.length > 1 always produce at least one member id. */
    const canonicalKey =
      [...members].sort(compareCandidates)[0]?.id ??
      `cluster-${clusters.length + 1}`;
    clusters.push(
      clusterFromMembers(
        "title_fuzzy",
        canonicalKey,
        members,
        "title_token_jaccard_above_threshold",
        threshold,
      ),
    );
  }
  return clusters;
}

function compareClusters(
  left: DedupeAuditCluster,
  right: DedupeAuditCluster,
): number {
  const bySize = right.cluster_size - left.cluster_size;
  if (bySize !== 0) {
    return bySize;
  }
  return left.canonical.id.localeCompare(right.canonical.id);
}

function collectDedupeClusters(
  mode: DedupeAuditMode,
  prepared: DedupeAuditPreparedCandidate[],
  fuzzyThreshold: number,
): DedupeAuditCluster[] {
  if (mode === "title_exact") {
    return collectExactTitleClusters(prepared);
  }
  if (mode === "parent_scope") {
    return collectParentScopedClusters(prepared);
  }
  return collectFuzzyTitleClusters(prepared, fuzzyThreshold);
}

/**
 * Precompute normalized fields used by every dedupe comparison strategy.
 */
function toPreparedDedupeCandidate(
  item: ListedItem,
): DedupeAuditPreparedCandidate {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    parent: item.parent ?? null,
    priority: item.priority,
    created_at: item.created_at,
    updated_at: item.updated_at,
    normalized_title: normalizeLowercaseWhitespace(item.title),
    title_tokens: tokenizeAlphaNumeric(item.title),
  };
}

function buildDedupeAuditFilters(params: {
  mode: DedupeAuditMode;
  status: ItemStatus | undefined;
  options: DedupeAuditOptions;
  limit: number | undefined;
  fuzzyThreshold: number;
}): DedupeAuditResult["filters"] {
  return {
    mode: params.mode,
    status: params.status ?? null,
    type: params.options.type ?? null,
    tag: params.options.tag ?? null,
    priority: params.options.priority ?? null,
    deadline_before: params.options.deadlineBefore ?? null,
    deadline_after: params.options.deadlineAfter ?? null,
    assignee: params.options.assignee ?? null,
    assignee_filter: params.options.assigneeFilter ?? null,
    parent: params.options.parent ?? null,
    sprint: params.options.sprint ?? null,
    release: params.options.release ?? null,
    limit: params.limit ?? null,
    threshold: params.mode === "title_fuzzy" ? params.fuzzyThreshold : null,
  };
}

/** Implements run dedupe audit for the public runtime surface of this module. */
export async function runDedupeAudit(
  options: DedupeAuditOptions,
  global: GlobalOptions,
): Promise<DedupeAuditResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  dedupeStatusRegistry = statusRegistry;
  dedupeAllowedStatuses = new Set(
    statusRegistry.definitions.map((definition) => definition.id),
  );
  dedupeTerminalStatuses = new Set(statusRegistry.terminal_statuses);
  const mode = parseMode(options.mode);
  const status = parseStatus(options.status);
  const limit = parseIntegerLimit(options.limit);
  const threshold = parseThreshold(options.threshold);
  const fuzzyThreshold = threshold ?? 0.8;

  const listed = await runList(
    status,
    { ...buildListQueryFilters(options), full: true as const },
    global,
  );

  const prepared = listed.items.map((item) => toPreparedDedupeCandidate(item));

  const clusters = collectDedupeClusters(mode, prepared, fuzzyThreshold);

  const sortedClusters = clusters.sort(compareClusters);
  const limitedClusters =
    limit === undefined ? sortedClusters : sortedClusters.slice(0, limit);
  const duplicateCandidates = limitedClusters.reduce(
    (total, cluster) => total + cluster.cluster_size,
    0,
  );
  const mergeSuggestions = limitedClusters.reduce(
    (total, cluster) => total + cluster.merge_suggestions.length,
    0,
  );
  /* c8 ignore next -- list warnings are normalized upstream in command-level tests. */
  const warnings =
    listed.warnings && listed.warnings.length > 0 ? listed.warnings : undefined;

  return {
    mode,
    clusters: limitedClusters,
    count: limitedClusters.length,
    totals: {
      items_considered: prepared.length,
      duplicate_candidates: duplicateCandidates,
      merge_suggestions: mergeSuggestions,
    },
    filters: buildDedupeAuditFilters({
      mode,
      status,
      options,
      limit,
      fuzzyThreshold,
    }),
    now: nowIso(),
    /* c8 ignore next -- warnings are omitted when undefined to keep stable result payloads. */
    ...(warnings ? { warnings } : {}),
  };
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  parseMode,
  parseStatus,
  parseThreshold,
  compareCandidates,
  collectExactTitleClusters,
  collectParentScopedClusters,
  collectFuzzyTitleClusters,
  clusterFromMembers,
  toMergeSuggestion,
};
