/**
 * @module core/extensions/service-ownership
 *
 * Validates host-enforced ownership metadata for extension service overrides.
 */
import type { ServiceOverrideOwnership } from "./extension-types.js";

/** Validate one service ownership declaration and return its normalized pass-through flag. */
export function normalizeServiceOverrideOwnership(
  ownership: ServiceOverrideOwnership,
): boolean {
  if (
    ownership === null ||
    typeof ownership !== "object" ||
    Array.isArray(ownership)
  ) {
    throw new TypeError("registerService ownership must be an object");
  }
  if (Reflect.ownKeys(ownership).some((key) => key !== "passThrough")) {
    throw new TypeError("registerService ownership supports only passThrough");
  }
  if (
    ownership.passThrough !== undefined &&
    typeof ownership.passThrough !== "boolean"
  ) {
    throw new TypeError(
      "registerService ownership.passThrough must be a boolean when provided",
    );
  }
  return ownership.passThrough === true;
}
