/**
 * @module core/item/toon-decode
 *
 * Defines item parsing, formatting, and lifecycle helpers for Toon Decode.
 */
import { decode as decodeToon } from "@toon-format/toon";

/** Public contract for toon scalar bracket escape upstream pr, shared by SDK and presentation-layer consumers. */
export const TOON_SCALAR_BRACKET_ESCAPE_UPSTREAM_PR =
  "https://github.com/toon-format/toon/pull/314" as const;

/** Historical tracking for the scalar-bracket decoder defect fixed upstream in TOON 2.3.1. */
export const TOON_SCALAR_BRACKET_ESCAPE_TRACKING = {
  dependency: "@toon-format/toon",
  affected_versions: "<=2.3.0",
  resolved_version: "2.3.1",
  upstream_pr: TOON_SCALAR_BRACKET_ESCAPE_UPSTREAM_PR,
  workaround_status: "removed",
} as const;

/** Documents the toon decode result payload exchanged by command, SDK, and package integrations. */
export interface ToonDecodeResult {
  /** The decoded TOON document. */
  value: unknown;
  /** Always false since TOON 2.3.1 fixed strict scalar-bracket decoding upstream. */
  usedScalarBracketEscape: boolean;
}

/**
 * Decode a TOON item document with the dependency's strict parser.
 *
 * TOON 2.3.1 resolves the quoted scalar bracket defect previously handled by a
 * local retry. Keeping one strict decode path avoids masking malformed input and
 * records `usedScalarBracketEscape: false` for result-shape compatibility.
 */
export function decodeToonItemContent(content: string): ToonDecodeResult {
  return { value: decodeToon(content), usedScalarBracketEscape: false };
}
