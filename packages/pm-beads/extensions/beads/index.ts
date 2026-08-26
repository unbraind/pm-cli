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
import {
  runBeadsImport,
  type BeadsImportOptions,
} from "./runtime.ts";

/** Declarative package manifest consumed by the extension loader. */
export const manifest = {
  name: "builtin-beads-import",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "importers"],
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
    backupDir: asOptionalString(options.backupDir),
    author: global.author,
    message: asOptionalString(options.message),
    preserveSourceIds: asBoolean(options.preserveSourceIds),
  };
}

/** Registers this package's commands, actions, and runtime hooks with the host. */
export function activate(api: ExtensionApi): void {
  // First-party exemplar for the importers capability: registerImporter creates
  // the `beads import` command path, and the options object keeps the command
  // description + flags discoverable in help and runtime contracts.
  api.registerImporter(
    "beads",
    async (context: ImportExportContext) =>
      runBeadsImport(
        toBeadsImportOptions(context.options, context.global),
        context.global,
      ),
    {
      action: "beads-import",
      description: "Import Beads JSONL records into pm items.",
      intent: "Import Beads records through audited pm item mutations.",
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
          long: "--backup-dir",
          value_name: "path",
          value_type: "string",
          description:
            "Path to a complete bd portable-backup directory with issue, event, comment, dependency, label, and count files.",
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
