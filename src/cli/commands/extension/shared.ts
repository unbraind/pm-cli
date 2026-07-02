/**
 * @module cli/commands/extension/shared
 *
 * Implements extension package-management support for Shared.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../../../core/fs/path-utils.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import type { ExtensionManifest } from "../../../core/extensions/loader.js";

export const DEFAULT_EXTENSION_PRIORITY = 100;

/**
 * Documents the validated extension directory payload exchanged by command, SDK, and package integrations.
 */
export interface ValidatedExtensionDirectory {
  directory: string;
  manifest_path: string;
  entry_path: string;
  manifest: ExtensionManifest;
}

/**
 * Implements normalize string list for the public runtime surface of this module.
 */
export function normalizeStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/**
 * Implements normalize extension name for match for the public runtime surface of this module.
 */
export function normalizeExtensionNameForMatch(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Implements normalize managed directory name for the public runtime surface of this module.
 */
export function normalizeManagedDirectoryName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new PmCliError("Extension manifest name must resolve to a non-empty directory name.", EXIT_CODE.USAGE);
  }
  if (normalized === "." || normalized === "..") {
    // Manifest-controlled input must resolve to a dedicated child directory, never
    // the extensions root itself or its parent (path-traversal guard).
    throw new PmCliError("Extension manifest name must not resolve to \".\" or \"..\".", EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseOptionalManifestPriority(value: unknown): number | null {
  if (value === undefined || value === null) {
    return DEFAULT_EXTENSION_PRIORITY;
  }
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseOptionalManifestCapabilities(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }
  return normalizeStringList(value.map((entry) => String(entry).toLowerCase()));
}

/**
 * Implements parse extension manifest for the public runtime surface of this module.
 */
export function parseExtensionManifest(raw: unknown): ExtensionManifest | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    return null;
  }
  if (typeof candidate.version !== "string" || candidate.version.trim().length === 0) {
    return null;
  }
  if (typeof candidate.entry !== "string" || candidate.entry.trim().length === 0) {
    return null;
  }

  const priority = parseOptionalManifestPriority(candidate.priority);
  const capabilities = parseOptionalManifestCapabilities(candidate.capabilities);
  if (priority === null || capabilities === null) {
    return null;
  }

  return {
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    entry: candidate.entry.trim(),
    priority,
    capabilities,
  };
}

/**
 * Implements check whether canonical path within directory for the public runtime surface of this module.
 */
export async function isCanonicalPathWithinDirectory(directory: string, targetPath: string): Promise<boolean> {
  const [resolvedDirectory, resolvedTargetPath] = await Promise.all([fs.realpath(directory), fs.realpath(targetPath)]);
  return isPathWithinDirectory(resolvedDirectory, resolvedTargetPath);
}

/**
 * Implements validate extension directory for the public runtime surface of this module.
 */
export async function validateExtensionDirectory(directory: string): Promise<ValidatedExtensionDirectory> {
  const manifestPath = path.join(directory, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new PmCliError(`Extension manifest is missing at "${manifestPath}".`, EXIT_CODE.USAGE);
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new PmCliError(
      `Failed to parse extension manifest at "${manifestPath}": ${formatManifestReadError(error)}`,
      EXIT_CODE.USAGE,
    );
  }

  const manifest = parseExtensionManifest(parsedManifest);
  if (!manifest) {
    throw new PmCliError(`Extension manifest at "${manifestPath}" is invalid.`, EXIT_CODE.USAGE);
  }

  const entryPath = path.resolve(directory, manifest.entry);
  if (!isPathWithinDirectory(directory, entryPath)) {
    throw new PmCliError(
      `Extension entry "${manifest.entry}" resolves outside extension directory "${directory}".`,
      EXIT_CODE.USAGE,
    );
  }
  if (!(await pathExists(entryPath))) {
    throw new PmCliError(`Extension entry file is missing at "${entryPath}".`, EXIT_CODE.USAGE);
  }
  if (!(await isCanonicalPathWithinDirectory(directory, entryPath))) {
    throw new PmCliError(
      `Extension entry "${manifest.entry}" resolves outside extension directory after symlink resolution.`,
      EXIT_CODE.USAGE,
    );
  }

  return {
    directory,
    manifest_path: manifestPath,
    entry_path: entryPath,
    manifest,
  };
}

function formatManifestReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const _testOnlyExtensionShared = {
  formatManifestReadError,
};
