/**
 * @module cli/commands/extension/bundled-catalog
 *
 * Implements extension package-management support for Bundled Catalog.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectPackageExtensionDirectories,
  PM_PACKAGE_RESOURCE_KINDS,
  readPmPackageManifest,
} from "../../../core/packages/manifest.js";
import { resolvePmPackageRootFromModule } from "../../../core/packages/root.js";
import { pathExists } from "../../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import type { GlobalOptions } from "../../../core/shared/command-types.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { splitCommaList } from "../../../core/shared/split-comma-list.js";
import { resolveExtensionRoots } from "../../../core/extensions/loader.js";
import { resolvePmRoot } from "../../../core/store/paths.js";
import { validateExtensionDirectory } from "./shared.js";
import { readManagedExtensionState } from "./managed-state.js";
import type { ExtensionCommandOptions, ExtensionScope } from "../extension.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const LEGACY_BUNDLED_PACKAGE_ALIASES: Record<
  string,
  { package_directory: string; legacy_extension_directory: string }
> = {
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
  package_name: string | null;
}

function resolvePackageRootCandidates(): string[] {
  const candidates: string[] = [];
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  /* c8 ignore start -- env-root override branch is exercised by package-root integration tests */
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    candidates.push(path.resolve(envRoot.trim()));
  }
  /* c8 ignore stop */
  candidates.push(
    resolvePmPackageRootFromModule(import.meta.url, ["../../../.."]),
  );
  return [...new Set(candidates)];
}

/** Implements resolve bundled extension alias source for the public runtime surface of this module. */
export async function resolveBundledExtensionAliasSource(
  input: string,
): Promise<string | null> {
  const normalized = input.trim().toLowerCase();
  const packageRoot = await resolveBundledPackageRoot(normalized);
  if (packageRoot) {
    return packageRoot;
  }

  const alias = LEGACY_BUNDLED_PACKAGE_ALIASES[normalized];
  /* c8 ignore start -- known aliases resolve through package manifests in normal runtime */
  if (!alias) {
    return null;
  }
  /* c8 ignore stop */
  /* c8 ignore start -- exercised only when legacy extension paths exist without package manifests */
  for (const packageRoot of resolvePackageRootCandidates()) {
    const legacyExtensionPath = path.join(
      packageRoot,
      ".agents",
      "pm",
      "extensions",
      alias.legacy_extension_directory,
    );
    if (await pathExists(path.join(legacyExtensionPath, "manifest.json"))) {
      return legacyExtensionPath;
    }
  }
  return null;
  /* c8 ignore stop */
}

/** Implements check whether bundled package install all target for the public runtime surface of this module. */
export function isBundledPackageInstallAllTarget(input: string): boolean {
  return BUNDLED_PACKAGE_INSTALL_ALL_TARGETS.has(input.trim().toLowerCase());
}

function derivePackageAlias(packageDirectory: string): string {
  return packageDirectory.replace(/^pm-/i, "").trim().toLowerCase();
}

async function collectManifestPackageEntries(
  packagesRoot: string,
  entriesByAlias: Map<string, BundledPackageEntry>,
): Promise<void> {
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
    const aliases =
      manifest.aliases && manifest.aliases.length > 0
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
        package_name: manifest.package_name ?? null,
      });
    }
  }
}

async function collectBundledPackageEntries(): Promise<BundledPackageEntry[]> {
  const entriesByAlias = new Map<string, BundledPackageEntry>();
  for (const packageRoot of resolvePackageRootCandidates()) {
    const packagesRoot = path.join(packageRoot, "packages");
    if (!(await pathExists(packagesRoot))) {
      continue;
    }
    await collectManifestPackageEntries(packagesRoot, entriesByAlias);
  }

  for (const [alias, legacy] of Object.entries(
    LEGACY_BUNDLED_PACKAGE_ALIASES,
  )) {
    /* c8 ignore start -- canonical aliases are present in bundled package manifests */
    if (entriesByAlias.has(alias)) {
      continue;
    }
    /* c8 ignore stop */
    /* c8 ignore start -- compatibility fallback when only legacy package layout exists */
    for (const packageRoot of resolvePackageRootCandidates()) {
      const packagePath = path.join(
        packageRoot,
        "packages",
        legacy.package_directory,
      );
      if (await pathExists(path.join(packagePath, "package.json"))) {
        entriesByAlias.set(alias, {
          alias,
          package_directory: legacy.package_directory,
          package_root: packagePath,
          package_name: null,
        });
        break;
      }
    }
    /* c8 ignore stop */
  }

  return [...entriesByAlias.values()].sort((left, right) =>
    left.alias.localeCompare(right.alias),
  );
}

