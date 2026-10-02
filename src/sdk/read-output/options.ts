/**
 * @module sdk/read-output/options
 *
 * Shares universal presentation controls without loading read execution code.
 */

/** Canonical field, amount, cost and encoding controls for every read surface. */
export const READ_OUTPUT_DIMENSION_FLAGS = {
  include: "--output-include",
  amount: "--output-limit",
  cost: "--output-budget",
  encoding: "--output-format",
} as const;

/** Presentation-only controls composing universal output shaping across calls. */
export const READ_OUTPUT_COMPOSITION_FLAGS = Object.freeze([
  "--output-session",
  "--output-cursor",
  "--output-row-contract",
] as const);
