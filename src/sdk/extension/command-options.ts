/**
 * @module sdk/extension/command-options
 *
 * Definition-driven extension command option grammar shared by every caller:
 * CLI argv dispatch, `PmClient.run`, MCP, and the extension test harness all
 * fold declared flag spellings into the handler key, apply declared defaults,
 * and coerce values through the functions in this module (pm-gh1665).
 */
import { isDeepStrictEqual } from "node:util";
import { resolvePmCommandOperation } from "../cli-contracts/command-aliases.js";
import {
  describeFlagScalarValueFailure,
  type FlagScalarValueFailure,
  resolveExtensionFlagValueContract,
  resolveExtensionLongFlagName,
  EXIT_CODE,
  PmCliError,
  flattenFlagListValue,
  resolveFlagValueKind,
  type FlagDefinition,
} from "../runtime-primitives.js";

/** Flag metadata consumed by loose-option parsing across core and extension commands. */
export interface LooseCommandFlagDefinition {
  /** Canonical long option token. */
  long?: string;
  /** Optional short option token. */
  short?: string;
  /** Backward-compatible aliases emitted by core command contracts. */
  aliases?: string[];
  /** Canonical runtime value kind. */
  value_type?: string;
  /** Backward-compatible runtime value kind alias. */
  type?: string;
  /** Whether the option can be supplied to the command. */
  enabled?: boolean;
  /** Whether callers must provide the option. */
  required?: boolean;
  /** Whether repeated or comma-delimited values accumulate. */
  list?: boolean;
  /** Whether repeated occurrences accumulate without splitting commas. */
  repeatable?: boolean;
  /** Value used when callers omit the option. */
  default?: unknown;
  /** `strict` refuses malformed number/boolean tokens before dispatch; `coerce` (default) forwards them. */
  value_validation?: string;
}
const UNSAFE_LOOSE_OPTION_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const LOOSE_OPTION_OCCURRENCES = Symbol("looseOptionOccurrences");

interface LooseOptionsWithOccurrences extends Record<string, unknown> {
  [LOOSE_OPTION_OCCURRENCES]?: ParsedLooseOptionToken[];
}

function toLooseOptionKey(rawKey: string): string {
  const key = rawKey.trim().toLowerCase();
  return key.replaceAll(/-([a-z0-9])/g, (_match, group: string) =>
    group.toUpperCase(),
  );
}

function setLooseOptionValue(
  options: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const existing = options[key];
  if (existing === undefined) {
    options[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    options[key] = existing;
    return;
  }
  options[key] = [existing, value];
}

interface ParsedLooseOptionToken {
  consumed: number;
  key: string;
  value: unknown;
  /** True when the value was attached with `=`, as opposed to a following token. */
  attached?: boolean;
}

function parseLooseOptionToken(
  args: string[],
  index: number,
): ParsedLooseOptionToken | null {
  const token = args[index];
  if (!token.startsWith("-") || token === "-" || token === "--") {
    return null;
  }

  if (!token.startsWith("--")) {
    const equalsIndex = token.indexOf("=");
    if (equalsIndex >= 0) {
      return {
        consumed: 1,
        key: token.slice(1, equalsIndex).trim(),
        value: token.slice(equalsIndex + 1),
        attached: true,
      };
    }
    const key = token.slice(1).trim();
    const next = args[index + 1];
    if (typeof next === "string" && !next.startsWith("-")) {
      return {
        consumed: 2,
        key,
        value: next,
      };
    }
    return {
      consumed: 1,
      key,
      value: true,
    };
  }

  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    return {
      consumed: 1,
      key: token.slice(2, equalsIndex).trim(),
      value: token.slice(equalsIndex + 1),
      attached: true,
    };
  }

  if (token.startsWith("--no-")) {
    return {
      consumed: 1,
      key: token.slice(5).trim(),
      value: false,
    };
  }

  const key = token.slice(2).trim();
  const next = args[index + 1];
  if (typeof next === "string" && !next.startsWith("-")) {
    return {
      consumed: 2,
      key,
      value: next,
    };
  }
  return {
    consumed: 1,
    key,
    value: true,
  };
}

function isUnsafeLooseOptionKey(key: string): boolean {
  return UNSAFE_LOOSE_OPTION_KEYS.has(key);
}

type LooseOptionCoercionKind = "string" | "number" | "boolean";

