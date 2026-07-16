/**
 * @module sdk/cli-bootstrap
 *
 * Provides public bootstrap argument normalization for embedded CLI hosts.
 */
import {
  EXECUTABLE_COMMAND_ALIASES,
  resolveSubcommandFlagContractsForCommand,
  type CliFlagContract,
} from "./cli-contracts.js";
export { EXECUTABLE_COMMAND_ALIASES };
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";

const GLOBAL_VALUE_CONSUMING_FLAGS = new Set<string>([
  "--pm-path",
  "--path",
  "--author",
]);

/** Whether a global value-consuming flag uses its inline `--flag=value` form. */
const isInlineGlobalValueToken = (token: string): boolean => {
  const equalsIndex = token.indexOf("=");
  return (
    equalsIndex > 0 &&
    GLOBAL_VALUE_CONSUMING_FLAGS.has(token.slice(0, equalsIndex))
  );
};

/** Whether optional bootstrap author syntax consumes the following token. */
const consumesBootstrapAuthorValue = (next: string | undefined): boolean => {
  return typeof next === "string" && !next.startsWith("-");
};

function parseBootstrapPathToken(
  token: string,
  next: string | undefined,
): { consumed: number; pathValue?: string; preferred: boolean } | null {
  if (token === "--path" || token === "--pm-path") {
    if (typeof next === "string" && next.length > 0) {
      return {
        consumed: 2,
        pathValue: next,
        preferred: token === "--pm-path",
      };
    }
    return {
      consumed: 1,
      preferred: token === "--pm-path",
    };
  }

  const inlinePrefix = token.startsWith("--path=")
    ? "--path="
    : token.startsWith("--pm-path=")
      ? "--pm-path="
      : undefined;
  if (!inlinePrefix) {
    return null;
  }

  const value = token.slice(inlinePrefix.length);
  if (value.length > 0) {
    return {
      consumed: 1,
      pathValue: value,
      preferred: inlinePrefix === "--pm-path=",
    };
  }
  return {
    consumed: 1,
    preferred: inlinePrefix === "--pm-path=",
  };
}

/** Documents the bootstrap global options payload exchanged by command, SDK, and package integrations. */
export interface BootstrapGlobalOptions {
  /** Filesystem path used for path resolution. */
  path?: string;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions: boolean;
  /** Value that configures or reports no pager for this contract. */
  noPager: boolean;
  /** Value that configures or reports json for this contract. */
  json: boolean;
  /** Value that configures or reports quiet for this contract. */
  quiet: boolean;
  /** Invocation-wide mutation author override. */
  author?: string;
  /** Whether `--author` was present without its required value. */
  authorMissingValue?: true;
}

/** Implements parse bootstrap global options for the public runtime surface of this module. */
export function parseBootstrapGlobalOptions(
  argv: string[],
): BootstrapGlobalOptions {
  let legacyPathValue: string | undefined;
  let pmPathValue: string | undefined;
  let noExtensions = false;
  let noPager = false;
  let json = false;
  let quiet = false;
  let author: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--no-extensions") {
      noExtensions = true;
      index += 1;
      continue;
    }
    if (token === "--no-pager") {
      noPager = true;
      index += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (token === "--quiet") {
      quiet = true;
      index += 1;
      continue;
    }
    const parsedPath = parseBootstrapPathToken(token, argv[index + 1]);
    if (parsedPath) {
      if (parsedPath.pathValue !== undefined) {
        if (parsedPath.preferred) {
          pmPathValue = parsedPath.pathValue;
        } else {
          legacyPathValue = parsedPath.pathValue;
        }
      }
      index += parsedPath.consumed;
      continue;
    }
    if (token === "--author") {
      if (consumesBootstrapAuthorValue(argv[index + 1])) {
        author = argv[index + 1];
        index += 2;
      } else {
        author = "";
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--author=")) {
      author = token.slice("--author=".length);
      index += 1;
      continue;
    }
    index += 1;
  }
  return {
    path: pmPathValue ?? legacyPathValue,
    noExtensions,
    noPager,
    json,
    quiet,
    ...(author === ""
      ? { authorMissingValue: true }
      : author !== undefined
        ? { author }
        : {}),
  };
}

