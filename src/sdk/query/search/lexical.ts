/**
 * @module sdk/query/search/lexical
 * Scores lexical matches and produces snippets from the same searchable field definitions.
 */
import { isTerminalStatus } from "../../../core/item/status.js";
import {
  type RuntimeStatusRegistry
} from "../../../core/schema/runtime-schema.js";
import {
  buildEventCorpus,
  buildPlanFlatCorpus,
  buildReminderCorpus
} from "../../../core/search/corpus.js";
import { tokenizeAlphaNumeric } from "../../../core/shared/text-normalization.js";
import {
  compareTimestampStrings
} from "../../../core/shared/time.js";
import type {
  ItemDocument,
  ItemMetadata
} from "../../../types/index.js";
import {
  normalizeSearchPhrase,
  type SearchTuning
} from "../search-contracts.js";
import { dependencyEntries,stringArray,textEntries } from "./filters.js";
import type { SearchHit,SearchHitHighlight } from "./types.js";

const LONG_QUERY_TOKEN_THRESHOLD = 2;

const LONG_QUERY_TITLE_EXACT_BONUS = 120;

const LONG_QUERY_PHRASE_MULTIPLIER = 6;

// GH-181: in default (OR) match mode, multi-token queries that match EVERY
// distinct query token in some searchable field get an additive ranking bonus so
// items covering all terms outrank items matching only a subset. This is a
// RANKING preference, not a hard filter (use --match-mode and for that).
const ALL_TERMS_COVERAGE_BONUS = 40;

const EXACT_ID_MATCH_SCORE = 1_000;

const SHORT_ID_MATCH_SCORE = 900;

// GH-157 matched-text highlighting (--highlight): markers wrapping each matching
// token run, and the number of characters of surrounding context retained on
// each side of the first match in a field. The «…» guillemets are single
// characters with negligible collision risk against item text, keeping the
// snippet token-cheap while staying visually unambiguous for agents.
const HIGHLIGHT_OPEN = "«";

const HIGHLIGHT_CLOSE = "»";

const HIGHLIGHT_SNIPPET_RADIUS = 60;

/** Count query-token occurrences in a searchable field for lexical scoring. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const foundAt = haystack.indexOf(needle, index);
    if (foundAt < 0) {
      return count;
    }
    count += 1;
    index = foundAt + needle.length;
  }
}



/**
 * Canonical definition of the document-derived searchable fields shared by the
 * lexical scorer ({@link scoreDocument}) and the matched-text highlighter
 * ({@link buildHitHighlights}). Keeping a single source of field name → text
 * extractor → tuning weight guarantees the highlighter can only ever produce
 * snippets for fields the scorer actually inspected. The `linked_content` field
 * is appended separately by the scorer because its text is supplied per-query
 * rather than derived from the document.
 */
const SEARCHABLE_FIELD_BUILDERS: ReadonlyArray<{
  name: string;
  weightKey: keyof SearchTuning;
  value: (document: ItemDocument) => string;
}> = [
  {
    name: "title",
    weightKey: "title_weight",
    value: (document) => document.metadata.title,
  },
  {
    name: "description",
    weightKey: "description_weight",
    value: (document) => document.metadata.description,
  },
  {
    name: "tags",
    weightKey: "tags_weight",
    value: (document) => stringArray(document.metadata.tags).join(" "),
  },
  {
    name: "status",
    weightKey: "status_weight",
    value: (document) =>
      typeof document.metadata.status === "string"
        ? document.metadata.status
        : "",
  },
  {
    name: "body",
    weightKey: "body_weight",
    value: (document) => document.body,
  },
  {
    name: "comments",
    weightKey: "comments_weight",
    value: (document) =>
      textEntries(document.metadata.comments)
        .map((entry) => entry.text)
        .join(" "),
  },
  {
    name: "notes",
    weightKey: "notes_weight",
    value: (document) =>
      textEntries(document.metadata.notes)
        .map((entry) => entry.text)
        .join(" "),
  },
  {
    name: "learnings",
    weightKey: "learnings_weight",
    value: (document) =>
      textEntries(document.metadata.learnings)
        .map((entry) => entry.text)
        .join(" "),
  },
  {
    name: "reminders",
    weightKey: "reminders_weight",
    value: (document) => buildReminderCorpus(document.metadata).join(" "),
  },
  {
    name: "events",
    weightKey: "events_weight",
    value: (document) => buildEventCorpus(document.metadata).join(" "),
  },
  {
    name: "dependencies",
    weightKey: "dependencies_weight",
    value: (document) =>
      dependencyEntries(document.metadata.dependencies)
        .map((entry) => `${entry.id} ${entry.kind}`)
        .join(" "),
  },
  {
    name: "plan",
    weightKey: "body_weight",
    value: (document) => buildPlanFlatCorpus(document.metadata),
  },
];

