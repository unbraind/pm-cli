/**
 * @module core/extensions/command-visibility-tier
 *
 * Validates extension command visibility metadata.
 */
import type { CommandDefinition } from "./extension-types.js";
import { assertOptionalStringField } from "./registration-validation.js";
import { EXTENSION_COMMAND_CAPABILITY_FAMILIES } from "./command-metadata-contract.js";

const COMMAND_CAPABILITY_FAMILIES = new Set<string>(
  EXTENSION_COMMAND_CAPABILITY_FAMILIES,
);

function assertCommandCapabilityFamily(family: unknown): void {
  if (
    family !== undefined &&
    !COMMAND_CAPABILITY_FAMILIES.has(String(family))
  ) {
    throw new Error(
      "registerCommand definition.family must be workspace, intake, context, lifecycle, evidence, graph, quality, automation, extensions, or internal",
    );
  }
}

/** Validate optional command metadata strings and the closed visibility tier. */
export function assertCommandDefinitionMetadataStrings(
  definition: CommandDefinition,
): void {
  assertOptionalStringField(
    "registerCommand definition.action",
    definition.action,
  );
  assertOptionalStringField(
    "registerCommand definition.family",
    definition.family,
  );
  assertOptionalStringField(
    "registerCommand definition.description",
    definition.description,
  );
  assertOptionalStringField(
    "registerCommand definition.intent",
    definition.intent,
  );
  assertOptionalStringField("registerCommand definition.tier", definition.tier);
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
  assertCommandCapabilityFamily(definition.family);
}
