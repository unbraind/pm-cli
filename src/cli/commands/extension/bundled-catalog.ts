import fs from "node:fs/promises";
import path from "node:path";
import { collectPackageExtensionDirectories, PM_PACKAGE_RESOURCE_KINDS, readPmPackageManifest } from "../../../core/packages/manifest.js";
import { resolvePmPackageRootFromModule } from "../../../core/packages/root.js";
import { pathExists } from "../../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import type { GlobalOptions } from "../../../core/shared/command-types.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { resolveExtensionRoots } from "../../../core/extensions/loader.js";
import { resolvePmRoot } from "../../../core/store/paths.js";
import { validateExtensionDirectory } from "./shared.js";
import { readManagedExtensionState } from "./managed-state.js";
import type { ExtensionCommandOptions, ExtensionScope } from "../extension.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const LEGACY_BUNDLED_PACKAGE_ALIASES: Record<string, { package_directory: string; legacy_extension_directory: string }> = {
  beads: {
    package_directory: "pm-beads",
    legacy_extension_directory: "beads",
  },
  todos: {
    package_directory: "pm-todos",
    legacy_extension_directory: "todos",
  },
};
const BUNDLED_PACKAGE_INSTALL_ALL_TARGETS = new Set(["*", "all"]);

interface BundledPackageEntry {
  alias: string;
  package_directory: string;
  package_root: string;
}

function resolvePackageRootCandidates(): string[] {
  const candidates: string[] = [];
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    candidates.push(path.resolve(envRoot.trim()));
  }
  candidates.push(resolvePmPackageRootFromModule(import.meta.url, ["../../../.."]));
  return [...new Set(candidates)];
}

export async function resolveBundledExtensionAliasSource(input: string): Promise<string | null> {
  const normalized = input.trim().toLowerCase();
  const packageRoot = await resolveBundledPackageRoot(normalized);
  if (packageRoot) {
    return packageRoot;
  }

  const alias = LEGACY_BUNDLED_PACKAGE_ALIASES[normalized];
  if (!alias) {
    return null;
  }
  for (const packageRoot of resolvePackageRootCandidates()) {
    const legacyExtensionPath = path.join(packageRoot, ".agents", "pm", "extensions", alias.legacy_extension_directory);
    if (await pathExists(path.join(legacyExtensionPath, "manifest.json"))) {
      return legacyExtensionPath;
    }
  }
  return null;
}

export function isBundledPackageInstallAllTarget(input: string): boolean {
  return BUNDLED_PACKAGE_INSTALL_ALL_TARGETS.has(input.trim().toLowerCase());
}

function derivePackageAlias(packageDirectory: string): string {
  return packageDirectory.replace(/^pm-/i, "").trim().toLowerCase();
}

async function collectBundledPackageEntries(): Promise<BundledPackageEntry[]> {
  const entriesByAlias = new Map<string, BundledPackageEntry>();
  for (const packageRoot of resolvePackageRootCandidates()) {
    const packagesRoot = path.join(packageRoot, "packages");
    if (!(await pathExists(packagesRoot))) {
      continue;
    }
    const entries = await fs.readdir(packagesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("pm-")) {
        continue;
      }
      const candidateRoot = path.join(packagesRoot, entry.name);
      if (!(await pathExists(path.join(candidateRoot, "package.json")))) {
        continue;
      }
      const manifest = await readPmPackageManifest(candidateRoot);
      const aliases = manifest.aliases && manifest.aliases.length > 0
        ? manifest.aliases
        : [derivePackageAlias(entry.name)];
      for (const alias of aliases) {
        const normalizedAlias = alias.trim().toLowerCase();
        if (normalizedAlias.length === 0 || entriesByAlias.has(normalizedAlias)) {
          continue;
        }
        entriesByAlias.set(normalizedAlias, {
          alias: normalizedAlias,
          package_directory: entry.name,
          package_root: candidateRoot,
        });
      }
    }
  }

  for (const [alias, legacy] of Object.entries(LEGACY_BUNDLED_PACKAGE_ALIASES)) {
    if (entriesByAlias.has(alias)) {
      continue;
    }
    for (const packageRoot of resolvePackageRootCandidates()) {
      const packagePath = path.join(packageRoot, "packages", legacy.package_directory);
      if (await pathExists(path.join(packagePath, "package.json"))) {
        entriesByAlias.set(alias, {
          alias,
          package_directory: legacy.package_directory,
          package_root: packagePath,
        });
        break;
      }
    }
  }

  return [...entriesByAlias.values()].sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function listBundledPackageAliases(): Promise<string[]> {
  return (await collectBundledPackageEntries()).map((entry) => entry.alias);
}

export async function resolveBundledPackageRoot(alias: string): Promise<string | null> {
  const normalized = alias.trim().toLowerCase();
  const entry = (await collectBundledPackageEntries()).find((candidate) => candidate.alias === normalized);
  return entry?.package_root ?? null;
}

export async function resolveBundledAliasManifestName(input: string): Promise<string | null> {
  const bundledAliasSource = await resolveBundledExtensionAliasSource(input);
  if (!bundledAliasSource) {
    return null;
  }
  try {
    const extensionDirectories = await collectPackageExtensionDirectories(bundledAliasSource);
    if (extensionDirectories.length !== 1) {
      return null;
    }
    const validated = await validateExtensionDirectory(extensionDirectories[0]);
    return validated.manifest.name;
  } catch {
    return null;
  }
}

