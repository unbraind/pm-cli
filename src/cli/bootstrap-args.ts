import { resolveSubcommandFlagContractsForCommand, type CliFlagContract } from "../sdk/cli-contracts.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";

function parseBootstrapPathToken(
  token: string,
  next: string | undefined,
): { consumed: number; pathValue?: string } | null {
  if (token === "--path") {
    if (typeof next === "string" && next.length > 0) {
      return {
        consumed: 2,
        pathValue: next,
      };
    }
    return {
      consumed: 1,
    };
  }

  if (!token.startsWith("--path=")) {
    return null;
  }

  const value = token.slice("--path=".length);
  if (value.length > 0) {
    return {
      consumed: 1,
      pathValue: value,
    };
  }
  return {
    consumed: 1,
  };
}

export interface BootstrapGlobalOptions {
  path?: string;
  noExtensions: boolean;
  noPager: boolean;
  json: boolean;
  quiet: boolean;
}

export function parseBootstrapGlobalOptions(argv: string[]): BootstrapGlobalOptions {
  let pathValue: string | undefined;
  let noExtensions = false;
  let noPager = false;
  let json = false;
  let quiet = false;
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
        pathValue = parsedPath.pathValue;
      }
      index += parsedPath.consumed;
      continue;
    }
    index += 1;
  }
  return {
    path: pathValue,
    noExtensions,
    noPager,
    json,
    quiet,
  };
}

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
      token === "--explain"
    ) {
      index += 1;
      continue;
    }
    if (token === "--path") {
      index += 2;
      continue;
    }
    if (token.startsWith("--path=")) {
      index += 1;
      continue;
    }
    remaining.push(token);
    index += 1;
  }
  return remaining;
}

export interface BootstrapHelpRequest {
  requested: boolean;
  commandPathTokens: string[];
}

export function parseBootstrapHelpRequest(argv: string[]): BootstrapHelpRequest {
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

  const helpFlagIndex = stripped.findIndex((token) => token === "--help" || token === "-h");
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

export function parseBootstrapCommandName(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    if (token === "--path") {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--path=") ||
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--explain"
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token.trim().toLowerCase();
  }
  return undefined;
}

function shouldDisablePagerForInvocation(argv: string[], bootstrapGlobal: BootstrapGlobalOptions): boolean {
  if (bootstrapGlobal.noPager) {
    return true;
  }
  if (process.stdout.isTTY === true) {
    return false;
  }
  const helpRequest = parseBootstrapHelpRequest(argv);
  return helpRequest.requested;
}

export function applyBootstrapPagerPolicy(argv: string[]): void {
  const bootstrapGlobal = parseBootstrapGlobalOptions(argv);
  if (!shouldDisablePagerForInvocation(argv, bootstrapGlobal)) {
    return;
  }
  process.env.PAGER = "cat";
  process.env.MANPAGER = "cat";
  process.env.GIT_PAGER = "cat";
  if (typeof process.env.LESS !== "string" || process.env.LESS.trim().length === 0) {
    process.env.LESS = "FRX";
  }
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

export function normalizeLegacyExtensionActionSyntax(argv: string[]): string[] {
  const extensionIndex = argv.findIndex((token) => token === "extension");
  if (extensionIndex < 0) {
    return [...argv];
  }
  const actionToken = argv[extensionIndex + 1];
  if (!actionToken || actionToken.startsWith("-")) {
    return [...argv];
  }
  if (!EXTENSION_ACTION_SYNTAX_TOKENS.has(actionToken as ExtensionSubcommandAction)) {
    return [...argv];
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return [...argv];
  }
  const forcedActionFlag = `--${actionToken}`;
  if (argv.includes(forcedActionFlag)) {
    return [...argv];
  }
  return [...argv.slice(0, extensionIndex + 1), forcedActionFlag, ...argv.slice(extensionIndex + 2)];
}

type BootstrapNormalizationReason =
  | "legacy_extension_action"
  | "command_alias"
  | "flag_alias"
  | "flag_typo"
  | "bare_key_value"
  | "list_merge";
type BootstrapNormalizationConfidence = "high" | "medium";

/**
 * Executable command aliases: a leading command token here is rewritten to its
 * canonical command BEFORE commander parses, so the alias actually runs instead of
 * merely being suggested. These are the highest-frequency aliases real agents type
 * (telemetry: `pm show <id>` alone is the single most common unknown-command) and
 * each target takes the same positional/flags as the alias (with `--comment`/
 * `--note`/`--learning` flag-aliased to `--add` on the target command). Keeping this
 * in one place means the alias is consistent across registration, commander dispatch,
 * telemetry, and error handling — all of which read the normalized argv.
 */
const EXECUTABLE_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  show: "get",
  view: "get",
  comment: "comments",
  note: "notes",
  learning: "learnings",
};

/**
 * Rewrite a leading command-alias token (e.g. `show` -> `get`) in place. Only the
 * command position is considered — the same token appearing later as an argument
 * (`pm get show`) is left untouched — and only when it is not preceded by `--` or a
 * value-consuming global flag, mirroring {@link parseBootstrapCommandName}.
 */
function rewriteCommandAlias(argv: string[], trace: BootstrapNormalizationEvent[]): string[] {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      return argv;
    }
    if (token === "--path") {
      index += 1;
      continue;
    }
    if (
      token.startsWith("--path=") ||
      token === "--json" ||
      token === "--quiet" ||
      token === "--no-extensions" ||
      token === "--no-pager" ||
      token === "--profile" ||
      token === "--explain"
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    const canonical = EXECUTABLE_COMMAND_ALIASES[token.trim().toLowerCase()];
    if (!canonical) {
      return argv;
    }
    const rewritten = [...argv];
    rewritten[index] = canonical;
    trace.push({ from: token, to: [canonical], reason: "command_alias", confidence: "high" });
    return rewritten;
  }
  return argv;
}

