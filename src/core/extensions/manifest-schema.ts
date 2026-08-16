/**
 * @module core/extensions/manifest-schema
 *
 * Defines the closed extension-manifest key vocabulary and returns pure schema
 * diagnostics shared by SDK authoring checks and runtime discovery.
 */

import type {
  ExtensionLayer,
  ExtensionManifest,
} from "./extension-types.js";

/** Canonical top-level keys accepted by an extension `manifest.json`. */
export const KNOWN_EXTENSION_MANIFEST_KEYS = new Set([
  "name",
  "version",
  "entry",
  "priority",
  "description",
  "author",
  "capabilities",
  "manifest_version",
  "pm_min_version",
  "pm_max_version",
  "engines",
  "trusted",
  "provenance",
  "sandbox_profile",
  "permissions",
  "activation",
  "contributions",
  "legacy_capability_aliases",
]);

/** Pure closed-schema inspection result for one raw extension manifest. */
export interface ExtensionManifestSchemaInspection {
  /** Unknown top-level keys in deterministic lexical order. */
  unknownKeys: string[];
  /** Whether neither canonical pm compatibility bound is present. */
  missingVersionBounds: boolean;
}

/** Inspect raw manifest keys without parsing, loading, or mutating an extension. */
export function inspectExtensionManifestSchema(
  manifest: Readonly<Record<string, unknown>>,
): ExtensionManifestSchemaInspection {
  return {
    unknownKeys: Object.keys(manifest)
      .filter((key) => !KNOWN_EXTENSION_MANIFEST_KEYS.has(key))
      .sort((left, right) => (left > right ? 1 : -1)),
    missingVersionBounds:
      manifest.pm_min_version === undefined &&
      manifest.pm_max_version === undefined,
  };
}

/** Format runtime discovery warnings for unknown keys and absent canonical compatibility bounds. */
export function formatExtensionManifestSchemaWarnings(
  layer: ExtensionLayer,
  manifest: ExtensionManifest,
  rawManifest: Readonly<Record<string, unknown>>,
): string[] {
  const inspection = inspectExtensionManifestSchema(rawManifest);
  const warnings = inspection.unknownKeys.map((key) =>
    key === "compatibility"
      ? `extension_manifest_unknown_key:${layer}:${manifest.name}:key=compatibility:suggested=pm_min_version`
      : `extension_manifest_unknown_key:${layer}:${manifest.name}:key=${key}`,
  );
  if (inspection.missingVersionBounds) {
    warnings.push(
      `extension_manifest_no_version_bounds:${layer}:${manifest.name}:suggested=pm_min_version`,
    );
  }
  return warnings;
}
