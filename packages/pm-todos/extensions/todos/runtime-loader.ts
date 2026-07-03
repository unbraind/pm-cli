import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const localRuntime = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime.ts");
const extensionName = "todos";
const packageName = "pm-todos";
const diagnosticName = "todos";
export type PackageRuntimeModule = Record<string, unknown>;

function asRuntimeError(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function reportsMissingTarget(error: unknown, target: string): boolean {
  const record = asRuntimeError(error);
  if (!record || record.code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  const targetUrl = pathToFileURL(target).href;
  const message = typeof record.message === "string" ? record.message : "";
  return record.url === targetUrl ||
    (typeof record.path === "string" && path.resolve(record.path) === path.resolve(target)) ||
    message.startsWith(`Cannot find module '${target}'`) ||
    message.startsWith(`Cannot find module '${target.replace(/\\/g, "/")}'`) ||
    message.startsWith(`Cannot find module '${targetUrl}'`);
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  const configuredRoot = process.env[PM_PACKAGE_ROOT_ENV]?.trim();
  if (configuredRoot) {
    roots.add(path.resolve(configuredRoot));
  }
  const argvPath = process.argv[1]?.trim();
  if (argvPath) {
    const entryDir = path.dirname(path.resolve(argvPath));
    for (const parent of ["..", "../..", "../../.."]) {
      roots.add(path.resolve(entryDir, parent));
    }
  }
  return [...roots];
}

function candidateRuntimeFiles(): string[] {
  return [
    ...candidateRoots().flatMap((root) => [
      path.join(root, ".agents", "pm", "extensions", extensionName, "runtime.ts"),
      path.join(root, "packages", packageName, "extensions", extensionName, "runtime.ts"),
    ]),
    localRuntime,
  ];
}

async function loadCandidate(target: string, attempted: string[]): Promise<PackageRuntimeModule | undefined> {
  attempted.push(target);
  if (!existsSync(target)) {
    return undefined;
  }
  try {
    return await import(pathToFileURL(target).href) as PackageRuntimeModule;
  } catch (error: unknown) {
    if (reportsMissingTarget(error, target)) {
      return undefined;
    }
    throw error;
  }
}

export async function loadPackageRuntimeModule(): Promise<PackageRuntimeModule> {
  const attempted: string[] = [];
  for (const target of candidateRuntimeFiles()) {
    const loaded = await loadCandidate(target, attempted);
    if (loaded !== undefined) {
      return loaded;
    }
  }
  throw new Error(`Unable to resolve packaged ${diagnosticName} extension runtime module. Tried: ${attempted.join(", ")}. Ensure the installed extension includes runtime.ts or PM_CLI_PACKAGE_ROOT points to an installed pm package root.`);
}
