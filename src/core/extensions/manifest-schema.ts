/**
 * @module core/extensions/manifest-schema
 *
 * Defines the closed extension-manifest key vocabulary and returns pure schema
 * diagnostics shared by SDK authoring checks and runtime discovery.
 */

import type { ExtensionLayer, ExtensionManifest } from "./extension-types.js";

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

/** Stable machine-readable schema finding emitted by author-time lint. */
export interface ExtensionManifestSchemaFinding {
  /** Schema condition an author must review. */
  code: "manifest_unknown_key" | "no_version_bounds_declared";
  /** JSON-style manifest location responsible for the finding. */
  path: string;
  /** Canonical key to use when the mistaken or missing field has one. */
  suggested_key?: "pm_min_version" | "pm_max_version";
  /** Actionable explanation of the ignored or missing declaration. */
  message: string;
}

/** Pure schema-lint result for one raw extension manifest. */
export interface ExtensionManifestSchemaLintResult {
  /** False when at least one author-facing schema finding is present. */
  ok: boolean;
  /** Deterministically ordered schema findings. */
  findings: ExtensionManifestSchemaFinding[];
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

/** Lint raw extension-manifest keys without loading code or evaluating versions. */
export function lintExtensionManifestSchema(
  manifest: Readonly<Record<string, unknown>>,
): ExtensionManifestSchemaLintResult {
  const inspection = inspectExtensionManifestSchema(manifest);
  const findings: ExtensionManifestSchemaFinding[] = inspection.unknownKeys.map(
    (key) => ({
      code: "manifest_unknown_key",
      path: key,
      ...(key === "compatibility"
        ? { suggested_key: "pm_min_version" as const }
        : {}),
      message:
        key === "compatibility"
          ? 'Manifest key "compatibility" is ignored; declare the canonical pm_min_version and optional pm_max_version fields instead.'
          : `Manifest key "${key}" is not part of the extension manifest contract and will be ignored.`,
    }),
  );
  if (inspection.missingVersionBounds) {
    findings.push({
      code: "no_version_bounds_declared",
      path: "$",
      suggested_key: "pm_min_version",
      message:
        "No canonical pm version bounds are declared; add pm_min_version so compatibility intent is explicit.",
    });
  }
  return { ok: findings.length === 0, findings };
}

/** Format runtime discovery warnings for unknown keys and absent canonical compatibility bounds. */
export function formatExtensionManifestSchemaWarnings(
  layer: ExtensionLayer,
  manifest: ExtensionManifest,
  rawManifest: Readonly<Record<string, unknown>>,
): string[] {
  return lintExtensionManifestSchema(rawManifest).findings.map((finding) =>
    finding.code === "manifest_unknown_key"
      ? `extension_manifest_unknown_key:${layer}:${manifest.name}:key=${finding.path}${finding.suggested_key ? `:suggested=${finding.suggested_key}` : ""}`
      : `extension_manifest_no_version_bounds:${layer}:${manifest.name}:suggested=pm_min_version`,
  );
}
