/**
 * @module cli/commands/next
 *
 * Implements the `pm next` command: the distilled "what should I work on now?"
 * query. It loads the active corpus, computes dependency-aware actionability
 * (ready vs blocked leaf work), and returns a single ranked recommendation with a
 * deterministic rationale plus the ranked ready/blocked queues — so an agent gets
 * the next action and the reason for it in one token-efficient read instead of
 * re-deriving readiness from a full `pm context` snapshot every turn.
 */
import {
  collectBlockedByIds,
  computeActionabilityReport,
  type ActionableEntry,
} from "../../sdk/actionability.js";
import {
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import {
  normalizeStatusInput,
  normalizeStatusForRegistry,
} from "../../core/item/status.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemMetadata, ItemStatus } from "../../types/index.js";
import { parseIntegerLimit } from "../shared-parsers.js";
import {
  buildChildrenByParent,
  buildItemContextRelevanceCandidates,
  collectSubtreeIds,
  compareCriticalItems,
  packRankedContextItems,
  toContextPackingSummary,
  toContextRankingSummary,
  toContextFocusItem,
  type ContextFocusItem,
  type ContextRankingSummary,
  type ContextPackingSummary,
} from "./context.js";
import { runList, type ListOptions } from "./list.js";
import { scoreContextCandidatesWithActiveExtensions } from "../../sdk/context-relevance.js";
import {
  readContextUsageAffinity,
  recordContextUsageServing,
} from "../../sdk/context-usage.js";
import type { ContextPackingReport } from "../../sdk/context-packing.js";

/** Supported values accepted by the next output contract. */
export const NEXT_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
/** Restricts `pm next` output format values accepted by command, SDK, and storage contracts. */
export type NextOutputFormat = (typeof NEXT_OUTPUT_VALUES)[number];

const DEFAULT_NEXT_LIMIT = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Documents the `pm next` options payload exchanged by command, SDK, and package integrations. */
export interface NextOptions {
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string | number;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports assignee filter for this contract. */
  assigneeFilter?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  /** Value that configures or reports parent for this contract. */
  parent?: string;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports blocked limit for this contract. */
  blockedLimit?: string;
  /** Value that configures or reports ready only for this contract. */
  readyOnly?: boolean;
  /** Value that configures or reports format for this contract. */
  format?: string;
  /** Value that configures or reports explain ranking for this contract. */
  explainRanking?: boolean;
  /** Include human-gated Decision items in the claimable ready queue. */
  includeDecisions?: boolean;
  /** Internal caller override used to align claim-next ranking with --author. */
  callerAuthor?: string;
  [key: string]: unknown;
}

/** A blocker reference projected onto the `pm next` output. */
export interface NextBlockerRef {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string | null;
  /** Lifecycle state reported for status. */
  status: ItemStatus | null;
}

/**
 * A classified actionable item on the `pm next` output: a {@link ContextFocusItem}
 * focus row augmented with its open-blocker references and the downstream items it
 * would unblock.
 */
export interface NextActionableItem extends ContextFocusItem {
  /** One-based position in the complete ranked actionable queue. */
  rank: number;
  /** Number of open blocker entries represented by this result. */
  open_blocker_count: number;
  /** Value that configures or reports blockers for this contract. */
  blockers: NextBlockerRef[];
  /** Value that configures or reports unblocks for this contract. */
  unblocks: string[];
}

/** The single recommended next item: an actionable row plus its rationale. */
export interface NextRecommendation extends NextActionableItem {
  /** Value that configures or reports reasons for this contract. */
  reasons: string[];
}

interface NextSummary {
  recommended: boolean;
  ready: number;
  blocked: number;
  in_progress: number;
  candidates: number;
  containers: number;
  decision_needed: number;
  held_by_others: number;
}

/** Documents the `pm next` result payload exchanged by command, SDK, and package integrations. */
export interface NextResult {
  /** Value that configures or reports output default for this contract. */
  output_default: "toon";
  /** Value that configures or reports now for this contract. */
  now: string;
  /** Value that configures or reports recommended for this contract. */
  recommended: NextRecommendation | null;
  /** Value that configures or reports ready for this contract. */
  ready: NextActionableItem[];
  /** Human-gated decisions kept visible without dispatching them to agents. */
  decision_needed: NextActionableItem[];
  /** Value that configures or reports blocked for this contract. */
  blocked: NextActionableItem[];
  /** Value that configures or reports held by others for this contract. */
  held_by_others: Array<{ id: string; assignee: string }>;
  /** Value that configures or reports summary for this contract. */
  summary: NextSummary;
  /** Value that configures or reports filters for this contract. */
  filters: {
    type: string | null;
    tag: string | null;
    priority: string | number | null;
    assignee: string | null;
    assignee_filter: string | null;
    sprint: string | null;
    release: string | null;
    parent: string | null;
    limit: number;
    blocked_limit: number;
    ready_only: boolean;
    include_decisions: boolean;
  };
  /** Value that configures or reports suggestions for this contract. */
  suggestions?: string[];
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
  /** Value that configures or reports ranking for this contract. */
  ranking?: ContextRankingSummary;
  /** Token-budget selection and projection accounting for the ready queue. */
  packing?: ContextPackingSummary;
  /** Explicit marker and complete counts for queues truncated by the shared section limit. */
  truncation?: {
    decision_needed_total?: number;
    held_by_others_total?: number;
  };
}

function parseNextOutputFormat(
  raw: string | undefined,
): NextOutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!NEXT_OUTPUT_VALUES.includes(normalized as NextOutputFormat)) {
    throw new PmCliError(
      "Next format must be one of markdown|toon|json",
      EXIT_CODE.USAGE,
    );
  }
  return normalized as NextOutputFormat;
}

