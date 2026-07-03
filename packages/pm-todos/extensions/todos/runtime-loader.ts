import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const localRuntime = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime.ts");
export type PackageRuntimeModule = Record<string, unknown>;
const packageConfig = { extensionName: "todos", packageName: "pm-todos", diagnosticName: "todos" } as const;
const runtimeRoots = (): string[] => [...new Set([process.env[PM_PACKAGE_ROOT_ENV]?.trim(), ...(["..", "../..", "../../.."].map((parent) => process.argv[1]?.trim() ? path.resolve(path.dirname(path.resolve(process.argv[1])), parent) : ""))].filter((root): root is string => Boolean(root)).map((root) => path.resolve(root)))];
const runtimeFiles = (): string[] => [...runtimeRoots().flatMap((root) => [path.join(root, ".agents", "pm", "extensions", packageConfig.extensionName, "runtime.ts"), path.join(root, "packages", packageConfig.packageName, "extensions", packageConfig.extensionName, "runtime.ts")]), localRuntime];
const runtimeRecord = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
const isTargetMissing = (error: unknown, target: string): boolean => { const record = runtimeRecord(error); const targetUrl = pathToFileURL(target).href; const message = typeof record?.message === "string" ? record.message : ""; return record?.code === "ERR_MODULE_NOT_FOUND" && (record.url === targetUrl || (typeof record.path === "string" && path.resolve(record.path) === path.resolve(target)) || [target, target.replace(/\\/g, "/"), targetUrl].some((value) => message.startsWith(`Cannot find module '${value}'`))); };
const loadRuntimeFile = async (target: string, attempted: string[]): Promise<PackageRuntimeModule | undefined> => { attempted.push(target); if (!existsSync(target)) { return undefined; } try { return await import(pathToFileURL(target).href) as PackageRuntimeModule; } catch (error: unknown) { if (isTargetMissing(error, target)) { return undefined; } throw error; } };
export async function loadPackageRuntimeModule(): Promise<PackageRuntimeModule> {
  const attempted: string[] = [];
  for (const target of runtimeFiles()) {
    const loaded = await loadRuntimeFile(target, attempted);
    if (loaded !== undefined) {
      return loaded;
    }
  }
  throw new Error(`Unable to resolve packaged ${packageConfig.diagnosticName} extension runtime module. Tried: ${attempted.join(", ")}. Ensure the installed extension includes runtime.ts or PM_CLI_PACKAGE_ROOT points to an installed pm package root.`);
}