/** Implements list bundled package aliases for the public runtime surface of this module. */
export async function listBundledPackageAliases(): Promise<string[]> {
  return (await collectBundledPackageEntries()).map((entry) => entry.alias);
}

/**
 * Implements resolve bundled package root for the public runtime surface of this module.
 * Accepts every spelling agents naturally reach for: the catalog alias
 * ("kanban"), the package directory ("pm-kanban"), and the published npm name
 * ("@unbrained/pm-kanban").
 */
export async function resolveBundledPackageRoot(
  alias: string,
): Promise<string | null> {
  const normalized = alias.trim().toLowerCase();
  const entry = (await collectBundledPackageEntries()).find(
    (candidate) =>
      candidate.alias === normalized ||
      candidate.package_directory.toLowerCase() === normalized ||
      candidate.package_name?.toLowerCase() === normalized,
  );
  return entry?.package_root ?? null;
}

/** Resolve the published npm package name for a bundled alias so install flows can persist it as managed-source provenance (`source.package`). Returns null when the alias is unknown or the bundled package manifest lacks a name. */
export async function resolveBundledPackageNpmName(
  alias: string,
): Promise<string | null> {
  const packageRoot = await resolveBundledPackageRoot(alias);
  if (!packageRoot) {
    return null;
  }
  const manifest = await readPmPackageManifest(packageRoot);
  return manifest.package_name ?? null;
}

/** Implements resolve bundled alias manifest name for the public runtime surface of this module. */
export async function resolveBundledAliasManifestName(
  input: string,
): Promise<string | null> {
  const bundledAliasSource = await resolveBundledExtensionAliasSource(input);
  if (!bundledAliasSource) {
    return null;
  }
  try {
    const extensionDirectories =
      await collectPackageExtensionDirectories(bundledAliasSource);
    if (extensionDirectories.length !== 1) {
      return null;
    }
    const validated = await validateExtensionDirectory(extensionDirectories[0]);
    return validated.manifest.name;
  } catch {
    return null;
  }
}

/** Resolve the catalog link block for a bundled package, preferring the explicit `catalog.links.*` manifest fields and falling back to the package's repository/bugs/homepage/npm metadata. The npm link is synthesized from the package name unless the package is private or unnamed. */
function buildBundledCatalogLinks(
  manifest: Awaited<ReturnType<typeof readPmPackageManifest>>,
): {
  docs: string | undefined;
  npm: string | undefined;
  repository: string | undefined;
  report: string | undefined;
} {
  return {
    docs: manifest.catalog?.links?.docs ?? manifest.package_homepage,
    npm:
      manifest.catalog?.links?.npm ??
      (manifest.package_name && manifest.package_private !== true
        ? `https://www.npmjs.com/package/${encodeURIComponent(manifest.package_name)}`
        : undefined),
    repository:
      manifest.catalog?.links?.repository ?? manifest.package_repository_url,
    report: manifest.catalog?.links?.report ?? manifest.package_bugs_url,
  };
}

