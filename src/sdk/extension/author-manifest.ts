/**
 * @module sdk/extension/author-manifest
 *
 * Reads the optional extension manifest at a package-author workspace root and
 * projects the public schema lint into health/doctor diagnostics.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isFileAbsentError } from "../../core/fs/fs-utils.js";
import {
  lintExtensionManifestSchema,
  type ExtensionManifestSchemaFinding,
} from "../../core/extensions/manifest-schema.js";
import { resolveWorkspaceRoot } from "../../core/store/paths.js";

/** Read-only author-workspace manifest diagnostic shared by health and doctor. */
export interface ExtensionAuthorManifestDiagnostic {
  /** Absolute path inspected for the extension runtime manifest. */
  path: string;
  /** Whether the workspace declares a root extension manifest. */
  present: boolean;
  /** Parse state for absent, valid, or malformed manifest content. */
  parse_status: "absent" | "valid" | "invalid_json" | "invalid_shape";
  /** Canonical package catalog metadata location, distinct from manifest.json. */
  package_metadata_location: "package.json#pm";
  /** Public schema findings when the file is a JSON object. */
  schema_findings: ExtensionManifestSchemaFinding[];
  /** Runtime warning tokens incorporated into health/doctor status. */
  warnings: string[];
  /** Direct author correction for every reported state. */
  remediation: string[];
}

function manifestName(raw: Readonly<Record<string, unknown>>): string {
  return typeof raw.name === "string" && raw.name.trim().length > 0
    ? raw.name.trim()
    : "workspace-manifest";
}

function authorManifestWarning(
  name: string,
  finding: ExtensionManifestSchemaFinding,
): string {
  return finding.code === "manifest_unknown_key"
    ? `extension_manifest_unknown_key:author:${name}:key=${finding.path}${finding.suggested_key ? `:suggested=${finding.suggested_key}` : ""}`
    : `extension_manifest_no_version_bounds:author:${name}:suggested=pm_min_version`;
}

/** Inspect `<workspace>/manifest.json` without loading extension code. */
export async function inspectExtensionAuthorManifest(
  workspaceRoot: string,
): Promise<ExtensionAuthorManifestDiagnostic> {
  const manifestPath = path.join(workspaceRoot, "manifest.json");
  let content: string;
  try {
    content = await fs.readFile(manifestPath, "utf8");
  } catch (error: unknown) {
    if (isFileAbsentError(error)) {
      return {
        path: manifestPath,
        present: false,
        parse_status: "absent",
        package_metadata_location: "package.json#pm",
        schema_findings: [],
        warnings: [],
        remediation: [],
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      path: manifestPath,
      present: true,
      parse_status: "invalid_json",
      package_metadata_location: "package.json#pm",
      schema_findings: [],
      warnings: ["extension_author_manifest_invalid_json:manifest.json"],
      remediation: [
        "Repair manifest.json so it contains one valid JSON object, then rerun pm package doctor --project.",
      ],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      path: manifestPath,
      present: true,
      parse_status: "invalid_shape",
      package_metadata_location: "package.json#pm",
      schema_findings: [],
      warnings: ["extension_author_manifest_invalid_shape:manifest.json"],
      remediation: [
        "Replace manifest.json with one JSON object, then rerun pm package doctor --project.",
      ],
    };
  }

  const raw = parsed as Readonly<Record<string, unknown>>;
  const lint = lintExtensionManifestSchema(raw);
  const name = manifestName(raw);
  return {
    path: manifestPath,
    present: true,
    parse_status: "valid",
    package_metadata_location: "package.json#pm",
    schema_findings: lint.findings,
    warnings: lint.findings.map((finding) =>
      authorManifestWarning(name, finding),
    ),
    remediation: lint.findings.map((finding) => finding.message),
  };
}

/** Inspect the author manifest for a resolved project tracker root. */
export function inspectExtensionAuthorManifestAtPmRoot(
  pmRoot: string,
): Promise<ExtensionAuthorManifestDiagnostic> {
  return inspectExtensionAuthorManifest(resolveWorkspaceRoot(pmRoot));
}
