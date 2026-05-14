import {
  runTemplatesList as runTemplatesListPackage,
  runTemplatesSave as runTemplatesSavePackage,
  runTemplatesShow as runTemplatesShowPackage,
} from "./runtime.js";

export const manifest = {
  name: "builtin-templates",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema"],
};

function firstArg(args, commandName) {
  const value = args[0];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`${commandName} requires a template name argument.`);
}

async function runTemplatesListFromRuntime(global) {
  return runTemplatesListPackage(global);
}

async function runTemplatesSaveFromRuntime(args, options, global) {
  return runTemplatesSavePackage(firstArg(args, "templates save"), options, global);
}

async function runTemplatesShowFromRuntime(args, global) {
  return runTemplatesShowPackage(firstArg(args, "templates show"), global);
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
];

export function activate(api) {
  api.registerCommand({
    name: "templates",
    action: "templates-list",
    description: "List saved create templates.",
    run: async (context) => runTemplatesListFromRuntime(context.global),
  });
  api.registerCommand({
    name: "templates list",
    action: "templates-list",
    description: "List saved create templates.",
    run: async (context) => runTemplatesListFromRuntime(context.global),
  });
  api.registerCommand({
    name: "templates save",
    action: "templates-save",
    description: "Save reusable create template defaults.",
    arguments: [{ name: "name", required: true, description: "Template name." }],
    flags: [...createOptionFlags],
    run: async (context) => runTemplatesSaveFromRuntime(context.args, context.options, context.global),
  });
  api.registerCommand({
    name: "templates show",
    action: "templates-show",
    description: "Show a saved create template.",
    arguments: [{ name: "name", required: true, description: "Template name." }],
    run: async (context) => runTemplatesShowFromRuntime(context.args, context.global),
  });
}

export default {
  manifest,
  activate,
};
