import { loadPackageRuntimeModule } from "./runtime-loader.js";
export const manifest = {
    name: "builtin-beads-import",
    version: "0.1.0",
    entry: "./index.js",
    priority: 0,
    capabilities: ["commands", "schema", "importers"],
};
function asOptionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function toBeadsImportOptions(options) {
    return {
        file: asOptionalString(options.file),
        author: asOptionalString(options.author),
        message: asOptionalString(options.message),
        preserveSourceIds: asBoolean(options.preserveSourceIds),
    };
}
async function runBeadsImportFromRuntime(options, global) {
    const runtime = await loadPackageRuntimeModule();
    if (typeof runtime.runBeadsImport !== "function") {
        throw new Error("Bundled beads runtime module is missing runBeadsImport().");
    }
    return runtime.runBeadsImport(options, global);
}
export function activate(api) {
    api.registerImporter("beads", async (context) => runBeadsImportFromRuntime(toBeadsImportOptions(context.options), context.global), {
        action: "beads-import",
        description: "Import Beads JSONL records into pm items.",
        flags: [
            {
                long: "--file",
                value_name: "path",
                value_type: "string",
                description: "Path to the Beads JSONL source file.",
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
            {
                long: "--preserve-source-ids",
                value_type: "boolean",
                description: "Preserve source IDs from Beads payload records when possible.",
            },
        ],
    });
}
export default {
    manifest,
    activate,
};
