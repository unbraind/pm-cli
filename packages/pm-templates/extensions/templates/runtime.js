import path from "node:path";
import { pathToFileURL } from "node:url";
const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
const sdk = await loadTemplatesSdkModule();
async function loadTemplatesSdkModule() {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(`builtin-templates requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`);
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "index.js");
  try {
    const loaded = await import(pathToFileURL(modulePath).href);
    if (typeof loaded.loadCreateTemplateOptions === "function" &&
      typeof loaded.runTemplatesList === "function" &&
      typeof loaded.runTemplatesSave === "function" &&
      typeof loaded.runTemplatesShow === "function") {
      return loaded;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(`builtin-templates failed to load template runtime exports from ${modulePath}.`);
}
export async function loadCreateTemplateOptions(pmRoot, rawTemplateName) {
  return sdk.loadCreateTemplateOptions(pmRoot, rawTemplateName);
}
export async function runTemplatesSave(rawTemplateName, options, global) {
  return sdk.runTemplatesSave(rawTemplateName, options, global);
}
export async function runTemplatesList(global) {
  return sdk.runTemplatesList(global);
}
export async function runTemplatesShow(rawTemplateName, global) {
  return sdk.runTemplatesShow(rawTemplateName, global);
}
