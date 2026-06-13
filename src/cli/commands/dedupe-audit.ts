import { isTerminalStatus, normalizeStatusInput } from "../../core/item/status.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso } from "../../core/shared/time.js";
import { jaccardSimilarity, normalizeLowercaseWhitespace, tokenizeAlphaNumeric } from "../../core/shared/text-normalization.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { type ItemStatus } from "../../types/index.js";
import { parseIntegerLimit } from "../shared-parsers.js";
import { runList } from "./list.js";

export const DEDUPE_AUDIT_MODES = ["title_exact", "title_fuzzy", "parent_scope"] as const;

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

export interface DedupeAuditCandidate {
  id: string;
  title: string;
  type: string;
  status: ItemStatus;
  parent: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface DedupeMergeSuggestion {
  duplicate_id: string;
  canonical_id: string;
  suggested_close_reason: string;
  suggested_message: string;
  suggested_command: string;
}

export interface DedupeAuditCluster {
  mode: DedupeAuditMode;
  key: string;
  match_reason: string;
  cluster_size: number;
  canonical: DedupeAuditCandidate;
  duplicates: DedupeAuditCandidate[];
  merge_suggestions: DedupeMergeSuggestion[];
  similarity?: {
    metric: "token_jaccard";
    threshold: number;
    min: number;
    max: number;
  };
}

export interface DedupeAuditOptions {
  mode?: string;
  status?: string;
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  assignee?: string;
  assigneeFilter?: string;
  parent?: string;
  sprint?: string;
  release?: string;
  limit?: string;
  threshold?: string;
}

export interface DedupeAuditResult {
  mode: DedupeAuditMode;
  clusters: DedupeAuditCluster[];
  count: number;
  totals: {
    items_considered: number;
    duplicate_candidates: number;
    merge_suggestions: number;
  };
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
  now: string;
  warnings?: string[];
}

function parseMode(raw: string | undefined): DedupeAuditMode {
  const normalized = (raw ?? "title_exact").trim().toLowerCase();
  if (!DEDUPE_AUDIT_MODES.includes(normalized as DedupeAuditMode)) {
    throw new PmCliError(`Dedupe audit mode must be one of ${DEDUPE_AUDIT_MODES.join("|")}`, EXIT_CODE.USAGE);
  }
  return normalized as DedupeAuditMode;
}

let dedupeAllowedStatuses = new Set<string>(["draft", "open", "in_progress", "blocked", "closed", "canceled"]);
let dedupeTerminalStatuses = new Set<string>(["closed", "canceled"]);
let dedupeStatusRegistry: RuntimeStatusRegistry | null = null;

function parseStatus(raw: string | undefined): ItemStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase().replaceAll("-", "_");
  if (!dedupeAllowedStatuses.has(normalized)) {
    throw new PmCliError(`Status filter must be one of ${[...dedupeAllowedStatuses].join("|")}`, EXIT_CODE.USAGE);
  }
  return normalized as ItemStatus;
}

