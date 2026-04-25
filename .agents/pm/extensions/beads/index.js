import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

export const manifest = {
  name: "builtin-beads-import",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema"],
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

function resolvePackageRootCandidates() {
  const candidates = [];
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

async function loadRuntimeModule() {
  const attempted = [];
  for (const packageRoot of resolvePackageRootCandidates()) {
    const modulePath = path.join(packageRoot, ".agents", "pm", "extensions", "beads", "runtime.js");
    attempted.push(modulePath);
    try {
      return await import(pathToFileURL(modulePath).href);
    } catch {
      // Try the next package-root candidate.
    }
  }
  throw new Error(
    "Unable to resolve bundled beads extension runtime module. " +
      `Tried: ${attempted.join(", ")}. Ensure PM_CLI_PACKAGE_ROOT points to an installed pm package root.`,
  );
}

async function runBeadsImportFromRuntime(options, global) {
  const runtime = await loadRuntimeModule();
  if (typeof runtime.runBeadsImport !== "function") {
    throw new Error('Bundled beads runtime module is missing runBeadsImport().');
  }
  return runtime.runBeadsImport(options, global);
}

export function activate(api) {
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
  });
}

export default {
  manifest,
  activate,
};
