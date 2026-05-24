import { decode as decodeToon } from "@toon-format/toon";

export interface ToonDecodeResult {
  /** The decoded TOON document. */
  value: unknown;
  /** True when strict decode failed and the lenient retry was used. */
  usedLenientFallback: boolean;
}

/**
 * Decode a TOON item document, working around an upstream `@toon-format/toon`
 * round-trip bug.
 *
 * The strict decoder's array-header detection scans the whole line for an
 * opening bracket when the key is unquoted, so a quoted scalar VALUE that
 * contains a bracketed token immediately followed by a colon (for example a
 * redacted endpoint marker, an "Unreleased" changelog marker, or a "med"
 * severity tag) is mis-detected as a `key`+bracket+colon array header and
 * throws "Invalid array length". The library's own `encode()` emits exactly
 * this otherwise-correctly-quoted form, so strict decode cannot read the
 * encoder's own output for such values.
 *
 * In lenient mode the same mis-detection does not throw — the line falls back
 * to a scalar key/value, which round-trips the original string correctly. We
 * therefore try strict first (retaining duplicate-key protection for normal
 * documents) and fall back to lenient decode only when strict throws. If the
 * lenient retry also fails the document is genuinely malformed, so the
 * original strict error is surfaced.
 */
export function decodeToonItemContent(content: string): ToonDecodeResult {
  try {
    return { value: decodeToon(content), usedLenientFallback: false };
  } catch (strictError) {
    try {
      return { value: decodeToon(content, { strict: false }), usedLenientFallback: true };
    } catch {
      throw strictError;
    }
  }
}
