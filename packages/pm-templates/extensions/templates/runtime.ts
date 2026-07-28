/**
 * Runtime contracts and behavior for packages/pm templates/extensions/templates/runtime.
 *
 * @module packages/pm-templates/extensions/templates/runtime
 */
import {
  loadCreateTemplateOptions as loadSdkCreateTemplateOptions,
  runTemplatesList as runSdkTemplatesList,
  runTemplatesSave as runSdkTemplatesSave,
  runTemplatesShow as runSdkTemplatesShow,
  type CreateTemplateOptions,
  type GlobalOptions,
  type TemplatesListResult,
  type TemplatesSaveResult,
  type TemplatesShowResult,
} from "@unbrained/pm-cli/sdk";

export type {
  CreateTemplateOptions,
  TemplatesListResult,
  TemplatesSaveResult,
  TemplatesShowResult,
} from "@unbrained/pm-cli/sdk";

/** Loads and validates create template options from the configured source. */
export async function loadCreateTemplateOptions(
  pmRoot: string,
  rawTemplateName: string,
): Promise<CreateTemplateOptions> {
  return loadSdkCreateTemplateOptions(pmRoot, rawTemplateName);
}

/** Executes the templates save operation through the package runtime. */
export async function runTemplatesSave(
  rawTemplateName: string,
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<TemplatesSaveResult> {
  return runSdkTemplatesSave(rawTemplateName, options, global);
}

/** Executes the templates list operation through the package runtime. */
export async function runTemplatesList(
  global: GlobalOptions,
): Promise<TemplatesListResult> {
  return runSdkTemplatesList(global);
}

/** Executes the templates show operation through the package runtime. */
export async function runTemplatesShow(
  rawTemplateName: string,
  global: GlobalOptions,
): Promise<TemplatesShowResult> {
  return runSdkTemplatesShow(rawTemplateName, global);
}
