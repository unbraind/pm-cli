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

type BootstrapNormalizationReason = "legacy_extension_action" | "flag_alias" | "flag_typo" | "bare_key_value";
type BootstrapNormalizationConfidence = "high" | "medium";

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
  }
  return {
    canonicalByNormalized,
    canonicalByCompact,
    canonicalComparables: [...canonicalComparablesMap.entries()].map(([canonicalFlag, comparable]) => ({
      canonicalFlag,
      comparable,
    })),
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
  const commandName = parseBootstrapCommandName(legacyNormalized);
  const lookup = buildFlagLookup(commandName);
  const normalizedArgv: string[] = [];
  for (let index = 0; index < legacyNormalized.length; index += 1) {
    const token = legacyNormalized[index];
    if (token === "--") {
      normalizedArgv.push(...legacyNormalized.slice(index));
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
  return {
    argv: normalizedArgv,
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