function resolveLooseOptionCoercionKind(
  definition: LooseCommandFlagDefinition,
): LooseOptionCoercionKind | null {
  // `value_type` is the canonical field; the deprecated `type` alias resolves
  // only when `value_type` is absent (FlagDefinition documents this precedence).
  const raw =
    (typeof definition.value_type === "string"
      ? definition.value_type
      : undefined) ??
    (typeof definition.type === "string" ? definition.type : undefined);
  return resolveFlagValueKind(raw);
}

function collectLooseOptionKeys(
  definition: LooseCommandFlagDefinition,
): string[] {
  const keys: string[] = [];
  const long =
    resolveExtensionLongFlagName(definition.long) ?? "";
  const short =
    typeof definition.short === "string" ? definition.short.trim() : "";
  if (long.startsWith("--")) {
    const normalized = toLooseOptionKey(long.slice(2));
    if (normalized.length > 0 && !isUnsafeLooseOptionKey(normalized)) {
      keys.push(normalized);
    }
  }
  if (short.startsWith("-") && !short.startsWith("--")) {
    const normalized = toLooseOptionKey(short.slice(1));
    if (normalized.length > 0 && !isUnsafeLooseOptionKey(normalized)) {
      keys.push(normalized);
    }
  }
  return [...new Set(keys)];
}

/** Implements collect loose command option keys for definitions for the public runtime surface of this module. */
export function collectLooseCommandOptionKeysForDefinitions(
  definitions: ReadonlyArray<LooseCommandFlagDefinition>,
): Set<string> {
  const keys = new Set<string>();
  for (const definition of definitions) {
    for (const key of collectLooseOptionKeys(definition)) {
      keys.add(key);
    }
  }
  return keys;
}

function resolveCanonicalLooseOptionKey(
  definition: LooseCommandFlagDefinition,
): string | null {
  const long =
    resolveExtensionLongFlagName(definition.long) ?? "";
  if (long.startsWith("--")) {
    const normalized = toLooseOptionKey(long.slice(2));
    if (normalized.length > 0 && !isUnsafeLooseOptionKey(normalized)) {
      return normalized;
    }
  }
  return collectLooseOptionKeys(definition)[0] ?? null;
}

function formatLooseOptionLabel(
  definition: LooseCommandFlagDefinition,
): string | null {
  const long =
    typeof definition.long === "string" ? definition.long.trim() : "";
  if (long.startsWith("--") && long.length > 2) {
    return long;
  }
  const short =
    typeof definition.short === "string" ? definition.short.trim() : "";
  if (short.startsWith("-") && !short.startsWith("--") && short.length > 1) {
    return short;
  }
  return null;
}

/** Implements validate loose command options with flag definitions for the public runtime surface of this module. */
export function validateLooseCommandOptionsWithFlagDefinitions(
  options: Record<string, unknown>,
  definitions: ReadonlyArray<LooseCommandFlagDefinition>,
  commandPath: string,
): void {
  if (definitions.length === 0) {
    return;
  }
  const allowed = new Set<string>();
  const disabled = new Map<string, string>();
  const required: Array<{ keys: string[]; label: string }> = [];
  const labels: string[] = [];
  for (const definition of definitions) {
    const keys = collectLooseOptionKeys(definition);
    const normalizedLabel = formatLooseOptionLabel(definition);
    if (normalizedLabel !== null) {
      labels.push(normalizedLabel);
    }
    for (const key of keys) {
      allowed.add(key);
      if (definition.enabled === false) {
        disabled.set(key, normalizedLabel as string);
      }
    }
    if (
      definition.required === true &&
      definition.enabled !== false &&
      keys.length > 0
    ) {
      required.push({ keys, label: normalizedLabel as string });
    }
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      const expected =
        labels.length > 0
          ? ` Expected one of: ${[...new Set(labels)].join(", ")}.`
          : "";
      throw new PmCliError(
        `Unknown option '--${key}' for extension command '${commandPath}'.${expected}`,
        EXIT_CODE.USAGE,
      );
    }
    const disabledLabel = disabled.get(key);
    if (disabledLabel) {
      throw new PmCliError(
        `Option '${disabledLabel}' is disabled for extension command '${commandPath}'.`,
        EXIT_CODE.USAGE,
      );
    }
  }
  for (const entry of required) {
    if (!entry.keys.some((key) => Object.hasOwn(options, key))) {
      throw new PmCliError(
        `Missing required option '${entry.label}' for extension command '${commandPath}'.`,
        EXIT_CODE.USAGE,
      );
    }
  }
}

/** Coerce a scalar value to a string. Existing strings pass through untouched and the `null`/`undefined` sentinels are preserved so an explicitly-cleared flag stays distinguishable from an omitted one; every other primitive is stringified. */
function coerceLooseStringOptionValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return value;
  }
  return String(value);
}

