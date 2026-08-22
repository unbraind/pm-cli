/**
 * @module sdk/agent-identity-config
 *
 * Pure and versioned mutation planning for legacy author interpretation. The
 * public summaries deliberately expose counts and revisions, never alias
 * spellings, so config discovery is useful without leaking historical names.
 */

/** Persisted legacy-author interpretation vocabulary. */
export interface AgentIdentityVocabulary {
  /** Monotonic interpretation revision. */
  version: number;
  /** Exact legacy author spelling to canonical harness namespace. */
  aliases: Record<string, string>;
}

/** Privacy-safe vocabulary projection used by config get/list/export. */
export interface AgentIdentityVocabularySummary {
  /** Current interpretation revision. */
  version: number;
  /** Number of exact legacy spellings configured. */
  alias_count: number;
}

/** Supported vocabulary mutations. */
export type AgentIdentityVocabularyOperation = "add" | "remove" | "clear";

/** One typed vocabulary mutation and optional residual-coverage census. */
export interface AgentIdentityVocabularyMutationInput {
  /** Exact operation applied to the vocabulary. */
  operation: AgentIdentityVocabularyOperation;
  /** Exact legacy spelling required by add/remove. */
  legacy_author?: string;
  /** Canonical lowercase harness namespace required by add. */
  canonical_harness?: string;
  /** Optional bounded author census used only to count still-unmapped values. */
  observed_authors?: readonly string[];
}

/** Privacy-safe dry-run or committed mutation preview. */
export interface AgentIdentityVocabularyMutationPreview {
  /** Operation that was evaluated. */
  operation: AgentIdentityVocabularyOperation;
  /** Whether persistence would change. */
  changed: boolean;
  /** Revision before the operation. */
  version_before: number;
  /** Revision after the operation, equal when idempotent. */
  version_after: number;
  /** Alias count after the operation. */
  alias_count: number;
  /** Unique non-canonical authors not covered after the operation. */
  residual_author_count: number;
}

/** Planned vocabulary plus a privacy-safe result preview. */
export interface AgentIdentityVocabularyMutationPlan {
  /** Complete value suitable for settings persistence. */
  vocabulary: AgentIdentityVocabulary;
  /** Public mutation result with no alias spellings. */
  preview: AgentIdentityVocabularyMutationPreview;
}

const HARNESS_NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_AUTHOR_LENGTH = 128;
const MAX_OBSERVED_AUTHORS = 10_000;

function requireLegacyAuthor(value: string | undefined): string {
  const author = value?.trim();
  if (!author || author.length > MAX_AUTHOR_LENGTH) {
    throw new Error(
      `A legacy author must contain 1-${MAX_AUTHOR_LENGTH} characters.`,
    );
  }
  return author;
}

function requireCanonicalHarness(value: string | undefined): string {
  const harness = value?.trim().toLowerCase();
  if (!harness || !HARNESS_NAMESPACE_PATTERN.test(harness)) {
    throw new Error(
      "A canonical harness must be a lowercase dash-separated namespace.",
    );
  }
  return harness;
}

function orderedAliases(aliases: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(aliases).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countResidualAuthors(
  observed: readonly string[] | undefined,
  aliases: Readonly<Record<string, string>>,
): number {
  const residual = new Set<string>();
  for (const raw of (observed ?? []).slice(0, MAX_OBSERVED_AUTHORS)) {
    const author = raw.trim().slice(0, MAX_AUTHOR_LENGTH);
    if (
      author.length === 0 ||
      author.startsWith("harness:") ||
      Object.hasOwn(aliases, author)
    ) {
      continue;
    }
    residual.add(author);
  }
  return residual.size;
}

function applyAddOperation(
  aliases: Record<string, string>,
  input: AgentIdentityVocabularyMutationInput,
): boolean {
  const legacyAuthor = requireLegacyAuthor(input.legacy_author);
  const canonicalHarness = requireCanonicalHarness(input.canonical_harness);
  if (
    legacyAuthor === canonicalHarness ||
    legacyAuthor === `harness:${canonicalHarness}` ||
    legacyAuthor.startsWith("harness:")
  ) {
    throw new Error(
      `The legacy author "${legacyAuthor}" is already canonical and must not be aliased.`,
    );
  }
  if (aliases[legacyAuthor] === canonicalHarness) return false;
  aliases[legacyAuthor] = canonicalHarness;
  return true;
}

function applyVocabularyOperation(
  aliases: Record<string, string>,
  input: AgentIdentityVocabularyMutationInput,
): boolean {
  if (input.operation === "add") return applyAddOperation(aliases, input);
  if (input.operation === "remove") {
    const legacyAuthor = requireLegacyAuthor(input.legacy_author);
    if (!Object.hasOwn(aliases, legacyAuthor)) return false;
    delete aliases[legacyAuthor];
    return true;
  }
  if (input.operation === "clear") {
    const changed = Object.keys(aliases).length > 0;
    for (const key of Object.keys(aliases)) delete aliases[key];
    return changed;
  }
  const exhaustive: never = input.operation;
  throw new Error(`Unsupported vocabulary operation: ${String(exhaustive)}`);
}

/** Return only the revision and count suitable for config discovery surfaces. */
export function summarizeAgentIdentityVocabulary(
  vocabulary: AgentIdentityVocabulary | undefined,
): AgentIdentityVocabularySummary {
  return {
    version: vocabulary?.version ?? 1,
    alias_count: Object.keys(vocabulary?.aliases ?? {}).length,
  };
}

/**
 * Validate and plan one exact mutation. A real change increments the revision
 * exactly once; identical adds and absent removes are idempotent.
 */
export function planAgentIdentityVocabularyMutation(
  current: AgentIdentityVocabulary | undefined,
  input: AgentIdentityVocabularyMutationInput,
): AgentIdentityVocabularyMutationPlan {
  const versionBefore = current?.version ?? 1;
  const aliases = { ...current?.aliases };
  const changed = applyVocabularyOperation(aliases, input);

  const vocabulary = {
    version: changed ? versionBefore + 1 : versionBefore,
    aliases: orderedAliases(aliases),
  };
  return {
    vocabulary,
    preview: {
      operation: input.operation,
      changed,
      version_before: versionBefore,
      version_after: vocabulary.version,
      alias_count: Object.keys(vocabulary.aliases).length,
      residual_author_count: countResidualAuthors(
        input.observed_authors,
        vocabulary.aliases,
      ),
    },
  };
}