/** Resolves the effective `pm next` output format from the command `--format` flag and the global `--json` switch, rejecting the contradictory `--json --format markdown|toon` combination. Defaults to `toon`. */
export function resolveNextOutputFormat(
  options: NextOptions,
  global: GlobalOptions,
): NextOutputFormat {
  const commandFormat = parseNextOutputFormat(options.format);
  if (global.json && commandFormat && commandFormat !== "json") {
    throw new PmCliError(
      "Cannot combine --json with --format markdown|toon",
      EXIT_CODE.USAGE,
    );
  }
  if (global.json) {
    return "json";
  }
  return commandFormat ?? "toon";
}

// Per-section row cap. A non-positive or absent value falls back to the default;
// invalid (non-integer) values throw via parseIntegerLimit.
function parseNextLimit(
  raw: string | undefined,
  flag: string,
  fallback: number,
): number {
  const parsed = parseIntegerLimit(raw, flag);
  if (parsed === undefined || parsed <= 0) return fallback;
  return parsed;
}

// Projects an actionable entry onto its output row. Ready entries carry no
// blockers; blocked entries surface their unresolved blockers for the agent.
function toNextActionableItem(
  entry: ActionableEntry,
  statusRegistry: RuntimeStatusRegistry,
  childrenByParent: Map<string, ItemMetadata[]>,
  rank: number,
): NextActionableItem {
  return {
    ...toContextFocusItem(entry.item, statusRegistry, childrenByParent),
    open_blocker_count: entry.open_blockers.length,
    blockers: entry.open_blockers.map((blocker) => ({
      id: blocker.id,
      title: blocker.title,
      status: blocker.status,
    })),
    unblocks: entry.unblocks,
    rank,
  };
}

// Builds the human+agent readable rationale for the recommended item, ordering
// clauses from most to least decisive (status, priority, deadline, blocker
// clearance, parent advancement, downstream unblocks).
function buildRecommendationReasons(
  entry: ActionableEntry,
  statusRegistry: RuntimeStatusRegistry,
  now: string,
  completedContainer: boolean,
): string[] {
  const item = entry.item;
  const reasons: string[] = [];
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  reasons.push(
    normalizeStatusForRegistry(item.status, statusRegistry) === inProgressStatus
      ? "in progress — resume to finish"
      : "open and ready to start",
  );
  if (completedContainer) {
    reasons.push("completed container — governance closeout");
  }
  reasons.push(
    `priority p${item.priority}${item.priority === 0 ? " (highest)" : ""}`,
  );
  if (typeof item.deadline === "string" && item.deadline.trim().length > 0) {
    reasons.push(describeDeadline(item.deadline, now));
  }
  reasons.push(
    collectBlockedByIds(item).length > 0
      ? "all blockers resolved"
      : "no blockers",
  );
  if (typeof item.parent === "string" && item.parent.trim().length > 0) {
    reasons.push(`advances ${item.parent.trim()}`);
  }
  if (entry.unblocks.length > 0) {
    reasons.push(
      `unblocks ${entry.unblocks.length} item(s): ${entry.unblocks.join(", ")}`,
    );
  }
  return reasons;
}

