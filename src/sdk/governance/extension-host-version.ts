/**
 * @module sdk/governance/extension-host-version
 *
 * Discovers the pm-cli copy that each loaded extension resolves at runtime so
 * package-manager layout skew is visible before SDK singleton state diverges.
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { resolvePmPackageRootFromModule } from "../../core/packages/root.js";
import type { LoadedExtension } from "../../core/extensions/loader.js";

/** One distinct resolvable pm-cli installation and its extension consumers. */
export interface ExtensionHostVersionCopy {
  /** Installed pm-cli version. */
  version: string;
  /** Privacy-safe workspace-relative package manifest location. */
  path: string;
  /** Dependency layout that exposed this copy. */
  layout: "host" | "npm" | "pnpm" | "other";
  /** Loaded extensions resolving this copy. */
  consumers: string[];
}

/** Extension/host version census returned by the health SDK. */
export interface ExtensionHostVersionCensus {
  /** Version of the process-hosting pm-cli package. */
  host_version: string | null;
  /** Every distinct relevant copy resolved by the host or an extension. */
  copies: ExtensionHostVersionCopy[];
  /** Copies whose version differs from the process host. */
  mismatches: ExtensionHostVersionCopy[];
  /** Stable health warning tokens for mismatched copies. */
  warnings: string[];
}

function displayPackagePath(
  packageJsonPath: string,
  workspaceRoot: string,
): string {
  const relative = path.relative(workspaceRoot, packageJsonPath);
  if (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return relative.split(path.sep).join("/");
  }
  const externalPath = path.resolve(packageJsonPath);
  let fingerprint = 0xcbf29ce484222325n;
  for (let index = 0; index < externalPath.length; index += 1) {
    fingerprint ^= BigInt(externalPath.charCodeAt(index));
    fingerprint = BigInt.asUintN(64, fingerprint * 0x100000001b3n);
  }
  const installationId = fingerprint.toString(16).padStart(16, "0");
  return `<external>/${installationId}/${path.basename(path.dirname(packageJsonPath))}/package.json`;
}

function dependencyLayout(
  packageJsonPath: string,
): ExtensionHostVersionCopy["layout"] {
  if (packageJsonPath.includes(`${path.sep}.pnpm${path.sep}`)) return "pnpm";
  if (packageJsonPath.includes(`${path.sep}node_modules${path.sep}`)) {
    return "npm";
  }
  return "other";
}

async function readPackageVersion(
  packageJsonPath: string,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return parsed.name === "@unbrained/pm-cli" &&
      typeof parsed.version === "string" &&
      parsed.version.trim().length > 0
      ? parsed.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve symlink and platform alias segments without failing soft scans for absent hosts. */
async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/** Scan the host plus the nearest pm-cli package resolvable by every loaded extension. */
export async function scanExtensionHostVersions(
  loadedExtensions: readonly LoadedExtension[],
  workspaceRoot: string,
  hostPackageRoot = resolvePmPackageRootFromModule(import.meta.url, [
    "../../..",
  ]),
): Promise<ExtensionHostVersionCensus> {
  const canonicalWorkspaceRoot = await canonicalPath(workspaceRoot);
  const hostPackageJson = await canonicalPath(
    path.join(hostPackageRoot, "package.json"),
  );
  const hostVersion = await readPackageVersion(hostPackageJson);
  const copies = new Map<string, ExtensionHostVersionCopy>();
  if (hostVersion !== undefined) {
    copies.set(hostPackageJson, {
      version: hostVersion,
      path: displayPackagePath(hostPackageJson, canonicalWorkspaceRoot),
      layout: "host",
      consumers: ["pm-cli-host"],
    });
  }

  for (const extension of loadedExtensions) {
    try {
      const resolved = createRequire(extension.entry_path).resolve(
        "@unbrained/pm-cli/package.json",
      );
      const canonicalPackageJson = await canonicalPath(resolved);
      const version = await readPackageVersion(canonicalPackageJson);
      if (version === undefined) continue;
      const key = canonicalPackageJson;
      const existing = copies.get(key);
      if (existing) {
        if (!existing.consumers.includes(extension.name)) {
          existing.consumers.push(extension.name);
          existing.consumers.sort((left, right) => left.localeCompare(right));
        }
        continue;
      }
      copies.set(key, {
        version,
        path: displayPackagePath(canonicalPackageJson, canonicalWorkspaceRoot),
        layout: dependencyLayout(canonicalPackageJson),
        consumers: [extension.name],
      });
    } catch {
      // Extensions that do not resolve pm-cli use the host surface they were
      // handed. Load/activation diagnostics own unrelated resolution failures.
    }
  }

  const sortedCopies = [...copies.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const mismatches =
    hostVersion === undefined
      ? []
      : sortedCopies.filter((copy) => copy.version !== hostVersion);
  return {
    host_version: hostVersion ?? null,
    copies: sortedCopies,
    mismatches,
    warnings: mismatches.map(
      (copy) =>
        `extension_host_pm_cli_version_skew:${hostVersion}:${copy.version}:${copy.consumers.join("+")}`,
    ),
  };
}
