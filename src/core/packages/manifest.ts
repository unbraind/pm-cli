/**
 * @module core/packages/manifest
 *
 * Discovers and validates pm package manifests for Manifest.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs/fs-utils.js";
import { isPathWithinDirectory } from "../fs/path-utils.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

/** Public contract for pm package resource kinds, shared by SDK and presentation-layer consumers. */
export const PM_PACKAGE_RESOURCE_KINDS = [
  "extensions",
  "docs",
  "examples",
  "assets",
  "prompts",
] as const;

/** Restricts pm package resource kind values accepted by command, SDK, and storage contracts. */
export type PmPackageResourceKind = (typeof PM_PACKAGE_RESOURCE_KINDS)[number];

/** Restricts pm package resource map values accepted by command, SDK, and storage contracts. */
export type PmPackageResourceMap = Partial<
  Record<PmPackageResourceKind, string[]>
>;

/** Documents the pm package catalog link map payload exchanged by command, SDK, and package integrations. */
export interface PmPackageCatalogLinkMap {
  /** Value that configures or reports docs for this contract. */
  docs?: string;
  /** Value that configures or reports npm for this contract. */
  npm?: string;
  /** Value that configures or reports repository for this contract. */
  repository?: string;
  /** Value that configures or reports report for this contract. */
  report?: string;
}

/** Documents the pm package catalog media map payload exchanged by command, SDK, and package integrations. */
export interface PmPackageCatalogMediaMap {
  /** Value that configures or reports image for this contract. */
  image?: string;
  /** Value that configures or reports video for this contract. */
  video?: string;
}

/** Documents the pm package catalog metadata payload exchanged by command, SDK, and package integrations. */
export interface PmPackageCatalogMetadata {
  /** Value that configures or reports display name for this contract. */
  display_name?: string;
  /** Value that configures or reports category for this contract. */
  category?: string;
  /** Value that configures or reports summary for this contract. */
  summary?: string;
  /** Value that configures or reports links for this contract. */
  links?: PmPackageCatalogLinkMap;
  /** Value that configures or reports media for this contract. */
  media?: PmPackageCatalogMediaMap;
  /** Value that configures or reports tags for this contract. */
  tags?: string[];
}

/** Documents the pm package manifest payload exchanged by command, SDK, and package integrations. */
export interface PmPackageManifest {
  /** Value that configures or reports source for this contract. */
  source: "pm" | "convention";
  /** Filesystem path used for package json resolution. */
  package_json_path?: string;
  /** Value that configures or reports package name for this contract. */
  package_name?: string;
  /** Value that configures or reports package version for this contract. */
  package_version?: string;
  /** Value that configures or reports package private for this contract. */
  package_private?: boolean;
  /** Value that configures or reports package description for this contract. */
  package_description?: string;
  /** Value that configures or reports package keywords for this contract. */
  package_keywords?: string[];
  /** Value that configures or reports package homepage for this contract. */
  package_homepage?: string;
  /** Value that configures or reports package repository url for this contract. */
  package_repository_url?: string;
  /** Value that configures or reports package bugs url for this contract. */
  package_bugs_url?: string;
  /** Value that configures or reports aliases for this contract. */
  aliases?: string[];
  /** Value that configures or reports resources for this contract. */
  resources: PmPackageResourceMap;
  /** Value that configures or reports catalog for this contract. */
  catalog?: PmPackageCatalogMetadata;
}

/** Public contract for pm package conventional resource roots, shared by SDK and presentation-layer consumers. */
export const PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS: Readonly<
  Record<PmPackageResourceKind, readonly string[]>
> = Object.freeze({
  extensions: Object.freeze([
    ".agents/pm/extensions",
    "extensions",
    ".custom/pm-extensions",
    ".custom/pm-extension",
  ]),
  docs: Object.freeze(["docs", "documentation"]),
  examples: Object.freeze(["examples", "docs/examples"]),
  assets: Object.freeze(["assets", ".agents/pm/assets"]),
  prompts: Object.freeze(["prompts", ".agents/pm/prompts"]),
});

function isKnownPackageResourceKind(
  value: string,
): value is PmPackageResourceKind {
  return (PM_PACKAGE_RESOURCE_KINDS as readonly string[]).includes(value);
}

function normalizePackageResourceEntries(
  kind: PmPackageResourceKind,
  raw: unknown,
): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new PmCliError(
        `Package manifest field pm.${kind} must contain string paths.`,
        EXIT_CODE.USAGE,
      );
    }
    normalized.push(entry.trim());
  }
  return [...new Set(normalized)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizePackageResourceMap(raw: unknown): PmPackageResourceMap {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PmCliError(
      "Package manifest field pm must be an object.",
      EXIT_CODE.USAGE,
    );
  }
  const resources: PmPackageResourceMap = {};
  const candidate = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(candidate)) {
    if (!isKnownPackageResourceKind(key)) {
      continue;
    }
    const entries = normalizePackageResourceEntries(key, value);
    if (entries.length > 0) {
      resources[key] = entries;
    }
  }
  return resources;
}

function readStringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  return values.length > 0
    ? [...new Set(values)].sort((left, right) => left.localeCompare(right))
    : undefined;
}