function partitionCallerOwnedReady(
  ready: ActionableEntry[],
  fallbackAuthor: string,
  explicitAuthor?: string,
): {
  available: ActionableEntry[];
  held: Array<{ id: string; assignee: string }>;
} {
  const caller =
    (explicitAuthor ?? process.env.PM_AUTHOR ?? fallbackAuthor).trim() ||
    "unknown";
  const available: ActionableEntry[] = [];
  const held: Array<{ id: string; assignee: string }> = [];
  for (const entry of ready) {
    const assignee =
      typeof entry.item.assignee === "string" ? entry.item.assignee.trim() : "";
    const isForeignWork = assignee.length > 0 && assignee !== caller;
    if (isForeignWork) held.push({ id: entry.item.id, assignee });
    else available.push(entry);
  }
  return { available, held };
}

/** Test-only access to deterministic next-work partitioning edge cases. */
export const _testOnlyNextCommand = { partitionCallerOwnedReady };

/** Separates human-gated decisions from autonomous agent work unless the caller explicitly opts into decision claims. */
export function partitionDecisionEntries(
  ready: ActionableEntry[],
  includeDecisions: boolean,
): { agent: ActionableEntry[]; decisions: ActionableEntry[] } {
  const decisions = ready.filter(
    (entry) => entry.item.type.trim().toLowerCase() === "decision",
  );
  return {
    agent: includeDecisions
      ? ready
      : ready.filter(
          (entry) => entry.item.type.trim().toLowerCase() !== "decision",
        ),
    decisions: includeDecisions ? [] : decisions,
  };
}

// Renders a deadline as a date token plus a relative tag (overdue/today/in Nd).
// The relative delta is computed on UTC calendar dates (both sides normalized to
// midnight) so a deadline due today never reads as "overdue 1d" just because the
// wall-clock time of `now` has passed midnight. Unparseable deadlines degrade to
// the raw token (defensive — stored deadlines are always valid ISO).
function describeDeadline(deadline: string, now: string): string {
  const deadlineMs = Date.parse(deadline);
  /* c8 ignore start -- defensive: a stored deadline that fails Date.parse still surfaces its raw token */
  if (!Number.isFinite(deadlineMs)) {
    return `deadline ${deadline.trim()}`;
  }
  /* c8 ignore stop */
  const dateToken = new Date(deadlineMs).toISOString().slice(0, 10);
  const nowToken = new Date(Date.parse(now)).toISOString().slice(0, 10);
  const days = Math.round(
    (Date.parse(dateToken) - Date.parse(nowToken)) / MS_PER_DAY,
  );
  if (days < 0) return `deadline ${dateToken} (overdue ${-days}d)`;
  if (days === 0) return `deadline ${dateToken} (due today)`;
  return `deadline ${dateToken} (in ${days}d)`;
}

function inProgressReadyCount(
  ready: NextActionableItem[],
  statusRegistry: RuntimeStatusRegistry,
): number {
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  return ready.filter(
    (item) =>
      normalizeStatusForRegistry(item.status, statusRegistry) ===
      inProgressStatus,
  ).length;
}

// Returns true when an otherwise-ready item still has terminal descendants. Such
// rows are useful governance closeout context, but concrete leaf work should rank
// ahead of them in the default agent loop.
function hasCompletedDescendants(
  item: ItemMetadata,
  childrenByParent: Map<string, ItemMetadata[]>,
): boolean {
  return (childrenByParent.get(item.id.trim().toLowerCase()) ?? []).length > 0;
}

