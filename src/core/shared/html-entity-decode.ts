/**
 * @module core/shared/html-entity-decode
 *
 * Provides shared primitives and utilities for Html Entity Decode.
 */
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
  // Activation signal is INTENTIONALLY narrow: only `&lt;` / `&gt;` trigger
  // decoding. Rationale: the observed MCP-platform behavior only encodes
  // angle brackets (the characters that risk display-time HTML
  // misinterpretation upstream). Widening to `&amp;` / `&quot;` / `&#39;`
  // would risk altering legitimate text that contains those literal token
  // sequences for unrelated reasons (a URL containing `&amp;`, a snippet
  // of HTML being intentionally stored as escaped, etc.). If upstream
  // changes its encoding policy to cover `&` / `"` / `'` standalone, the
  // signal-guard here will need to be widened in lockstep — covered by
  // tests `&amp;-only is no-op` and `&quot;-only is no-op`.
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
 * a WeakMap is used as defensive protection against accidental cycles and
 * repeated references.
 */
export function decodeHtmlEntitiesInOptions<T>(options: T): T {
  return decodeValue(options, new WeakMap<object, unknown>()) as T;
}

function decodeValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") {
    return decodeHtmlEntitiesIfEscaped(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return seen.get(value);
    }
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) {
      result.push(decodeValue(entry, seen));
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    // Only traverse plain objects (`{}` and `Object.create(null)` literals).
    // Class instances (Date, RegExp, Map, Set, Buffer, etc.) and `null`-proto
    // objects with no proto would lose their prototype and methods if we
    // rebuilt them as a `Record<string, unknown>` here, so we pass them through.
    if (!isPlainObject(value)) {
      return value;
    }
    if (seen.has(value as object)) {
      return seen.get(value as object);
    }
    const source = value as Record<string, unknown>;
    // Preserve the original prototype so downstream callers can still rely on
    // standard methods like `.hasOwnProperty` on plain objects.
    const result: Record<string, unknown> = Object.create(
      Object.getPrototypeOf(value as object),
    );
    seen.set(value as object, result);
    // Use Object.defineProperty (not bracket assignment) for ALL keys so a
    // smuggled `__proto__` / `constructor` / `prototype` key from an MCP
    // caller becomes a regular own property — never triggers JS's special
    // prototype-chain assignment semantics that would otherwise pollute
    // Object.prototype. This preserves legitimate data while staying safe.
    for (const [key, entry] of Object.entries(source)) {
      Object.defineProperty(result, key, {
        value: decodeValue(entry, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
