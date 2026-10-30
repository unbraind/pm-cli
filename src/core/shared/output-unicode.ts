/**
 * @module core/shared/output-unicode
 *
 * Applies the host's format-independent Unicode policy to structured output.
 */
import { isBoxedPrimitive } from "node:util/types";
import { EXIT_CODE } from "./constants.js";
import { PmCliError } from "./errors.js";

const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

/** Replace lone UTF-16 surrogates while preserving valid astral characters. */
export function toWellFormedText(value: string): string {
  return value.replaceAll(LONE_SURROGATE_PATTERN, "�");
}

/** First malformed string in a structured value, without retaining its contents. */
interface IllFormedOutputText {
  field: string;
  index: number;
}

/** Keep diagnostic coordinates printable even when the offending key is malformed. */
function outputFieldPath(field: string, key: string, array: boolean): string {
  if (array && /^\d+$/u.test(key)) return `${field}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? `${field}.${key}` : `${field}[${JSON.stringify(key)}]`;
}

/** Find malformed strings and keys; leave circular-value admission to the serializer. */
function findIllFormedOutputText(value: unknown, field: string, seen: WeakSet<object>): IllFormedOutputText | undefined {
  if (typeof value === "string") {
    const index = value.search(LONE_SURROGATE_PATTERN);
    return index < 0 ? undefined : { field, index };
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const child = outputFieldPath(field, key, Array.isArray(value));
    const malformed = findIllFormedOutputText(key, `${child} (key)`, seen) ?? findIllFormedOutputText(entry, child, seen);
    if (malformed) return malformed;
  }
  return undefined;
}

/** Materialize boxed primitives and custom JSON serializers once, preserving shared/circular data. */
function snapshotOutputText(value: unknown, key: string, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isBoxedPrimitive(value) || typeof (value as { toJSON?: unknown }).toJSON === "function") {
    // The wrapper supplies the same key argument as JSON.stringify at this position.
    return (JSON.parse(JSON.stringify({ [key]: value })) as Record<string, unknown>)[key];
  }
  if (seen.has(value)) return seen.get(value);
  const snapshot = Array.isArray(value) ? new Array(value.length) : {};
  seen.set(value, snapshot);
  for (const [childKey, entry] of Object.entries(value)) {
    Object.defineProperty(snapshot, childKey, {
      value: snapshotOutputText(entry, childKey, seen), enumerable: true, configurable: true, writable: true,
    });
  }
  return snapshot;
}

/** Build the validated snapshot used by both native formatters, without a second toJSON call. */
export function prepareWellFormedOutputText(value: unknown): unknown {
  const snapshot = snapshotOutputText(value, "", new WeakMap());
  const malformed = findIllFormedOutputText(snapshot, "$", new WeakSet());
  if (malformed) throwIllFormedOutputText(malformed);
  return snapshot;
}

/** Raise the shared typed diagnostic without including the malformed value. */
function throwIllFormedOutputText(malformed: IllFormedOutputText): never {
  throw new PmCliError(
    `Output field ${malformed.field} contains an unpaired surrogate code unit at index ${malformed.index}; structured output requires well-formed Unicode.`,
    EXIT_CODE.USAGE,
    {
      code: "text_unpaired_surrogate",
      field: malformed.field,
      required: "Well-formed UTF-16 strings and object keys in both JSON and TOON output.",
      nextSteps: ["Repair the producer's text before returning output; use toWellFormedText from @unbrained/pm-cli/sdk when replacement is intended."],
    },
  );
}

/**
 * Refuse malformed strings or keys in JSON-compatible output with a typed field
 * diagnostic. This never changes the caller's data. Use toWellFormedText at an
 * external text boundary when replacement is the producer's intended policy.
 */
export function assertWellFormedOutputText(value: unknown): void {
  prepareWellFormedOutputText(value);
}
