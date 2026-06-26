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
} from "../../core/item/actionability.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { normalizeStatusInput, normalizeStatusForRegistry } from "../../core/item/status.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus } from "../../types/index.js";
import { parseIntegerLimit } from "../shared-parsers.js";
import {
  buildChildrenByParent,
  collectSubtreeIds,
  compareCriticalItems,
  toContextFocusItem,
  type ContextFocusItem,
} from "./context.js";
import { runList, type ListOptions } from "./list.js";

export const NEXT_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
/**
 * Restricts `pm next` output format values accepted by command, SDK, and storage contracts.
 */
export type NextOutputFormat = (typeof NEXT_OUTPUT_VALUES)[number];

const DEFAULT_NEXT_LIMIT = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Documents the `pm next` options payload exchanged by command, SDK, and package integrations.
 */
export interface NextOptions {
  type?: string;
  tag?: string;
  priority?: string;
  assignee?: string;
  assigneeFilter?: string;
  sprint?: string;
  release?: string;
  parent?: string;
  limit?: string;
  blockedLimit?: string;
  readyOnly?: boolean;
  format?: string;
  [key: string]: unknown;
}

/** A blocker reference projected onto the `pm next` output. */
export interface NextBlockerRef {
  id: string;
  title: string | null;
  status: ItemStatus | null;
}

/**
 * A classified actionable item on the `pm next` output: a {@link ContextFocusItem}
 * focus row augmented with its open-blocker references and the downstream items it
 * would unblock.
 */
export interface NextActionableItem extends ContextFocusItem {
  open_blocker_count: number;
  blockers: NextBlockerRef[];
  unblocks: string[];
}

/** The single recommended next item: an actionable row plus its rationale. */
export interface NextRecommendation extends NextActionableItem {
  reasons: string[];
}

interface NextSummary {
  recommended: boolean;
  ready: number;
  blocked: number;
  in_progress: number;
  candidates: number;
  containers: number;
}

/**
 * Documents the `pm next` result payload exchanged by command, SDK, and package integrations.
 */
export interface NextResult {
  output_default: "toon";
  now: string;
  recommended: NextRecommendation | null;
  ready: NextActionableItem[];
  blocked: NextActionableItem[];
  summary: NextSummary;
  filters: {
    type: string | null;
    tag: string | null;
    priority: string | null;
    assignee: string | null;
    assignee_filter: string | null;
    sprint: string | null;
    release: string | null;
    parent: string | null;
    limit: number;
    blocked_limit: number;
    ready_only: boolean;
  };
  suggestions?: string[];
  warnings?: string[];
}

function parseNextOutputFormat(raw: string | undefined): NextOutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!NEXT_OUTPUT_VALUES.includes(normalized as NextOutputFormat)) {
    throw new PmCliError("Next format must be one of markdown|toon|json", EXIT_CODE.USAGE);
  }
  return normalized as NextOutputFormat;
}

/**
 * Resolves the effective `pm next` output format from the command `--format` flag
 * and the global `--json` switch, rejecting the contradictory `--json --format
 * markdown|toon` combination. Defaults to `toon`.
 */
export function resolveNextOutputFormat(options: NextOptions, global: GlobalOptions): NextOutputFormat {
  const commandFormat = parseNextOutputFormat(options.format);
  if (global.json && commandFormat && commandFormat !== "json") {
    throw new PmCliError("Cannot combine --json with --format markdown|toon", EXIT_CODE.USAGE);
  }
  if (global.json) {
    return "json";
  }
  return commandFormat ?? "toon";
}

// Per-section row cap. A non-positive or absent value falls back to the default;
// invalid (non-integer) values throw via parseIntegerLimit.
function parseNextLimit(raw: string | undefined, flag: string, fallback: number): number {
  const parsed = parseIntegerLimit(raw, flag);
  if (parsed === undefined || parsed <= 0) return fallback;
  return parsed;
}

