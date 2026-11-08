/**
 * @module sdk/read-output/positional-rows
 *
 * Declares read collections whose rows are addressed by their absolute
 * one-based position (`--edit <index>`, `--delete <index>`), so a renderer
 * delivers one row per stored entry, a malformed null entry included
 * (pm-e3hfv8). Kept free of runtime imports so the core renderer can read it
 * without loading the read-output contracts.
 */
import type { PmReadOutputSurface } from "../read-output-contracts.js";

/** Read surfaces whose listed rows are addressed by absolute position, with the row paths that carry them. */
export const PM_READ_OUTPUT_POSITIONAL_ROW_PATHS: Readonly<
  Partial<Record<PmReadOutputSurface, readonly string[]>>
> = Object.freeze({
  comments: Object.freeze(["comments"]),
  notes: Object.freeze(["notes"]),
  learnings: Object.freeze(["learnings"]),
});

/** Row paths of one read surface whose rows are addressed by absolute position; empty when it declares none. */
export function readOutputPositionalRowPaths(
  surface: PmReadOutputSurface | string | undefined,
): readonly string[] {
  if (surface === undefined || !Object.hasOwn(PM_READ_OUTPUT_POSITIONAL_ROW_PATHS, surface)) return [];
  return PM_READ_OUTPUT_POSITIONAL_ROW_PATHS[surface as PmReadOutputSurface]!;
}