/** Implements strip global bootstrap tokens for the public runtime surface of this module. */
export function stripGlobalBootstrapTokens(argv: string[]): string[] {
  const remaining: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--id-only" ||
      token === "--explain"
    ) {
      index += 1;
      continue;
    }
    if (token === "--author") {
      index += consumesBootstrapAuthorValue(argv[index + 1]) ? 2 : 1;
      continue;
    }
    if (GLOBAL_VALUE_CONSUMING_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    if (isInlineGlobalValueToken(token)) {
      index += 1;
      continue;
    }
    remaining.push(token);
    index += 1;
  }
  return remaining;
}

/** Documents the bootstrap help request payload exchanged by command, SDK, and package integrations. */
export interface BootstrapHelpRequest {
  /** Value that configures or reports requested for this contract. */
  requested: boolean;
  /** Value that configures or reports command path tokens for this contract. */
  commandPathTokens: string[];
}

/** Implements parse bootstrap help request for the public runtime surface of this module. */
export function parseBootstrapHelpRequest(
  argv: string[],
): BootstrapHelpRequest {
  const stripped = stripGlobalBootstrapTokens(argv);
  const first = stripped[0]?.trim().toLowerCase();
  if (first === "help") {
    const commandPathTokens: string[] = [];
    for (let index = 1; index < stripped.length; index += 1) {
      const token = stripped[index];
      if (token.startsWith("-")) {
        break;
      }
      commandPathTokens.push(token.trim().toLowerCase());
    }
    return {
      requested: true,
      commandPathTokens,
    };
  }

  const helpFlagIndex = stripped.findIndex(
    (token) => token === "--help" || token === "-h",
  );
  if (helpFlagIndex < 0) {
    return {
      requested: false,
      commandPathTokens: [],
    };
  }

  const commandPathTokens: string[] = [];
  for (const token of stripped) {
    if (token.startsWith("-")) {
      break;
    }
    commandPathTokens.push(token.trim().toLowerCase());
  }
  return {
    requested: true,
    commandPathTokens,
  };
}

/**
 * Index of the command token in argv — the first non-flag token, skipping the
 * value-consuming/global bootstrap flags. Returns undefined when there is none
 * (bare invocation, only global flags, or a leading `--`). Single source of truth
 * for command-position scanning shared by {@link parseBootstrapCommandName} and the
 * command-alias rewrite so their precedence rules can never drift apart.
 */
function findCommandTokenIndex(argv: string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      return undefined;
    }
    if (token === "--author") {
      index += consumesBootstrapAuthorValue(argv[index + 1]) ? 1 : 0;
      continue;
    }
    if (GLOBAL_VALUE_CONSUMING_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (
      isInlineGlobalValueToken(token) ||
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--id-only" ||
      token === "--explain"
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return index;
  }
  return undefined;
}

/** Implements parse bootstrap command name for the public runtime surface of this module. */
export function parseBootstrapCommandName(argv: string[]): string | undefined {
  const index = findCommandTokenIndex(argv);
  return index === undefined ? undefined : argv[index].trim().toLowerCase();
}

function shouldDisablePagerForInvocation(
  argv: string[],
  bootstrapGlobal: BootstrapGlobalOptions,
): boolean {
  if (bootstrapGlobal.noPager) {
    return true;
  }
  if (process.stdout.isTTY === true) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(argv);
  return helpRequest.requested;
}

