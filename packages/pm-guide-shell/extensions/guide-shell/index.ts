import type {
  CommandDefinition,
  ExtensionApi,
  ServiceOverrideContext,
} from "../../../../src/sdk/index.js";
import {
  renderGuideShellPackageOutput,
  runCompletionPackage,
  runCompletionStatusesPackage,
  runCompletionTagsPackage,
  runCompletionTypesPackage,
  runGuidePackage,
} from "./runtime.js";

export const manifest = {
  name: "builtin-guide-shell",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "services"],
};

const guideFlags = [
  { long: "--list", value_type: "boolean", description: "List available guide topics." },
  { long: "--format", value_name: "value", value_type: "string", description: "Output format override: markdown|toon|json." },
  { long: "--depth", value_name: "value", value_type: "string", description: "Guide detail depth." },
  { long: "--topic", value_name: "value", value_type: "string", description: "Explicit guide topic override." },
] as const;

const completionFlags = [
  { long: "--shell", value_name: "value", value_type: "string", description: "Completion target shell: bash|zsh|fish." },
  { long: "--item-types", value_name: "csv", value_type: "string", description: "Filter completion item types." },
  { long: "--item_types", value_name: "csv", value_type: "string", description: "Alias for --item-types." },
  { long: "--tags", value_name: "csv", value_type: "string", description: "Filter completion tags." },
  { long: "--eager-tags", value_type: "boolean", description: "Expand all tag suggestions eagerly." },
  { long: "--eager_tags", value_type: "boolean", description: "Alias for --eager-tags." },
] as const;

function guideCommand(): CommandDefinition {
  return {
    name: "guide",
    action: "guide",
    description: "Show migration and usage guidance for pm command families.",
    arguments: [{ name: "topic", required: false, description: "Optional guide topic." }],
    flags: [...guideFlags],
    run: async (context) => runGuidePackage(context.args, context.options, context.global),
  };
}

function completionCommand(): CommandDefinition {
  return {
    name: "completion",
    action: "completion",
    description: "Generate shell completion scripts for bash, zsh, and fish.",
    arguments: [{ name: "shell", required: false, description: "Target shell (bash|zsh|fish)." }],
    flags: [...completionFlags],
    run: async (context) => runCompletionPackage(context.args, context.options, context.global),
  };
}

function completionTagsCommand(): CommandDefinition {
  return {
    name: "completion-tags",
    action: "completion-tags",
    description: "Print known tags for completion filters.",
    run: async (context) => runCompletionTagsPackage(context.global),
  };
}

function completionStatusesCommand(): CommandDefinition {
  return {
    name: "completion-statuses",
    action: "completion-statuses",
    description: "Print runtime status IDs for completion filters.",
    run: async (context) => runCompletionStatusesPackage(context.global),
  };
}

function completionTypesCommand(): CommandDefinition {
  return {
    name: "completion-types",
    action: "completion-types",
    description: "Print runtime item type IDs for completion filters.",
    run: async (context) => runCompletionTypesPackage(context.global),
  };
}

export function activate(api: ExtensionApi): void {
  api.registerCommand(guideCommand());
  api.registerCommand(completionCommand());
  api.registerCommand(completionTagsCommand());
  api.registerCommand(completionStatusesCommand());
  api.registerCommand(completionTypesCommand());
  api.registerService("output_format", (context) => {
    const rendered = renderGuideShellPackageOutput(context as ServiceOverrideContext);
    return rendered ?? null;
  });
}

export default {
  manifest,
  activate,
};
