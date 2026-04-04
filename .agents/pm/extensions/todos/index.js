import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

export const manifest = {
  name: "builtin-todos-import-export",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands"],
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

async function loadRuntimeModule(moduleName) {
  const attempted = [];
  for (const packageRoot of resolvePackageRootCandidates()) {
    const modulePath = path.join(packageRoot, "dist", "cli", "commands", moduleName);
    attempted.push(modulePath);
    try {
      return await import(pathToFileURL(modulePath).href);
    } catch {
      // Try the next package-root candidate.
    }
  }
  throw new Error(
    `Unable to resolve bundled extension runtime module "${moduleName}". ` +
      `Tried: ${attempted.join(", ")}. Ensure PM_CLI_PACKAGE_ROOT points to an installed pm package root.`,
  );
}

async function runTodosImportFromRuntime(options, global) {
  const runtime = await loadRuntimeModule("todos.js");
  if (typeof runtime.runTodosImport !== "function") {
    throw new Error('Bundled runtime module "todos.js" is missing runTodosImport().');
  }
  return runtime.runTodosImport(options, global);
}

async function runTodosExportFromRuntime(options, global) {
  const runtime = await loadRuntimeModule("todos.js");
  if (typeof runtime.runTodosExport !== "function") {
    throw new Error('Bundled runtime module "todos.js" is missing runTodosExport().');
  }
  return runtime.runTodosExport(options, global);
}

export function activate(api) {
  api.registerCommand({
    name: "todos import",
    run: async (context) => runTodosImportFromRuntime(toImportOptions(context.options), context.global),
  });
  api.registerCommand({
    name: "todos export",
    run: async (context) => runTodosExportFromRuntime(toExportOptions(context.options), context.global),
  });
}

export default {
  manifest,
  activate,
};
