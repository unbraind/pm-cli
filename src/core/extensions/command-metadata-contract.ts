/**
 * @module core/extensions/command-metadata-contract
 *
 * Owns the closed metadata domains shared by extension registration, runtime
 * validation, SDK contracts, and workspace projections.
 */

/** Canonical capability-family values accepted for every command surface. */
export const EXTENSION_COMMAND_CAPABILITY_FAMILIES = Object.freeze([
  "workspace",
  "intake",
  "context",
  "lifecycle",
  "evidence",
  "graph",
  "quality",
  "automation",
  "extensions",
  "internal",
] as const);

/** Capability family an extension command contributes to agent routing. */
export type ExtensionCommandCapabilityFamily =
  (typeof EXTENSION_COMMAND_CAPABILITY_FAMILIES)[number];