/** Implements apply bootstrap pager policy for the public runtime surface of this module. */
export function applyBootstrapPagerPolicy(argv: string[]): () => void {
  const pagerEnvironmentKeys = [
    "PAGER",
    "MANPAGER",
    "GIT_PAGER",
    "LESS",
  ] as const;
  const previousValues = pagerEnvironmentKeys.map((key) => process.env[key]);
  const restore = (): void => {
    for (const [index, key] of pagerEnvironmentKeys.entries()) {
      const value = previousValues[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  const bootstrapGlobal = parseBootstrapGlobalOptions(argv);
  if (!shouldDisablePagerForInvocation(argv, bootstrapGlobal)) {
    return restore;
  }
  process.env.PAGER = "cat";
  process.env.MANPAGER = "cat";
  process.env.GIT_PAGER = "cat";
  if (
    typeof process.env.LESS !== "string" ||
    process.env.LESS.trim().length === 0
  ) {
    process.env.LESS = "FRX";
  }
  return restore;
}

type ExtensionSubcommandAction =
  | "init"
  | "install"
  | "uninstall"
  | "explore"
  | "manage"
  | "doctor"
  | "adopt"
  | "adopt-all"
  | "activate"
  | "deactivate";

const EXTENSION_ACTION_SYNTAX_TOKENS = new Set<ExtensionSubcommandAction>([
  "install",
  "uninstall",
  "explore",
  "manage",
  "doctor",
  "adopt",
  "adopt-all",
  "activate",
  "deactivate",
]);

/** Implements normalize legacy extension action syntax for the public runtime surface of this module. */
export function normalizeLegacyExtensionActionSyntax(argv: string[]): string[] {
  const extensionIndex = findCommandTokenIndex(argv);
  if (extensionIndex === undefined || argv[extensionIndex] !== "extension") {
    return [...argv];
  }
  const actionToken = argv[extensionIndex + 1];
  if (!actionToken || actionToken.startsWith("-")) {
    return [...argv];
  }
  if (
    !EXTENSION_ACTION_SYNTAX_TOKENS.has(
      actionToken as ExtensionSubcommandAction,
    )
  ) {
    return [...argv];
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return [...argv];
  }
  const forcedActionFlag = `--${actionToken}`;
  if (argv.includes(forcedActionFlag)) {
    return [...argv];
  }
  return [
    ...argv.slice(0, extensionIndex + 1),
    forcedActionFlag,
    ...argv.slice(extensionIndex + 2),
  ];
}

type BootstrapNormalizationReason =
  | "legacy_extension_action"
  | "command_alias"
  | "flag_alias"
  | "flag_typo"
  | "bare_key_value"
  | "list_merge";
type BootstrapNormalizationConfidence = "high" | "medium";

/** Executable command aliases: a leading command token here is rewritten to its canonical command BEFORE commander parses, so the alias actually runs instead of merely being suggested. These are the highest-frequency aliases real agents type (telemetry: `pm show <id>` alone is the single most common unknown-command) and each target takes the same positional/flags as the alias (with `--comment`/ `--note`/`--learning` flag-aliased to `--add` on the target command). Keeping this in one place means the alias is consistent across registration, commander dispatch, telemetry, and error handling — all of which read the normalized argv. */
/**
 * Rewrite a leading command-alias token (e.g. `show` -> `get`) in place. Only the
 * command position is considered — the same token appearing later as an argument
 * (`pm get show`) is left untouched — and only when it is not preceded by `--` or a
 * value-consuming global flag, mirroring {@link parseBootstrapCommandName}.
 */
function rewriteCommandAlias(
  argv: string[],
  trace: BootstrapNormalizationEvent[],
): string[] {
  const index = findCommandTokenIndex(argv);
  if (index === undefined) {
    return argv;
  }
  const token = argv[index];
  const canonical = EXECUTABLE_COMMAND_ALIASES[token.trim().toLowerCase()];
  if (!canonical) {
    return argv;
  }
  const rewritten = [...argv];
  rewritten[index] = canonical;
  trace.push({
    from: token,
    to: [canonical],
    reason: "command_alias",
    confidence: "high",
  });
  return rewritten;
}

/** Documents the bootstrap normalization event payload exchanged by command, SDK, and package integrations. */
export interface BootstrapNormalizationEvent {
  /** Value that configures or reports from for this contract. */
  from: string;
  /** Value that configures or reports to for this contract. */
  to: string[];
  /** Value that configures or reports reason for this contract. */
  reason: BootstrapNormalizationReason;
  /** Value that configures or reports confidence for this contract. */
  confidence: BootstrapNormalizationConfidence;
}

/** Documents the bootstrap invocation normalization result payload exchanged by command, SDK, and package integrations. */
export interface BootstrapInvocationNormalizationResult {
  /** Value that configures or reports argv for this contract. */
  argv: string[];
  /** Value that configures or reports command name for this contract. */
  commandName: string | undefined;
  /** Value that configures or reports trace for this contract. */
  trace: BootstrapNormalizationEvent[];
}

interface FlagLookup {
  canonicalByNormalized: Map<string, string | null>;
  canonicalByCompact: Map<string, string | null>;
  canonicalComparables: Array<{ canonicalFlag: string; comparable: string }>;
  listCanonicalFlags: Set<string>;
}

function normalizeFlagKeyToken(raw: string): string {
  const withoutPrefix = raw.replace(/^--?/, "");
  return withoutPrefix
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function toComparableFlagKey(raw: string): string {
  return normalizeFlagKeyToken(raw).replace(/-/g, "");
}

function markUnambiguousFlag(
  map: Map<string, string | null>,
  key: string,
  canonicalFlag: string,
): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, canonicalFlag);
    return;
  }
  if (existing !== canonicalFlag) {
    map.set(key, null);
  }
}

function collectLongFlagCandidates(contract: CliFlagContract): string[] {
  const candidates: string[] = [];
  const pushLongFlag = (value: string | undefined): void => {
    if (typeof value !== "string") {
      return;
    }
    if (!value.startsWith("--")) {
      return;
    }
    candidates.push(value);
  };
  pushLongFlag(contract.flag);
  for (const alias of contract.aliases ?? []) {
    pushLongFlag(alias);
  }
  return candidates;
}

function buildFlagLookup(
  commandName: string | undefined,
  contractsOverride?: CliFlagContract[],
): FlagLookup {
  const contracts =
    contractsOverride ?? resolveSubcommandFlagContractsForCommand(commandName);
  const canonicalByNormalized = new Map<string, string | null>();
  const canonicalByCompact = new Map<string, string | null>();
  const canonicalComparablesMap = new Map<string, string>();
  const listCanonicalFlags = new Set<string>();
  for (const contract of contracts) {
    const longCandidates = collectLongFlagCandidates(contract);
    if (longCandidates.length === 0) {
      continue;
    }
    const canonicalFlag = `--${normalizeFlagKeyToken(longCandidates[0])}`;
    for (const candidate of longCandidates) {
      markUnambiguousFlag(
        canonicalByNormalized,
        normalizeFlagKeyToken(candidate),
        canonicalFlag,
      );
      markUnambiguousFlag(
        canonicalByCompact,
        toComparableFlagKey(candidate),
        canonicalFlag,
      );
    }
    const comparable = toComparableFlagKey(canonicalFlag);
    if (!canonicalComparablesMap.has(canonicalFlag)) {
      canonicalComparablesMap.set(canonicalFlag, comparable);
    }
    if (contract.list === true) {
      listCanonicalFlags.add(canonicalFlag);
    }
  }
  return {
    canonicalByNormalized,
    canonicalByCompact,
    canonicalComparables: [...canonicalComparablesMap.entries()].map(
      ([canonicalFlag, comparable]) => ({
        canonicalFlag,
        comparable,
      }),
    ),
    listCanonicalFlags,
  };
}

function resolveCanonicalFlag(
  rawKey: string,
  lookup: FlagLookup,
): {
  flag: string;
  reason: "flag_alias" | "flag_typo";
  confidence: BootstrapNormalizationConfidence;
} | null {
  const normalizedKey = normalizeFlagKeyToken(rawKey);
  const direct = lookup.canonicalByNormalized.get(normalizedKey);
  if (typeof direct === "string") {
    return {
      flag: direct,
      reason: "flag_alias",
      confidence: "high",
    };
  }
  const comparableKey = normalizedKey.replace(/-/g, "");
  const compactMatch = lookup.canonicalByCompact.get(comparableKey);
  if (typeof compactMatch === "string") {
    return {
      flag: compactMatch,
      reason: "flag_alias",
      confidence: "high",
    };
  }
  const maxDistance = comparableKey.length >= 8 ? 2 : 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestFlag: string | undefined;
  let tied = false;
  for (const candidate of lookup.canonicalComparables) {
    const distance = levenshteinDistanceWithinLimit(
      comparableKey,
      candidate.comparable,
      maxDistance,
    );
    if (distance === null) {
      continue;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      bestFlag = candidate.canonicalFlag;
      tied = false;
      continue;
    }
    if (distance === bestDistance && bestFlag !== candidate.canonicalFlag) {
      tied = true;
    }
  }
  if (
    !bestFlag ||
    tied ||
    !Number.isFinite(bestDistance) ||
    bestDistance <= 0
  ) {
    return null;
  }
  return {
    flag: bestFlag,
    reason: "flag_typo",
    confidence: bestDistance >= 2 ? "medium" : "high",
  };
}

/** Implements list alias plural keys for the public runtime surface of this module. */
export function listAliasPluralKeys(normalizedKey: string): string[] {
  const candidates = [`${normalizedKey}s`];
  if (normalizedKey.endsWith("y") && normalizedKey.length > 1) {
    candidates.push(`${normalizedKey.slice(0, -1)}ies`);
  }
  return candidates;
}

function parseBareKeyValueToken(
  token: string,
  preserve = false,
): { key: string; value: string } | null {
  if (preserve || token.includes("://")) {
    return null;
  }
  const match = token.match(/^([A-Za-z][A-Za-z0-9_-]{1,63})([:=])(.*)$/);
  if (!match) {
    return null;
  }
  const key = match[1];
  const value = match[3];
  if (value.length === 0) {
    return null;
  }
  return {
    key,
    value,
  };
}

function normalizeLongOptionToken(
  token: string,
  lookup: FlagLookup,
  preserve = false,
): { tokens: string[]; event?: BootstrapNormalizationEvent } {
  if (preserve || !token.startsWith("--")) {
    return { tokens: [token] };
  }
  const equalsIndex = token.indexOf("=");
  const key = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
  const inlineValue =
    equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
  const resolution = resolveCanonicalFlag(key, lookup);
  if (!resolution) {
    return { tokens: [token] };
  }
  const normalizedToken =
    inlineValue === undefined
      ? resolution.flag
      : `${resolution.flag}=${inlineValue}`;
  if (normalizedToken === token) {
    return { tokens: [token] };
  }
  return {
    tokens: [normalizedToken],
    event: {
      from: token,
      to: [normalizedToken],
      reason: resolution.reason,
      confidence: resolution.confidence,
    },
  };
}

/** Locate global path-value tokens that normalization must preserve literally. */
function collectBootstrapPathValueIndices(argv: string[]): Set<number> {
  const indices = new Set<number>();
  let expectsValue = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (expectsValue) {
      indices.add(index);
      expectsValue = false;
      continue;
    }
    const token = argv[index];
    expectsValue = token === "--path" || token === "--pm-path";
  }
  return indices;
}

