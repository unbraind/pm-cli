import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";
import { flattenFlagListValue, resolveFlagValueKind } from "../core/extensions/flag-value-types.js";

const UNSAFE_LOOSE_OPTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function toLooseOptionKey(rawKey: string): string {
  const key = rawKey.trim().toLowerCase();
  return key.replaceAll(/-([a-z0-9])/g, (_match, group: string) => group.toUpperCase());
}

function setLooseOptionValue(options: Record<string, unknown>, key: string, value: unknown): void {
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
}

function parseLooseOptionToken(args: string[], index: number): ParsedLooseOptionToken | null {
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

function resolveLooseOptionCoercionKind(definition: Record<string, unknown>): LooseOptionCoercionKind | null {
  // `value_type` is the canonical field; the deprecated `type` alias resolves
  // only when `value_type` is absent (FlagDefinition documents this precedence).
  const raw =
    (typeof definition.value_type === "string" ? definition.value_type : undefined) ??
    (typeof definition.type === "string" ? definition.type : undefined);
  return resolveFlagValueKind(raw);
}

function collectLooseOptionKeys(definition: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const long = typeof definition.long === "string" ? definition.long.trim() : "";
  const short = typeof definition.short === "string" ? definition.short.trim() : "";
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

export function collectLooseCommandOptionKeysForDefinitions(
  definitions: Array<Record<string, unknown>>,
): Set<string> {
  const keys = new Set<string>();
  for (const definition of definitions) {
    for (const key of collectLooseOptionKeys(definition)) {
      keys.add(key);
    }
  }
  return keys;
}

function resolveCanonicalLooseOptionKey(definition: Record<string, unknown>): string | null {
  const long = typeof definition.long === "string" ? definition.long.trim() : "";
  if (long.startsWith("--")) {
    const normalized = toLooseOptionKey(long.slice(2));
    if (normalized.length > 0 && !isUnsafeLooseOptionKey(normalized)) {
      return normalized;
    }
  }
  return collectLooseOptionKeys(definition)[0] ?? null;
}

function formatLooseOptionLabel(definition: Record<string, unknown>): string | null {
  const long = typeof definition.long === "string" ? definition.long.trim() : "";
  if (long.startsWith("--") && long.length > 2) {
    return long;
  }
  const short = typeof definition.short === "string" ? definition.short.trim() : "";
  if (short.startsWith("-") && !short.startsWith("--") && short.length > 1) {
    return short;
  }
  return null;
}

export function validateLooseCommandOptionsWithFlagDefinitions(
  options: Record<string, unknown>,
  definitions: Array<Record<string, unknown>>,
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
    const label = formatLooseOptionLabel(definition);
    const fallbackLabel = keys.length > 0 ? `--${keys[0]}` : null;
    const normalizedLabel = label ?? fallbackLabel;
    if (normalizedLabel) {
      labels.push(normalizedLabel);
    }
    for (const key of keys) {
      allowed.add(key);
      if (definition.enabled === false) {
        disabled.set(key, normalizedLabel as string);
      }
    }
    if (definition.required === true && definition.enabled !== false && keys.length > 0) {
      required.push({ keys, label: normalizedLabel as string });
    }
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      const expected = labels.length > 0 ? ` Expected one of: ${[...new Set(labels)].join(", ")}.` : "";
      throw new PmCliError(`Unknown option '--${key}' for extension command '${commandPath}'.${expected}`, EXIT_CODE.USAGE);
    }
    const disabledLabel = disabled.get(key);
    if (disabledLabel) {
      throw new PmCliError(`Option '${disabledLabel}' is disabled for extension command '${commandPath}'.`, EXIT_CODE.USAGE);
    }
  }
  for (const entry of required) {
    if (!entry.keys.some((key) => Object.hasOwn(options, key))) {
      throw new PmCliError(`Missing required option '${entry.label}' for extension command '${commandPath}'.`, EXIT_CODE.USAGE);
    }
  }
}

function coerceLooseOptionValue(value: unknown, kind: LooseOptionCoercionKind): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => coerceLooseOptionValue(entry, kind));
  }
  if (kind === "string") {
    if (typeof value === "string") {
      return value;
    }
    if (value === null || value === undefined) {
      return value;
    }
    return String(value);
  }
  if (kind === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
  }
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

/**
 * Flatten a (possibly repeated and/or comma-joined) value into a list, applying
 * the declared coercion kind per element. Mirrors how core list flags such as
 * `--tags` split comma values and accumulate repeated occurrences, so an
 * extension flag declared `list: true` behaves identically. Empty segments are
 * dropped and surrounding whitespace is trimmed.
 */
function splitCommaListValue(value: unknown, kind: LooseOptionCoercionKind | null): unknown[] {
  const entries = flattenFlagListValue(value);
  return kind ? entries.map((entry) => coerceLooseOptionValue(entry, kind)) : entries;
}

/**
 * Resolve the value applied when a flag is omitted entirely. List flags wrap the
 * default into an accumulated array; scalar flags coerce by declared kind.
 */
function applyFlagDefault(
  defaultValue: unknown,
  kind: LooseOptionCoercionKind | null,
  isListFlag: boolean,
): unknown {
  if (isListFlag) {
    return splitCommaListValue(defaultValue, kind);
  }
  return kind ? coerceLooseOptionValue(defaultValue, kind) : defaultValue;
}

export function coerceLooseCommandOptionsWithFlagDefinitions(
  options: Record<string, unknown>,
  definitions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (definitions.length === 0) {
    return options;
  }
  const coerced = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(options)) {
    coerced[key] = value;
  }
  for (const definition of definitions) {
    const canonical = resolveCanonicalLooseOptionKey(definition);
    if (!canonical) {
      continue;
    }
    for (const key of collectLooseOptionKeys(definition)) {
      if (key === canonical || !Object.hasOwn(coerced, key)) {
        continue;
      }
      if (Object.hasOwn(coerced, canonical)) {
        continue;
      }
      coerced[canonical] = coerced[key];
      delete coerced[key];
    }
    const kind = resolveLooseOptionCoercionKind(definition);
    const isListFlag = definition.list === true;
    if (!Object.hasOwn(coerced, canonical)) {
      // Flag was omitted entirely: apply the declared default when present.
      if (definition.default !== undefined) {
        coerced[canonical] = applyFlagDefault(definition.default, kind, isListFlag);
      }
      continue;
    }
    if (isListFlag) {
      coerced[canonical] = splitCommaListValue(coerced[canonical], kind);
      continue;
    }
    if (!kind) {
      continue;
    }
    coerced[canonical] = coerceLooseOptionValue(coerced[canonical], kind);
  }
  return coerced;
}

export function parseLooseCommandOptions(args: string[]): Record<string, unknown> {
  const options = Object.create(null) as Record<string, unknown>;
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
    index += parsed.consumed;
  }
  return options;
}

export function stripLooseCommandOptionTokens(
  args: string[],
  definitions: Array<Record<string, unknown>>,
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
        const consumed = booleanKeys.has(normalizedKey) && !token.includes("=") ? 1 : parsed.consumed;
        index += consumed;
        continue;
      }
    }
    stripped.push(args[index]);
    index += 1;
  }
  return stripped;
}
