/**
 * @module tests/types/service-pass-through.test-d
 *
 * Compile-time proof that package authors can declare the host-enforced service
 * pass-through contract from both public SDK entrypoints.
 */
import type {
  ExtensionApi,
  ServiceOverrideOwnership,
} from "../../src/sdk/authoring.js";
import type { ServiceOverrideOwnership as RootOwnership } from "../../src/sdk/index.js";

const ownership = {
  passThrough: true,
} satisfies ServiceOverrideOwnership & RootOwnership;

declare const api: ExtensionApi;
api.registerService(
  "output_format",
  () => ({ handled: false }),
  ownership,
);

api.registerService("output_format", () => ({ handled: false }), {
  // @ts-expect-error passThrough is intentionally a strict boolean declaration
  passThrough: "yes",
});