// Global option flags whose value may legitimately begin with "--" (commander
// accepts such values). Their value token must not be reinterpreted as a list
// flag during coalescing. `--pm-path <dir>` and its legacy `--path <dir>`
// alias are the documented cases; other globals
// (--json/--quiet/--no-extensions/--no-pager/--profile) are boolean.
function splitCanonicalListToken(
  token: string,
): { flag: string; inlineValue?: string } | null {
  if (!token.startsWith("--")) {
    return null;
  }
  const equalsIndex = token.indexOf("=");
  if (equalsIndex < 0) {
    return { flag: token };
  }
  return {
    flag: token.slice(0, equalsIndex),
    inlineValue: token.slice(equalsIndex + 1),
  };
}

interface ListFlagSlot {
  outputIndex: number;
  originalTokens: string[];
  values: string[];
  occurrences: number;
}

interface ListFlagOccurrence {
  originalTokens: string[];
  value: string | undefined;
  consumed: number;
}

interface ValuedListFlagOccurrence {
  originalTokens: string[];
  value: string;
}

function copyValueConsumingFlag(
  argv: string[],
  index: number,
  result: (string | null)[],
): number {
  result.push(argv[index]);
  const next = argv[index + 1];
  if (typeof next === "string" && next !== "--") {
    result.push(next);
    return index + 2;
  }
  return index + 1;
}

