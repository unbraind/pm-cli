import { runAdvancedReindexPackage, runAdvancedSearchPackage } from "./runtime.js";

export const manifest = {
  name: "builtin-search-advanced",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands"],
};

const searchAdvancedFlags = [
  {
    long: "--mode",
    value_name: "value",
    value_type: "string",
    description: "Search mode override: keyword|semantic|hybrid.",
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
];

const reindexFlags = [
  {
    long: "--mode",
    value_name: "value",
    value_type: "string",
    description: "Reindex mode: keyword|semantic|hybrid.",
  },
  {
    long: "--progress",
    value_type: "boolean",
    description: "Emit non-interactive progress lines to stderr.",
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
}

export default {
  manifest,
  activate,
};