/** Coerce a scalar value to a number. Existing numbers pass through; a non-blank numeric string is parsed and adopted only when it yields a finite number, otherwise the original value is returned unchanged so malformed input reaches validation rather than silently degrading to `NaN`. */
function coerceLooseNumberOptionValue(value: unknown): unknown {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

/** Coerce a scalar value to a boolean. Booleans pass through; the case-insensitive tokens `true`/`1` and `false`/`0` map to their boolean values and any other input is returned unchanged for validation to reject. */
function coerceLooseBooleanOptionValue(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return value;
}

// Per-kind scalar coercers dispatched by the declared flag value type. The table
// keeps `coerceLooseOptionValue` a flat array-or-scalar branch instead of a
// per-kind `if` ladder.
const LOOSE_OPTION_VALUE_COERCERS: Record<
  LooseOptionCoercionKind,
  (value: unknown) => unknown
> = {
  string: coerceLooseStringOptionValue,
  number: coerceLooseNumberOptionValue,
  boolean: coerceLooseBooleanOptionValue,
};

function coerceLooseOptionValue(
  value: unknown,
  kind: LooseOptionCoercionKind,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => coerceLooseOptionValue(entry, kind));
  }
  return LOOSE_OPTION_VALUE_COERCERS[kind](value);
}

/**
 * Normalize an accumulated extension flag while preserving the semantic
 * difference between the canonical CSV-friendly `list` form and the
 * package-author `repeatable` alias. Both accumulate occurrences in order;
 * `repeatable` additionally preserves commas inside each occurrence so
 * structured values such as `id=pm-a,kind=related` remain atomic.
 */
function normalizeAccumulatedFlagValue(
  value: unknown,
  kind: LooseOptionCoercionKind | null,
  preserveOccurrenceCommas: boolean,
): unknown[] {
  const entries = preserveOccurrenceCommas
    ? (Array.isArray(value) ? value.flat(Infinity) : [value]).filter(
        (entry) => entry !== undefined && entry !== null && entry !== "",
      )
    : flattenFlagListValue(value);
  return kind
    ? entries.map((entry) => coerceLooseOptionValue(entry, kind))
    : entries;
}

/** Resolve the value applied when a flag is omitted entirely. List flags wrap the default into an accumulated array; scalar flags coerce by declared kind. */
function applyFlagDefault(
  defaultValue: unknown,
  kind: LooseOptionCoercionKind | null,
  isListFlag: boolean,
  preserveOccurrenceCommas: boolean,
): unknown {
  if (isListFlag) {
    return normalizeAccumulatedFlagValue(
      defaultValue,
      kind,
      preserveOccurrenceCommas,
    );
  }
  return kind ? coerceLooseOptionValue(defaultValue, kind) : defaultValue;
}

/** Preserve parse-time value order for list flags whose long and short aliases are interleaved. */
function readOrderedLooseListValues(
  occurrenceSource: Record<string, unknown>,
  optionKeys: readonly string[],
  fallback: unknown,
): unknown {
  const occurrences = (occurrenceSource as LooseOptionsWithOccurrences)[
    LOOSE_OPTION_OCCURRENCES
  ];
  if (!occurrences || occurrences.length === 0) {
    return fallback;
  }
  const acceptedKeys = new Set(optionKeys);
  return occurrences
    .filter((occurrence) => acceptedKeys.has(occurrence.key))
    .map((occurrence) => occurrence.value);
}

/** Whether a declared `boolean` flag is a value-less switch (as opposed to the legacy `bool` optional-value grammar), per the shared value contract. */
function isBooleanSwitchDefinition(
  definition: LooseCommandFlagDefinition,
): boolean {
  return (
    resolveExtensionFlagValueContract(
      definition as Parameters<typeof resolveExtensionFlagValueContract>[0],
    ).value_arity === "none"
  );
}

/** Throw the typed usage refusal for one malformed strict scalar token. */
function refuseStrictScalarValue(
  definition: LooseCommandFlagDefinition,
  kind: Exclude<LooseOptionCoercionKind, "string">,
  entry: unknown,
  expected: string,
  commandPath: string | undefined,
): never {
  // A definition with a resolvable canonical key always has a printable label.
  const label = formatLooseOptionLabel(definition) as string;
  const scope = commandPath ? ` for extension command '${commandPath}'` : "";
  const received = entry === true ? "no value" : JSON.stringify(entry);
  throw new PmCliError(
    `Option '${label}'${scope} expects ${expected}; received ${received}.`,
    EXIT_CODE.USAGE,
    {
      code: "extension_flag_value_invalid",
      required: `Pass ${label} ${kind === "number" ? "<number>" : "<true|false|1|0>"}.`,
      why: `The flag declares value_type ${kind} with value_validation strict, so a malformed token is refused before the extension handler runs.`,
      nextSteps: [
        `Re-run with a valid ${kind} value for ${label}.`,
        `Run pm ${commandPath ?? "<command>"} --help to review the declared flag contract.`,
      ],
    },
  );
}

