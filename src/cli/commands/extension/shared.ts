import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../../../core/fs/path-utils.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import type { ExtensionManifest } from "../../../core/extensions/loader.js";

export const DEFAULT_EXTENSION_PRIORITY = 100;

export interface ValidatedExtensionDirectory {
  directory: string;
  manifest_path: string;
  entry_path: string;
  manifest: ExtensionManifest;
}

export function normalizeStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function normalizeExtensionNameForMatch(value: string): string {
  return value.trim().toLowerCase();
}

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

  let priority = DEFAULT_EXTENSION_PRIORITY;
  if (candidate.priority !== undefined && candidate.priority !== null) {
    if (typeof candidate.priority !== "number" || !Number.isInteger(candidate.priority)) {
      return null;
    }
    priority = candidate.priority;
  }

  let capabilities: string[] = [];
  if (candidate.capabilities !== undefined && candidate.capabilities !== null) {
    if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((value) => typeof value !== "string")) {
      return null;
    }
    capabilities = normalizeStringList(candidate.capabilities.map((value) => String(value).toLowerCase()));
  }

  return {
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    entry: candidate.entry.trim(),
    priority,
    capabilities,
  };
}

export async function isCanonicalPathWithinDirectory(directory: string, targetPath: string): Promise<boolean> {
  const [resolvedDirectory, resolvedTargetPath] = await Promise.all([fs.realpath(directory), fs.realpath(targetPath)]);
  return isPathWithinDirectory(resolvedDirectory, resolvedTargetPath);
}

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
      `Failed to parse extension manifest at "${manifestPath}": ${error instanceof Error ? error.message : String(error)}`,
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
