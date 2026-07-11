/**
 * Runtime contracts and behavior for packages/pm templates/extensions/templates/runtime.
 *
 * @module packages/pm-templates/extensions/templates/runtime
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

type TemplateOptionValue = string | string[];
/** Creates template options using the validated operation inputs. */
export type CreateTemplateOptions = Record<string, TemplateOptionValue>;

/** Structured result returned by the templates save operation. */
export interface TemplatesSaveResult {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports options for this contract. */
  options: CreateTemplateOptions;
}

/** Structured result returned by the templates list operation. */
export interface TemplatesListResult {
  /** Value that configures or reports templates for this contract. */
  templates: string[];
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports builtin templates for this contract. */
  builtin_templates: string[];
  /** Value that configures or reports user templates for this contract. */
  user_templates: string[];
}

/** Structured result returned by the templates show operation. */
export interface TemplatesShowResult {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports source for this contract. */
  source: "builtin" | "user";
  /** ISO 8601 timestamp recording when created occurred. */
  created_at: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports options for this contract. */
  options: CreateTemplateOptions;
}

interface TemplatesSdkModule {
  loadCreateTemplateOptions: (
    pmRoot: string,
    rawTemplateName: string,
  ) => Promise<CreateTemplateOptions>;
  runTemplatesList: (global: GlobalOptions) => Promise<TemplatesListResult>;
  runTemplatesSave: (
    rawTemplateName: string,
    options: Record<string, unknown>,
    global: GlobalOptions,
  ) => Promise<TemplatesSaveResult>;
  runTemplatesShow: (
    rawTemplateName: string,
    global: GlobalOptions,
  ) => Promise<TemplatesShowResult>;
}

const sdk = await loadTemplatesSdkModule();

async function loadTemplatesSdkModule(): Promise<TemplatesSdkModule> {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-templates requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(
    path.resolve(envRoot.trim()),
    "dist",
    "sdk",
    "index.js",
  );
  try {
    const loaded = (await import(
      pathToFileURL(modulePath).href
    )) as Partial<TemplatesSdkModule>;
    if (
      typeof loaded.loadCreateTemplateOptions === "function" &&
      typeof loaded.runTemplatesList === "function" &&
      typeof loaded.runTemplatesSave === "function" &&
      typeof loaded.runTemplatesShow === "function"
    ) {
      return loaded as TemplatesSdkModule;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-templates failed to load template runtime exports from ${modulePath}.`,
  );
}

/** Loads and validates create template options from the configured source. */
export async function loadCreateTemplateOptions(
  pmRoot: string,
  rawTemplateName: string,
): Promise<CreateTemplateOptions> {
  return sdk.loadCreateTemplateOptions(pmRoot, rawTemplateName);
}

/** Executes the templates save operation through the package runtime. */
export async function runTemplatesSave(
  rawTemplateName: string,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<TemplatesSaveResult> {
  return sdk.runTemplatesSave(rawTemplateName, options, global);
}

/** Executes the templates list operation through the package runtime. */
export async function runTemplatesList(
  global: GlobalOptions,
): Promise<TemplatesListResult> {
  return sdk.runTemplatesList(global);
}

/** Executes the templates show operation through the package runtime. */
export async function runTemplatesShow(
  rawTemplateName: string,
  global: GlobalOptions,
): Promise<TemplatesShowResult> {
  return sdk.runTemplatesShow(rawTemplateName, global);
}