/** Whether the definition opts into strict refusal for a typed scalar. Registration refuses strict on string flags; untyped values never reach here. */
function isStrictTypedDefinition(
  definition: LooseCommandFlagDefinition,
  kind: LooseOptionCoercionKind,
): kind is Exclude<LooseOptionCoercionKind, "string"> {
  return definition.value_validation === "strict" && kind !== "string";
}

/** Read the parse-time occurrences recorded on the loose options object, if any. */
function readLooseOccurrences(
  occurrenceSource: Record<string, unknown>,
  optionKeys: readonly string[],
): ParsedLooseOptionToken[] {
  const occurrences = (occurrenceSource as LooseOptionsWithOccurrences)[
    LOOSE_OPTION_OCCURRENCES
  ];
  if (!occurrences) {
    return [];
  }
  const acceptedKeys = new Set(optionKeys);
  return occurrences.filter((occurrence) => acceptedKeys.has(occurrence.key));
}

/**
 * Refuse `--switch=<token>` when the attached token is not a boolean literal.
 * A following positional token is not an attached value: the switch keeps its
 * presence semantics and the token stays positional.
 */
function refuseMalformedAttachedSwitchValues(
  definition: LooseCommandFlagDefinition,
  optionKeys: readonly string[],
  occurrenceSource: Record<string, unknown>,
  commandPath: string | undefined,
): void {
  if (!isBooleanSwitchDefinition(definition)) {
    return;
  }
  for (const occurrence of readLooseOccurrences(occurrenceSource, optionKeys)) {
    if (occurrence.attached !== true) continue;
    const values = definition.list === true && definition.repeatable !== true
      ? flattenFlagListValue(occurrence.value)
      : [occurrence.value];
    for (const value of values) {
      const failure = describeFlagScalarValueFailure(
        coerceLooseOptionValue(value, "boolean"),
        "boolean",
      );
      if (failure !== null) {
        refuseStrictScalarValue(definition, "boolean", value, failure.expected, commandPath);
      }
    }
  }
}

/** Refuse an explicitly empty list entry (`--ids=`, or the empty CSV segment in `--ids=1,,2`) before list normalization silently drops it. Repeatable flags keep commas inside one occurrence, so only CSV lists split. */
function refuseEmptyStrictListEntries(
  definition: LooseCommandFlagDefinition,
  kind: Exclude<LooseOptionCoercionKind, "string">,
  rawValue: unknown,
  preserveOccurrenceCommas: boolean,
  commandPath: string | undefined,
): void {
  const occurrences = Array.isArray(rawValue) ? rawValue.flat(Infinity) : [rawValue];
  const entries = preserveOccurrenceCommas
    ? occurrences
    : occurrences.flatMap((entry) => (typeof entry === "string" ? entry.split(",") : [entry]));
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim().length === 0) {
      const failure = describeFlagScalarValueFailure(entry, kind);
      // An empty string never satisfies a number or boolean kind.
      refuseStrictScalarValue(definition, kind, entry, (failure as FlagScalarValueFailure).expected, commandPath);
    }
  }
}

/**
 * Refuse a strict-validated scalar whose coerced value is still malformed and
 * return the value to store. A `boolean` switch keeps its canonical presence
 * semantics: a following positional token that the loose parser read as its
 * value is not a malformed boolean, so the switch resolves to `true`.
 */
function validateStrictScalarOptionValue(
  definition: LooseCommandFlagDefinition,
  value: unknown,
  kind: LooseOptionCoercionKind,
  commandPath: string | undefined,
): unknown {
  if (!isStrictTypedDefinition(definition, kind)) {
    return value;
  }
  const isSwitch = kind === "boolean" && isBooleanSwitchDefinition(definition);
  const normalizeEntry = (entry: unknown): unknown => {
    const failure = describeFlagScalarValueFailure(entry, kind);
    if (failure === null) return entry;
    if (isSwitch && typeof entry === "string") return true;
    return refuseStrictScalarValue(definition, kind, entry, failure.expected, commandPath);
  };
  return Array.isArray(value) ? value.map(normalizeEntry) : normalizeEntry(value);
}

