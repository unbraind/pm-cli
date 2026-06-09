import { runAdvancedReindexPackage, runAdvancedSearchPackage } from "./runtime.js";

export const manifest = {
  name: "builtin-search-advanced",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "search"],
};

export const SEARCH_ADVANCED_LOCAL_PROVIDER = "search-advanced-local";

const SEARCH_FIELD_WEIGHTS = { title: 3, tags: 2, description: 1 };

function tokenizeSearchText(value) {
  // Unicode-aware: keep letters/numbers from any script (é, ü, CJK, Cyrillic, ...)
  // so the provider works for non-English/multilingual corpora.
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function scoreDocumentForQuery(queryTokens, document) {
  const metadata = document?.metadata;
  // A non-string id would crash hits.sort()'s localeCompare; treat as unscoreable.
  if (!metadata || typeof metadata.id !== "string") {
    return { score: 0, matched_fields: [] };
  }
  const fields = [
    { field: "title", tokens: tokenizeSearchText(typeof metadata.title === "string" ? metadata.title : "") },
    {
      field: "tags",
      tokens: Array.isArray(metadata.tags)
        ? metadata.tags.flatMap((tag) => (tag == null ? [] : tokenizeSearchText(String(tag))))
        : [],
    },
    {
      field: "description",
      tokens: tokenizeSearchText(typeof metadata.description === "string" ? metadata.description : ""),
    },
  ];
  let score = 0;
  const matched = [];
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

export function searchAdvancedLocalProvider() {
  return {
    name: SEARCH_ADVANCED_LOCAL_PROVIDER,
    query(context) {
      const queryTokens = tokenizeSearchText(context.query);
      if (queryTokens.length === 0) {
        return [];
      }
      const hits = [];
      for (const document of context.documents) {
        const { score, matched_fields } = scoreDocumentForQuery(queryTokens, document);
        if (score > 0) {
          hits.push({ id: document.metadata.id, score, matched_fields });
        }
      }
      return hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    },
  };
}

const searchAdvancedFlags = [
  {
    long: "--mode",
    value_name: "value",
    value_type: "string",
    description: "Search mode override: keyword|semantic|hybrid.",
  },
  {
    long: "--semantic",
    value_type: "boolean",
    description: "Alias for --mode semantic.",
  },
  {
    long: "--hybrid",
    value_type: "boolean",
    description: "Alias for --mode hybrid.",
  },
  {
    long: "--include-linked",
    value_type: "boolean",
    description: "Include linked docs/files/tests corpus in lexical scoring.",
  },
  {
    long: "--include_linked",
    value_type: "boolean",
    description: "Alias for --include-linked.",
  },
  {
    long: "--title-exact",
    value_type: "boolean",
    description: "Require exact title phrase matching before scoring.",
  },
  {
    long: "--title_exact",
    value_type: "boolean",
    description: "Alias for --title-exact.",
  },
  {
    long: "--phrase-exact",
    value_type: "boolean",
    description: "Require exact phrase match across searchable document fields.",
  },
  {
    long: "--phrase_exact",
    value_type: "boolean",
    description: "Alias for --phrase-exact.",
  },
  {
    long: "--type",
    value_name: "value",
    value_type: "string",
    description: "Filter by item type.",
  },
  {
    long: "--tag",
    value_name: "value",
    value_type: "string",
    description: "Filter by tag.",
  },
  {
    long: "--priority",
    value_name: "value",
    value_type: "string",
    description: "Filter by priority.",
  },
  {
    long: "--deadline-before",
    value_name: "date",
    value_type: "string",
    description: "Filter to items with deadlines before a date.",
  },
  {
    long: "--deadline_before",
    value_name: "date",
    value_type: "string",
    description: "Alias for --deadline-before.",
  },
  {
    long: "--deadline-after",
    value_name: "date",
    value_type: "string",
    description: "Filter to items with deadlines after a date.",
  },
  {
    long: "--deadline_after",
    value_name: "date",
    value_type: "string",
    description: "Alias for --deadline-after.",
  },
  {
    long: "--limit",
    value_name: "count",
    value_type: "string",
    description: "Limit the number of search results.",
  },
  {
    long: "--fields",
    value_name: "list",
    value_type: "string",
    description: "Return only selected result fields.",
  },
  {
    long: "--compact",
    value_type: "boolean",
    description: "Return compact token-efficient search results.",
  },
  {
    long: "--full",
    value_type: "boolean",
    description: "Return full search results.",
  },
];

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
    description: "Run golden-query relevance eval and append nDCG@5 summary output.",
  },
  {
    long: "--eval-fixtures",
    value_name: "path",
    value_type: "string",
    description: "Path to reindex eval fixtures JSON (default: tests/search-eval/golden-queries.json).",
  },
  {
    long: "--eval_fixtures",
    value_name: "path",
    value_type: "string",
    description: "Alias for --eval-fixtures.",
  },
];

function searchAdvancedCommand() {
  return {
    name: "search-advanced",
    action: "search-advanced",
    description: "Enable optional semantic and hybrid search modes via package runtime.",
    arguments: [{ name: "keywords", required: true, variadic: true, description: "Query tokens." }],
    run: async (context) => runAdvancedSearchPackage(context.args, context.options, context.global),
  };
}

function reindexCommand() {
  return {
    name: "reindex",
    action: "reindex",
    description: "Rebuild search artifacts for keyword, semantic, and hybrid modes.",
    flags: [...reindexFlags],
    run: async (context) => runAdvancedReindexPackage(context.options, context.global),
  };
}

export function activate(api) {
  api.registerFlags("search-advanced", [...searchAdvancedFlags]);
  api.registerCommand(searchAdvancedCommand());
  api.registerCommand(reindexCommand());
  api.registerSearchProvider(searchAdvancedLocalProvider());
}

export default {
  manifest,
  activate,
};
