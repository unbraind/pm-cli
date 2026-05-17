import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs/fs-utils.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

export const PM_PACKAGE_RESOURCE_KINDS = [
  "extensions",
  "docs",
  "examples",
] as const;

export type PmPackageResourceKind = (typeof PM_PACKAGE_RESOURCE_KINDS)[number];

export type PmPackageResourceMap = Partial<Record<PmPackageResourceKind, string[]>>;

export interface PmPackageCatalogLinkMap {
  docs?: string;
  npm?: string;
  repository?: string;
  report?: string;
}

export interface PmPackageCatalogMediaMap {
  image?: string;
  video?: string;
}

export interface PmPackageCatalogMetadata {
  display_name?: string;
  category?: string;
  summary?: string;
  links?: PmPackageCatalogLinkMap;
  media?: PmPackageCatalogMediaMap;
  tags?: string[];
}

export interface PmPackageManifest {
  source: "pm" | "convention";
  package_json_path?: string;
  package_name?: string;
  package_version?: string;
  package_private?: boolean;
  package_description?: string;
  package_keywords?: string[];
  package_homepage?: string;
  package_repository_url?: string;
  package_bugs_url?: string;
  aliases?: string[];
  resources: PmPackageResourceMap;
  catalog?: PmPackageCatalogMetadata;
}

export const PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS: Readonly<Record<PmPackageResourceKind, readonly string[]>> =
  Object.freeze({
    extensions: Object.freeze([
      ".agents/pm/extensions",
      "extensions",
      ".custom/pm-extensions",
      ".custom/pm-extension",
    ]),
    docs: Object.freeze([
      "docs",
      "documentation",
    ]),
    examples: Object.freeze([
      "examples",
      "docs/examples",
    ]),
  });

function isKnownPackageResourceKind(value: string): value is PmPackageResourceKind {
  return (PM_PACKAGE_RESOURCE_KINDS as readonly string[]).includes(value);
}

function normalizePackageResourceEntries(kind: PmPackageResourceKind, raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new PmCliError(`Package manifest field pm.${kind} must contain string paths.`, EXIT_CODE.USAGE);
    }
    normalized.push(entry.trim());
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function normalizePackageResourceMap(raw: unknown): PmPackageResourceMap {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PmCliError("Package manifest field pm must be an object.", EXIT_CODE.USAGE);
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

function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0);
  return values.length > 0 ? [...new Set(values)].sort((left, right) => left.localeCompare(right)) : undefined;
}

function readUrlLikeField(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).url;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }
  return undefined;
}

function normalizeCatalogLinks(raw: unknown): PmPackageCatalogLinkMap | undefined {
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
  return Object.values(links).some((value) => typeof value === "string") ? links : undefined;
}

function normalizeCatalogMedia(raw: unknown): PmPackageCatalogMediaMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const media: PmPackageCatalogMediaMap = {
    image: readStringField(source, "image"),
    video: readStringField(source, "video"),
  };
  return Object.values(media).some((value) => typeof value === "string") ? media : undefined;
}

function normalizePackageCatalogMetadata(raw: unknown): PmPackageCatalogMetadata | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const catalog: PmPackageCatalogMetadata = {
    display_name: readStringField(source, "display_name") ?? readStringField(source, "displayName"),
    category: readStringField(source, "category"),
    summary: readStringField(source, "summary"),
    links: normalizeCatalogLinks(source.links),
    media: normalizeCatalogMedia(source.media),
    tags: normalizeStringArray(source.tags),
  };
  return Object.values(catalog).some((value) => value !== undefined) ? catalog : undefined;
}

export async function readPmPackageManifest(packageRoot: string): Promise<PmPackageManifest> {
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
    throw new PmCliError(`Package manifest at "${packageJsonPath}" must be a JSON object.`, EXIT_CODE.USAGE);
  }

  const packageJson = parsed as Record<string, unknown>;
  const pmManifest = packageJson.pm;
  const hasPmManifest = pmManifest !== undefined && pmManifest !== null;
  const pmManifestRecord = typeof pmManifest === "object" && pmManifest !== null && !Array.isArray(pmManifest)
    ? pmManifest as Record<string, unknown>
    : {};
  return {
    source: hasPmManifest ? "pm" : "convention",
    package_json_path: packageJsonPath,
    package_name: typeof packageJson.name === "string" ? packageJson.name : undefined,
    package_version: typeof packageJson.version === "string" ? packageJson.version : undefined,
    package_private: packageJson.private === true,
    package_description: typeof packageJson.description === "string" ? packageJson.description : undefined,
    package_keywords: normalizeStringArray(packageJson.keywords),
    package_homepage: typeof packageJson.homepage === "string" ? packageJson.homepage : undefined,
    package_repository_url: readUrlLikeField(packageJson.repository),
    package_bugs_url: readUrlLikeField(packageJson.bugs),
    aliases: normalizeStringArray(pmManifestRecord.aliases),
    resources: normalizePackageResourceMap(pmManifest),
    catalog: normalizePackageCatalogMetadata(pmManifestRecord.catalog),
  };
}

function isPathWithinDirectory(directory: string, targetPath: string): boolean {
  const relative = path.relative(directory, targetPath);
  if (relative.length === 0) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function listExtensionManifestDirectories(parentDirectory: string): Promise<string[]> {
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

export async function collectPackageExtensionDirectories(packageRoot: string): Promise<string[]> {
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
      throw new PmCliError(`Package extension entry "${entry}" resolves outside package root.`, EXIT_CODE.USAGE);
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
      for (const child of await listExtensionManifestDirectories(path.join(packageRoot, root))) {
        discovered.add(child);
      }
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}
