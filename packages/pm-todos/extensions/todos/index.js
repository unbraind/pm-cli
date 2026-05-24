import { loadPackageRuntimeModule } from "./runtime-loader.js";
export const manifest = {
    name: "builtin-todos-import-export",
    version: "0.1.0",
    entry: "./index.js",
    priority: 0,
    capabilities: ["commands", "schema"],
};
function asOptionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function toImportOptions(options) {
    return {
        folder: asOptionalString(options.folder),
        author: asOptionalString(options.author),
        message: asOptionalString(options.message),
    };
}
function toExportOptions(options) {
    return {
        folder: asOptionalString(options.folder),
    };
}
async function runTodosImportFromRuntime(options, global) {
    const runtime = await loadPackageRuntimeModule();
    if (typeof runtime.runTodosImport !== "function") {
        throw new Error("Bundled todos runtime module is missing runTodosImport().");
    }
    return runtime.runTodosImport(options, global);
}
async function runTodosExportFromRuntime(options, global) {
    const runtime = await loadPackageRuntimeModule();
    if (typeof runtime.runTodosExport !== "function") {
        throw new Error("Bundled todos runtime module is missing runTodosExport().");
    }
    return runtime.runTodosExport(options, global);
}
export function activate(api) {
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
    });
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
    });
}
export default {
    manifest,
    activate,
};
