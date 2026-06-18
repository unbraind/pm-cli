/**
 * @module core/packages/root
 *
 * Discovers and validates pm package manifests for Root.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PM_CLI_PACKAGE_NAME = "@unbrained/pm-cli";

function packageJsonNamesPmCli(packageJsonPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return parsed.name === PM_CLI_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Implements find pm package root from path for the public runtime surface of this module.
 */
export function findPmPackageRootFromPath(startPath: string): string | undefined {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? path.resolve(startPath)
    : path.dirname(path.resolve(startPath));

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath) && packageJsonNamesPmCli(packageJsonPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Implements resolve pm package root from module for the public runtime surface of this module.
 */
export function resolvePmPackageRootFromModule(metaUrl: string, fallbackRelativeSegments: string[] = []): string {
  const modulePath = fileURLToPath(metaUrl);
  const discovered = findPmPackageRootFromPath(modulePath);
  if (discovered) {
    return discovered;
  }
  return path.resolve(path.dirname(modulePath), ...fallbackRelativeSegments);
}

/**
 * Read the pm-cli package version from the resolved package root's `package.json`.
 *
 * Centralizes the read+parse+guard logic shared by the CLI banner, the Sentry
 * release tag, the MCP `serverInfo`, and the upgrade check so they never drift.
 * Returns `undefined` when the version cannot be resolved; callers supply their
 * own fallback (the CLI/MCP use `"0.0.0"`). Resolution must never throw, so the
 * hot startup path is safe.
 */
export function resolvePmCliVersion(metaUrl: string, fallbackRelativeSegments: string[] = []): string | undefined {
  try {
    const packageJsonPath = path.join(resolvePmPackageRootFromModule(metaUrl, fallbackRelativeSegments), "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Implements resolve configured pm package root for the public runtime surface of this module.
 */
export function resolveConfiguredPmPackageRoot(
  env: NodeJS.ProcessEnv = process.env,
  envName = "PM_CLI_PACKAGE_ROOT",
  metaUrl?: string,
  fallbackRelativeSegments: string[] = [],
): string {
  const envRoot = env[envName];
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    return path.resolve(envRoot.trim());
  }
  if (metaUrl) {
    return resolvePmPackageRootFromModule(metaUrl, fallbackRelativeSegments);
  }
  return process.cwd();
}