export interface BootstrapNormalizationEvent {
  from: string;
  to: string[];
  reason: BootstrapNormalizationReason;
  confidence: BootstrapNormalizationConfidence;
}

export interface BootstrapInvocationNormalizationResult {
  argv: string[];
  commandName: string | undefined;
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

function buildFlagLookup(commandName: string | undefined): FlagLookup {
  const contracts = resolveSubcommandFlagContractsForCommand(commandName);
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
      markUnambiguousFlag(canonicalByNormalized, normalizeFlagKeyToken(candidate), canonicalFlag);
      markUnambiguousFlag(canonicalByCompact, toComparableFlagKey(candidate), canonicalFlag);
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
    canonicalComparables: [...canonicalComparablesMap.entries()].map(([canonicalFlag, comparable]) => ({
      canonicalFlag,
      comparable,
    })),
    listCanonicalFlags,
  };
}

function resolveCanonicalFlag(
  rawKey: string,
  lookup: FlagLookup,
): { flag: string; reason: "flag_alias" | "flag_typo"; confidence: BootstrapNormalizationConfidence } | null {
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
    const distance = levenshteinDistanceWithinLimit(comparableKey, candidate.comparable, maxDistance);
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
  if (!bestFlag || tied || !Number.isFinite(bestDistance) || bestDistance <= 0) {
    return null;
  }
  return {
    flag: bestFlag,
    reason: "flag_typo",
    confidence: bestDistance >= 2 ? "medium" : "high",
  };
}

