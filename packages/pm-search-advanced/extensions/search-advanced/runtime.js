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
      if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
        return false;
      }
    }
  }
  return undefined;
}

function resolveSearchQuery(args) {
  const query = args
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(" ");
  if (query.length === 0) {
    throw new PmCliError("Search query must not be empty", EXIT_CODE.USAGE);
  }
  return query;
}

function normalizeAdvancedSearchOptions(rawOptions) {
  const fields = readStringOption(rawOptions, "fields");
  const compactRequested = readBooleanOption(rawOptions, "compact") === true;
  const fullRequested = readBooleanOption(rawOptions, "full") === true;
  const defaultCompact = !compactRequested && !fullRequested && fields === undefined;
  return {
    mode: readStringOption(rawOptions, "mode"),
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
  return runSearch(resolveSearchQuery(args), normalizeAdvancedSearchOptions(rawOptions), global);
}

export async function runAdvancedReindexPackage(rawOptions, global) {
  return runReindex(normalizeReindexOptions(rawOptions), global);
}