// Projects an actionable entry onto its output row. Ready entries carry no
// blockers; blocked entries surface their unresolved blockers for the agent.
function toNextActionableItem(
  entry: ActionableEntry,
  statusRegistry: RuntimeStatusRegistry,
  childrenByParent: Map<string, ItemFrontMatter[]>,
): NextActionableItem {
  return {
    ...toContextFocusItem(entry.item, statusRegistry, childrenByParent),
    open_blocker_count: entry.open_blockers.length,
    blockers: entry.open_blockers.map((blocker) => ({ id: blocker.id, title: blocker.title, status: blocker.status })),
    unblocks: entry.unblocks,
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
  reasons.push(`priority p${item.priority}${item.priority === 0 ? " (highest)" : ""}`);
  if (typeof item.deadline === "string" && item.deadline.trim().length > 0) {
    reasons.push(describeDeadline(item.deadline, now));
  }
  reasons.push(collectBlockedByIds(item).length > 0 ? "all blockers resolved" : "no blockers");
  if (typeof item.parent === "string" && item.parent.trim().length > 0) {
    reasons.push(`advances ${item.parent.trim()}`);
  }
  if (entry.unblocks.length > 0) {
    reasons.push(`unblocks ${entry.unblocks.length} item(s): ${entry.unblocks.join(", ")}`);
  }
  return reasons;
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
  const days = Math.round((Date.parse(dateToken) - Date.parse(nowToken)) / MS_PER_DAY);
  if (days < 0) return `deadline ${dateToken} (overdue ${-days}d)`;
  if (days === 0) return `deadline ${dateToken} (due today)`;
  return `deadline ${dateToken} (in ${days}d)`;
}

function inProgressReadyCount(ready: NextActionableItem[], statusRegistry: RuntimeStatusRegistry): number {
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  return ready.filter((item) => normalizeStatusForRegistry(item.status, statusRegistry) === inProgressStatus).length;
}

// Returns true when an otherwise-ready item still has terminal descendants. Such
// rows are useful governance closeout context, but concrete leaf work should rank
// ahead of them in the default agent loop.
function hasCompletedDescendants(item: ItemFrontMatter, childrenByParent: Map<string, ItemFrontMatter[]>): boolean {
  return (childrenByParent.get(item.id.trim().toLowerCase()) ?? []).length > 0;
}

// Strips projection/pagination flags so the corpus reads stay full: limits are
// per-section display caps applied after classification, never corpus filters.
function nextListOptions(options: NextOptions, extra: Partial<ListOptions>): ListOptions {
  return {
    type: options.type,
    tag: options.tag,
    priority: options.priority,
    assignee: options.assignee,
    assigneeFilter: options.assigneeFilter,
    sprint: options.sprint,
    release: options.release,
    noTruncate: true,
    ...extra,
  };
}

/**
 * Implements `pm next`: computes the ranked ready/blocked actionable queues and a
 * single recommended next item with rationale for the public runtime surface.
 */
export async function runNext(options: NextOptions, global: GlobalOptions): Promise<NextResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const now = nowIso();
  const limit = parseNextLimit(options.limit, "--limit", DEFAULT_NEXT_LIMIT);
  const blockedLimit = parseNextLimit(options.blockedLimit, "--blocked-limit", limit);
  const readyOnly = options.readyOnly === true;
  const parentScope = typeof options.parent === "string" ? options.parent.trim() : "";

  // Active (non-terminal) candidates honor the caller's filters; the corpus is the
  // FULL, UNFILTERED set (every status, every item) so blocker and descendant
  // resolution still sees items outside the caller's filters or --parent subtree —
  // otherwise a real blocker assigned to someone else (or a parent of a different
  // type) would be missing and the blocked item misread as ready.
  const candidatesList = await runList(undefined, nextListOptions(options, { excludeTerminal: true }), global);
  const corpusList = await runList(undefined, { excludeTerminal: false, noTruncate: true }, global);
  let candidates = candidatesList.items as ItemFrontMatter[];
  const corpus = corpusList.items as ItemFrontMatter[];

  if (parentScope.length > 0) {
    const subtree = collectSubtreeIds(corpus, parentScope);
    if (!subtree.found) {
      throw new PmCliError(`Next --parent item not found: ${parentScope}`, EXIT_CODE.NOT_FOUND);
    }
    candidates = candidates.filter((item) => subtree.ids.has(item.id.trim().toLowerCase()));
  }

  const report = computeActionabilityReport(candidates, corpus, statusRegistry);
  const childrenByParent = buildChildrenByParent(corpus);
  const rankedReady = [...report.ready].sort((left, right) => {
    const leftCompletedContainer = hasCompletedDescendants(left.item, childrenByParent);
    const rightCompletedContainer = hasCompletedDescendants(right.item, childrenByParent);
    if (leftCompletedContainer !== rightCompletedContainer) {
      return Number(leftCompletedContainer) - Number(rightCompletedContainer);
    }
    return compareCriticalItems(left.item, right.item, statusRegistry);
  });
  const rankedBlocked = [...report.blocked].sort((left, right) =>
    compareCriticalItems(left.item, right.item, statusRegistry),
  );

  const readyRows = rankedReady.map((entry) => toNextActionableItem(entry, statusRegistry, childrenByParent));
  const blockedRows = rankedBlocked.map((entry) => toNextActionableItem(entry, statusRegistry, childrenByParent));

  const recommended: NextRecommendation | null =
    rankedReady.length > 0
      ? {
          ...readyRows[0],
          reasons: buildRecommendationReasons(
            rankedReady[0],
            statusRegistry,
            now,
            hasCompletedDescendants(rankedReady[0].item, childrenByParent),
          ),
        }
      : null;

  const result: NextResult = {
    output_default: "toon",
    now,
    recommended,
    ready: readyRows.slice(0, limit),
    blocked: readyOnly ? [] : blockedRows.slice(0, blockedLimit),
    summary: {
      recommended: recommended !== null,
      ready: readyRows.length,
      blocked: blockedRows.length,
      in_progress: inProgressReadyCount(readyRows, statusRegistry),
      candidates: report.active_count,
      containers: report.container_count,
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
    },
  };

  const warnings = [...new Set([...(candidatesList.warnings ?? []), ...(corpusList.warnings ?? [])])].sort((a, b) =>
    a.localeCompare(b),
  );
  if (warnings.length > 0) result.warnings = warnings;

  if (recommended === null) {
    result.suggestions =
      blockedRows.length > 0
        ? [
            `${blockedRows.length} item(s) are blocked; unblock the top one by closing ${blockedRows[0].blockers
              .map((blocker) => blocker.id)
              .join(", ")}`,
            "pm next --ready-only after a blocker closes to re-check ready work",
            'pm create --type Task --title "..." to add new ready work',
          ]
        : [
            'pm create --type Task --title "..." to add a new work item',
            "pm list --status in_progress to review work already underway",
            "pm context --depth deep for the full project snapshot",
          ];
  }

  return result;
}