// Name → builder index so the highlighter can resolve a matched field to its
// text extractor in O(1) and evaluate ONLY the matched fields' values, instead
// of materializing all twelve (several of which join/build corpora) per hit.
const SEARCHABLE_FIELD_BUILDER_BY_NAME = new Map(
  SEARCHABLE_FIELD_BUILDERS.map((builder) => [builder.name, builder]),
);



/**
 * Wrap every case-insensitive occurrence of any query token in `text` with the
 * {@link HIGHLIGHT_OPEN}/{@link HIGHLIGHT_CLOSE} markers. Token boundaries follow
 * the same substring semantics as the lexical scorer (a token highlights inside
 * longer words, matching how it scored), and overlapping matches are coalesced
 * by the single combined alternation so markers never nest.
 */
function markTokenRuns(text: string, tokens: string[]): string {
  // Sort by length descending before building the alternation so a longer token
  // wins over a shorter token that is its prefix (regex alternation is greedy
  // left-to-right, so `auth|authority` would mark «auth»ority instead of
  // «authority»). `.filter` already returns a fresh array, so the in-place sort
  // never mutates the caller's token list.
  const escaped = tokens
    .filter((token) => token.length > 0)
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) {
    return text;
  }
  const pattern = new RegExp(escaped.join("|"), "gi");
  return text.replace(
    pattern,
    (match) => `${HIGHLIGHT_OPEN}${match}${HIGHLIGHT_CLOSE}`,
  );
}

/**
 * Build a single highlighted snippet for one field value (GH-157), or null when
 * no token matches. The snippet is a window of {@link HIGHLIGHT_SNIPPET_RADIUS}
 * characters on each side of the first match with the matching token runs
 * wrapped in markers, prefixed/suffixed with an ellipsis when the field text was
 * trimmed. Returning null lets the caller skip fields with no concrete textual
 * match (e.g. a field flagged purely by the phrase-coverage bonus).
 */
function highlightFieldSnippet(text: string, tokens: string[]): string | null {
  if (text.length === 0) {
    return null;
  }
  const lowerText = text.toLowerCase();
  let firstMatchIndex = -1;
  let firstMatchLength = 0;
  for (const token of tokens) {
    if (token.length === 0) {
      continue;
    }
    const index = lowerText.indexOf(token);
    if (index >= 0 && (firstMatchIndex < 0 || index < firstMatchIndex)) {
      firstMatchIndex = index;
      firstMatchLength = token.length;
    }
  }
  if (firstMatchIndex < 0) {
    return null;
  }
  const windowStart = Math.max(0, firstMatchIndex - HIGHLIGHT_SNIPPET_RADIUS);
  const windowEnd = Math.min(
    text.length,
    firstMatchIndex + firstMatchLength + HIGHLIGHT_SNIPPET_RADIUS,
  );
  const marked = markTokenRuns(text.slice(windowStart, windowEnd), tokens);
  const prefix = windowStart > 0 ? "…" : "";
  const suffix = windowEnd < text.length ? "…" : "";
  return `${prefix}${marked}${suffix}`;
}

