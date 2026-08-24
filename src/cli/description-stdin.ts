/**
 * @module cli/description-stdin
 *
 * Resolves the shared create/update description stdin sentinel.
 */
import { createStdinTokenResolver } from "../sdk/runtime-primitives.js";

/** Replace a description stdin sentinel with the complete standard-input payload. */
export async function resolveDescriptionStdin(
  options: Record<string, unknown>,
): Promise<void> {
  if (
    typeof options.description === "string" &&
    options.description.trim() === "-"
  ) {
    options.description =
      (await createStdinTokenResolver().resolveValue(
        options.description,
        "--description",
      )) ?? "";
  }
}
