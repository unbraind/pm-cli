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
  type GlobalOptions,
} from "@unbrained/pm-cli/sdk";

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
