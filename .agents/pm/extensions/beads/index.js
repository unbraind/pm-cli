import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

export const manifest = {
  name: "builtin-beads-import",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands"],
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

async function runBeadsImportFromRuntime(options, global) {
  const runtime = await loadRuntimeModule("beads.js");
  if (typeof runtime.runBeadsImport !== "function") {
    throw new Error('Bundled runtime module "beads.js" is missing runBeadsImport().');
  }
  return runtime.runBeadsImport(options, global);
}

export function activate(api) {
  api.registerCommand({
    name: "beads import",
    run: async (context) => runBeadsImportFromRuntime(toBeadsImportOptions(context.options), context.global),
  });
}

export default {
  manifest,
  activate,
};