function readListFlagOccurrence(
  argv: string[],
  index: number,
  parsed: { flag: string; inlineValue?: string },
  multiValueListFlags: Set<string>,
): ListFlagOccurrence {
  if (parsed.inlineValue !== undefined) {
    return {
      originalTokens: [argv[index]],
      value: parsed.inlineValue,
      consumed: 1,
    };
  }

  const values: string[] = [];
  let valueIndex = index + 1;
  while (
    valueIndex < argv.length &&
    argv[valueIndex] !== "--" &&
    !argv[valueIndex].startsWith("-") &&
    (values.length === 0 || multiValueListFlags.has(parsed.flag))
  ) {
    values.push(argv[valueIndex]);
    valueIndex += 1;
  }

  const consumed = values.length === 0 ? 1 : 1 + values.length;
  return {
    originalTokens: argv.slice(index, index + consumed),
    value: values.length === 0 ? undefined : values.join(","),
    consumed,
  };
}

function recordListFlagOccurrence(
  slots: Map<string, ListFlagSlot>,
  result: (string | null)[],
  flag: string,
  occurrence: ValuedListFlagOccurrence,
): void {
  const existing = slots.get(flag);
  if (existing) {
    existing.values.push(occurrence.value);
    existing.occurrences += 1;
    return;
  }

  slots.set(flag, {
    outputIndex: result.length,
    originalTokens: occurrence.originalTokens,
    values: [occurrence.value],
    occurrences: 1,
  });
  // Reserve the anchor position; finalized after the walk so we know the full
  // merged value or can restore the original token form for single uses.
  result.push(null);
}

