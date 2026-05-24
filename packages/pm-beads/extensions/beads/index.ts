import type { CommandDefinition, ExtensionApi, GlobalOptions } from "../../../../src/sdk/index.js";
import type { BeadsImportOptions, BeadsImportResult } from "./runtime.js";
import { loadPackageRuntimeModule } from "./runtime-loader.js";

export const manifest = {
  name: "builtin-beads-import",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema"],
};

type RuntimeModule = {
  runBeadsImport?: (options: BeadsImportOptions, global: GlobalOptions) => Promise<BeadsImportResult>;
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toBeadsImportOptions(options: Record<string, unknown>): BeadsImportOptions {
  return {
    file: asOptionalString(options.file),
    author: asOptionalString(options.author),
    message: asOptionalString(options.message),
    preserveSourceIds: asBoolean(options.preserveSourceIds),
  };
}

async function runBeadsImportFromRuntime(options: BeadsImportOptions, global: GlobalOptions): Promise<BeadsImportResult> {
  const runtime = await loadPackageRuntimeModule() as RuntimeModule;
  if (typeof runtime.runBeadsImport !== "function") {
    throw new Error("Bundled beads runtime module is missing runBeadsImport().");
  }
  return runtime.runBeadsImport(options, global);
}

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "beads import",
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
    run: async (context) => runBeadsImportFromRuntime(toBeadsImportOptions(context.options), context.global),
  } satisfies CommandDefinition);
}

export default {
  manifest,
  activate,
};