/** Produce per-field matched-text snippets for a hit (GH-157, `--highlight`). Iterates the hit's already-sorted `matched_fields`, retains only the document-derived searchable fields (skipping synthetic markers like `id`, `semantic`, `rerank`, and `linked_content`), and emits a snippet for each field that still contains a concrete token match. */
function buildHitHighlights(
  document: ItemDocument,
  matchedFields: string[],
  tokens: string[],
): SearchHitHighlight[] {
  const highlights: SearchHitHighlight[] = [];
  for (const field of matchedFields) {
    const builder = SEARCHABLE_FIELD_BUILDER_BY_NAME.get(field);
    if (builder === undefined) {
      continue;
    }
    const snippet = highlightFieldSnippet(builder.value(document), tokens);
    if (snippet !== null) {
      highlights.push({ field, snippet });
    }
  }
  return highlights;
}

interface SearchableScoringField {
  name: string;
  value: string;
  weight: number;
}

interface SearchScoreState {
  score: number;
  matched: Set<string>;
  matchedTokens: Set<string>;
}

function buildSearchableScoringFields(
  document: ItemDocument,
  linkedCorpus: string,
  tuning: SearchTuning,
): SearchableScoringField[] {
  return [
    ...SEARCHABLE_FIELD_BUILDERS.map((builder) => ({
      name: builder.name,
      value: builder.value(document),
      weight: tuning[builder.weightKey],
    })),
    {
      name: "linked_content",
      value: linkedCorpus,
      weight: tuning.linked_content_weight,
    },
  ];
}

function buildExactIdSearchHit(
  item: ItemMetadata,
  normalizedQuery: string,
  idPrefix: string,
): SearchHit | null {
  const normalizedId = normalizeSearchPhrase(item.id);
  const normalizedIdPrefix =
    typeof idPrefix === "string" ? idPrefix.trim().toLowerCase() : "";
  const normalizedIdPrefixPhrase = normalizeSearchPhrase(normalizedIdPrefix);
  const normalizedShortId =
    normalizedIdPrefixPhrase.length > 0 &&
    normalizedId.startsWith(normalizedIdPrefixPhrase)
      ? normalizedId.slice(normalizedIdPrefixPhrase.length).trim()
      : normalizedId;
  if (
    normalizedQuery !== normalizedId &&
    normalizedQuery !== normalizedShortId
  ) {
    return null;
  }
  return {
    item,
    score:
      normalizedQuery === normalizedId
        ? EXACT_ID_MATCH_SCORE
        : SHORT_ID_MATCH_SCORE,
    matched_fields: ["id"],
    matched_all_terms: true,
    exact_id_match: true,
  };
}

function scoreTokenMatches(
  tokens: string[],
  titleTokenCounts: Map<string, number>,
  searchableFields: SearchableScoringField[],
  tuning: SearchTuning,
  state: SearchScoreState,
): void {
  for (const token of tokens) {
    const exactTitleMatches = titleTokenCounts.get(token) ?? 0;
    if (exactTitleMatches > 0) {
      state.score += exactTitleMatches * tuning.title_exact_bonus;
      state.matched.add("title");
      state.matchedTokens.add(token);
    }
    for (const field of searchableFields) {
      const occurrences = countOccurrences(field.value.toLowerCase(), token);
      if (occurrences > 0) {
        state.score += occurrences * field.weight;
        state.matched.add(field.name);
        state.matchedTokens.add(token);
      }
    }
  }
}

function scorePhraseMatches(
  item: ItemMetadata,
  normalizedQuery: string,
  searchableFields: SearchableScoringField[],
  state: SearchScoreState,
): void {
  const normalizedTitle = normalizeSearchPhrase(item.title);
  if (normalizedTitle === normalizedQuery) {
    state.score += LONG_QUERY_TITLE_EXACT_BONUS;
    state.matched.add("title");
  }
  for (const field of searchableFields) {
    const phraseOccurrences = countOccurrences(
      normalizeSearchPhrase(field.value),
      normalizedQuery,
    );
    if (phraseOccurrences > 0) {
      state.score +=
        phraseOccurrences * field.weight * LONG_QUERY_PHRASE_MULTIPLIER;
      state.matched.add(field.name);
    }
  }
}