/** Fold short/alias spellings into the canonical option key: scalars keep the canonical value, list flags concatenate every spelling's values. */
function mergeAliasOptionKeys(
  coerced: Record<string, unknown>,
  canonical: string,
  optionKeys: readonly string[],
  isListFlag: boolean,
): void {
  for (const key of optionKeys) {
    if (key === canonical || !Object.hasOwn(coerced, key)) {
      continue;
    }
    if (Object.hasOwn(coerced, canonical)) {
      if (isListFlag) {
        const canonicalValue = coerced[canonical];
        const aliasValue = coerced[key];
        coerced[canonical] = [
          ...(Array.isArray(canonicalValue)
            ? canonicalValue
            : [canonicalValue]),
          ...(Array.isArray(aliasValue) ? aliasValue : [aliasValue]),
        ].filter((value) => value != null);
      }
      delete coerced[key];
      continue;
    }
    coerced[canonical] = coerced[key];
    delete coerced[key];
  }
}

/** Implements coerce loose command options with flag definitions for the public runtime surface of this module. */
export function coerceLooseCommandOptionsWithFlagDefinitions(
  options: Record<string, unknown>,
  definitions: ReadonlyArray<LooseCommandFlagDefinition>,
  occurrenceSource: Record<string, unknown> = options,
  commandPath?: string,
): Record<string, unknown> {
  if (definitions.length === 0) {
    return options;
  }
  const coerced = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(options)) {
    coerced[key] = value;
  }
  const canonicalKeys = new Set(
    definitions
      .map((definition) => resolveCanonicalLooseOptionKey(definition))
      .filter((key): key is string => key !== null),
  );
  for (const definition of definitions) {
    const canonical = resolveCanonicalLooseOptionKey(definition);
    if (canonical) {
      // A lower-cased short alias (`-S` -> `s`) never absorbs another flag's own key (`--s`).
      const optionKeys = collectLooseOptionKeys(definition).filter(
        (key) => key === canonical || !canonicalKeys.has(key),
      );
      coerceDefinedLooseOption(coerced, definition, canonical, optionKeys, occurrenceSource, commandPath);
    }
  }
  return coerced;
}

/** Fold, default, normalize, and strictly validate one declared flag in place under its canonical key. */
function coerceDefinedLooseOption(
  coerced: Record<string, unknown>,
  definition: LooseCommandFlagDefinition,
  canonical: string,
  optionKeys: readonly string[],
  occurrenceSource: Record<string, unknown>,
  commandPath: string | undefined,
): void {
  const isListFlag = definition.list === true;
  const kind = resolveLooseOptionCoercionKind(definition);
  if (kind && !isListFlag) {
    refuseMalformedScalarAliasValues(coerced, definition, canonical, optionKeys, kind, commandPath);
  }
  mergeAliasOptionKeys(coerced, canonical, optionKeys, isListFlag);
  const preserveOccurrenceCommas = definition.repeatable === true;
  if (!Object.hasOwn(coerced, canonical)) {
    // Flag was omitted entirely: apply the declared default when present.
    if (definition.default !== undefined) {
      coerced[canonical] = applyFlagDefault(
        definition.default,
        kind,
        isListFlag,
        preserveOccurrenceCommas,
      );
    }
    return;
  }
  if (kind === "boolean" && isStrictTypedDefinition(definition, kind)) {
    refuseMalformedAttachedSwitchValues(definition, optionKeys, occurrenceSource, commandPath);
  }
  if (isListFlag) {
    coerced[canonical] = coerceAccumulatedLooseOption(
      definition,
      optionKeys,
      occurrenceSource,
      coerced[canonical],
      kind,
      preserveOccurrenceCommas,
      commandPath,
    );
    return;
  }
  if (!kind) {
    return;
  }
  coerced[canonical] = validateStrictScalarOptionValue(
    definition,
    coerceLooseOptionValue(coerced[canonical], kind),
    kind,
    commandPath,
  );
}

/** Alias folding keeps the canonical scalar and drops the alias value, so a malformed alias token must be refused before it is discarded. */
function refuseMalformedScalarAliasValues(
  coerced: Record<string, unknown>,
  definition: LooseCommandFlagDefinition,
  canonical: string,
  optionKeys: readonly string[],
  kind: LooseOptionCoercionKind,
  commandPath: string | undefined,
): void {
  for (const key of optionKeys) {
    if (key !== canonical && Object.hasOwn(coerced, key)) {
      validateStrictScalarOptionValue(
        definition,
        coerceLooseOptionValue(coerced[key], kind),
        kind,
        commandPath,
      );
    }
  }
}

