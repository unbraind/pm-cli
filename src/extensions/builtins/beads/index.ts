import { runBeadsImport } from "../../../cli/commands/beads.js";
import type { BeadsImportOptions } from "../../../cli/commands/beads.js";
import type { ExtensionApi, ExtensionManifest } from "../../../core/extensions/loader.js";

export const manifest: ExtensionManifest = {
  name: "builtin-beads-import",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands"],
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toBeadsImportOptions(options: Record<string, unknown>): BeadsImportOptions {
  return {
    file: asOptionalString(options.file),
    author: asOptionalString(options.author),
    message: asOptionalString(options.message),
  };
}

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "beads import",
    run: async (context) => runBeadsImport(toBeadsImportOptions(context.options), context.global),
  });
}

export default {
  manifest,
  activate,
};
