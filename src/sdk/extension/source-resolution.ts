/**
 * @module sdk/extension/source-resolution
 *
 * Resolves install-source identity without executing package code.
 */
import {
  findInstalledNpmPackageCandidate,
  parseExtensionInstallSource,
  type InstallSource,
} from "./install-sources.js";
import {
  resolveBundledExtensionAliasSource,
  resolveBundledPackageNpmName,
} from "./bundled-catalog.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import type { ManagedExtensionRecord } from "./managed-state.js";

/** Selected install-source identity. */
export interface ExtensionInstallSourceSelection {
  /** Selected source family. */
  kind: "builtin" | "local" | "github" | "npm";
  /** Canonical source input used for resolution. */
  input: string;
  /** Canonical package name when known. */
  package?: string;
}

/** One source candidate and the explicit command that selects it. */
export interface ExtensionInstallSourceCandidate
  extends ExtensionInstallSourceSelection {
  /** Installed candidate version when known. */
  version?: string;
  /** Installed candidate directory when relevant. */
  directory?: string;
  /** Unambiguous CLI command that selects this candidate. */
  command: string;
}

/** Machine-readable explanation of how one install target resolved. */
export interface ExtensionInstallSourceResolution {
  /** Exact target supplied by the caller. */
  requested: string;
  /** Source selected by the deterministic resolver. */
  selected: ExtensionInstallSourceSelection;
  /** Whether another locally available source could satisfy the same bare name. */
  ambiguous: boolean;
  /** Stable precedence rule used for the selection. */
  precedence: "bundled_alias_before_installed_npm";
  /** Every matching candidate and its explicit install command. */
  candidates: ExtensionInstallSourceCandidate[];
}

/** Complete result of resolving one extension install target. */
export interface ResolvedExtensionInstallSource {
  /** Normalized bundled alias, or null for non-bundled sources. */
  bundledAliasName: string | null;
  /** Bundled package name, or null when unavailable. */
  bundledPackageName: string | null;
  /** Parsed source passed to the install resolver. */
  installSource: InstallSource;
  /** Observable source-selection decision. */
  sourceResolution: ExtensionInstallSourceResolution;
}

/** Reuse recorded registry identity for a missing bare managed name, preserving explicit local and bundled precedence. */
async function resolveManagedNpmReinstall(source: InstallSource, entries: readonly ManagedExtensionRecord[]): Promise<InstallSource> {
  if (source.kind !== "local" || source.input.startsWith(".") || source.input.includes("\\") ||
    (source.input.includes("/") && !/^@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/u.test(source.input)) || await pathExists(source.absolute_path)) return source;
  const managed = entries.find((entry) => entry.source.kind === "npm" &&
    [entry.name, entry.directory, entry.source.package].includes(source.input.trim()));
  return managed?.source.package === undefined ? source : parseExtensionInstallSource(`npm:${managed.source.package}`, {});
}

/** Resolve bundled-alias provenance and competing installed npm identity. */
export async function resolveExtensionInstallSourceIdentity(
  explicitSourceInput: string,
  githubOption: string | undefined,
  ref: string | undefined,
  managedEntries: readonly ManagedExtensionRecord[] = [],
): Promise<ResolvedExtensionInstallSource> {
  const bundledAliasSource =
    typeof githubOption === "string"
      ? null
      : await resolveBundledExtensionAliasSource(explicitSourceInput);
  const bundledAliasName =
    bundledAliasSource === null
      ? null
      : explicitSourceInput.trim().toLowerCase();
  const bundledPackageName =
    bundledAliasName === null
      ? null
      : await resolveBundledPackageNpmName(bundledAliasName);
  const installSource = await resolveManagedNpmReinstall(parseExtensionInstallSource(
    bundledAliasSource ?? explicitSourceInput,
    { forceGithub: typeof githubOption === "string", ref },
  ), managedEntries);
  const installedNpmCandidate =
    bundledAliasName === null
      ? null
      : await findInstalledNpmPackageCandidate(explicitSourceInput);
  return {
    bundledAliasName,
    bundledPackageName,
    installSource,
    sourceResolution: {
      requested: explicitSourceInput,
      selected: {
        kind: bundledAliasName === null ? installSource.kind : "builtin",
        input: bundledAliasName ?? installSource.input,
        ...(bundledPackageName === null ? {} : { package: bundledPackageName }),
      },
      ambiguous: installedNpmCandidate !== null,
      precedence: "bundled_alias_before_installed_npm",
      candidates: [
        ...(bundledAliasName === null
          ? []
          : [{
              kind: "builtin" as const,
              input: bundledAliasName,
              ...(bundledPackageName === null
                ? {}
                : { package: bundledPackageName }),
              command: `pm install ${bundledAliasName}`,
            }]),
        ...(installedNpmCandidate === null
          ? []
          : [{
              kind: "npm" as const,
              input: `npm:${installedNpmCandidate.package}`,
              package: installedNpmCandidate.package,
              ...(installedNpmCandidate.version === undefined
                ? {}
                : { version: installedNpmCandidate.version }),
              directory: installedNpmCandidate.directory,
              command: `pm install npm:${installedNpmCandidate.package}`,
            }]),
      ],
    },
  };
}
