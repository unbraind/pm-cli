import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const sdk = await loadSearchSdkModule();
const {
  EXIT_CODE,
  PmCliError,
  runSearch,
  runReindex,
} = sdk;

async function loadSearchSdkModule() {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-search-advanced requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const loaded = await import(pathToFileURL(modulePath).href);
    if (
      typeof loaded.runSearch === "function" &&
      typeof loaded.runReindex === "function" &&
      typeof loaded.PmCliError === "function" &&
      typeof loaded.EXIT_CODE === "object" &&
      loaded.EXIT_CODE !== null
    ) {
      return loaded;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-search-advanced failed to load SDK runtime exports from ${modulePath}.`,
  );
}

function readStringOption(options, key, aliases = []) {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

const BOOLEAN_TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const BOOLEAN_FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function readBooleanOption(options, key, aliases = []) {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (BOOLEAN_TRUE_VALUES.has(normalized)) {
        return true;
      }
      if (BOOLEAN_FALSE_VALUES.has(normalized)) {
        return false;
      }
    }
  }
  return undefined;
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

function stripSearchOptionTokens(args) {
  const queryTokens = [];
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

function resolveSearchQuery(args) {
  const query = stripSearchOptionTokens(args).join(" ");
  if (query.length === 0) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return query;
}

function normalizeAdvancedSearchOptions(rawOptions, args) {
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

function normalizeReindexOptions(rawOptions) {
  return {
    mode: readStringOption(rawOptions, "mode"),
    progress: readBooleanOption(rawOptions, "progress") === true ? true : undefined,
  };
}

export async function runAdvancedSearchPackage(args, rawOptions, global) {
  return runSearch(resolveSearchQuery(args), normalizeAdvancedSearchOptions(rawOptions, args), global);
}

export async function runAdvancedReindexPackage(rawOptions, global) {
  return runReindex(normalizeReindexOptions(rawOptions), global);
}