function parseBareKeyValueToken(token: string): { key: string; value: string } | null {
  if (token.includes("://")) {
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
): { tokens: string[]; event?: BootstrapNormalizationEvent } {
  if (!token.startsWith("--")) {
    return { tokens: [token] };
  }
  const equalsIndex = token.indexOf("=");
  const key = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
  const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
  const resolution = resolveCanonicalFlag(key, lookup);
  if (!resolution) {
    return { tokens: [token] };
  }
  const normalizedToken = inlineValue === undefined ? resolution.flag : `${resolution.flag}=${inlineValue}`;
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

// Global option flags whose value may legitimately begin with "--" (commander
// accepts such values). Their value token must not be reinterpreted as a list
// flag during coalescing. `--path <dir>` is the documented case; other globals
// (--json/--quiet/--no-extensions/--no-pager/--profile) are boolean.
const GLOBAL_VALUE_CONSUMING_FLAGS = new Set<string>(["--path"]);

function splitCanonicalListToken(token: string): { flag: string; inlineValue?: string } | null {
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
): { argv: string[]; events: BootstrapNormalizationEvent[] } {
  if (listFlags.size === 0) {
    return { argv: [...argv], events: [] };
  }

  interface ListFlagSlot {
    outputIndex: number;
    originalTokens: string[];
    values: string[];
    occurrences: number;
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
      result.push(token);
      const next = argv[index + 1];
      if (typeof next === "string" && next !== "--") {
        result.push(next);
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    const parsed = splitCanonicalListToken(token);
    if (!parsed || !listFlags.has(parsed.flag)) {
      result.push(token);
      index += 1;
      continue;
    }

    // Determine this occurrence's value (if any) and how many argv tokens it
    // consumes. Only treat the next token as a value when it is not a flag.
    let value: string | undefined;
    let consumed = 1;
    if (parsed.inlineValue !== undefined) {
      value = parsed.inlineValue;
    } else {
      const next = argv[index + 1];
      if (typeof next === "string" && next !== "--" && !next.startsWith("-")) {
        value = next;
        consumed = 2;
      }
    }

    if (value === undefined) {
      // Value-less occurrence: leave untouched, do not coalesce.
      result.push(token);
      index += consumed;
      continue;
    }

    const originalTokens = argv.slice(index, index + consumed);
    const existing = slots.get(parsed.flag);
    if (existing) {
      existing.values.push(value);
      existing.occurrences += 1;
    } else {
      const slot: ListFlagSlot = {
        outputIndex: result.length,
        originalTokens,
        values: [value],
        occurrences: 1,
      };
      slots.set(parsed.flag, slot);
      // Reserve the anchor position; finalized after the walk so we know the
      // full merged value (or restore the original tokens for single uses).
      result.push(null);
    }
    index += consumed;
  }

  const events: BootstrapNormalizationEvent[] = [];
  const splices: Array<{ outputIndex: number; tokens: string[] }> = [];
  for (const [flag, slot] of slots) {
    if (slot.occurrences >= 2) {
      const mergedToken = `${flag}=${slot.values.join(",")}`;
      splices.push({ outputIndex: slot.outputIndex, tokens: [mergedToken] });
      events.push({
        from: `${flag} (x${slot.occurrences})`,
        to: [mergedToken],
        reason: "list_merge",
        confidence: "high",
      });
    } else {
      // Single occurrence: restore the original token form verbatim.
      splices.push({ outputIndex: slot.outputIndex, tokens: slot.originalTokens });
    }
  }

  // Apply anchor splices from the end so earlier indices stay valid when a
  // single-occurrence anchor expands back into two tokens.
  splices.sort((a, b) => b.outputIndex - a.outputIndex);
  for (const splice of splices) {
    result.splice(splice.outputIndex, 1, ...splice.tokens);
  }

  return { argv: result as string[], events };
}

export function normalizeBootstrapInvocation(argv: string[]): BootstrapInvocationNormalizationResult {
  const trace: BootstrapNormalizationEvent[] = [];
  const legacyNormalized = normalizeLegacyExtensionActionSyntax(argv);
  if (legacyNormalized.length !== argv.length || legacyNormalized.some((token, index) => token !== argv[index])) {
    trace.push({
      from: argv.join(" "),
      to: [...legacyNormalized],
      reason: "legacy_extension_action",
      confidence: "high",
    });
  }
  const aliasNormalized = rewriteCommandAlias(legacyNormalized, trace);
  const commandName = parseBootstrapCommandName(aliasNormalized);
  const lookup = buildFlagLookup(commandName);
  const normalizedArgv: string[] = [];
  for (let index = 0; index < aliasNormalized.length; index += 1) {
    const token = aliasNormalized[index];
    if (token === "--") {
      normalizedArgv.push(...aliasNormalized.slice(index));
      break;
    }
    const previous = normalizedArgv[normalizedArgv.length - 1];
    if (token.startsWith("--")) {
      const normalizedToken = normalizeLongOptionToken(token, lookup);
      normalizedArgv.push(...normalizedToken.tokens);
      if (normalizedToken.event) {
        trace.push(normalizedToken.event);
      }
      continue;
    }
    const bareKeyValue = parseBareKeyValueToken(token);
    if (
      bareKeyValue &&
      !(typeof previous === "string" && previous.startsWith("-"))
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
  const coalesced = coalesceRepeatedListFlags(
    normalizedArgv,
    lookup.listCanonicalFlags,
    GLOBAL_VALUE_CONSUMING_FLAGS,
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

export function parseBootstrapTypeValue(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
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
