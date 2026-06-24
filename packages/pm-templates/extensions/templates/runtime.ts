import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

type TemplateOptionValue = string | string[];
export type CreateTemplateOptions = Record<string, TemplateOptionValue>;

export interface TemplatesSaveResult {
  name: string;
  created_at: string;
  updated_at: string;
  path: string;
  options: CreateTemplateOptions;
}

export interface TemplatesListResult {
  templates: string[];
  count: number;
  builtin_templates: string[];
  user_templates: string[];
}

export interface TemplatesShowResult {
  name: string;
  source: "builtin" | "user";
  created_at: string;
  updated_at: string;
  path: string;
  options: CreateTemplateOptions;
}

interface TemplatesSdkModule {
  loadCreateTemplateOptions: (pmRoot: string, rawTemplateName: string) => Promise<CreateTemplateOptions>;
  runTemplatesList: (global: GlobalOptions) => Promise<TemplatesListResult>;
  runTemplatesSave: (
    rawTemplateName: string,
    options: Record<string, unknown>,
    global: GlobalOptions,
  ) => Promise<TemplatesSaveResult>;
  runTemplatesShow: (rawTemplateName: string, global: GlobalOptions) => Promise<TemplatesShowResult>;
}

const sdk = await loadTemplatesSdkModule();

async function loadTemplatesSdkModule(): Promise<TemplatesSdkModule> {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-templates requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "index.js");
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<TemplatesSdkModule>;
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

export async function loadCreateTemplateOptions(pmRoot: string, rawTemplateName: string): Promise<CreateTemplateOptions> {
  return sdk.loadCreateTemplateOptions(pmRoot, rawTemplateName);
}

export async function runTemplatesSave(
  rawTemplateName: string,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<TemplatesSaveResult> {
  return sdk.runTemplatesSave(rawTemplateName, options, global);
}

export async function runTemplatesList(global: GlobalOptions): Promise<TemplatesListResult> {
  return sdk.runTemplatesList(global);
}

export async function runTemplatesShow(rawTemplateName: string, global: GlobalOptions): Promise<TemplatesShowResult> {
  return sdk.runTemplatesShow(rawTemplateName, global);
}