// Strips projection/pagination flags so the corpus reads stay full: limits are
// per-section display caps applied after classification, never corpus filters.
function nextListOptions(
  options: NextOptions,
  extra: Partial<ListOptions>,
): ListOptions {
  return {
    type: options.type,
    tag: options.tag,
    priority:
      typeof options.priority === "number"
        ? String(options.priority)
        : options.priority,
    assignee: options.assignee,
    assigneeFilter: options.assigneeFilter,
    sprint: options.sprint,
    release: options.release,
    noTruncate: true,
    ...extra,
  };
}

function rankNextReadyEntries(
  ready: ActionableEntry[],
  childrenByParent: Map<string, ItemMetadata[]>,
  statusRegistry: RuntimeStatusRegistry,
): ActionableEntry[] {
  return [...ready].sort((left, right) => {
    const leftCompletedContainer = hasCompletedDescendants(
      left.item,
      childrenByParent,
    );
    const rightCompletedContainer = hasCompletedDescendants(
      right.item,
      childrenByParent,
    );
    if (leftCompletedContainer !== rightCompletedContainer) {
      return Number(leftCompletedContainer) - Number(rightCompletedContainer);
    }
    return compareCriticalItems(left.item, right.item, statusRegistry);
  });
}

function buildNextRecommendation(params: {
  projectedReady: ActionableEntry[];
  readyRows: NextActionableItem[];
  statusRegistry: RuntimeStatusRegistry;
  now: string;
  completedContainer: boolean;
}): NextRecommendation | null {
  if (params.projectedReady.length === 0) {
    return null;
  }
  return {
    ...params.readyRows[0],
    reasons: buildRecommendationReasons(
      params.projectedReady[0],
      params.statusRegistry,
      params.now,
      params.completedContainer,
    ),
  };
}

function buildNextSuggestions(
  recommended: NextRecommendation | null,
  blockedRows: NextActionableItem[],
): string[] | undefined {
  if (recommended !== null) {
    return undefined;
  }
  if (blockedRows.length > 0) {
    const blockedWithReferences = blockedRows.find(
      (item) => item.blockers.length > 0,
    );
    return [
      blockedWithReferences
        ? `${blockedRows.length} item(s) are blocked; unblock the top one by closing ${blockedWithReferences.blockers.map((blocker) => blocker.id).join(", ")}`
        : `${blockedRows.length} item(s) are blocked; add blocker context or move the top item back to an active status`,
      "pm next --ready-only after a blocker closes to re-check ready work",
      'pm create --type Task --title "..." to add new ready work',
    ];
  }
  return [
    'pm create --type Task --title "..." to add a new work item',
    "pm list --status in_progress to review work already underway",
    "pm context --depth deep for the full project snapshot",
  ];
}

function buildNextTruncation(
  decisionCount: number,
  heldCount: number,
  limit: number,
): NextResult["truncation"] {
  const truncation: NonNullable<NextResult["truncation"]> = {};
  if (decisionCount > limit) {
    truncation.decision_needed_total = decisionCount;
  }
  if (heldCount > limit) {
    truncation.held_by_others_total = heldCount;
  }
  return Object.keys(truncation).length > 0 ? truncation : undefined;
}

async function attachNextUsageFeedback(params: {
  result: NextResult;
  pmRoot: string;
  author: string;
  packing: ContextPackingReport<ItemMetadata>;
  ranking: Awaited<
    ReturnType<typeof scoreContextCandidatesWithActiveExtensions<ItemMetadata>>
  >;
}): Promise<void> {
  try {
    const included = new Set(params.packing.included.map((entry) => entry.id));
    await recordContextUsageServing({
      pmRoot: params.pmRoot,
      author: params.author,
      surface: "next",
      profile: params.packing.profile,
      rows: params.ranking.ranked.map((entry) => ({
        id: entry.id,
        rank: entry.rank,
        included: included.has(entry.id),
      })),
      enabled: process.env.PM_CONTEXT_USAGE_DISABLED !== "1",
    });
  } catch {
    params.result.warnings = [
      ...new Set([
        ...(params.result.warnings ?? []),
        "context_usage_feedback_write_failed",
      ]),
    ].sort((left, right) => left.localeCompare(right));
  }
}