function readUrlLikeField(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).url;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  }
  return undefined;
}

function normalizeCatalogLinks(
  raw: unknown,
): PmPackageCatalogLinkMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const links: PmPackageCatalogLinkMap = {
    docs: readStringField(source, "docs"),
    npm: readStringField(source, "npm"),
    repository: readStringField(source, "repository"),
    report: readStringField(source, "report"),
  };
  return Object.values(links).some((value) => typeof value === "string")
    ? links
    : undefined;
}

function normalizeCatalogMedia(
  raw: unknown,
): PmPackageCatalogMediaMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const media: PmPackageCatalogMediaMap = {
    image: readStringField(source, "image"),
    video: readStringField(source, "video"),
  };
  return Object.values(media).some((value) => typeof value === "string")
    ? media
    : undefined;
}

function normalizePackageCatalogMetadata(
  raw: unknown,
): PmPackageCatalogMetadata | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const catalog: PmPackageCatalogMetadata = {
    display_name:
      readStringField(source, "display_name") ??
      readStringField(source, "displayName"),
    category: readStringField(source, "category"),
    summary: readStringField(source, "summary"),
    links: normalizeCatalogLinks(source.links),
    media: normalizeCatalogMedia(source.media),
    tags: normalizeStringArray(source.tags),
  };
  return Object.values(catalog).some((value) => value !== undefined)
    ? catalog
    : undefined;
}

/** Implements read pm package manifest for the public runtime surface of this module. */
export async function readPmPackageManifest(
  packageRoot: string,
): Promise<PmPackageManifest> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return {
      source: "convention",
      resources: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new PmCliError(
      `Failed to parse package manifest at "${packageJsonPath}": ${String(error)}`,
      EXIT_CODE.USAGE,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PmCliError(
      `Package manifest at "${packageJsonPath}" must be a JSON object.`,
      EXIT_CODE.USAGE,
    );
  }

  const packageJson = parsed as Record<string, unknown>;
  const pmManifest = packageJson.pm;
  const hasPmManifest = pmManifest !== undefined && pmManifest !== null;
  const pmManifestRecord =
    typeof pmManifest === "object" &&
    pmManifest !== null &&
    !Array.isArray(pmManifest)
      ? (pmManifest as Record<string, unknown>)
      : {};
  return {
    source: hasPmManifest ? "pm" : "convention",
    package_json_path: packageJsonPath,
    package_name:
      typeof packageJson.name === "string" ? packageJson.name : undefined,
    package_version:
      typeof packageJson.version === "string" ? packageJson.version : undefined,
    package_private: packageJson.private === true,
    package_description:
      typeof packageJson.description === "string"
        ? packageJson.description
        : undefined,
    package_keywords: normalizeStringArray(packageJson.keywords),
    package_homepage:
      typeof packageJson.homepage === "string"
        ? packageJson.homepage
        : undefined,
    package_repository_url: readUrlLikeField(packageJson.repository),
    package_bugs_url: readUrlLikeField(packageJson.bugs),
    aliases: normalizeStringArray(pmManifestRecord.aliases),
    resources: normalizePackageResourceMap(pmManifest),
    catalog: normalizePackageCatalogMetadata(pmManifestRecord.catalog),
  };
}

async function listExtensionManifestDirectories(
  parentDirectory: string,
): Promise<string[]> {
  if (!(await pathExists(parentDirectory))) {
    return [];
  }
  const entries = await fs.readdir(parentDirectory, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = path.join(parentDirectory, entry.name);
    if (await pathExists(path.join(directory, "manifest.json"))) {
      candidates.push(directory);
    }
  }
  return candidates.sort((left, right) => left.localeCompare(right));
}

/** Implements collect package extension directories for the public runtime surface of this module. */
export async function collectPackageExtensionDirectories(
  packageRoot: string,
): Promise<string[]> {
  if (await pathExists(path.join(packageRoot, "manifest.json"))) {
    return [packageRoot];
  }

  const manifest = await readPmPackageManifest(packageRoot);
  const manifestEntries = manifest.resources.extensions ?? [];
  const discovered = new Set<string>();

  for (const entry of manifestEntries) {
    if (entry.includes("*") || entry.startsWith("!")) {
      throw new PmCliError(
        `Package extension entry "${entry}" uses a glob/exclusion pattern. pm package installs currently require concrete extension paths or directories.`,
        EXIT_CODE.USAGE,
      );
    }
    const absolute = path.resolve(packageRoot, entry);
    if (!isPathWithinDirectory(packageRoot, absolute)) {
      throw new PmCliError(
        `Package extension entry "${entry}" resolves outside package root.`,
        EXIT_CODE.USAGE,
      );
    }
    if (await pathExists(path.join(absolute, "manifest.json"))) {
      discovered.add(absolute);
      continue;
    }
    for (const child of await listExtensionManifestDirectories(absolute)) {
      discovered.add(child);
    }
  }

  if (manifestEntries.length === 0) {
    for (const root of PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS.extensions) {
      for (const child of await listExtensionManifestDirectories(
        path.join(packageRoot, root),
      )) {
        discovered.add(child);
      }
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}