/**
 * Renders a {@link NextResult} as compact agent-readable markdown: the
 * recommendation with its rationale, the ranked ready queue, and (unless
 * `--ready-only`) the blocked queue annotated with each item's open blockers.
 */
export function renderNextMarkdown(result: NextResult): string {
  const lines: string[] = ["# pm next", ""];
  lines.push(`- now: ${result.now}`);
  lines.push(
    `- ready: ${result.summary.ready} (in_progress: ${result.summary.in_progress}), blocked: ${result.summary.blocked}, candidates: ${result.summary.candidates}`,
  );
  if (result.filters.parent) {
    lines.push(`- scope: subtree of ${result.filters.parent}`);
  }
  lines.push("");

  lines.push("## Recommended");
  if (result.recommended) {
    lines.push(`- ${formatNextLine(result.recommended)}`);
    lines.push(`  why: ${result.recommended.reasons.join("; ")}`);
  } else {
    lines.push("No ready work.");
  }
  lines.push("");

  lines.push("## Ready");
  if (result.ready.length === 0) {
    lines.push("No ready items.");
  } else {
    for (const item of result.ready) {
      lines.push(`- ${formatNextLine(item)}`);
    }
  }
  lines.push("");

  if (!result.filters.ready_only) {
    lines.push("## Blocked");
    if (result.blocked.length === 0) {
      lines.push("No blocked items.");
    } else {
      for (const item of result.blocked) {
        const by = item.blockers
          .map((blocker) => `${blocker.id}(${blocker.status ?? "?"})`)
          .join(", ");
        lines.push(`- ${formatNextLine(item)} blocked_by:${by}`);
      }
    }
    lines.push("");
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push("## Suggestions");
    for (const suggestion of result.suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return lines.join("\n").trimEnd();
}

// Formats a single actionable row: id, priority, status, type, deadline, parent,
// downstream-unblock count, and title. Mirrors the context focus-line shape.
function formatNextLine(item: NextActionableItem): string {
  const deadlineToken = item.deadline ?? "-";
  const parentToken = item.parent ? ` parent:${item.parent}` : "";
  const unblocksToken = item.unblocks.length > 0 ? ` unblocks:${item.unblocks.length}` : "";
  return `${item.id} p${item.priority} ${item.status} ${item.type} deadline:${deadlineToken}${parentToken}${unblocksToken} ${item.title}`;
}
