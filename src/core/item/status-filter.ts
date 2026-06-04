import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../shared/levenshtein.js";
import type { RuntimeStatusRegistry } from "../schema/runtime-schema.js";
import type { ItemStatus } from "../../types/index.js";
import { normalizeStatusInput } from "./status.js";

// Workflow-group aliases shared by every status-filter consumer so that the
// agent-friendly `open`/`closed`/`canceled` shorthands resolve to whatever the
// runtime workflow has configured as its open/close/cancel anchors, rather than
// hardcoding the built-in status ids. `cancelled` is accepted as a spelling
// variant of `canceled`.
const STATUS_GROUP_ALIASES: Readonly<Record<string, "open_status" | "close_status" | "canceled_status">> = {
  open: "open_status",
  closed: "close_status",
  canceled: "canceled_status",
  cancelled: "canceled_status",
};

/**
 * Resolve a single status-filter token to a concrete runtime status id.
 *
 * Returns `undefined` when the token is not a recognized workflow-group alias
 * (open/closed/canceled) and does not normalize to a known registry status.
 * Callers decide whether an unrecognized token is an error (strict mode) or is
 * passed through verbatim (lenient mode) — see {@link parseStatusFilterCsv}.
 */
export function resolveStatusFilterToken(
  token: string,
  registry: RuntimeStatusRegistry,
): ItemStatus | undefined {
  const trimmed = token.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }
  const group = STATUS_GROUP_ALIASES[trimmed];
  if (group) {
    return registry[group] as ItemStatus;
  }
  return normalizeStatusInput(token, registry);
}

function collectStatusSuggestionCandidates(registry: RuntimeStatusRegistry): string[] {
  const candidates = new Set<string>(Object.keys(STATUS_GROUP_ALIASES));
  for (const definition of registry.definitions) {
    candidates.add(definition.id);
    for (const alias of definition.aliases) {
      candidates.add(alias);
    }
  }
  return [...candidates];
}

function suggestClosestStatus(value: string, registry: RuntimeStatusRegistry): string | undefined {
  // Only ever called for an unresolved, already-non-empty token (parseStatusFilterCsv
  // filters blanks first), so no empty-input guard is needed here.
  const normalized = value.trim().toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of collectStatusSuggestionCandidates(registry)) {
    const distance = levenshteinDistanceWithinLimit(normalized, candidate.toLowerCase(), 2);
    if (distance !== null && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ParseStatusFilterOptions {
  /**
   * When true, an unrecognized token throws a USAGE error with a did-you-mean
   * hint. When false (default), an unrecognized token is passed through
   * verbatim so custom/unknown statuses still compare against item values by
   * their raw string — preserving the long-standing lenient `pm list` behavior.
   */
  strict?: boolean;
  /** Flag label used in error messages (default: "--status"). */
  flagLabel?: string;
}

/**
 * Parse a comma-separated status filter into a de-duplicated list of concrete
 * status ids. Shared by `pm list` (lenient) and `pm search` (strict, with a
 * did-you-mean hint on typos) so both surfaces resolve the open/closed/canceled
 * workflow-group aliases identically.
 */
export function parseStatusFilterCsv(
  raw: unknown,
  registry: RuntimeStatusRegistry,
  options?: ParseStatusFilterOptions,
): ItemStatus[] | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const strict = options?.strict === true;
  const flagLabel = options?.flagLabel ?? "--status";
  const tokens = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }
  const resolved: ItemStatus[] = [];
  for (const token of tokens) {
    const status = resolveStatusFilterToken(token, registry);
    if (status === undefined) {
      if (strict) {
        const suggestion = suggestClosestStatus(token, registry);
        throw new PmCliError(
          `Invalid ${flagLabel} value "${token}". Use open|closed|canceled or a configured status id${
            suggestion ? `. Did you mean "${suggestion}"?` : "."
          }`,
          EXIT_CODE.USAGE,
        );
      }
      resolved.push(token as ItemStatus);
      continue;
    }
    resolved.push(status);
  }
  return [...new Set(resolved)];
}
