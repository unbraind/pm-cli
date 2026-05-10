import { PM_TOOL_ACTIONS } from "../../../dist/sdk/cli-contracts.js";
import { runNativePmAction } from "../../../dist/pi/native.js";

const PM_PI_TOOL_PARAMETERS_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["action"],
  description: "Parameters for the native pm Pi tool. Extra properties are forwarded to the selected pm action.",
  properties: {
    action: {
      type: "string",
      description: "pm action to execute, for example context, search, get, create, update, files, docs, test, validate, or close-task.",
    },
    id: { type: "string", description: "pm item id for item-scoped actions." },
    text: { type: "string", description: "Text payload for comment-like actions or close reasons." },
    title: { type: "string", description: "Title for create actions." },
    description: { type: "string", description: "Description for create/update actions." },
    query: { type: "string", description: "Search query text." },
    limit: { type: "string", description: "Result limit. Numeric strings are accepted." },
    author: { type: "string", description: "Explicit pm author for mutations." },
    path: { type: "string", description: "pm data path override or linked file path, depending on action." },
    scope: { type: "string", description: "Link scope such as project." },
    command: { type: "string", description: "Linked test command or shell completion target, depending on action." },
    options: {
      type: "object",
      additionalProperties: true,
      description: "Advanced command options object forwarded to the selected pm action.",
    },
  },
};

function contentText(result) {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

function errorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof error?.exitCode === "number" ? error.exitCode : 1,
  };
}

export function createPmToolDefinition() {
  return {
    name: "pm",
    label: "pm",
    description:
      "Use pm natively from Pi without shelling out to the pm CLI. Supports pm project context, search, lifecycle mutations, links, tests, validation, extension management, templates, calendar, and audit workflows.",
    promptSnippet: "Run native pm project-management operations without bash or the pm CLI.",
    promptGuidelines: [
      "Use the pm tool instead of bash pm commands for project-management operations when this tool is available.",
      "Use pm action=context/list-open/list-in-progress/search before creating new work items.",
      "For mutations, set author explicitly and link changed files/tests/docs through pm actions before closing work.",
    ],
    parameters: PM_PI_TOOL_PARAMETERS_SCHEMA,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Running native pm action: ${params.action}` }] });
      try {
        const result = await runNativePmAction({ cwd: ctx?.cwd, ...params });
        return {
          content: [{ type: "text", text: contentText(result) }],
          details: { ok: true, action: params.action, result, native: true },
        };
      } catch (error) {
        const details = errorDetails(error);
        throw new Error(`pm ${params.action ?? "action"} failed: ${details.message}`);
      }
    },
  };
}

export function registerPmCommands(pi) {
  pi.registerCommand("pm-context", {
    description: "Show pm context snapshot using the native pm integration",
    handler: async (args, ctx) => {
      const limit = args?.trim() || "10";
      const result = await runNativePmAction({ cwd: ctx.cwd, action: "context", limit, json: false });
      ctx.ui.notify(contentText(result), "info");
    },
  });

  pi.registerCommand("pm-start", {
    description: "Start/claim a pm item: /pm-start <id>",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) return ctx.ui.notify("Usage: /pm-start <id>", "error");
      const result = await runNativePmAction({ cwd: ctx.cwd, action: "start-task", id, author: "pi-agent" });
      ctx.ui.notify(contentText(result), "success");
    },
  });

  pi.registerCommand("pm-close", {
    description: "Close and release a pm item: /pm-close <id> <reason>",
    handler: async (args, ctx) => {
      const [id, ...reasonParts] = (args ?? "").trim().split(/\s+/);
      const reason = reasonParts.join(" ");
      if (!id || !reason) return ctx.ui.notify("Usage: /pm-close <id> <reason>", "error");
      const result = await runNativePmAction({ cwd: ctx.cwd, action: "close-task", id, text: reason, author: "pi-agent", validateClose: "warn" });
      ctx.ui.notify(contentText(result), "success");
    },
  });

  pi.registerCommand("pm-actions", {
    description: "List native pm tool actions",
    handler: async (_args, ctx) => {
      ctx.ui.notify(PM_TOOL_ACTIONS.join(", "), "info");
    },
  });
}

function patchPmToolParametersInProviderPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.tools)) {
    return undefined;
  }
  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (!tool || typeof tool !== "object") {
      return tool;
    }
    if (tool.name === "pm") {
      const parameters = tool.parameters;
      if (!parameters || parameters.type !== "object") {
        changed = true;
        return { ...tool, parameters: PM_PI_TOOL_PARAMETERS_SCHEMA };
      }
    }
    if (tool.function?.name === "pm") {
      const parameters = tool.function.parameters;
      if (!parameters || parameters.type !== "object") {
        changed = true;
        return { ...tool, function: { ...tool.function, parameters: PM_PI_TOOL_PARAMETERS_SCHEMA } };
      }
    }
    return tool;
  });
  return changed ? { ...payload, tools } : undefined;
}

export default function pmCliPiExtension(pi) {
  pi.registerTool(createPmToolDefinition());
  pi.on("before_provider_request", (event) => patchPmToolParametersInProviderPayload(event.payload));
  registerPmCommands(pi);
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus?.("pm", "pm native");
  });
}