/** Score one item using weighted fields and the exact-ID ranking guarantee. */
function scoreDocument(
  document: ItemDocument,
  tokens: string[],
  normalizedQuery: string,
  linkedCorpus: string,
  tuning: SearchTuning,
  idPrefix: string,
  applyCoverageBonus = false,
): SearchHit | null {
  const item = document.metadata;
  const exactIdHit = buildExactIdSearchHit(item, normalizedQuery, idPrefix);
  if (exactIdHit) {
    return exactIdHit;
  }
  const titleTokenCounts = new Map<string, number>();
  for (const token of tokenizeAlphaNumeric(item.title)) {
    titleTokenCounts.set(token, (titleTokenCounts.get(token) ?? 0) + 1);
  }
  const searchableFields = buildSearchableScoringFields(
    document,
    linkedCorpus,
    tuning,
  );
  const state: SearchScoreState = {
    score: 0,
    matched: new Set(),
    matchedTokens: new Set(),
  };
  scoreTokenMatches(tokens, titleTokenCounts, searchableFields, tuning, state);
  const distinctTokens = new Set(tokens);
  // matchedTokens only ever holds entries drawn from `tokens`, so it is always a
  // subset of distinctTokens — exact size equality means every distinct term matched.
  const matchedAllTerms =
    distinctTokens.size > 0 && state.matchedTokens.size === distinctTokens.size;
  // GH-181 default-mode all-terms ranking bonus: only meaningful for multi-token
  // queries where every distinct token matched somewhere.
  if (applyCoverageBonus && distinctTokens.size > 1 && matchedAllTerms) {
    state.score += ALL_TERMS_COVERAGE_BONUS;
  }

  const isLongPhraseQuery =
    tokens.length >= LONG_QUERY_TOKEN_THRESHOLD &&
    normalizedQuery.includes(" ");
  if (isLongPhraseQuery) {
    scorePhraseMatches(item, normalizedQuery, searchableFields, state);
  }

  if (state.score <= 0) {
    return null;
  }

  return {
    item,
    score: state.score,
    matched_fields: [...state.matched].sort((a, b) => a.localeCompare(b)),
    matched_all_terms: matchedAllTerms,
  };
}

/** Order hits by descending relevance with deterministic item tie breakers. */
function sortHits(
  items: SearchHit[],
  statusRegistry: RuntimeStatusRegistry,
): SearchHit[] {
  return [...items].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    const aTerminal = isTerminalStatus(a.item.status, statusRegistry);
    const bTerminal = isTerminalStatus(b.item.status, statusRegistry);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
    const byPriority = a.item.priority - b.item.priority;
    if (byPriority !== 0) return byPriority;
    const byUpdated = compareTimestampStrings(
      b.item.updated_at,
      a.item.updated_at,
    );
    if (byUpdated !== 0) return byUpdated;
    return a.item.id.localeCompare(b.item.id);
  });
}

/** Compute the lexical contribution used when blending keyword and semantic relevance. */
function buildHybridLexicalScore(
  document: ItemDocument,
  tokens: string[],
  normalizedQuery: string,
  includeLinked: boolean,
  linkedCorpusById: Map<string, string>,
  tuning: SearchTuning,
  idPrefix: string,
  applyCoverageBonus = false,
): SearchHit | null {
  /* c8 ignore start -- linked corpus presence branch is covered by keyword/hybrid integration query tests */
  return scoreDocument(
    document,
    tokens,
    normalizedQuery,
    includeLinked ? (linkedCorpusById.get(document.metadata.id) ?? "") : "",
    tuning,
    idPrefix,
    applyCoverageBonus,
  );
  /* c8 ignore stop */
}

/** Normalize provider score ranges before combining retrieval results. */
function normalizeScoreMap(
  scoreById: Map<string, number>,
): Map<string, number> {
  if (scoreById.size === 0) {
    return new Map();
  }
  const values = [...scoreById.values()];
  const minScore = Math.min(...values);
  const maxScore = Math.max(...values);
  if (maxScore === minScore) {
    return new Map([...scoreById.keys()].map((id) => [id, 1]));
  }
  const normalized = new Map<string, number>();
  for (const [id, score] of scoreById) {
    normalized.set(id, (score - minScore) / (maxScore - minScore));
  }
  return normalized;
}

export { buildHitHighlights,buildHybridLexicalScore,countOccurrences,highlightFieldSnippet,markTokenRuns,normalizeScoreMap,scoreDocument,sortHits };
