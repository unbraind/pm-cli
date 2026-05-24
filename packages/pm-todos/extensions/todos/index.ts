import type { CommandDefinition, ExtensionApi, GlobalOptions } from "../../../../src/sdk/index.js";
import type { TodosExportOptions, TodosExportResult, TodosImportOptions, TodosImportResult } from "./runtime.js";
import { loadPackageRuntimeModule } from "./runtime-loader.js";

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

async function runTodosImportFromRuntime(options: TodosImportOptions, global: GlobalOptions): Promise<TodosImportResult> {
  const runtime = await loadPackageRuntimeModule() as RuntimeModule;
  if (typeof runtime.runTodosImport !== "function") {
    throw new Error("Bundled todos runtime module is missing runTodosImport().");
  }
  return runtime.runTodosImport(options, global);
}

async function runTodosExportFromRuntime(options: TodosExportOptions, global: GlobalOptions): Promise<TodosExportResult> {
  const runtime = await loadPackageRuntimeModule() as RuntimeModule;
  if (typeof runtime.runTodosExport !== "function") {
    throw new Error("Bundled todos runtime module is missing runTodosExport().");
  }
  return runtime.runTodosExport(options, global);
}

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "todos import",
    action: "todos-import",
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
    action: "todos-export",
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
