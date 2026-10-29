/**
 * @module core/shared/output-unicode
 *
 * Applies the host's format-independent Unicode policy to structured output.
 */
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

/**
 * Refuse malformed strings or keys in JSON-compatible output with a typed field
 * diagnostic. This never changes the caller's data. Use toWellFormedText at an
 * external text boundary when replacement is the producer's intended policy.
 */
export function assertWellFormedOutputText(value: unknown): void {
  const malformed = findIllFormedOutputText(value, "$", new WeakSet());
  if (!malformed) return;
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