/** Build one bundled-package catalog entry from its manifest, marking it `installed` when the managed state for `scope` already records the package by built-in alias or resolved location, and projecting the metadata-only resource kinds (everything except installable `extensions`) that the package ships. */
function buildBundledCatalogPackageEntry(
  manifest: Awaited<ReturnType<typeof readPmPackageManifest>>,
  bundledEntry: BundledPackageEntry,
  scope: ExtensionScope,
  installedBuiltinAliases: Set<string>,
  installedLocations: Set<string>,
): Record<string, unknown> {
  const installScopeFlag = scope === "global" ? "--global" : "--project";
  const metadataOnlyResources = Object.fromEntries(
    PM_PACKAGE_RESOURCE_KINDS.filter(
      (resourceKind) => resourceKind !== "extensions",
    )
      .map((resourceKind) => [
        resourceKind,
        manifest.resources[resourceKind] ?? [],
      ])
      .filter(([, entries]) => Array.isArray(entries) && entries.length > 0),
  );
  return {
    alias: bundledEntry.alias,
    bundled: true,
    available: true,
    installed:
      installedBuiltinAliases.has(bundledEntry.alias) ||
      installedLocations.has(path.resolve(bundledEntry.package_root)),
    install_target: bundledEntry.alias,
    install_command: `pm install ${bundledEntry.alias} ${installScopeFlag}`,
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
      links: buildBundledCatalogLinks(manifest),
      media: manifest.catalog?.media,
    },
  };
}

/** Implements build bundled package catalog for the public runtime surface of this module. */
export async function buildBundledPackageCatalog(
  scope: ExtensionScope,
  global: GlobalOptions,
  options: ExtensionCommandOptions = {},
): Promise<{
  total: number;
  scope: ExtensionScope;
  installable_resource_kinds: string[];
  metadata_only_resource_kinds: string[];
  packages: Array<Record<string, unknown>>;
}> {
  const roots = resolveExtensionRoots(
    resolvePmRoot(process.cwd(), global.path),
    process.cwd(),
  );
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
      .filter(
        (entry) => entry.scope === scope && entry.source.kind === "builtin",
      )
      .flatMap((entry) => [
        entry.source.name,
        entry.source.input,
        entry.source.location,
      ])
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .map((value) => value.trim().toLowerCase()),
  );
  const packages: Array<Record<string, unknown>> = [];

  for (const bundledEntry of await collectBundledPackageEntries()) {
    const manifest = await readPmPackageManifest(bundledEntry.package_root);
    packages.push(
      buildBundledCatalogPackageEntry(
        manifest,
        bundledEntry,
        scope,
        installedBuiltinAliases,
        installedLocations,
      ),
    );
  }

  const fields = parsePackageCatalogFields(options.fields);
  const outputPackages = fields
    ? packages.map((entry) => projectPackageCatalogEntry(entry, fields))
    : packages;
  return {
    total: outputPackages.length,
    scope,
    installable_resource_kinds: ["extensions"],
    metadata_only_resource_kinds: PM_PACKAGE_RESOURCE_KINDS.filter(
      (resourceKind) => resourceKind !== "extensions",
    ),
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

function parsePackageCatalogFields(
  raw: string | undefined,
): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const fields = splitCommaList(raw);
  if (fields.length === 0) {
    throw new PmCliError(
      "Package catalog --fields requires a comma-separated list of field names",
      EXIT_CODE.USAGE,
    );
  }
  const unknown = fields.filter(
    (field) => !PACKAGE_CATALOG_FIELD_KEYS.has(field),
  );
  if (unknown.length > 0) {
    throw new PmCliError(
      `Unknown package catalog --fields value(s): ${unknown.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        examples: [
          "pm package list --project --fields alias,installed,install_command",
          "pm package catalog --project --fields alias,package_name,category",
        ],
      },
    );
  }
  return fields;
}

function projectPackageCatalogEntry(
  entry: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === "category") {
      projected[field] =
        (entry.catalog as { category?: unknown } | undefined)?.category ?? null;
    } else if (field === "display_name") {
      projected[field] =
        (entry.catalog as { display_name?: unknown } | undefined)
          ?.display_name ?? null;
    } else {
      projected[field] = entry[field] ?? null;
    }
  }
  return projected;
}

/** Public contract for test only bundled catalog, shared by SDK and presentation-layer consumers. */
export const _testOnlyBundledCatalog = {
  parsePackageCatalogFields,
  projectPackageCatalogEntry,
};
