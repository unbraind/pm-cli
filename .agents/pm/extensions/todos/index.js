import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

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
    const modulePath = path.join(packageRoot, ".agents", "pm", "extensions", "todos", "runtime.js");
    attempted.push(modulePath);
    try {
      return await import(pathToFileURL(modulePath).href);
    } catch {
      // Try the next package-root candidate.
    }
  }
  throw new Error(
    "Unable to resolve bundled todos extension runtime module. " +
      `Tried: ${attempted.join(", ")}. Ensure PM_CLI_PACKAGE_ROOT points to an installed pm package root.`,
  );
}

async function runTodosImportFromRuntime(options, global) {
  const runtime = await loadRuntimeModule();
  if (typeof runtime.runTodosImport !== "function") {
    throw new Error('Bundled todos runtime module is missing runTodosImport().');
  }
  return runtime.runTodosImport(options, global);
}

async function runTodosExportFromRuntime(options, global) {
  const runtime = await loadRuntimeModule();
  if (typeof runtime.runTodosExport !== "function") {
    throw new Error('Bundled todos runtime module is missing runTodosExport().');
  }
  return runtime.runTodosExport(options, global);
}

export function activate(api) {
  api.registerCommand({
    name: "todos import",
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
