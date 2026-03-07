import { runTodosExport, runTodosImport } from "./import-export.js";
import type { TodosExportOptions, TodosImportOptions } from "./import-export.js";
import type { ExtensionApi, ExtensionManifest } from "../../../core/extensions/loader.js";

export const manifest: ExtensionManifest = {
  name: "builtin-todos-import-export",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands"],
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

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "todos import",
    run: async (context) => runTodosImport(toImportOptions(context.options), context.global),
  });
  api.registerCommand({
    name: "todos export",
    run: async (context) => runTodosExport(toExportOptions(context.options), context.global),
  });
}

export default {
  manifest,
  activate,
};
