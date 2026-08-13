/**
 * Runtime contracts and behavior for packages/pm search advanced/extensions/search advanced/index.
 *
 * @module packages/pm-search-advanced/extensions/search-advanced/index
 */
import type {
  CommandDefinition,
  ExtensionApi,
  ItemDocument,
  SearchProviderDefinition,
  SearchProviderHit,
  SearchProviderQueryContext,
} from "@unbrained/pm-cli/sdk";
import {
  runAdvancedReindexPackage,
  runAdvancedSearchPackage,
  SEARCH_EXTENSION_FLAG_DEFINITIONS,
} from "./runtime.ts";

/** Declarative package manifest consumed by the extension loader. */
export const manifest = {
  name: "builtin-search-advanced",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "search"],
};

/** Provider name selected via `pm config set search.provider search-advanced-local`. Core search invokes the registered `query` when this name is configured. */
export const SEARCH_ADVANCED_LOCAL_PROVIDER = "search-advanced-local";

const SEARCH_FIELD_WEIGHTS = { title: 3, tags: 2, description: 1 } as const;

function tokenizeSearchText(value: string): string[] {
  // Unicode-aware: keep letters/numbers from any script (é, ü, CJK, Cyrillic, ...)
  // so the provider works for non-English/multilingual corpora.
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function scoreDocumentForQuery(
  queryTokens: readonly string[],
  document: ItemDocument,
): { score: number; matched_fields: string[] } {
  const metadata = document?.metadata;
  // A non-string id would crash hits.sort()'s localeCompare; treat as unscoreable.
  if (!metadata || typeof metadata.id !== "string") {
    return { score: 0, matched_fields: [] };
  }
  const fields: Array<{
    field: keyof typeof SEARCH_FIELD_WEIGHTS;
    tokens: string[];
  }> = [
    {
      field: "title",
      tokens: tokenizeSearchText(
        typeof metadata.title === "string" ? metadata.title : "",
      ),
    },
    {
      field: "tags",
      tokens: Array.isArray(metadata.tags)
        ? metadata.tags.flatMap((tag) =>
            tag == null ? [] : tokenizeSearchText(String(tag)),
          )
        : [],
    },
    {
      field: "description",
      tokens: tokenizeSearchText(
        typeof metadata.description === "string" ? metadata.description : "",
      ),
    },
  ];
  let score = 0;
  const matched: string[] = [];
  for (const { field, tokens } of fields) {
    const available = new Set(tokens);
    let fieldMatches = 0;
    for (const queryToken of queryTokens) {
      if (available.has(queryToken)) {
        fieldMatches += 1;
      }
    }
    if (fieldMatches > 0) {
      score += fieldMatches * SEARCH_FIELD_WEIGHTS[field];
      matched.push(field);
    }
  }
  return { score, matched_fields: matched };
}

/** First-party exemplar SearchProvider: a deterministic, dependency-free local lexical ranker over the in-memory document corpus. Core search calls `query` when `settings.search.provider === "search-advanced-local"`. Authors building embedding-backed providers (for example Ollama or a hosted model) implement `embed`/`embedBatch` on this same SearchProviderDefinition shape instead. */
export function searchAdvancedLocalProvider(): SearchProviderDefinition {
  return {
    name: SEARCH_ADVANCED_LOCAL_PROVIDER,
    query(context: SearchProviderQueryContext): SearchProviderHit[] {
      const queryTokens = tokenizeSearchText(context.query);
      if (queryTokens.length === 0) {
        return [];
      }
      const hits: SearchProviderHit[] = [];
      for (const document of context.documents) {
        const { score, matched_fields } = scoreDocumentForQuery(
          queryTokens,
          document,
        );
        if (score > 0) {
          hits.push({ id: document.metadata.id, score, matched_fields });
        }
      }
      return hits.sort(
        (left, right) =>
          right.score - left.score || left.id.localeCompare(right.id),
      );
    },
  };
}

const reindexFlags = [
  {
    long: "--mode",
    value_name: "value",
    value_type: "string",
    description: "Reindex mode: keyword|semantic|hybrid.",
  },
  {
    long: "--full",
    value_type: "boolean",
    description:
      "Force full semantic/hybrid embedding rebuild; by default semantic/hybrid reindex only embeds stale items.",
  },
  {
    long: "--progress",
    value_type: "boolean",
    description: "Emit non-interactive progress lines to stderr.",
  },
  {
    long: "--eval",
    value_type: "boolean",
    description:
      "Run golden-query relevance eval and append nDCG@5 summary output.",
  },
  {
    long: "--eval-fixtures",
    value_name: "path",
    value_type: "string",
    description:
      "Path to reindex eval fixtures JSON (default: tests/search-eval/golden-queries.json).",
  },
  {
    long: "--eval_fixtures",
    value_name: "path",
    value_type: "string",
    description: "Alias for --eval-fixtures.",
  },
] as const;

function searchAdvancedCommand(): CommandDefinition {
  return {
    name: "search-advanced",
    action: "search-advanced",
    description:
      "Enable optional semantic and hybrid search modes via package runtime.",
    intent: "Search work with package-provided semantic or hybrid retrieval.",
    arguments: [
      {
        name: "keywords",
        required: true,
        variadic: true,
        description: "Query tokens.",
      },
    ],
    run: async (context) =>
      runAdvancedSearchPackage(context.args, context.options, context.global),
  };
}

function reindexCommand(): CommandDefinition {
  return {
    name: "reindex",
    action: "reindex",
    description:
      "Rebuild search artifacts for keyword, semantic, and hybrid modes.",
    intent: "Refresh search indexes and optionally evaluate retrieval quality.",
    flags: [...reindexFlags],
    run: async (context) =>
      runAdvancedReindexPackage(context.options, context.global),
  };
}

/** Registers this package's commands, actions, and runtime hooks with the host. */
export function activate(api: ExtensionApi): void {
  api.registerFlags("search-advanced", [
    ...SEARCH_EXTENSION_FLAG_DEFINITIONS,
  ]);
  api.registerCommand(searchAdvancedCommand());
  api.registerCommand(reindexCommand());
  api.registerSearchProvider(searchAdvancedLocalProvider());
}

export default {
  manifest,
  activate,
};