function buildListFlagCoalescingSplices(
  slots: Map<string, ListFlagSlot>,
  multiValueListFlags: Set<string>,
): {
  events: BootstrapNormalizationEvent[];
  splices: Array<{ outputIndex: number; tokens: string[] }>;
} {
  const events: BootstrapNormalizationEvent[] = [];
  const splices: Array<{ outputIndex: number; tokens: string[] }> = [];
  for (const [flag, slot] of slots) {
    const shouldMerge =
      slot.occurrences >= 2 ||
      (multiValueListFlags.has(flag) && slot.originalTokens.length > 2);
    if (!shouldMerge) {
      splices.push({
        outputIndex: slot.outputIndex,
        tokens: slot.originalTokens,
      });
      continue;
    }
    const mergedToken = `${flag}=${slot.values.join(",")}`;
    splices.push({ outputIndex: slot.outputIndex, tokens: [mergedToken] });
    events.push({
      from: `${flag} (x${slot.occurrences})`,
      to: [mergedToken],
      reason: "list_merge",
      confidence: "high",
    });
  }
  return { events, splices };
}

function applyListFlagSplices(
  result: (string | null)[],
  splices: Array<{ outputIndex: number; tokens: string[] }>,
): void {
  splices.sort((a, b) => b.outputIndex - a.outputIndex);
  for (const splice of splices) {
    result.splice(splice.outputIndex, 1, ...splice.tokens);
  }
}

/**
 * Coalesce repeated occurrences of comma-separated list flags into a single
 * `--flag=v1,v2,v3` token anchored at the FIRST occurrence. Without this,
 * Commander treats these flags as scalars and silently keeps only the last
 * value (data loss). Both `--flag value` and `--flag=value` forms are merged;
 * a value-less occurrence is preserved untouched, and a `--` terminator stops
 * coalescing (remainder is passed through verbatim).
 *
 * `valueConsumingFlags` lists option flags (e.g. global `--path`) whose value
 * may itself begin with `--`. Their value token is emitted verbatim so a
 * list-flag-looking value (`--path --tags`) is never reinterpreted as a flag
 * nor allowed to swallow the following command/positional token.
 */
export function coalesceRepeatedListFlags(
  argv: string[],
  listFlags: Set<string>,
  valueConsumingFlags: Set<string> = new Set(),
  multiValueListFlags: Set<string> = new Set(),
): { argv: string[]; events: BootstrapNormalizationEvent[] } {
  if (listFlags.size === 0) {
    return { argv: [...argv], events: [] };
  }

  const result: (string | null)[] = [];
  const slots = new Map<string, ListFlagSlot>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      result.push(...argv.slice(index));
      break;
    }
    // A value-consuming option in space form owns the next token as its value,
    // even when that value begins with "--". Emit both verbatim so the value is
    // never misread as a list-flag occurrence.
    if (valueConsumingFlags.has(token)) {
      index = copyValueConsumingFlag(argv, index, result);
      continue;
    }
    const parsed = splitCanonicalListToken(token);
    if (!parsed || !listFlags.has(parsed.flag)) {
      result.push(token);
      index += 1;
      continue;
    }

    const occurrence = readListFlagOccurrence(
      argv,
      index,
      parsed,
      multiValueListFlags,
    );
    if (occurrence.value === undefined) {
      // Value-less occurrence: leave untouched, do not coalesce.
      result.push(token);
      index += occurrence.consumed;
      continue;
    }

    recordListFlagOccurrence(slots, result, parsed.flag, {
      originalTokens: occurrence.originalTokens,
      value: occurrence.value,
    });
    index += occurrence.consumed;
  }

  // Apply anchor splices from the end so earlier indices stay valid when a
  // single-occurrence anchor expands back into two tokens.
  const { events, splices } = buildListFlagCoalescingSplices(
    slots,
    multiValueListFlags,
  );
  applyListFlagSplices(result, splices);

  return { argv: result as string[], events };
}

