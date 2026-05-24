import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  GlobalOptions,
  ReindexOptions,
  ReindexResult,
  SearchOptions,
  SearchResult,
} from "../../../../src/sdk/runtime.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

interface SearchRuntimeSdkModule {
  EXIT_CODE: {
    USAGE: number;
  };
  PmCliError: new (message: string, exitCode?: number) => Error;
  runSearch: (query: string, options: SearchOptions, global: GlobalOptions) => Promise<SearchResult>;
  runReindex: (options: ReindexOptions, global: GlobalOptions) => Promise<ReindexResult>;
  readStringOption: (options: Record<string, unknown>, key: string, aliases?: string[]) => string | undefined;
  readBooleanOption: (options: Record<string, unknown>, key: string, aliases?: string[]) => boolean | undefined;
}

const sdk = await loadSearchSdkModule();
const {
  EXIT_CODE,
  PmCliError,
  runSearch,
  runReindex,
  readStringOption,
  readBooleanOption,
} = sdk;

async function loadSearchSdkModule(): Promise<SearchRuntimeSdkModule> {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-search-advanced requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<SearchRuntimeSdkModule>;
    if (
      typeof loaded.runSearch === "function" &&
      typeof loaded.runReindex === "function" &&
      typeof loaded.PmCliError === "function" &&
      typeof loaded.readStringOption === "function" &&
      typeof loaded.readBooleanOption === "function" &&
      typeof loaded.EXIT_CODE === "object" &&
      loaded.EXIT_CODE !== null
    ) {
      return loaded as SearchRuntimeSdkModule;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-search-advanced failed to load SDK runtime exports from ${modulePath}.`,
  );
}

const SEARCH_VALUE_FLAGS = new Set([
  "--mode",
  "--type",
  "--tag",
  "--priority",
  "--deadline-before",
  "--deadline_before",
  "--deadline-after",
  "--deadline_after",
  "--limit",
  "--fields",
]);

const SEARCH_BOOLEAN_FLAGS = new Set([
  "--semantic",
  "--hybrid",
  "--include-linked",
  "--include_linked",
  "--title-exact",
  "--title_exact",
  "--phrase-exact",
  "--phrase_exact",
  "--compact",
  "--full",
  "--json",
]);

function stripSearchOptionTokens(args: string[]): string[] {
  const queryTokens: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]?.trim() ?? "";
    const equalsIndex = token.indexOf("=");
    const flagName = equalsIndex > 0 ? token.slice(0, equalsIndex) : token;
    if (SEARCH_VALUE_FLAGS.has(flagName)) {
      if (equalsIndex < 0) {
        index += 1;
      }
      continue;
    }
    if (SEARCH_BOOLEAN_FLAGS.has(flagName)) {
      continue;
    }
    if (token.length > 0) {
      queryTokens.push(token);
    }
  }
  return queryTokens;
}

function resolveSearchQuery(args: string[]): string {
  const query = stripSearchOptionTokens(args).join(" ");
  if (query.length === 0) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return query;
}

function normalizeAdvancedSearchOptions(rawOptions: Record<string, unknown>, args: string[]): SearchOptions {
  const fields = readStringOption(rawOptions, "fields");
  const compactRequested = readBooleanOption(rawOptions, "compact") === true;
  const fullRequested = readBooleanOption(rawOptions, "full") === true;
  const defaultCompact = !compactRequested && !fullRequested && fields === undefined;
  const explicitMode = readStringOption(rawOptions, "mode");
  const argFlags = new Set(args.map((value) => value?.trim() ?? ""));
  const mode =
    explicitMode ??
    (readBooleanOption(rawOptions, "semantic") === true || argFlags.has("--semantic")
      ? "semantic"
      : readBooleanOption(rawOptions, "hybrid") === true || argFlags.has("--hybrid")
        ? "hybrid"
        : "keyword");
  return {
    mode,
    includeLinked: readBooleanOption(rawOptions, "includeLinked", ["include_linked"]) === true ? true : undefined,
    titleExact: readBooleanOption(rawOptions, "titleExact", ["title_exact"]) === true ? true : undefined,
    phraseExact: readBooleanOption(rawOptions, "phraseExact", ["phrase_exact"]) === true ? true : undefined,
    type: readStringOption(rawOptions, "type"),
    tag: readStringOption(rawOptions, "tag"),
    priority: readStringOption(rawOptions, "priority"),
    deadlineBefore: readStringOption(rawOptions, "deadlineBefore", ["deadline_before"]),
    deadlineAfter: readStringOption(rawOptions, "deadlineAfter", ["deadline_after"]),
    limit: readStringOption(rawOptions, "limit"),
    fields,
    compact: compactRequested || defaultCompact ? true : undefined,
    full: fullRequested ? true : undefined,
  };
}

function normalizeReindexOptions(rawOptions: Record<string, unknown>): ReindexOptions {
  return {
    mode: readStringOption(rawOptions, "mode"),
    progress: readBooleanOption(rawOptions, "progress") === true ? true : undefined,
  };
}

export async function runAdvancedSearchPackage(
  args: string[],
  rawOptions: Record<string, unknown>,
  global: GlobalOptions,
): Promise<SearchResult> {
  return runSearch(resolveSearchQuery(args), normalizeAdvancedSearchOptions(rawOptions, args), global);
}

export async function runAdvancedReindexPackage(
  rawOptions: Record<string, unknown>,
  global: GlobalOptions,
): Promise<ReindexResult> {
  return runReindex(normalizeReindexOptions(rawOptions), global);
}