function parseThreshold(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new PmCliError("--threshold must be a number between 0 and 1", EXIT_CODE.USAGE);
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

function compareCandidates(left: DedupeAuditPreparedCandidate, right: DedupeAuditPreparedCandidate): number {
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

function toCandidate(candidate: DedupeAuditPreparedCandidate): DedupeAuditCandidate {
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

function toMergeSuggestion(duplicate: DedupeAuditPreparedCandidate, canonical: DedupeAuditPreparedCandidate, mode: DedupeAuditMode): DedupeMergeSuggestion {
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
  const mergeSuggestions = duplicates.map((candidate) => toMergeSuggestion(candidate, canonical, mode));
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
      for (let rightIndex = leftIndex + 1; rightIndex < sortedMembers.length; rightIndex += 1) {
        const score = similarityScore(sortedMembers[leftIndex], sortedMembers[rightIndex]);
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

function similarityScore(left: DedupeAuditPreparedCandidate, right: DedupeAuditPreparedCandidate): number {
  if (left.normalized_title === right.normalized_title) {
    return 1;
  }
  return jaccardSimilarity(left.title_tokens, right.title_tokens);
}

function collectExactTitleClusters(items: DedupeAuditPreparedCandidate[]): DedupeAuditCluster[] {
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
    clusters.push(clusterFromMembers("title_exact", title, members, "exact_normalized_title_match", undefined));
  }
  return clusters;
}

function collectParentScopedClusters(items: DedupeAuditPreparedCandidate[]): DedupeAuditCluster[] {
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
    clusters.push(clusterFromMembers("parent_scope", key, members, "same_parent_and_exact_normalized_title", undefined));
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

function collectFuzzyTitleClusters(items: DedupeAuditPreparedCandidate[], threshold: number): DedupeAuditCluster[] {
  if (items.length <= 1) {
    return [];
  }
  const parents = items.map((_item, index) => index);
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
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
    const canonicalKey = [...members].sort(compareCandidates)[0]?.id ?? `cluster-${clusters.length + 1}`;
    clusters.push(
      clusterFromMembers("title_fuzzy", canonicalKey, members, "title_token_jaccard_above_threshold", threshold),
    );
  }
  return clusters;
}

function compareClusters(left: DedupeAuditCluster, right: DedupeAuditCluster): number {
  const bySize = right.cluster_size - left.cluster_size;
  if (bySize !== 0) {
    return bySize;
  }
  return left.canonical.id.localeCompare(right.canonical.id);
}

export async function runDedupeAudit(options: DedupeAuditOptions, global: GlobalOptions): Promise<DedupeAuditResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  dedupeStatusRegistry = statusRegistry;
  dedupeAllowedStatuses = new Set(statusRegistry.definitions.map((definition) => definition.id));
  dedupeTerminalStatuses = new Set(statusRegistry.terminal_statuses);
  const mode = parseMode(options.mode);
  const status = parseStatus(options.status);
  const limit = parseIntegerLimit(options.limit);
  const threshold = parseThreshold(options.threshold);
  const fuzzyThreshold = threshold ?? 0.8;

  const listed = await runList(
    status,
    {
      type: options.type,
      tag: options.tag,
      priority: options.priority,
      deadlineBefore: options.deadlineBefore,
      deadlineAfter: options.deadlineAfter,
      assignee: options.assignee,
      assigneeFilter: options.assigneeFilter,
      parent: options.parent,
      sprint: options.sprint,
      release: options.release,
    },
    global,
  );

  const prepared: DedupeAuditPreparedCandidate[] = listed.items.map((item) => ({
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
  }));

  const clusters = (() => {
    if (mode === "title_exact") {
      return collectExactTitleClusters(prepared);
    }
    if (mode === "parent_scope") {
      return collectParentScopedClusters(prepared);
    }
    return collectFuzzyTitleClusters(prepared, fuzzyThreshold);
  })();

  const sortedClusters = clusters.sort(compareClusters);
  const limitedClusters = limit === undefined ? sortedClusters : sortedClusters.slice(0, limit);
  const duplicateCandidates = limitedClusters.reduce((total, cluster) => total + cluster.cluster_size, 0);
  const mergeSuggestions = limitedClusters.reduce((total, cluster) => total + cluster.merge_suggestions.length, 0);
  const warnings = listed.warnings && listed.warnings.length > 0 ? listed.warnings : undefined;

  return {
    mode,
    clusters: limitedClusters,
    count: limitedClusters.length,
    totals: {
      items_considered: prepared.length,
      duplicate_candidates: duplicateCandidates,
      merge_suggestions: mergeSuggestions,
    },
    filters: {
      mode,
      status: status ?? null,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      parent: options.parent ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      limit: limit ?? null,
      threshold: mode === "title_fuzzy" ? fuzzyThreshold : null,
    },
    now: nowIso(),
    ...(warnings ? { warnings } : {}),
  };
}

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
