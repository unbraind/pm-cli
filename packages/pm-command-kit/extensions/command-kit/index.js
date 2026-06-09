/**
 * pm-command-kit — first-party exemplar for the `commands` capability surface.
 *
 * Demonstrates the three command-facing SDK registration APIs:
 * 1. `registerCommand` with a FULL CommandDefinition (name, action, description,
 *    intent, arguments, flags, examples, failure_hints, run).
 * 2. `registerParser` to preprocess parsed options before the command handler runs.
 * 3. `registerFlags` to inject an additional flag into an EXISTING command.
 *
 * The extension is intentionally pure: no filesystem, network, environment, or
 * process access — so its manifest declares `sandbox_profile: "strict"` with all
 * permissions false. Third-party authors can copy this package wholesale and
 * replace the echo behavior with their own command logic.
 *
 * Hand-maintained alongside index.ts: this file is import-free so the extension
 * stays loadable in extension-only installs without SDK module resolution.
 */
export const manifest = {
  name: "builtin-command-kit",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "parser"],
  activation: { commands: ["command-kit echo", "list"] },
};

export const ECHO_COMMAND = "command-kit echo";

function toPositiveInteger(value, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function toDecorationList(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set();
  for (const entry of raw) {
    const trimmed = String(entry).trim();
    if (trimmed.length > 0) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}

/**
 * registerParser exemplar: normalize parsed options BEFORE the command handler
 * runs. Returns a delta — only the keys you set are merged over the parsed
 * input. Here the deprecated `--shout` alias is rewritten to `--upper`,
 * `--repeat` is coerced to a positive integer, and `--decorations` values are
 * trimmed and de-duplicated.
 *
 * @param {{ command: string, args: string[], options: Record<string, unknown>, global: Record<string, unknown>, pm_root: string }} context
 * @returns {{ options: Record<string, unknown> }}
 */
export function rewriteEchoOptions(context) {
  const options = { ...context.options };
  if (options.shout === true || options.shout === "true") {
    options.upper = true;
  }
  delete options.shout;
  options.repeat = toPositiveInteger(options.repeat, 1);
  if (options.decorations !== undefined) {
    options.decorations = toDecorationList(options.decorations);
  }
  return { options };
}

/**
 * Command handler: pure compute, structured result rendered by the host.
 *
 * @param {{ command: string, args: string[], options: Record<string, unknown>, global: Record<string, unknown>, pm_root: string }} context
 * @returns {Record<string, unknown>}
 */
export function runEchoCommand(context) {
  const args = Array.isArray(context?.args) ? context.args : [];
  const options =
    context?.options && typeof context.options === "object" && !Array.isArray(context.options) ? context.options : {};
  const message = args
    .map((arg) => String(arg).trim())
    .filter((arg) => arg.length > 0)
    .join(" ");
  if (message.length === 0) {
    throw new Error('command-kit echo requires a message argument. Try: pm command-kit echo "hello world".');
  }
  const upper = options.upper === true || options.upper === "true";
  const repeat = toPositiveInteger(options.repeat, 1);
  const decorations = toDecorationList(options.decorations);
  const rendered = upper ? message.toUpperCase() : message;
  return {
    action: "command-kit-echo",
    message: rendered,
    lines: Array.from({ length: repeat }, () => rendered),
    repeat,
    upper,
    decorations,
  };
}

const echoFlags = [
  {
    long: "--upper",
    value_type: "boolean",
    description: "Uppercase the echoed message.",
  },
  {
    long: "--shout",
    value_type: "boolean",
    description: "Deprecated alias for --upper; rewritten to --upper by the registered parser.",
  },
  {
    long: "--repeat",
    value_name: "count",
    value_type: "number",
    default: 1,
    description: "Echo the message this many times (minimum 1).",
  },
  {
    long: "--decorations",
    value_name: "csv",
    value_type: "string",
    list: true,
    description: "Comma-separated decoration labels; repeated flags accumulate.",
  },
];

/** registerCommand exemplar: a FULL CommandDefinition with every field populated. */
export function buildEchoCommandDefinition() {
  return {
    name: ECHO_COMMAND,
    action: "command-kit-echo",
    description: "Echo a message as structured output (commands-capability exemplar).",
    intent: "Demonstrate every CommandDefinition field: arguments, flags, examples, and failure hints.",
    arguments: [
      {
        name: "message",
        required: true,
        variadic: true,
        description: "Message words to echo back.",
      },
    ],
    flags: [...echoFlags],
    examples: [
      'pm command-kit echo "hello world"',
      "pm command-kit echo hello --upper --repeat 2",
      "pm command-kit echo hello --decorations star,spark --decorations wave",
    ],
    failure_hints: [
      "command-kit echo requires a message argument; pass words after the command name.",
      "--repeat takes a positive integer; invalid values fall back to 1.",
    ],
    run: runEchoCommand,
  };
}

/** registerFlags exemplar: inject an inert, namespaced flag into an existing core command. */
export const injectedListFlags = [
  {
    long: "--kit-note",
    value_name: "text",
    value_type: "string",
    description: "Inert exemplar flag injected into `pm list` by pm-command-kit; the core list handler ignores it.",
  },
];

/**
 * @param {import("../../../../src/sdk/index.js").ExtensionApi} api
 */
export function activate(api) {
  api.registerCommand(buildEchoCommandDefinition());
  api.registerParser(ECHO_COMMAND, rewriteEchoOptions);
  api.registerFlags("list", injectedListFlags);
}

export default {
  manifest,
  activate,
};
