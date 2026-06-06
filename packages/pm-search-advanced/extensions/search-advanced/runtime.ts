import { readFile } from "node:fs/promises";
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
const DEFAULT_EVAL_FIXTURES_PATH = path.join("tests", "search-eval", "golden-queries.json");
const DEFAULT_EVAL_MIN_NDCG_AT_5 = 0.7;
const EVAL_RANK_CUTOFF = 5;
const VALID_EVAL_SEARCH_MODES = new Set(["keyword", "semantic", "hybrid"] as const);

type EvalSearchMode = "keyword" | "semantic" | "hybrid";

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

interface SearchEvalFixtureInput {
  query?: unknown;
  mode?: unknown;
  expected_top_ids?: unknown;
  min_ndcg_at_5?: unknown;
  name?: unknown;
}

interface SearchEvalFixture {
  name: string;
  query: string;
  mode: EvalSearchMode;
  expected_top_ids: string[];
  min_ndcg_at_5: number;
}

interface SearchEvalResult {
  fixture: string;
  query: string;
  requested_mode: EvalSearchMode;
  resolved_mode: SearchResult["mode"];
  expected_top_ids: string[];
  actual_top_ids: string[];
  ndcg_at_5: number;
  min_ndcg_at_5: number;
  passed: boolean;
  warnings: string[];
}

interface ReindexEvalSummary {
  enabled: true;
  fixtures_path: string;
  k: number;
  fixture_count: number;
  pass_count: number;
  fail_count: number;
  average_ndcg_at_5: number;
  passed: boolean;
  results: SearchEvalResult[];
  evaluated_at: string;
}

interface ReindexResultWithEval extends ReindexResult {
  eval?: ReindexEvalSummary;
}

interface ReindexRuntimeOptions {
  reindex: ReindexOptions;
  eval?: {
    fixturesPath: string;
  };
}

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

function normalizeEvalFixturePath(rawPath: string | undefined): string {
  const candidate = typeof rawPath === "string" ? rawPath : DEFAULT_EVAL_FIXTURES_PATH;
  return path.resolve(process.cwd(), candidate);
}

function normalizeReindexRuntimeOptions(rawOptions: Record<string, unknown>): ReindexRuntimeOptions {
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

function toScoreAtRank(relevance: number, rankIndex: number): number {
  if (relevance <= 0) {
    return 0;
  }
  return (2 ** relevance - 1) / Math.log2(rankIndex + 2);
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function toCompactExpectedIds(value: unknown, fixtureLabel: string, fixturesPath: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PmCliError(
      `Reindex eval fixture ${fixtureLabel} in ${fixturesPath} must provide a non-empty expected_top_ids array.`,
      EXIT_CODE.USAGE,
    );
  }
  const expectedIds = value
    .filter((entry): entry is string => typeof entry === "string")
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

function normalizeFixtureMode(rawMode: unknown, fixtureLabel: string, fixturesPath: string): EvalSearchMode {
  if (rawMode === undefined) {
    return "keyword";
  }
  const normalized = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : "";
  if (VALID_EVAL_SEARCH_MODES.has(normalized as EvalSearchMode)) {
    return normalized as EvalSearchMode;
  }
  throw new PmCliError(
    `Reindex eval fixture ${fixtureLabel} in ${fixturesPath} has unsupported mode "${String(rawMode)}". Expected keyword|semantic|hybrid.`,
    EXIT_CODE.USAGE,
  );
}

function normalizeFixtureThreshold(rawValue: unknown, fixtureLabel: string, fixturesPath: string): number {
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

function normalizeFixtureEntry(rawFixture: unknown, index: number, fixturesPath: string): SearchEvalFixture {
  if (!rawFixture || typeof rawFixture !== "object") {
    throw new PmCliError(
      `Reindex eval fixture at index ${index + 1} in ${fixturesPath} must be an object.`,
      EXIT_CODE.USAGE,
    );
  }
  const fixture = rawFixture as SearchEvalFixtureInput;
  const rawQuery = typeof fixture.query === "string" ? fixture.query.trim() : "";
  if (rawQuery.length === 0) {
    throw new PmCliError(
      `Reindex eval fixture at index ${index + 1} in ${fixturesPath} must provide a non-empty query.`,
      EXIT_CODE.USAGE,
    );
  }
  const fallbackName = `fixture-${index + 1}`;
  const fixtureName = typeof fixture.name === "string" && fixture.name.trim().length > 0 ? fixture.name.trim() : fallbackName;
  return {
    name: fixtureName,
    query: rawQuery,
    mode: normalizeFixtureMode(fixture.mode, fixtureName, fixturesPath),
    expected_top_ids: toCompactExpectedIds(fixture.expected_top_ids, fixtureName, fixturesPath),
    min_ndcg_at_5: normalizeFixtureThreshold(fixture.min_ndcg_at_5, fixtureName, fixturesPath),
  };
}

function normalizeFixtureCollection(parsed: unknown, fixturesPath: string): SearchEvalFixture[] {
  const parsedObject = parsed as { fixtures?: unknown } | null;
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

async function loadEvalFixtures(fixturesPath: string): Promise<SearchEvalFixture[]> {
  let rawText = "";
  try {
    rawText = await readFile(fixturesPath, "utf8");
  } catch {
    throw new PmCliError(`Unable to read reindex eval fixtures at ${fixturesPath}.`, EXIT_CODE.USAGE);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new PmCliError(`Reindex eval fixtures at ${fixturesPath} must be valid JSON.`, EXIT_CODE.USAGE);
  }
  return normalizeFixtureCollection(parsed, fixturesPath);
}

function computeNdcgAt5(actualIds: readonly string[], expectedIds: readonly string[]): number {
  const expectedTop = expectedIds.slice(0, EVAL_RANK_CUTOFF);
  const relevanceById = new Map<string, number>();
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

async function runFixtureEvaluation(fixture: SearchEvalFixture, global: GlobalOptions): Promise<SearchEvalResult> {
  const searchResult = await runSearch(
    fixture.query,
    {
      mode: fixture.mode,
      limit: String(EVAL_RANK_CUTOFF),
      fields: "id,score",
    },
    global,
  );
  const actualTopIds = searchResult.items.map((item) => (item as { id: string }).id).slice(0, EVAL_RANK_CUTOFF);
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

async function runReindexEvaluation(fixturesPath: string, global: GlobalOptions): Promise<ReindexEvalSummary> {
  const fixtures = await loadEvalFixtures(fixturesPath);
  const results: SearchEvalResult[] = await Promise.all(fixtures.map((fixture) => runFixtureEvaluation(fixture, global)));
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
): Promise<ReindexResultWithEval> {
  const options = normalizeReindexRuntimeOptions(rawOptions);
  const reindexResult = await runReindex(options.reindex, global);
  if (!options.eval) {
    return reindexResult;
  }
  const evalSummary = await runReindexEvaluation(options.eval.fixturesPath, global);
  return { ...reindexResult, eval: evalSummary };
}
