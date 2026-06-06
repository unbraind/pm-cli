import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const DEFAULT_EVAL_FIXTURES_PATH = path.join("tests", "search-eval", "golden-queries.json");
const DEFAULT_EVAL_MIN_NDCG_AT_5 = 0.7;
const EVAL_RANK_CUTOFF = 5;
const VALID_EVAL_SEARCH_MODES = new Set(["keyword", "semantic", "hybrid"]);

const sdk = await loadSearchSdkModule();
const {
  EXIT_CODE,
  PmCliError,
  runSearch,
  runReindex,
  readStringOption,
  readBooleanOption,
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
      typeof loaded.readStringOption === "function" &&
      typeof loaded.readBooleanOption === "function" &&
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

function normalizeEvalFixturePath(rawPath) {
  const candidate = typeof rawPath === "string" ? rawPath : DEFAULT_EVAL_FIXTURES_PATH;
  return path.resolve(process.cwd(), candidate);
}

function normalizeReindexRuntimeOptions(rawOptions) {
  const reindex = normalizeReindexOptions(rawOptions);
  const evalEnabled = readBooleanOption(rawOptions, "eval") === true;
  const evalFixturePath = readStringOption(rawOptions, "evalFixtures", ["eval_fixtures"]);
  if (!evalEnabled) {
    if (typeof evalFixturePath === "string" && evalFixturePath.trim().length > 0) {
      throw new PmCliError("`--eval-fixtures` requires `--eval`.", EXIT_CODE.USAGE);
    }
    return { reindex };
  }
  return {
    reindex,
    eval: {
      fixturesPath: normalizeEvalFixturePath(evalFixturePath),
    },
  };
}

function toScoreAtRank(relevance, rankIndex) {
  if (relevance <= 0) {
    return 0;
  }
  return (2 ** relevance - 1) / Math.log2(rankIndex + 2);
}

function roundMetric(value) {
  return Math.round(value * 10_000) / 10_000;
}

function toCompactExpectedIds(value, fixtureLabel, fixturesPath) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PmCliError(
      `Reindex eval fixture ${fixtureLabel} in ${fixturesPath} must provide a non-empty expected_top_ids array.`,
      EXIT_CODE.USAGE,
    );
  }
  const expectedIds = value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (expectedIds.length === 0) {
    throw new PmCliError(
      `Reindex eval fixture ${fixtureLabel} in ${fixturesPath} must provide at least one non-empty expected_top_ids value.`,
      EXIT_CODE.USAGE,
    );
  }
  return [...new Set(expectedIds)];
}

function normalizeFixtureMode(rawMode, fixtureLabel, fixturesPath) {
  if (rawMode === undefined) {
    return "keyword";
  }
  const normalized = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : "";
  if (VALID_EVAL_SEARCH_MODES.has(normalized)) {
    return normalized;
  }
  throw new PmCliError(
    `Reindex eval fixture ${fixtureLabel} in ${fixturesPath} has unsupported mode "${String(rawMode)}". Expected keyword|semantic|hybrid.`,
    EXIT_CODE.USAGE,
  );
}

