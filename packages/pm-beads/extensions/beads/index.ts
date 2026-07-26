/**
 * Runtime contracts and behavior for packages/pm beads/extensions/beads/index.
 *
 * @module packages/pm-beads/extensions/beads/index
 */
import type {
  ExtensionApi,
  GlobalOptions,
  ImportExportContext,
  ImportExportRegistrationOptions,
} from "@unbrained/pm-cli/sdk";
import type { BeadsImportOptions, BeadsImportResult } from "./runtime.ts";
import { loadPackageRuntimeModule } from "./runtime-loader.ts";

/** Declarative package manifest consumed by the extension loader. */
export const manifest = {
  name: "builtin-beads-import",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "importers"],
};

type RuntimeModule = {
  runBeadsImport?: (
    options: BeadsImportOptions,
    global: GlobalOptions,
  ) => Promise<BeadsImportResult>;
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toBeadsImportOptions(
  options: Record<string, unknown>,
  global: GlobalOptions,
): BeadsImportOptions {
  return {
    file: asOptionalString(options.file),
    author: global.author,
    message: asOptionalString(options.message),
    preserveSourceIds: asBoolean(options.preserveSourceIds),
  };
}

async function runBeadsImportFromRuntime(
  options: BeadsImportOptions,
  global: GlobalOptions,
): Promise<BeadsImportResult> {
  const runtime = (await loadPackageRuntimeModule()) as RuntimeModule;
  if (typeof runtime.runBeadsImport !== "function") {
    throw new Error(
      "Bundled beads runtime module is missing runBeadsImport().",
    );
  }
  return runtime.runBeadsImport(options, global);
}

/** Registers this package's commands, actions, and runtime hooks with the host. */
export function activate(api: ExtensionApi): void {
  // First-party exemplar for the importers capability: registerImporter creates
  // the `beads import` command path, and the options object keeps the command
  // description + flags discoverable in help and runtime contracts.
  api.registerImporter(
    "beads",
    async (context: ImportExportContext) =>
      runBeadsImportFromRuntime(
        toBeadsImportOptions(context.options, context.global),
        context.global,
      ),
    {
      action: "beads-import",
      description: "Import Beads JSONL records into pm items.",
      failure_hints: [
        "Use the host-global --author <id> flag when an explicit mutation identity override is required.",
      ],
      flags: [
        {
          long: "--file",
          value_name: "path",
          value_type: "string",
          description: "Path to the Beads JSONL source file.",
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
          description:
            "Preserve source IDs from Beads payload records when possible.",
        },
      ],
    } satisfies ImportExportRegistrationOptions,
  );
}

export default {
  manifest,
  activate,
};