/** Order, normalize, and strictly validate the accumulated values of a list or repeatable flag. */
function coerceAccumulatedLooseOption(
  definition: LooseCommandFlagDefinition,
  optionKeys: readonly string[],
  occurrenceSource: Record<string, unknown>,
  current: unknown,
  kind: LooseOptionCoercionKind | null,
  preserveOccurrenceCommas: boolean,
  commandPath: string | undefined,
): unknown {
  const ordered = readOrderedLooseListValues(occurrenceSource, optionKeys, current);
  if (kind && isStrictTypedDefinition(definition, kind)) {
    refuseEmptyStrictListEntries(definition, kind, ordered, preserveOccurrenceCommas, commandPath);
  }
  const normalized = normalizeAccumulatedFlagValue(ordered, kind, preserveOccurrenceCommas);
  return kind
    ? validateStrictScalarOptionValue(definition, normalized, kind, commandPath)
    : normalized;
}

/** Implements parse loose command options for the public runtime surface of this module. */
export function parseLooseCommandOptions(
  args: string[],
): Record<string, unknown> {
  const options = Object.create(null) as LooseOptionsWithOccurrences;
  const occurrences: ParsedLooseOptionToken[] = [];
  Object.defineProperty(options, LOOSE_OPTION_OCCURRENCES, {
    value: occurrences,
  });
  let index = 0;
  while (index < args.length) {
    const parsed = parseLooseOptionToken(args, index);
    if (!parsed) {
      index += 1;
      continue;
    }

    const normalizedKey = toLooseOptionKey(parsed.key);
    if (normalizedKey.length === 0 || isUnsafeLooseOptionKey(normalizedKey)) {
      index += parsed.consumed;
      continue;
    }
    setLooseOptionValue(options, normalizedKey, parsed.value);
    occurrences.push({ ...parsed, key: normalizedKey });
    index += parsed.consumed;
  }
  return options;
}

