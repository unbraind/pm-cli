import { EXIT_CODE, PmCliError, PmClient, type ListOptions } from "./sdk.ts";

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

export interface LinkedArtifactAuditPayload {
  paths?: string[];
  items?: Array<{ id: string; artifacts?: Array<{ path: string }> }>;
}

export interface LinkedArtifactAuditEntry {
  path: string;
  linked_by_count: number;
  linked_item_ids: string[];
}

export function buildLinkedArtifactAudit(
  input: LinkedArtifactAuditPayload,
): LinkedArtifactAuditEntry[] {
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

interface CommandResultPayload {
  command?: string;
  args?: string[];
  options?: Record<string, unknown>;
  pm_root?: string;
  result?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasUpdateAuditBypass(options: Record<string, unknown>): boolean {
  return (
    options.allowAuditUpdate === true ||
    options.allow_audit_update === true ||
    options.allowAuditDepUpdate === true ||
    options.allow_audit_dep_update === true
  );
}

async function decorateLinkedArtifactResult(
  payload: CommandResultPayload,
  result: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (
    (payload.command !== "files" && payload.command !== "docs") ||
    payload.options?.audit !== true ||
    !payload.pm_root
  ) {
    return undefined;
  }
  const artifactKey = payload.command;
  const artifacts = Array.isArray(result[artifactKey])
    ? (result[artifactKey] as Array<{ path?: unknown }>)
    : [];
  const paths = artifacts.flatMap((entry) =>
    typeof entry.path === "string" ? [entry.path] : [],
  );
  const listed = await new PmClient({ pmRoot: payload.pm_root }).list({
    status: "all",
    noTruncate: true,
    fields: `id,${artifactKey}`,
  });
  const items = listed.items.map((item) => ({
    id: item.id,
    artifacts: Array.isArray(item[artifactKey])
      ? (item[artifactKey] as Array<{ path: string }>)
      : undefined,
  }));
  return {
    ...result,
    audit: buildLinkedArtifactAudit({ paths, items }),
  };
}

/** Add package-owned fields to a completed core command result. */
export async function decorateGovernanceCommandResult(
  raw: unknown,
): Promise<unknown> {
  const payload = asRecord(raw) as CommandResultPayload | undefined;
  const result = asRecord(payload?.result);
  const options = payload?.options ?? {};
  if (!payload || !result) return payload?.result;
  const linkedArtifactResult = await decorateLinkedArtifactResult(payload, result);
  if (linkedArtifactResult) return linkedArtifactResult;

  if (
    (payload.command === "update" || payload.command === "update-many") &&
    hasUpdateAuditBypass(options)
  ) {
    return { ...result, audit_update: true };
  }

  if (payload.command === "release" && options.allowAuditRelease === true) {
    return { ...result, audit_release: true };
  }

  return result;
}
