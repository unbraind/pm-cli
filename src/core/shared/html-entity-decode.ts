// Defensive HTML-entity decode for free-text fields arriving over the MCP boundary.
// Background (pm-ydkl 2026-05-28): when Claude / the Anthropic MCP SDK forwards
// tool arguments containing `<` or `>`, the upstream platform HTML-encodes those
// characters before they reach pm-cli. The result is stored pm text containing
// literal `&lt;type&gt;` instead of `<type>`. Direct CLI calls do NOT have this
// issue — only the MCP path — so the decode is applied exclusively at the MCP
// server boundary on incoming tool-call arguments.
//
// We decode only the five core HTML entities and ONLY when `&lt;` or `&gt;` is
// present in the string (the signal that something upstream HTML-encoded it).
// That makes the function a true no-op for normal text. All replacements run in
// a single non-greedy pass via a lookup map so we never double-decode — most
// importantly `&amp;lt;` stays as the literal `&lt;` (because `&amp;` is the
// last entity resolved in the pass), preserving any text that was already
// double-encoded upstream.

const ENTITY_MAP: Readonly<Record<string, string>> = Object.freeze({
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&amp;": "&",
});

// Pattern order is important for documentation only: the alternation matches
// the leftmost occurrence at each position, and the map lookup resolves each
// match independently. Crucially, `&amp;` is matched as a whole token, so a
// substring like `&amp;lt;` matches `&amp;` once → `&lt;` (literal) and the
// regex engine then advances past the inserted text without re-scanning it.
const ENTITY_PATTERN = /&(?:lt|gt|quot|#39|amp);/g;

/**
 * Decode the five core HTML entities (`&lt;`, `&gt;`, `&quot;`, `&#39;`,
 * `&amp;`) in a single pass — but only when the input contains `&lt;` or
 * `&gt;`. Returns the input unchanged otherwise so the function is a no-op for
 * normal text and idempotent on already-decoded strings.
 *
 * Single-pass semantics guarantee `&amp;lt;` decodes to `&lt;` (literal) rather
 * than collapsing to `<`, preserving any intentional double-encoding.
 */
export function decodeHtmlEntitiesIfEscaped(input: string): string {
  if (typeof input !== "string") {
    return input;
  }
  if (!input.includes("&lt;") && !input.includes("&gt;")) {
    return input;
  }
  // The regex only matches keys present in ENTITY_MAP, so the lookup is total.
  return input.replace(ENTITY_PATTERN, (match) => ENTITY_MAP[match] as string);
}

/**
 * Walk an arbitrary value (string / array / plain object) and apply
 * {@link decodeHtmlEntitiesIfEscaped} to every string leaf. Non-string scalars
 * (numbers, booleans, null, undefined) and non-plain values pass through
 * untouched.
 *
 * The walker mutates a fresh shallow copy at each level so the caller's input
 * is not modified. Cycles are not expected (MCP arguments arrive as JSON), but
 * a visited-set is used as defensive protection against accidental cycles.
 */
export function decodeHtmlEntitiesInOptions<T>(options: T): T {
  return decodeValue(options, new WeakSet<object>()) as T;
}

function decodeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return decodeHtmlEntitiesIfEscaped(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    return value.map((entry) => decodeValue(entry, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value as object)) {
      return value;
    }
    seen.add(value as object);
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      result[key] = decodeValue(entry, seen);
    }
    return result;
  }
  return value;
}
