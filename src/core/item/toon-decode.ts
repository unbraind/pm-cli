import { decode as decodeToon } from "@toon-format/toon";

export interface ToonDecodeResult {
  /** The decoded TOON document. */
  value: unknown;
  /** True when the strict decode required the scalar-bracket escape workaround. */
  usedScalarBracketEscape: boolean;
}

/**
 * Escape `[` as `\u005b` inside quoted scalar values so the upstream
 * `@toon-format/toon` strict decoder cannot mis-read them.
 *
 * The upstream bug: the strict decoder's array-header detection scans the whole
 * line for an opening bracket when the key is unquoted, so a quoted scalar value
 * that contains a bracketed token followed (anywhere later on the line) by a
 * colon, e.g. `body: "POST [redacted]: ok"` or `desc: "sntr[ysu]_ ... :"`, is
 * mis-detected as a `key`+bracket+colon array header and throws. The library's
 * own `encode()` emits exactly this otherwise-correctly-quoted form, so strict
 * decode cannot read the encoder's own output for such values.
 *
 * A line is treated as a scalar `key: value` (not an array header) only when its
 * `": "` key/value separator occurs before the first `[`; array-header lines
 * (`tags[3]:`, `comments[6]{...}:`) have the bracket first and are left
 * untouched, as are non-string (unquoted) values. Within a matched quoted value
 * every `[` becomes `\u005b`, which the decoder unescapes back to `[`, so the
 * decoded value is byte-for-byte identical. Crucially, this neutralises only the
 * bracket trigger and nothing else, so the retry stays in strict mode and every
 * other strict invariant (duplicate sibling keys, array-count mismatches, tabs
 * in indentation, ...) is still enforced.
 */
function escapeBracketsInQuotedScalars(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const separatorIndex = line.indexOf(": ");
      const bracketIndex = line.indexOf("[");
      if (separatorIndex === -1 || bracketIndex === -1 || bracketIndex < separatorIndex) {
        return line;
      }
      const key = line.slice(0, separatorIndex + 2);
      const value = line.slice(separatorIndex + 2);
      if (!value.startsWith('"')) {
        return line;
      }
      return key + value.replaceAll("[", "\\u005b");
    })
    .join("\n");
}

/**
 * Decode a TOON item document, working around the upstream bracket mis-parse
 * bug described in {@link escapeBracketsInQuotedScalars}.
 *
 * Strict decode is attempted first (the fast path for all well-formed
 * documents). Only if it fails is the scalar-bracket escape applied and strict
 * decode retried, so the workaround never relaxes strict validation; it only
 * removes the specific trigger. If the escaped content is identical to the
 * original (no quoted-scalar bracket to neutralise) the original strict error is
 * surfaced unchanged; if the retry itself fails the document has a genuine
 * problem beyond the bracket bug and that error propagates.
 */
export function decodeToonItemContent(content: string): ToonDecodeResult {
  try {
    return { value: decodeToon(content), usedScalarBracketEscape: false };
  } catch (strictError) {
    const escaped = escapeBracketsInQuotedScalars(content);
    if (escaped === content) {
      throw strictError;
    }
    return { value: decodeToon(escaped), usedScalarBracketEscape: true };
  }
}