function normalizeFixtureThreshold(rawValue, fixtureLabel, fixturesPath) {
  if (rawValue === undefined) {
    return DEFAULT_EVAL_MIN_NDCG_AT_5;
  }
  const parsed = typeof rawValue === "number" ? rawValue : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new PmCliError(
      `Reindex eval fixture ${fixtureLabel} in ${fixturesPath} has invalid min_ndcg_at_5; expected a number between 0 and 1.`,
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

function normalizeFixtureEntry(rawFixture, index, fixturesPath) {
  if (!rawFixture || typeof rawFixture !== "object") {
    throw new PmCliError(
      `Reindex eval fixture at index ${index + 1} in ${fixturesPath} must be an object.`,
      EXIT_CODE.USAGE,
    );
  }
  const rawQuery = typeof rawFixture.query === "string" ? rawFixture.query.trim() : "";
  if (rawQuery.length === 0) {
    throw new PmCliError(
      `Reindex eval fixture at index ${index + 1} in ${fixturesPath} must provide a non-empty query.`,
      EXIT_CODE.USAGE,
    );
  }
  const fallbackName = `fixture-${index + 1}`;
  const fixtureName =
    typeof rawFixture.name === "string" && rawFixture.name.trim().length > 0 ? rawFixture.name.trim() : fallbackName;
  return {
    name: fixtureName,
    query: rawQuery,
    mode: normalizeFixtureMode(rawFixture.mode, fixtureName, fixturesPath),
    expected_top_ids: toCompactExpectedIds(rawFixture.expected_top_ids, fixtureName, fixturesPath),
    min_ndcg_at_5: normalizeFixtureThreshold(rawFixture.min_ndcg_at_5, fixtureName, fixturesPath),
  };
}

function normalizeFixtureCollection(parsed, fixturesPath) {
  const parsedObject = parsed && typeof parsed === "object" ? parsed : null;
  const candidateFixtures = Array.isArray(parsed)
    ? parsed
    : parsedObject && Array.isArray(parsedObject.fixtures)
      ? parsedObject.fixtures
      : null;
  if (!candidateFixtures) {
    throw new PmCliError(
      `Reindex eval fixtures at ${fixturesPath} must be an array or an object with a fixtures array.`,
      EXIT_CODE.USAGE,
    );
  }
  if (candidateFixtures.length === 0) {
    throw new PmCliError(`Reindex eval fixtures at ${fixturesPath} must contain at least one fixture.`, EXIT_CODE.USAGE);
  }
  return candidateFixtures.map((entry, index) => normalizeFixtureEntry(entry, index, fixturesPath));
}

async function loadEvalFixtures(fixturesPath) {
  let rawText = "";
  try {
    rawText = await readFile(fixturesPath, "utf8");
  } catch {
    throw new PmCliError(`Unable to read reindex eval fixtures at ${fixturesPath}.`, EXIT_CODE.USAGE);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new PmCliError(`Reindex eval fixtures at ${fixturesPath} must be valid JSON.`, EXIT_CODE.USAGE);
  }
  return normalizeFixtureCollection(parsed, fixturesPath);
}

function computeNdcgAt5(actualIds, expectedIds) {
  const expectedTop = expectedIds.slice(0, EVAL_RANK_CUTOFF);
  const relevanceById = new Map();
  for (let index = 0; index < expectedTop.length; index += 1) {
    relevanceById.set(expectedTop[index], expectedTop.length - index);
  }
  const dcg = actualIds.slice(0, EVAL_RANK_CUTOFF).reduce((sum, id, index) => {
    const relevance = relevanceById.get(id) ?? 0;
    return sum + toScoreAtRank(relevance, index);
  }, 0);
  const idealDcg = expectedTop.reduce((sum, _id, index) => sum + toScoreAtRank(expectedTop.length - index, index), 0);
  return dcg / idealDcg;
}

async function runFixtureEvaluation(fixture, global) {
  const searchResult = await runSearch(
    fixture.query,
    {
      mode: fixture.mode,
      limit: String(EVAL_RANK_CUTOFF),
      fields: "id,score",
    },
    global,
  );
  const actualTopIds = searchResult.items.map((item) => item.id).slice(0, EVAL_RANK_CUTOFF);
  const ndcgAt5 = roundMetric(computeNdcgAt5(actualTopIds, fixture.expected_top_ids));
  const minNdcgAt5 = roundMetric(fixture.min_ndcg_at_5);
  return {
    fixture: fixture.name,
    query: fixture.query,
    requested_mode: fixture.mode,
    resolved_mode: searchResult.mode,
    expected_top_ids: fixture.expected_top_ids,
    actual_top_ids: actualTopIds,
    ndcg_at_5: ndcgAt5,
    min_ndcg_at_5: minNdcgAt5,
    passed: ndcgAt5 >= minNdcgAt5,
    warnings: searchResult.warnings ?? [],
  };
}

async function runReindexEvaluation(fixturesPath, global) {
  const fixtures = await loadEvalFixtures(fixturesPath);
  const results = await Promise.all(fixtures.map((fixture) => runFixtureEvaluation(fixture, global)));
  const passCount = results.filter((result) => result.passed).length;
  const averageNdcg = roundMetric(results.reduce((sum, result) => sum + result.ndcg_at_5, 0) / results.length);
  return {
    enabled: true,
    fixtures_path: fixturesPath,
    k: EVAL_RANK_CUTOFF,
    fixture_count: results.length,
    pass_count: passCount,
    fail_count: results.length - passCount,
    average_ndcg_at_5: averageNdcg,
    passed: passCount === results.length,
    results,
    evaluated_at: new Date().toISOString(),
  };
}

export async function runAdvancedSearchPackage(args, rawOptions, global) {
  return runSearch(resolveSearchQuery(args), normalizeAdvancedSearchOptions(rawOptions, args), global);
}

export async function runAdvancedReindexPackage(rawOptions, global) {
  const options = normalizeReindexRuntimeOptions(rawOptions);
  const reindexResult = await runReindex(options.reindex, global);
  if (!options.eval) {
    return reindexResult;
  }
  const evalSummary = await runReindexEvaluation(options.eval.fixturesPath, global);
  return { ...reindexResult, eval: evalSummary };
}
