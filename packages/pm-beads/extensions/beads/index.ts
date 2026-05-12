import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CommandDefinition, ExtensionApi, GlobalOptions } from "../../../../src/sdk/index.js";
import type { BeadsImportOptions, BeadsImportResult } from "./runtime.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const CURRENT_EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));

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
      path.join(packageRoot, ".agents", "pm", "extensions", "beads", "runtime.js"),
      path.join(packageRoot, "packages", "pm-beads", "extensions", "beads", "runtime.js"),
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
    "Unable to resolve packaged beads extension runtime module. " +
      `Tried: ${attempted.join(", ")}. Ensure the installed extension includes runtime.js or PM_CLI_PACKAGE_ROOT points to an installed pm package root.`,
  );
}

async function runBeadsImportFromRuntime(options: BeadsImportOptions, global: GlobalOptions): Promise<BeadsImportResult> {
  const runtime = await loadRuntimeModule();
  if (typeof runtime.runBeadsImport !== "function") {
    throw new Error("Bundled beads runtime module is missing runBeadsImport().");
  }
  return runtime.runBeadsImport(options, global);
}

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "beads import",
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
