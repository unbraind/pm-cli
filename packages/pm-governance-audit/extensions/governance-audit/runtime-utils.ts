import { EXIT_CODE, PmCliError, type ListOptions } from "./sdk.ts";

export const DEFAULT_CLOSURE_LIKE_METADATA_FIELD_PATTERNS = {
  blocked_reason: ["no active blocker because work is closed", "work is closed"],
  resolution: ["closed with implementation evidence", "closed with verification evidence", "work completed and recorded", "work is closed"],
  actual_result: ["closed and recorded", "work completed", "work completed and recorded"],
} as const;

export function buildListQueryFilters(
  filters: Pick<
    ListOptions,
    | "type"
    | "tag"
    | "priority"
    | "deadlineBefore"
    | "deadlineAfter"
    | "assignee"
    | "assigneeFilter"
    | "parent"
    | "sprint"
    | "release"
  >,
): ListOptions {
  const { type, tag, priority, deadlineBefore, deadlineAfter, assignee, assigneeFilter, parent, sprint, release } = filters;
  return { type, tag, priority, deadlineBefore, deadlineAfter, assignee, assigneeFilter, parent, sprint, release };
}

export function compareTimestampStrings(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
  return left.localeCompare(right);
}

export function jaccardSimilarity(leftTokens: string[], rightTokens: string[]): number {
  if (leftTokens.length === 0 && rightTokens.length === 0) return 1;
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / new Set([...left, ...right]).size;
}

export function normalizeLowercaseWhitespace(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function tokenizeAlphaNumeric(value: string): string[] {
  return normalizeLowercaseWhitespace(value).split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

export function parseIntegerLimit(raw: string | undefined, label = "--limit"): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new PmCliError(`${label} must be a non-negative integer`, EXIT_CODE.USAGE);
  return parsed;
}

export function splitCommaList(raw: string | undefined | null): string[] {
  if (raw == null) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name;
  return String(error);
}

export function toNonEmptyStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildLinkedArtifactAudit(payload: unknown): unknown {
  const input = payload as {
    paths?: string[];
    items?: Array<{ id: string; artifacts?: Array<{ path: string }> }>;
  };
  const index = new Map<string, Set<string>>();
  for (const item of input.items ?? []) {
    for (const artifact of item.artifacts ?? []) {
      const ids = index.get(artifact.path) ?? new Set<string>();
      ids.add(item.id);
      index.set(artifact.path, ids);
    }
  }
  return [...new Set(input.paths ?? [])]
    .sort((left, right) => left.localeCompare(right))
    .map((linkedPath) => {
      const linkedItemIds = [...(index.get(linkedPath) ?? [])].sort(
        (left, right) => left.localeCompare(right),
      );
      return {
        path: linkedPath,
        linked_by_count: linkedItemIds.length,
        linked_item_ids: linkedItemIds,
      };
    });
}
