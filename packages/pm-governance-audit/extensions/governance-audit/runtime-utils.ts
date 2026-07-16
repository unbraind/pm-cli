/**
 * @module pm-governance-audit/runtime-utils
 *
 * Shared parsing, comparison, linked-artifact, and result-decoration helpers
 * for the governance-audit extension runtime.
 */
import { EXIT_CODE, PmCliError, PmClient, type ListOptions } from "./sdk.ts";

/** Retain only list filters that the package-owned audit queries may forward. */
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
  const {
    type,
    tag,
    priority,
    deadlineBefore,
    deadlineAfter,
    assignee,
    assigneeFilter,
    parent,
    sprint,
    release,
  } = filters;
  return {
    type,
    tag,
    priority,
    deadlineBefore,
    deadlineAfter,
    assignee,
    assigneeFilter,
    parent,
    sprint,
    release,
  };
}

/** Order valid timestamps chronologically and malformed values lexicographically. */
export function compareTimestampStrings(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs)
    return leftMs - rightMs;
  return left.localeCompare(right);
}

/** Measure set overlap between two token lists on the inclusive zero-to-one scale. */
export function jaccardSimilarity(
  leftTokens: string[],
  rightTokens: string[],
): number {
  if (leftTokens.length === 0 && rightTokens.length === 0) return 1;
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / new Set([...left, ...right]).size;
}

/** Trim, lowercase, and collapse internal whitespace for stable audit comparisons. */
export function normalizeLowercaseWhitespace(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Split normalized text into non-empty lowercase ASCII alphanumeric tokens. */
export function tokenizeAlphaNumeric(value: string): string[] {
  return normalizeLowercaseWhitespace(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Parse an optional non-negative integer limit with package-specific error context. */
export function parseIntegerLimit(
  raw: string | undefined,
  label = "--limit",
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new PmCliError(
      `${label} must be a non-negative integer`,
      EXIT_CODE.USAGE,
    );
  return parsed;
}

/** Normalize an optional comma-separated value into trimmed non-empty entries. */
export function splitCommaList(raw: string | undefined | null): string[] {
  if (raw == null) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Convert thrown values to a concise message suitable for audit result envelopes. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name;
  return String(error);
}

/** Return trimmed non-empty text while rejecting non-string and blank values. */
export function toNonEmptyStringOrUndefined(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/** Inputs used to attribute linked paths to every item that references them. */
export interface LinkedArtifactAuditPayload {
  /** Paths whose reverse-reference attribution should be reported. */
  paths?: string[];
  /** Item identities and linked artifacts used to build the reverse index. */
  items?: Array<{ id: string; artifacts?: Array<{ path: string }> }>;
}

/** Deterministic reverse-reference summary for one linked artifact path. */
export interface LinkedArtifactAuditEntry {
  /** Linked artifact path described by this summary. */
  path: string;
  /** Number of distinct items that reference the path. */
  linked_by_count: number;
  /** Sorted distinct item ids that reference the path. */
  linked_item_ids: string[];
}

/** Build sorted, duplicate-free reverse attribution for requested artifact paths. */
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

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  /** Narrow an unknown payload to a non-null object record. */
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
};

const hasUpdateAuditBypass = (
  options: Record<string, unknown> | undefined,
): boolean => {
  /** Detect every supported update-audit bypass alias. */
  const resolved = options ?? {};
  return (
    resolved.allowAuditUpdate === true ||
    resolved.allow_audit_update === true ||
    resolved.allowAuditDepUpdate === true ||
    resolved.allow_audit_dep_update === true
  );
};

const resolveLinkedArtifactAuditKey = (
  payload: CommandResultPayload,
): "files" | "docs" | undefined => {
  /** Resolve the supported linked-artifact result key for an eligible audit request. */
  if (payload.command !== "files" && payload.command !== "docs") {
    return undefined;
  }
  if (payload.options?.audit !== true || !payload.pm_root) {
    return undefined;
  }
  return payload.command;
};

const decorateLinkedArtifactResult = async (
  payload: CommandResultPayload,
  result: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> => {
  /** Add reverse linked-artifact attribution to eligible files/docs results. */
  const artifactKey = resolveLinkedArtifactAuditKey(payload);
  if (artifactKey === undefined) return undefined;
  const artifacts = Array.isArray(result[artifactKey])
    ? result[artifactKey]
    : [];
  const paths = artifacts.flatMap((entry) => {
    const artifact = asRecord(entry);
    return typeof artifact?.path === "string" ? [artifact.path] : [];
  });
  const listed = await new PmClient({ pmRoot: payload.pm_root }).list({
    status: "all",
    noTruncate: true,
    fields: `id,${artifactKey}`,
  });
  const items = listed.items.flatMap((item) =>
    typeof item.id === "string"
      ? [
          {
            id: item.id,
            artifacts: Array.isArray(item[artifactKey])
              ? item[artifactKey].flatMap((entry) => {
                  const artifact = asRecord(entry);
                  return typeof artifact?.path === "string"
                    ? [{ path: artifact.path }]
                    : [];
                })
              : undefined,
          },
        ]
      : [],
  );
  return {
    ...result,
    audit: buildLinkedArtifactAudit({ paths, items }),
  };
};

const decorateAuditBypassResult = (
  payload: CommandResultPayload,
  result: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  /** Add the package-owned audit marker for explicit update or release bypasses. */
  const isUpdate = ["update", "update-many"].includes(String(payload.command));
  if (isUpdate && hasUpdateAuditBypass(payload.options)) {
    return { ...result, audit_update: true };
  }
  if (
    payload.command === "release" &&
    payload.options?.allowAuditRelease === true
  ) {
    return { ...result, audit_release: true };
  }
  return undefined;
};

/** Add package-owned fields to a completed core command result. */
export const decorateGovernanceCommandResult = async (
  raw: unknown,
): Promise<unknown> => {
  const payload = asRecord(raw) as CommandResultPayload | undefined;
  if (!payload) return undefined;
  const result = asRecord(payload.result);
  if (!result) return payload.result;
  const linkedArtifactResult = await decorateLinkedArtifactResult(
    payload,
    result,
  );
  if (linkedArtifactResult) return linkedArtifactResult;
  return decorateAuditBypassResult(payload, result) ?? result;
};
