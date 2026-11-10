/**
 * @module tests/types/settings-validation.test-d
 * Typed consumption of validated context sections (pm-gh1695).
 */
import { validateSettings } from "../../src/core/store/settings-validator.js";

/** A caller can consume either preserved section without a cast. */
export function readValidatedContextSections(raw: unknown): [boolean | undefined, boolean | undefined] | undefined {
  const result = validateSettings(raw);
  if (!result.success) return undefined;
  return [
    result.data.context?.sections?.recently_created,
    result.data.context?.sections?.unparented,
  ];
}