/** Linked-test entry keys accepted in the two-token form `pm test <id> --add command "npm test -- parser"` (GH-191). Only entry-identity keys are merged: `command`/`cmd` name the shell command and `path` names the test file, so a single key=value entry is meaningful for them. Other structured keys (scope, env_set, assertions, ...) cannot form a valid standalone entry and are left for the normal parser to reject. `--remove` matches existing entries by `command=`/`path=` only, so `cmd` is excluded there. Key names mirror STRUCTURED_LINKED_TEST_KEYS in src/cli/commands/linked-test-entry.ts. */
const LINKED_TEST_TWO_TOKEN_KEYS_BY_FLAG: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["--add", new Set(["command", "cmd", "path"])],
  ["--remove", new Set(["command", "path"])],
]);

/** Sandbox-safe linked-test commands legitimately start with env assignments (`PM_PATH=... PM_GLOBAL_PATH=... vitest run -- parser`), which look like bare key=value settings tokens. When the two preceding tokens are a linked-test flag plus a bare two-token key (`--add command <value>`), the value must be left intact for mergeLinkedTestTwoTokenEntries instead of being rewritten into a canonical flag (e.g. PM_PATH= -> --pm-path), which would silently corrupt the command into `--add command --pm-path ...`. */
function isLinkedTestTwoTokenValuePosition(
  commandName: string | undefined,
  emittedTokens: readonly string[],
): boolean {
  if (commandName !== "test" || emittedTokens.length < 2) {
    return false;
  }
  const key = emittedTokens[emittedTokens.length - 1];
  const flag = emittedTokens[emittedTokens.length - 2];
  const keys = LINKED_TEST_TWO_TOKEN_KEYS_BY_FLAG.get(flag);
  return keys !== undefined && keys.has(key);
}

function shouldPreserveBareKeyValueToken(
  commandName: string | undefined,
  emittedTokens: readonly string[],
): boolean {
  return (
    commandName === "search" ||
    isLinkedTestTwoTokenValuePosition(commandName, emittedTokens)
  );
}

/** Accept the two-token linked-test form `pm test <id> --add command "npm test -- parser"` by merging the bare key token and its single quoted value into the documented `--add command=...` shape. Without this merge Commander binds the bare key as the option value and treats the quoted command as an excess positional, failing with "too many arguments" (GH-191). The merge only fires when EXACTLY ONE non-flag token follows the bare key, i.e. the value was quoted into one shell token — an unquoted multi-token value stays ambiguous (it may swallow the item id), still fails fast, and is routed to targeted quoting guidance by the commander error classifier instead. */
export function mergeLinkedTestTwoTokenEntries(
  argv: string[],
  commandName: string | undefined,
  trace: BootstrapNormalizationEvent[],
): string[] {
  if (commandName !== "test") {
    return argv;
  }
  const result: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      result.push(...argv.slice(index));
      return result;
    }
    const keys = LINKED_TEST_TWO_TOKEN_KEYS_BY_FLAG.get(token);
    const key = keys ? argv[index + 1] : undefined;
    if (!keys || typeof key !== "string" || !keys.has(key)) {
      result.push(token);
      index += 1;
      continue;
    }
    let runEnd = index + 2;
    while (runEnd < argv.length && !argv[runEnd].startsWith("-")) {
      runEnd += 1;
    }
    if (runEnd - (index + 2) !== 1) {
      result.push(token);
      index += 1;
      continue;
    }
    const value = argv[index + 2];
    const mergedValue = `${key}=${value}`;
    result.push(token, mergedValue);
    trace.push({
      from: `${token} ${key} ${value}`,
      to: [token, mergedValue],
      reason: "bare_key_value",
      confidence: "high",
    });
    index += 3;
  }
  return result;
}

