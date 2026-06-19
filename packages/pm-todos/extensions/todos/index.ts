import type {
  ExtensionApi,
  GlobalOptions,
  ImportExportContext,
  ImportExportRegistrationOptions,
} from "../../../../src/sdk/index.js";
import type { TodosExportOptions, TodosExportResult, TodosImportOptions, TodosImportResult } from "./runtime.js";
import { loadPackageRuntimeModule } from "./runtime-loader.js";

export const manifest = {
  name: "builtin-todos-import-export",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "importers"],
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
  // First-party exemplar for the importers capability: registerImporter/
  // registerExporter create the `todos import` / `todos export` command paths,
  // and the options object keeps the command description + flags as discoverable
  // as the previous registerCommand registration.
  api.registerImporter(
    "todos",
    async (context: ImportExportContext) => runTodosImportFromRuntime(toImportOptions(context.options), context.global),
    {
      action: "todos-import",
      description: "Import Todo markdown files into pm items.",
      failure_hints: ["This command reads a directory, not a file. Use --folder <path> to point at the Todo markdown directory."],
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
    } satisfies ImportExportRegistrationOptions,
  );
  api.registerExporter(
    "todos",
    async (context: ImportExportContext) => runTodosExportFromRuntime(toExportOptions(context.options), context.global),
    {
      action: "todos-export",
      description: "Export pm items into Todo markdown files.",
      failure_hints: ["This command writes a directory of markdown files. Use --folder <path> to choose the destination directory."],
      flags: [
        {
          long: "--folder",
          value_name: "path",
          value_type: "string",
          description: "Destination folder for exported Todo markdown files.",
        },
      ],
    } satisfies ImportExportRegistrationOptions,
  );
}

export default {
  manifest,
  activate,
};