/** Returns the positional operands in `args`, skipping option tokens and the values they consume (`--flag value`, `--flag=value`, `-f value`, and boolean flags). Tokens after a bare `--` separator are all positional. Used to count genuinely unexpected positionals for extension commands that declare no arguments without miscounting leaked/undeclared option tokens as operands. */
export function collectLoosePositionalArgs(args: string[]): string[] {
  const positionals: string[] = [];
  let index = 0;
  while (index < args.length) {
    if (args[index] === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    const parsed = parseLooseOptionToken(args, index);
    if (parsed) {
      index += Math.max(1, parsed.consumed);
      continue;
    }
    positionals.push(args[index]);
    index += 1;
  }
  return positionals;
}

/** Implements strip loose command option tokens for the public runtime surface of this module. */
export function stripLooseCommandOptionTokens(
  args: string[],
  definitions: ReadonlyArray<LooseCommandFlagDefinition>,
): string[] {
  if (definitions.length === 0) {
    return [...args];
  }
  const knownKeys = new Set<string>();
  const booleanKeys = new Set<string>();
  for (const definition of definitions) {
    const valueKind = resolveLooseOptionCoercionKind(definition);
    for (const key of collectLooseOptionKeys(definition)) {
      knownKeys.add(key);
      if (valueKind === "boolean") {
        booleanKeys.add(key);
      }
    }
  }
  if (knownKeys.size === 0) {
    return [...args];
  }

  const stripped: string[] = [];
  let index = 0;
  while (index < args.length) {
    if (args[index] === "--") {
      stripped.push(...args.slice(index + 1));
      break;
    }
    const parsed = parseLooseOptionToken(args, index);
    if (parsed) {
      const normalizedKey = toLooseOptionKey(parsed.key);
      if (knownKeys.has(normalizedKey)) {
        const token = args[index] as string;
        const consumed =
          booleanKeys.has(normalizedKey) && !token.includes("=")
            ? 1
            : parsed.consumed;
        index += consumed;
        continue;
      }
    }
    stripped.push(args[index]);
    index += 1;
  }
  return stripped;
}

/**
 * Handler option key a declared extension flag is delivered under in
 * `context.options` — the key `pm contracts` publishes as `sdk_option` and the
 * key direct callers pass to `PmClient.run` or the test harness.
 */
export function resolveExtensionFlagOptionKey(
  definition: LooseCommandFlagDefinition,
): string | null {
  return resolveCanonicalLooseOptionKey(definition);
}

/** Normalize a command path the way extension registration does: trimmed, lower-cased, single-spaced. */
function normalizeFlagTargetCommandPath(commandPath: string): string {
  return commandPath
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");
}

/** Join contributed flags by stable operation identity so canonical and compatibility command paths share one schema. */
export function collectExtensionFlagDefinitionsForCommand(
  registrations: {
    readonly flags: ReadonlyArray<{
      readonly target_command: string;
      readonly flags: readonly FlagDefinition[];
    }>;
  },
  commandPath: string,
): FlagDefinition[] {
  const normalizedCommandPath = normalizeFlagTargetCommandPath(commandPath);
  if (normalizedCommandPath.length === 0) {
    return [];
  }
  const operation = resolvePmCommandOperation(normalizedCommandPath);
  return registrations.flags
    .filter(
      (entry) =>
        resolvePmCommandOperation(
          normalizeFlagTargetCommandPath(entry.target_command),
        ) === operation,
    )
    .flatMap((entry) => [...entry.flags]);
}

/** Refuse two spellings of one declared flag that carry different values, instead of silently keeping one. */
function refuseConflictingOptionSpellings(
  definition: LooseCommandFlagDefinition,
  handlerKey: string,
  spellings: readonly [string, string],
  commandPath: string,
): never {
  // Declarations with a handler key always carry a printable long or short label.
  const label = formatLooseOptionLabel(definition) as string;
  const [first, second] = spellings;
  throw new PmCliError(
    `Options '${first}' and '${second}' both set ${label} for extension command '${commandPath}' with different values.`,
    EXIT_CODE.USAGE,
    {
      code: "extension_option_spelling_conflict",
      required: `Pass ${label} once, under the handler key '${handlerKey}'.`,
      why: `'${first}' and '${second}' are spellings of the same declared flag, and pm refuses to choose between two different values.`,
      nextSteps: [
        `Remove '${first}' or '${second}' and pass one value as '${handlerKey}'.`,
        `Run pm contracts --command ${commandPath} --flags-only --json to read each flag's sdk_option key.`,
      ],
    },
  );
}

/**
 * Normalize the options a direct caller — `PmClient.run`, an MCP tool call, or
 * the extension test harness — passes to an extension command, exactly as CLI
 * dispatch normalizes argv. Each declared spelling of a flag (`statusFilter`,
 * `status-filter`, `--status-filter`, or its short letter) folds into the
 * handler key, then declared defaults, value coercion, and strict validation
 * apply through {@link coerceLooseCommandOptionsWithFlagDefinitions}. An
 * `undefined` value counts as omitted. Undeclared keys pass through unchanged.
 * Two spellings of one flag with different values are refused with
 * `extension_option_spelling_conflict`.
 */
export function normalizeDirectExtensionCommandOptions(
  options: Record<string, unknown>,
  definitions: ReadonlyArray<LooseCommandFlagDefinition>,
  commandPath: string,
): Record<string, unknown> {
  if (definitions.length === 0) {
    return options;
  }
  const index = indexDeclaredOptionSpellings(definitions);
  const folded = foldDirectOptionSpellings(options, index, commandPath);
  // Only declared handler keys reach the shared coercer: its CLI alias folding (`-S` -> `s`) must never
  // rewrite or absorb an undeclared key a direct caller passes through.
  const handlerKeys = new Set([...index.long.values()].map(({ handlerKey }) => handlerKey));
  const declared = Object.create(null) as Record<string, unknown>;
  const passthrough = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(folded)) {
    (handlerKeys.has(key) ? declared : passthrough)[key] = value;
  }
  // Required and disabled declarations bind direct callers as they bind CLI argv.
  validateLooseCommandOptionsWithFlagDefinitions(declared, definitions, commandPath);
  return Object.assign(
    passthrough,
    coerceLooseCommandOptionsWithFlagDefinitions(
      declared,
      definitions,
      recordDirectOptionOccurrences(declared, index),
      commandPath,
    ),
  );
}

/**
 * Record each declared direct value as an attached occurrence. A direct caller
 * names the value explicitly, as `--flag=value` does, so there is no following
 * positional token to reinterpret: a strict boolean switch given `"nonsense"`
 * is refused instead of resolving to `true` (CLI argv keeps that fallback for
 * a separated token). Array values, nested or not, become one occurrence per
 * scalar entry, matching the list coercer's recursive flattening.
 */
function recordDirectOptionOccurrences(
  folded: Record<string, unknown>,
  index: DeclaredOptionSpellingIndex,
): Record<string, unknown> {
  const handlerKeys = new Set([...index.long.values()].map(({ handlerKey }) => handlerKey));
  const occurrences: ParsedLooseOptionToken[] = Object.entries(folded)
    .filter(([key]) => handlerKeys.has(key))
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value.flat(Infinity) : [value]).map((entry) => ({ consumed: 1, key, value: entry, attached: true })),
    );
  const occurrenceSource = Object.create(null) as LooseOptionsWithOccurrences;
  Object.defineProperty(occurrenceSource, LOOSE_OPTION_OCCURRENCES, { value: occurrences });
  return occurrenceSource;
}

