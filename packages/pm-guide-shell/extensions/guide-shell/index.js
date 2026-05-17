import {
  renderGuideShellPackageOutput,
  runCompletionPackage,
  runCompletionTagsPackage,
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
];

const completionFlags = [
  { long: "--shell", value_name: "value", value_type: "string", description: "Completion target shell: bash|zsh|fish." },
  { long: "--item-types", value_name: "csv", value_type: "string", description: "Filter completion item types." },
  { long: "--item_types", value_name: "csv", value_type: "string", description: "Alias for --item-types." },
  { long: "--tags", value_name: "csv", value_type: "string", description: "Filter completion tags." },
  { long: "--eager-tags", value_type: "boolean", description: "Expand all tag suggestions eagerly." },
  { long: "--eager_tags", value_type: "boolean", description: "Alias for --eager-tags." },
];

function guideCommand() {
  return {
    name: "guide",
    action: "guide",
    description: "Show migration and usage guidance for pm command families.",
    arguments: [{ name: "topic", required: false, description: "Optional guide topic." }],
    flags: [...guideFlags],
    run: async (context) => runGuidePackage(context.args, context.options, context.global),
  };
}

function completionCommand() {
  return {
    name: "completion",
    action: "completion",
    description: "Generate shell completion scripts for bash, zsh, and fish.",
    arguments: [{ name: "shell", required: false, description: "Target shell (bash|zsh|fish)." }],
    flags: [...completionFlags],
    run: async (context) => runCompletionPackage(context.args, context.options, context.global),
  };
}

function completionTagsCommand() {
  return {
    name: "completion-tags",
    action: "completion-tags",
    description: "Print known tags for completion filters.",
    run: async (context) => runCompletionTagsPackage(context.global),
  };
}

export function activate(api) {
  api.registerCommand(guideCommand());
  api.registerCommand(completionCommand());
  api.registerCommand(completionTagsCommand());
  api.registerService("output_format", (context) => {
    const rendered = renderGuideShellPackageOutput(context);
    return rendered ?? null;
  });
}

export default {
  manifest,
  activate,
};
