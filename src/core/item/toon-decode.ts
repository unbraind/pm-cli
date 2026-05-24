import { decode as decodeToon } from "@toon-format/toon";

import { toErrorMessage } from "../shared/primitives.js";

export interface ToonDecodeResult {
  /** The decoded TOON document. */
  value: unknown;
  /** True when strict decode failed for the known parser bug and the lenient retry was used. */
  usedLenientFallback: boolean;
}

/**
 * Error-message fragments emitted by the upstream `@toon-format/toon` strict
 * decoder when its array-header detection mis-reads a quoted scalar value that
 * contains a bracketed token followed by a colon (e.g. `"...[redacted]: x"`,
 * `"...[Unreleased]: x"`, `"...[med]: x"`). These are the only strict failures
 * we work around; every other strict error (duplicate sibling keys, tabs in
 * indentation, unterminated strings, etc.) must keep failing so strict
 * validation semantics are preserved.
 */
const BRACKET_MISPARSE_SIGNATURES = [
  "Invalid array length",
  "between bracket segment and colon",
  "between bracket and fields segment",
] as const;

function isBracketColonMisparse(error: unknown): boolean {
  const message = toErrorMessage(error);
  return BRACKET_MISPARSE_SIGNATURES.some((signature) => message.includes(signature));
}

/**
 * Decode a TOON item document, working around an upstream `@toon-format/toon`
 * round-trip bug.
 *
 * The strict decoder's array-header detection scans the whole line for an
 * opening bracket when the key is unquoted, so a quoted scalar VALUE that
 * contains a bracketed token immediately followed by a colon is mis-detected as
 * a `key`+bracket+colon array header and throws. The library's own `encode()`
 * emits exactly this otherwise-correctly-quoted form, so strict decode cannot
 * read the encoder's own output for such values.
 *
 * In lenient mode the same mis-detection does not throw — the line falls back
 * to a scalar key/value, which round-trips the original string correctly. We
 * therefore try strict first (retaining duplicate-key and other strict
 * protections for normal documents) and fall back to lenient decode ONLY when
 * strict fails with one of the bracket mis-parse signatures. Any other strict
 * error — including the duplicate-sibling-key conflicts that lenient mode would
 * silently resolve last-write-wins — is rethrown unchanged. If the gated
 * lenient retry also fails the document is genuinely malformed, so the original
 * strict error is surfaced.
 */
export function decodeToonItemContent(content: string): ToonDecodeResult {
  try {
    return { value: decodeToon(content), usedLenientFallback: false };
  } catch (strictError) {
    if (!isBracketColonMisparse(strictError)) {
      throw strictError;
    }
    try {
      return { value: decodeToon(content, { strict: false }), usedLenientFallback: true };
    } catch {
      throw strictError;
    }
  }
}