/** Implements normalize bootstrap invocation for the public runtime surface of this module. */
export function normalizeBootstrapInvocation(
  argv: string[],
): BootstrapInvocationNormalizationResult {
  const trace: BootstrapNormalizationEvent[] = [];
  const legacyNormalized = normalizeLegacyExtensionActionSyntax(argv);
  if (
    legacyNormalized.length !== argv.length ||
    legacyNormalized.some((token, index) => token !== argv[index])
  ) {
    trace.push({
      from: argv.join(" "),
      to: [...legacyNormalized],
      reason: "legacy_extension_action",
      confidence: "high",
    });
  }
  const aliasNormalized = rewriteCommandAlias(legacyNormalized, trace);
  const commandName = parseBootstrapCommandName(aliasNormalized);
  const commandPathName = parseBootstrapCommandPathName(aliasNormalized);
  const lookup = buildFlagLookup(commandPathName ?? commandName);
  const normalizedArgv: string[] = [];
  const pathValueIndices = collectBootstrapPathValueIndices(aliasNormalized);
  for (let index = 0; index < aliasNormalized.length; index += 1) {
    const token = aliasNormalized[index];
    if (token === "--") {
      normalizedArgv.push(...aliasNormalized.slice(index));
      break;
    }
    const preserveCurrentToken = pathValueIndices.has(index);
    const previous = normalizedArgv[normalizedArgv.length - 1];
    if (token.startsWith("--")) {
      const normalizedToken = normalizeLongOptionToken(
        token,
        lookup,
        preserveCurrentToken,
      );
      normalizedArgv.push(...normalizedToken.tokens);
      if (normalizedToken.event) {
        trace.push(normalizedToken.event);
      }
      continue;
    }
    const bareKeyValue = parseBareKeyValueToken(token, preserveCurrentToken);
    if (
      bareKeyValue &&
      !(typeof previous === "string" && previous.startsWith("-")) &&
      !shouldPreserveBareKeyValueToken(commandName, normalizedArgv)
    ) {
      const resolution = resolveCanonicalFlag(bareKeyValue.key, lookup);
      if (resolution) {
        const replacement = [resolution.flag, bareKeyValue.value];
        normalizedArgv.push(...replacement);
        trace.push({
          from: token,
          to: replacement,
          reason: "bare_key_value",
          confidence: resolution.confidence,
        });
        continue;
      }
    }
    normalizedArgv.push(token);
  }
  const linkedTestNormalized = mergeLinkedTestTwoTokenEntries(
    normalizedArgv,
    commandName,
    trace,
  );
  const coalesced = coalesceRepeatedListFlags(
    linkedTestNormalized,
    lookup.listCanonicalFlags,
    GLOBAL_VALUE_CONSUMING_FLAGS,
    commandName === "create" ? new Set(["--tags"]) : new Set(),
  );
  for (const event of coalesced.events) {
    trace.push(event);
  }
  return {
    argv: coalesced.argv,
    commandName,
    trace,
  };
}

function parseBootstrapCommandPathName(argv: string[]): string | undefined {
  const stripped = stripGlobalBootstrapTokens(argv);
  const first = stripped[0]?.trim().toLowerCase();
  const second = stripped[1]?.trim().toLowerCase();
  if (
    (first === "extension" || first === "package" || first === "packages") &&
    typeof second === "string" &&
    second.length > 0 &&
    !second.startsWith("-")
  ) {
    return `${first} ${second}`;
  }
  return first;
}

/** Implements parse bootstrap type value for the public runtime surface of this module. */
export function parseBootstrapTypeValue(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--type") {
      const candidate = argv[index + 1];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
      continue;
    }
    if (token.startsWith("--type=")) {
      const candidate = token.slice("--type=".length).trim();
      if (candidate.length > 0) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  buildFlagLookup,
  collectBootstrapPathValueIndices,
  collectLongFlagCandidates,
  markUnambiguousFlag,
  normalizeLongOptionToken,
  resolveCanonicalFlag,
};
