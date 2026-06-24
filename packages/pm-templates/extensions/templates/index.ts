import type { CommandDefinition, ExtensionApi, GlobalOptions } from "@unbrained/pm-cli/sdk";
import {
  runTemplatesList as runTemplatesListPackage,
  runTemplatesSave as runTemplatesSavePackage,
  runTemplatesShow as runTemplatesShowPackage,
  type TemplatesListResult,
  type TemplatesSaveResult,
  type TemplatesShowResult,
} from "./runtime.ts";

export const manifest = {
  name: "builtin-templates",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema"],
};

function onlyArg(args: string[], commandName: string): string {
  const value = args[0];
  if (typeof value === "string" && value.trim().length > 0) {
    if (args.length > 1) {
      throw new Error(`${commandName} accepts exactly one template name argument.`);
    }
    return value;
  }
  throw new Error(`${commandName} requires a template name argument.`);
}

function optionKeys(options: Record<string, unknown>): string[] {
  return Object.entries(options)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key]) => key)
    .sort();
}

function assertListInvocation(args: string[], options: Record<string, unknown>, commandName: string): void {
  const unexpectedSubcommand = args.find((arg) => arg.trim().length > 0);
  if (unexpectedSubcommand) {
    throw new Error(
      `Unknown pm templates subcommand "${unexpectedSubcommand}". Allowed: list, save, show. Apply a saved template with pm create <type> <title> --template <name>.`,
    );
  }
  const unexpectedOptions = optionKeys(options);
  if (unexpectedOptions.length > 0) {
    throw new Error(
      `pm ${commandName} does not accept options: ${unexpectedOptions.map((key) => `--${key}`).join(", ")}. Allowed subcommands: list, save, show. Save defaults with pm templates save <name> ... or apply them with pm create <type> <title> --template <name>.`,
    );
  }
}

async function runTemplatesListFromRuntime(global: GlobalOptions): Promise<TemplatesListResult> {
  return runTemplatesListPackage(global);
}

async function runTemplatesSaveFromRuntime(
  args: string[],
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<TemplatesSaveResult> {
  return runTemplatesSavePackage(onlyArg(args, "templates save"), options, global);
}

async function runTemplatesShowFromRuntime(args: string[], global: GlobalOptions): Promise<TemplatesShowResult> {
  return runTemplatesShowPackage(onlyArg(args, "templates show"), global);
}

const createOptionFlags = [
  { long: "--title", short: "-t", value_name: "value", value_type: "string", description: "Template default item title." },
  { long: "--description", short: "-d", value_name: "value", value_type: "string", description: "Template default item description." },
  { long: "--type", value_name: "value", value_type: "string", description: "Template default item type." },
  { long: "--status", short: "-s", value_name: "value", value_type: "string", description: "Template default item status." },
  { long: "--priority", short: "-p", value_name: "value", value_type: "string", description: "Template default priority 0..4." },
  { long: "--tags", value_name: "value", value_type: "string", description: "Template default comma-separated tags." },
  { long: "--body", short: "-b", value_name: "value", value_type: "string", description: "Template default item markdown body." },
  { long: "--deadline", value_name: "value", value_type: "string", description: "Template default deadline." },
  { long: "--estimate", value_name: "value", value_type: "string", description: "Template default estimated minutes." },
  { long: "--estimated-minutes", value_name: "value", value_type: "string", description: "Template default estimated minutes." },
  { long: "--acceptance-criteria", value_name: "value", value_type: "string", description: "Template default acceptance criteria." },
  { long: "--ac", value_name: "value", value_type: "string", description: "Alias for --acceptance-criteria." },
  { long: "--author", value_name: "value", value_type: "string", description: "Template default mutation author." },
  { long: "--message", value_name: "value", value_type: "string", description: "Template default history message." },
  { long: "--assignee", value_name: "value", value_type: "string", description: "Template default assignee." },
  { long: "--parent", value_name: "value", value_type: "string", description: "Template default parent item ID." },
  { long: "--reviewer", value_name: "value", value_type: "string", description: "Template default reviewer." },
  { long: "--risk", value_name: "value", value_type: "string", description: "Template default risk level." },
  { long: "--confidence", value_name: "value", value_type: "string", description: "Template default confidence." },
  { long: "--sprint", value_name: "value", value_type: "string", description: "Template default sprint identifier." },
  { long: "--release", value_name: "value", value_type: "string", description: "Template default release identifier." },
  { long: "--dep", value_name: "value", value_type: "string", description: "Template default dependency seed.", repeatable: true },
  { long: "--comment", value_name: "value", value_type: "string", description: "Template default comment seed.", repeatable: true },
  { long: "--note", value_name: "value", value_type: "string", description: "Template default note seed.", repeatable: true },
  { long: "--learning", value_name: "value", value_type: "string", description: "Template default learning seed.", repeatable: true },
  { long: "--file", value_name: "value", value_type: "string", description: "Template default linked file seed.", repeatable: true },
  { long: "--test", value_name: "value", value_type: "string", description: "Template default linked test seed.", repeatable: true },
  { long: "--doc", value_name: "value", value_type: "string", description: "Template default linked doc seed.", repeatable: true },
  { long: "--reminder", value_name: "value", value_type: "string", description: "Template default reminder seed.", repeatable: true },
  { long: "--event", value_name: "value", value_type: "string", description: "Template default event seed.", repeatable: true },
] as const;

export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "templates",
    action: "templates-list",
    description: "List saved create templates.",
    run: async (context) => {
      assertListInvocation(context.args, context.options, "templates");
      return runTemplatesListFromRuntime(context.global);
    },
  } satisfies CommandDefinition);
  api.registerCommand({
    name: "templates list",
    action: "templates-list",
    description: "List saved create templates.",
    run: async (context) => {
      assertListInvocation(context.args, context.options, "templates list");
      return runTemplatesListFromRuntime(context.global);
    },
  } satisfies CommandDefinition);
  api.registerCommand({
    name: "templates save",
    action: "templates-save",
    description: "Save reusable create template defaults.",
    arguments: [{ name: "name", required: true, description: "Template name." }],
    flags: [...createOptionFlags],
    run: async (context) => runTemplatesSaveFromRuntime(context.args, context.options, context.global),
  } satisfies CommandDefinition);
  api.registerCommand({
    name: "templates show",
    action: "templates-show",
    description: "Show a saved create template.",
    arguments: [{ name: "name", required: true, description: "Template name." }],
    run: async (context) => runTemplatesShowFromRuntime(context.args, context.global),
  } satisfies CommandDefinition);
}

export default {
  manifest,
  activate,
};
