/**
 * @module core/extensions/command-visibility-tier
 *
 * Validates extension command visibility metadata.
 */
import type { CommandDefinition } from "./extension-types.js";
import { assertOptionalStringField } from "./registration-validation.js";

/** Validate optional command metadata strings and the closed visibility tier. */
export function assertCommandDefinitionMetadataStrings(
  definition: CommandDefinition,
): void {
  assertOptionalStringField(
    "registerCommand definition.action",
    definition.action,
  );
  assertOptionalStringField(
    "registerCommand definition.description",
    definition.description,
  );
  assertOptionalStringField(
    "registerCommand definition.intent",
    definition.intent,
  );
  assertOptionalStringField(
    "registerCommand definition.tier",
    definition.tier,
  );
  const tier = definition.tier;
  if (
    tier !== undefined &&
    tier !== "core" &&
    tier !== "standard" &&
    tier !== "full" &&
    tier !== "internal"
  ) {
    throw new Error(
      "registerCommand definition.tier must be core, standard, full, or internal",
    );
  }
}