/** A declared flag reachable through one direct-caller spelling. */
interface DeclaredOptionSpelling {
  handlerKey: string;
  definition: LooseCommandFlagDefinition;
}

/**
 * Direct-caller spellings of the declared flags. Long spellings fold through
 * the CLI's camel-case key; short letters stay case-sensitive, as Commander
 * keeps `-s` and `-S` distinct on the CLI. The first declaration of a spelling
 * owns it.
 */
interface DeclaredOptionSpellingIndex {
  long: Map<string, DeclaredOptionSpelling>;
  short: Map<string, DeclaredOptionSpelling>;
}

/** Index every declared long and short spelling by the handler key it folds into. */
function indexDeclaredOptionSpellings(
  definitions: ReadonlyArray<LooseCommandFlagDefinition>,
): DeclaredOptionSpellingIndex {
  const index: DeclaredOptionSpellingIndex = { long: new Map(), short: new Map() };
  const claim = (map: Map<string, DeclaredOptionSpelling>, spelling: string, entry: DeclaredOptionSpelling): void => {
    if (spelling.length > 0 && !map.has(spelling)) map.set(spelling, entry);
  };
  for (const definition of definitions) {
    const handlerKey = resolveCanonicalLooseOptionKey(definition);
    if (handlerKey === null) continue;
    const entry = { handlerKey, definition };
    claim(index.long, handlerKey, entry);
    const short = typeof definition.short === "string" ? definition.short.trim() : "";
    if (short.startsWith("-") && !short.startsWith("--")) claim(index.short, short.slice(1), entry);
  }
  return index;
}

/** Resolve one direct-caller key: a handler key, a case-sensitive short letter, or a long spelling. */
function resolveDeclaredOptionSpelling(
  index: DeclaredOptionSpellingIndex,
  spelling: string,
): DeclaredOptionSpelling | undefined {
  return (
    index.long.get(spelling) ??
    index.short.get(spelling.replace(/^-(?!-)/u, "")) ??
    index.long.get(toLooseOptionKey(spelling.replace(/^-{1,2}/u, "")))
  );
}

/**
 * Read `--no-verbose: true` (or `no-verbose`) as `verbose: false` for a declared
 * boolean flag, as Commander does on the CLI. A spelling that is itself
 * declared, or names no declared boolean, is left as it is.
 */
function resolveNegatedBooleanSpelling(
  index: DeclaredOptionSpellingIndex,
  spelling: string,
  value: unknown,
): { spelling: string; value: unknown } {
  const negated = /^(?:--)?no-(.+)$/u.exec(spelling)?.[1];
  if (negated === undefined || resolveDeclaredOptionSpelling(index, spelling) !== undefined) {
    return { spelling, value };
  }
  const declared = resolveDeclaredOptionSpelling(index, negated);
  const flag = coerceLooseBooleanOptionValue(value);
  return declared !== undefined &&
    resolveLooseOptionCoercionKind(declared.definition) === "boolean" &&
    typeof flag === "boolean"
    ? { spelling: negated, value: !flag }
    : { spelling, value };
}

/** Fold declared spellings into handler keys, refusing two spellings of one flag with different values. */
function foldDirectOptionSpellings(
  options: Record<string, unknown>,
  index: DeclaredOptionSpellingIndex,
  commandPath: string,
): Record<string, unknown> {
  const folded = Object.create(null) as Record<string, unknown>;
  const suppliedBy = new Map<string, string>();
  for (const [rawSpelling, rawValue] of Object.entries(options)) {
    const { spelling, value } = resolveNegatedBooleanSpelling(index, rawSpelling, rawValue);
    const declared = resolveDeclaredOptionSpelling(index, spelling);
    if (declared === undefined) {
      folded[spelling] = value;
    } else if (value !== undefined) {
      const prior = suppliedBy.get(declared.handlerKey);
      if (prior === undefined) {
        suppliedBy.set(declared.handlerKey, spelling);
        folded[declared.handlerKey] = value;
      } else if (!isDeepStrictEqual(folded[declared.handlerKey], value)) {
        refuseConflictingOptionSpellings(declared.definition, declared.handlerKey, [prior, spelling], commandPath);
      }
    }
  }
  return folded;
}
