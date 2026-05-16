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

export function resolvePmPackageRootFromModule(metaUrl: string, fallbackRelativeSegments: string[] = []): string {
  const modulePath = fileURLToPath(metaUrl);
  const discovered = findPmPackageRootFromPath(modulePath);
  if (discovered) {
    return discovered;
  }
  return path.resolve(path.dirname(modulePath), ...fallbackRelativeSegments);
}

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