async function finalizeNextResult(params: {
  result: NextResult;
  recommended: NextRecommendation | null;
  blockedRows: NextActionableItem[];
  candidatesWarnings: string[] | undefined;
  corpusWarnings: string[] | undefined;
  readyRanking: Awaited<
    ReturnType<typeof scoreContextCandidatesWithActiveExtensions<ItemMetadata>>
  >;
  explainRanking: boolean;
  pmRoot: string;
  author: string;
  packing: ContextPackingReport<ItemMetadata>;
}): Promise<NextResult> {
  const warnings = [
    ...new Set([
      ...(params.candidatesWarnings ?? []),
      ...(params.corpusWarnings ?? []),
      ...(params.readyRanking.warnings ?? []),
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (warnings.length > 0) params.result.warnings = warnings;
  if (params.explainRanking) {
    params.result.ranking = toContextRankingSummary(params.readyRanking);
    params.result.packing = toContextPackingSummary(params.packing);
  }

  params.result.suggestions = buildNextSuggestions(
    params.recommended,
    params.blockedRows,
  );
  await attachNextUsageFeedback({
    result: params.result,
    pmRoot: params.pmRoot,
    author: params.author,
    packing: params.packing,
    ranking: params.readyRanking,
  });
  return params.result;
}

function filterCandidatesByParentScope(
  candidates: ItemMetadata[],
  corpus: ItemMetadata[],
  parentScope: string,
): ItemMetadata[] {
  if (!parentScope) {
    return candidates;
  }
  const subtree = collectSubtreeIds(corpus, parentScope);
  if (!subtree.found) {
    throw new PmCliError(
      `Next --parent item not found: ${parentScope}`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  return candidates.filter((item) =>
    subtree.ids.has(item.id.trim().toLowerCase()),
  );
}

async function rankReadyEntriesWithRelevance(
  rankedReady: ActionableEntry[],
  childrenByParent: Map<string, ItemMetadata[]>,
  statusRegistry: RuntimeStatusRegistry,
  now: string,
  callerAuthor: string,
  pmRoot: string,
  tokenBudget: number,
): Promise<{
  projectedReady: ActionableEntry[];
  ranking: Awaited<
    ReturnType<
      typeof scoreContextCandidatesWithActiveExtensions<ItemMetadata>
    >
  >;
  completedContainer: boolean;
  packing: ContextPackingReport<ItemMetadata>;
}> {
  const concreteReady = rankedReady.filter(
    (entry) => !hasCompletedDescendants(entry.item, childrenByParent),
  );
  const structuralReady =
    concreteReady.length > 0 ? concreteReady : rankedReady;
  const usage = await readContextUsageAffinity({
    pmRoot,
    author: callerAuthor,
    enabled: process.env.PM_CONTEXT_USAGE_DISABLED !== "1",
  });
  const ranking = await scoreContextCandidatesWithActiveExtensions(
    "next",
    buildItemContextRelevanceCandidates(
      structuralReady.map((entry) => entry.item),
      { statusRegistry, now, author: callerAuthor, usageAffinity: usage.affinity },
    ),
  );
  const packing = packRankedContextItems(ranking, tokenBudget, new Set(), "next");
  const readyById = new Map(
    structuralReady.map((entry) => [entry.item.id, entry]),
  );
  const projectedReady = ranking.ranked
    .map((entry) => readyById.get(entry.id))
    .filter((entry): entry is ActionableEntry => entry !== undefined);
  return {
    projectedReady,
    ranking,
    completedContainer: concreteReady.length === 0,
    packing,
  };
}

/** Resolve the ranking perspective from an explicit caller, delegated assignee, environment author, or project default. */
function resolveNextCallerAuthor(
  options: NextOptions,
  settingsAuthor: string,
): string {
  const requestedAssignee = options.assignee?.trim();
  return (
    options.callerAuthor ??
    (requestedAssignee && requestedAssignee.length > 0
      ? requestedAssignee
      : undefined) ??
    process.env.PM_AUTHOR ??
    settingsAuthor
  );
}

/** Implements `pm next`: computes the ranked ready/blocked actionable queues and a single recommended next item with rationale for the public runtime surface. */
export async function runNext(
  options: NextOptions,
  global: GlobalOptions,
): Promise<NextResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const callerAuthor = resolveNextCallerAuthor(
    options,
    settings.author_default,
  );
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const now = nowIso();
  const limit = parseNextLimit(options.limit, "--limit", DEFAULT_NEXT_LIMIT);
  const blockedLimit = parseNextLimit(
    options.blockedLimit,
    "--blocked-limit",
    limit,
  );
  const readyOnly = options.readyOnly === true;
  const parentScope =
    typeof options.parent === "string" ? options.parent.trim() : "";

  // Active (non-terminal) candidates honor the caller's filters; the corpus is the
  // FULL, UNFILTERED set (every status, every item) so blocker and descendant
  // resolution still sees items outside the caller's filters or --parent subtree —
  // otherwise a real blocker assigned to someone else (or a parent of a different
  // type) would be missing and the blocked item misread as ready.
  const candidatesList = await runList(
    undefined,
    nextListOptions(options, { excludeTerminal: true }),
    global,
  );
  const corpusList = await runList(
    undefined,
    { excludeTerminal: false, noTruncate: true },
    global,
  );
  const candidates = filterCandidatesByParentScope(
    candidatesList.items as ItemMetadata[],
    corpusList.items as ItemMetadata[],
    parentScope,
  );
  const corpus = corpusList.items as ItemMetadata[];

  const report = computeActionabilityReport(candidates, corpus, statusRegistry);
  const childrenByParent = buildChildrenByParent(corpus);
  const partitionedByDecision = partitionDecisionEntries(
    report.ready,
    options.includeDecisions === true,
  );
  const callerPartition = partitionCallerOwnedReady(
    partitionedByDecision.agent,
    settings.author_default,
    callerAuthor,
  );
  const rankedReady = rankNextReadyEntries(
    callerPartition.available,
    childrenByParent,
    statusRegistry,
  );
  const rankedBlocked = [...report.blocked].sort((left, right) =>
    compareCriticalItems(left.item, right.item, statusRegistry),
  );
  const {
    projectedReady,
    ranking: readyRanking,
    completedContainer,
    packing: readyPacking,
  } = await rankReadyEntriesWithRelevance(
    rankedReady,
    childrenByParent,
    statusRegistry,
    now,
    callerAuthor,
    pmRoot,
    Math.max(192, limit * 128),
  );

  const readyRows = projectedReady.map((entry, index) =>
    toNextActionableItem(entry, statusRegistry, childrenByParent, index + 1),
  );
  const blockedRows = rankedBlocked.map((entry, index) =>
    toNextActionableItem(entry, statusRegistry, childrenByParent, index + 1),
  );
  const decisionRows = rankNextReadyEntries(
    partitionedByDecision.decisions,
    childrenByParent,
    statusRegistry,
  ).map((entry, index) =>
    toNextActionableItem(entry, statusRegistry, childrenByParent, index + 1),
  );

  const recommended = buildNextRecommendation({
    projectedReady,
    readyRows,
    statusRegistry,
    now,
    completedContainer,
  });
  const truncation = buildNextTruncation(
    decisionRows.length,
    callerPartition.held.length,
    limit,
  );

  const result: NextResult = {
    output_default: "toon",
    now,
    recommended,
    ready: readyRows.slice(1, limit + 1),
    decision_needed: decisionRows.slice(0, limit),
    blocked: readyOnly ? [] : blockedRows.slice(0, blockedLimit),
    held_by_others: callerPartition.held.slice(0, limit),
    summary: {
      recommended: recommended !== null,
      ready: readyRows.length,
      blocked: blockedRows.length,
      in_progress: inProgressReadyCount(readyRows, statusRegistry),
      candidates: report.active_count,
      containers: report.container_count,
      decision_needed: decisionRows.length,
      held_by_others: callerPartition.held.length,
    },
    filters: {
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      parent: parentScope.length > 0 ? parentScope : null,
      limit,
      blocked_limit: blockedLimit,
      ready_only: readyOnly,
      include_decisions: options.includeDecisions === true,
    },
    truncation,
  };

  return finalizeNextResult({
    result,
    recommended,
    blockedRows,
    candidatesWarnings: candidatesList.warnings,
    corpusWarnings: corpusList.warnings,
    readyRanking,
    explainRanking: options.explainRanking === true,
    pmRoot,
    author: callerAuthor,
    packing: readyPacking,
  });
}

/**
 * Renders a {@link NextResult} as compact agent-readable markdown: the
 * recommendation with its rationale, the ranked ready queue, and (unless
 * `--ready-only`) the blocked queue annotated with each item's open blockers.
 */
export function renderNextMarkdown(result: NextResult): string {
  const lines: string[] = ["# pm next", "", ...renderNextSummaryLines(result)];
  lines.push(...renderNextSection("Recommended", renderNextRecommendedRows(result.recommended), "No ready work."));
  lines.push(
    ...renderNextSection(
      "Decision needed",
      // `?? []` tolerates JSON payloads from pre-decision-queue builds (the
      // field is newer than the rest of the shape); pinned by a dedicated spec.
      (result.decision_needed ?? []).map((item) => `- ${formatNextLine(item)}`),
      "No human-gated decisions.",
    ),
  );
  lines.push(
    ...renderNextSection(
      "Ready",
      result.ready.map((item) => `- ${formatNextLine(item)}`),
      "No ready items.",
    ),
  );
  if (!result.filters.ready_only) {
    lines.push(
      ...renderNextSection(
        "Blocked",
        result.blocked.map((item) => `- ${formatNextBlockedLine(item)}`),
        "No blocked items.",
      ),
    );
  }
  if (result.suggestions && result.suggestions.length > 0) {
    lines.push("## Suggestions");
    for (const suggestion of result.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return lines.join("\n").trimEnd();
}

// Renders the top-of-report summary bullet block (timestamp, queue counts,
// optional subtree scope) followed by its separating blank line.
function renderNextSummaryLines(result: NextResult): string[] {
  const lines = [
    `- now: ${result.now}`,
    `- ready: ${result.summary.ready} (in_progress: ${result.summary.in_progress}), blocked: ${result.summary.blocked}, candidates: ${result.summary.candidates}`,
  ];
  if (result.filters.parent) {
    lines.push(`- scope: subtree of ${result.filters.parent}`);
  }
  lines.push("");
  return lines;
}

// Renders the recommendation rows (item line + rationale) or nothing when no
// candidate is ready, letting the shared section helper supply the empty state.
function renderNextRecommendedRows(recommended: NextResult["recommended"]): string[] {
  if (!recommended) {
    return [];
  }
  return [`- ${formatNextLine(recommended)}`, `  why: ${recommended.reasons.join("; ")}`];
}

// Renders one markdown queue section: the `##` header, then either the rows or
// the section's empty-state message, closed by a separating blank line.
function renderNextSection(header: string, rows: string[], emptyMessage: string): string[] {
  return [`## ${header}`, ...(rows.length === 0 ? [emptyMessage] : rows), ""];
}

// Formats a blocked row: the standard actionable line annotated with each open
// blocker's id and current status.
function formatNextBlockedLine(item: NextResult["blocked"][number]): string {
  const by = item.blockers
    .map((blocker) => `${blocker.id}(${blocker.status ?? "?"})`)
    .join(", ");
  return `${formatNextLine(item)} blocked_by:${by}`;
}

// Formats a single actionable row: id, priority, status, type, deadline, parent,
// downstream-unblock count, and title. Mirrors the context focus-line shape.
function formatNextLine(item: NextActionableItem): string {
  const deadlineToken = item.deadline ?? "-";
  const parentToken = item.parent ? ` parent:${item.parent}` : "";
  const unblocksToken =
    item.unblocks.length > 0 ? ` unblocks:${item.unblocks.length}` : "";
  const rankToken = Number.isInteger(item.rank) ? `#${item.rank} ` : "";
  return `${rankToken}${item.id} p${item.priority} ${item.status} ${item.type} deadline:${deadlineToken}${parentToken}${unblocksToken} ${item.title}`;
}
