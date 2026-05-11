import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fs/fs-utils.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

export const PM_PACKAGE_RESOURCE_KINDS = [
  "extensions",
] as const;

export type PmPackageResourceKind = (typeof PM_PACKAGE_RESOURCE_KINDS)[number];

export type PmPackageResourceMap = Partial<Record<PmPackageResourceKind, string[]>>;

export interface PmPackageManifest {
  source: "pm" | "convention";
  package_json_path?: string;
  package_name?: string;
  package_version?: string;
  resources: PmPackageResourceMap;
}

export const PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS: Readonly<Record<PmPackageResourceKind, readonly string[]>> =
  Object.freeze({
    extensions: Object.freeze([
      ".agents/pm/extensions",
      "extensions",
      ".custom/pm-extensions",
      ".custom/pm-extension",
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
  return {
    source: hasPmManifest ? "pm" : "convention",
    package_json_path: packageJsonPath,
    package_name: typeof packageJson.name === "string" ? packageJson.name : undefined,
    package_version: typeof packageJson.version === "string" ? packageJson.version : undefined,
    resources: normalizePackageResourceMap(pmManifest),
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