export async function buildBundledPackageCatalog(scope: ExtensionScope, global: GlobalOptions, options: ExtensionCommandOptions = {}): Promise<{
  total: number;
  scope: ExtensionScope;
  installable_resource_kinds: string[];
  metadata_only_resource_kinds: string[];
  packages: Array<Record<string, unknown>>;
}> {
  const roots = resolveExtensionRoots(resolvePmRoot(process.cwd(), global.path), process.cwd());
  const selectedRoot = scope === "global" ? roots.global : roots.project;
  const managedStateRead = await readManagedExtensionState(selectedRoot);
  const installedLocations = new Set(
    managedStateRead.state.entries
      .filter((entry) => entry.scope === scope)
      .filter((entry) => entry.source.kind !== "builtin")
      .map((entry) => path.resolve(entry.source.location)),
  );
  const installedBuiltinAliases = new Set(
    managedStateRead.state.entries
      .filter((entry) => entry.scope === scope && entry.source.kind === "builtin")
      .flatMap((entry) => [entry.source.name, entry.source.input, entry.source.location])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase()),
  );
  const packages: Array<Record<string, unknown>> = [];

  for (const alias of await listBundledPackageAliases()) {
    const packageRoot = await resolveBundledPackageRoot(alias);
    const installScopeFlag = scope === "global" ? "--global" : "--project";
    if (!packageRoot) {
      packages.push({
        alias,
        bundled: true,
        available: false,
        installed: false,
        install_target: alias,
        install_command: `pm install ${alias} ${installScopeFlag}`,
      });
      continue;
    }

    const manifest = await readPmPackageManifest(packageRoot);
    const repository = manifest.catalog?.links?.repository ?? manifest.package_repository_url;
    const report = manifest.catalog?.links?.report ?? manifest.package_bugs_url;
    const docs = manifest.catalog?.links?.docs ?? manifest.package_homepage;
    const npm = manifest.catalog?.links?.npm ??
      (manifest.package_name && manifest.package_private !== true
        ? `https://www.npmjs.com/package/${encodeURIComponent(manifest.package_name)}`
        : undefined);
    const metadataOnlyResources = Object.fromEntries(
      PM_PACKAGE_RESOURCE_KINDS
        .filter((resourceKind) => resourceKind !== "extensions")
        .map((resourceKind) => [resourceKind, manifest.resources[resourceKind] ?? []])
        .filter(([, entries]) => Array.isArray(entries) && entries.length > 0),
    );
    packages.push({
      alias,
      bundled: true,
      available: true,
      installed: installedBuiltinAliases.has(alias) || installedLocations.has(path.resolve(packageRoot)),
      install_target: alias,
      install_command: `pm install ${alias} ${installScopeFlag}`,
      package_name: manifest.package_name,
      package_version: manifest.package_version,
      description: manifest.catalog?.summary ?? manifest.package_description,
      keywords: manifest.package_keywords ?? [],
      resources: manifest.resources,
      installable_resources: {
        extensions: manifest.resources.extensions ?? [],
      },
      metadata_only_resources: metadataOnlyResources,
      catalog: {
        display_name: manifest.catalog?.display_name,
        category: manifest.catalog?.category,
        tags: manifest.catalog?.tags ?? manifest.package_keywords ?? [],
        links: {
          docs,
          npm,
          repository,
          report,
        },
        media: manifest.catalog?.media,
      },
    });
  }

  const fields = parsePackageCatalogFields(options.fields);
  const outputPackages = fields ? packages.map((entry) => projectPackageCatalogEntry(entry, fields)) : packages;
  return {
    total: outputPackages.length,
    scope,
    installable_resource_kinds: ["extensions"],
    metadata_only_resource_kinds: PM_PACKAGE_RESOURCE_KINDS.filter((resourceKind) => resourceKind !== "extensions"),
    packages: outputPackages,
  };
}

const PACKAGE_CATALOG_FIELD_KEYS = new Set([
  "alias",
  "bundled",
  "available",
  "installed",
  "install_target",
  "install_command",
  "package_name",
  "package_version",
  "description",
  "keywords",
  "resources",
  "installable_resources",
  "metadata_only_resources",
  "catalog",
  "category",
  "display_name",
]);

function parsePackageCatalogFields(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const fields = [...new Set(raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  if (fields.length === 0) {
    throw new PmCliError("Package catalog --fields requires a comma-separated list of field names", EXIT_CODE.USAGE);
  }
  const unknown = fields.filter((field) => !PACKAGE_CATALOG_FIELD_KEYS.has(field));
  if (unknown.length > 0) {
    throw new PmCliError(`Unknown package catalog --fields value(s): ${unknown.join(", ")}`, EXIT_CODE.USAGE, {
      examples: [
        "pm package list --project --fields alias,installed,install_command",
        "pm package catalog --project --fields alias,package_name,category",
      ],
    });
  }
  return fields;
}

function projectPackageCatalogEntry(entry: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === "category") {
      projected[field] = (entry.catalog as { category?: unknown } | undefined)?.category ?? null;
    } else if (field === "display_name") {
      projected[field] = (entry.catalog as { display_name?: unknown } | undefined)?.display_name ?? null;
    } else {
      projected[field] = entry[field] ?? null;
    }
  }
  return projected;
}
