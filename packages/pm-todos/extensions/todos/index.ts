import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CommandDefinition, ExtensionApi, GlobalOptions } from "../../../../src/sdk/index.js";
import type { TodosExportOptions, TodosExportResult, TodosImportOptions, TodosImportResult } from "./runtime.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const CURRENT_EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const manifest = {
  name: "builtin-todos-import-export",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema"],
};

type RuntimeModule = {
  runTodosImport?: (options: TodosImportOptions, global: GlobalOptions) => Promise<TodosImportResult>;
  runTodosExport?: (options: TodosExportOptions, global: GlobalOptions) => Promise<TodosExportResult>;
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toImportOptions(options: Record<string, unknown>): TodosImportOptions {
  return {
    folder: asOptionalString(options.folder),
    author: asOptionalString(options.author),
    message: asOptionalString(options.message),
  };
}

function toExportOptions(options: Record<string, unknown>): TodosExportOptions {
  return {
    folder: asOptionalString(options.folder),
  };
}

function resolvePackageRootCandidates(): string[] {
  const candidates: string[] = [];
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    candidates.push(path.resolve(envRoot.trim()));
  }
  const argvEntry = typeof process.argv[1] === "string" ? process.argv[1].trim() : "";
  if (argvEntry.length > 0) {
    const resolvedEntry = path.resolve(argvEntry);
    const entryDir = path.dirname(resolvedEntry);
    candidates.push(path.resolve(entryDir, ".."));
    candidates.push(path.resolve(entryDir, "../.."));
    candidates.push(path.resolve(entryDir, "../../.."));
  }
  return [...new Set(candidates)];
}

async function loadRuntimeModule(): Promise<RuntimeModule> {
  const attempted: string[] = [];
  for (const packageRoot of resolvePackageRootCandidates()) {
    const modulePaths = [
      path.join(packageRoot, ".agents", "pm", "extensions", "todos", "runtime.js"),
      path.join(packageRoot, "packages", "pm-todos", "extensions", "todos", "runtime.js"),
    ];
    for (const modulePath of modulePaths) {
      attempted.push(modulePath);
      try {
        return await import(pathToFileURL(modulePath).href) as RuntimeModule;
      } catch {
        // Try the next package-root candidate.
      }
    }
  }

  const localRuntimePath = path.join(CURRENT_EXTENSION_ROOT, "runtime.js");
  attempted.push(localRuntimePath);
  try {
    return await import(pathToFileURL(localRuntimePath).href) as RuntimeModule;
  } catch {
    // Fall through to the diagnostic below.
  }

  throw new Error(
    "Unable to resolve packaged todos extension runtime module. " +
      `Tried: ${attempted.join(", ")}. Ensure the installed extension includes runtime.js or PM_CLI_PACKAGE_ROOT points to an installed pm package root.`,
  );
}

async function runTodosImportFromRuntime(options: TodosImportOptions, global: GlobalOptions): Promise<TodosImportResult> {
  const runtime = await loadRuntimeModule();
  if (typeof runtime.runTodosImport !== "function") {
    throw new Error("Bundled todos runtime module is missing runTodosImport().");
  }
  return runtime.runTodosImport(options, global);
}

async function runTodosExportFromRuntime(options: TodosExportOptions, global: GlobalOptions): Promise<TodosExportResult> {
  const runtime = await loadRuntimeModule();
  if (typeof runtime.runTodosExport !== "function") {
    throw new Error("Bundled todos runtime module is missing runTodosExport().");
  }
  return runtime.runTodosExport(options, global);
}

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "todos import",
    description: "Import Todo markdown files into pm items.",
    flags: [
      {
        long: "--folder",
        value_name: "path",
        value_type: "string",
        description: "Source folder containing Todo markdown files.",
      },
      {
        long: "--author",
        value_name: "author",
        value_type: "string",
        description: "Override import mutation author.",
      },
      {
        long: "--message",
        value_name: "text",
        value_type: "string",
        description: "Override import history message.",
      },
    ],
    run: async (context) => runTodosImportFromRuntime(toImportOptions(context.options), context.global),
  } satisfies CommandDefinition);
  api.registerCommand({
    name: "todos export",
    description: "Export pm items into Todo markdown files.",
    flags: [
      {
        long: "--folder",
        value_name: "path",
        value_type: "string",
        description: "Destination folder for exported Todo markdown files.",
      },
    ],
    run: async (context) => runTodosExportFromRuntime(toExportOptions(context.options), context.global),
  } satisfies CommandDefinition);
}

export default {
  manifest,
  activate,
};
