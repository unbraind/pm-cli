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
      description:
        "pm action to execute, for example context, search, get, create, update, files, docs, test, validate, extension, templates, calendar, or close-task.",
    },
    id: { type: "string", description: "pm item id for item-scoped actions." },
    text: { type: "string", description: "Text payload for comment-like actions, body appends, or close reasons." },
    title: { type: "string", description: "Title for create actions." },
    description: { type: "string", description: "Description for create/update actions." },
    query: { type: "string", description: "Search query text." },
    limit: { type: "string", description: "Result limit. Numeric strings are accepted." },
    author: { type: "string", description: "Explicit pm author for mutations." },
    path: { type: "string", description: "pm data path override or linked file/source path, depending on action." },
    scope: { type: "string", description: "Link/config scope such as project or global." },
    command: { type: "string", description: "Linked test command or shell completion target, depending on action." },
    target: { type: "string", description: "Extension/template/restore/test-run target identifier, depending on action." },
    shell: { type: "string", description: "Shell name for completion actions (bash, zsh, fish)." },
    runId: { type: "string", description: "Managed linked-test run id for test-runs actions." },
    cwd: { type: "string", description: "Working directory for the native action. Defaults to the current Pi workspace." },
    json: { type: "boolean", description: "Return JSON-shaped pm results. Defaults to true for the native integration." },
    quiet: { type: "boolean", description: "Suppress user-facing output where supported." },
    force: { type: "boolean", description: "Force lifecycle or ownership operations where supported." },
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

function firstText(result) {
  const entry = Array.isArray(result?.content) ? result.content.find((part) => part?.type === "text") : undefined;
  return typeof entry?.text === "string" ? entry.text : "";
}

function truncatePlain(value, width) {
  const text = String(value ?? "");
  let visible = 0;
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\u001b") {
      const match = text.slice(index).match(/^\u001b\[[0-9;?]*[ -/]*[@-~]/);
      if (match) {
        output += match[0];
        index += match[0].length - 1;
        continue;
      }
    }
    if (visible >= Math.max(0, width - 1)) return `${output}…`;
    output += char;
    visible += 1;
  }
  return output;
}

function statusIcon(status, theme) {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "closed") return theme.fg("success", "✓");
  if (normalized === "blocked") return theme.fg("warning", "!");
  if (normalized === "in_progress") return theme.fg("accent", "▶");
  if (normalized === "canceled") return theme.fg("dim", "×");
  return theme.fg("dim", "○");
}

class PmPanelComponent {
  constructor(title, lines, theme, onClose) {
    this.title = title;
    this.lines = lines;
    this.theme = theme;
    this.onClose = onClose;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data) {
    if (data === "\u001b" || data === "\u0003" || data === "q" || data === "Q") {
      this.onClose?.();
    }
  }

  render(width) {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const theme = this.theme;
    const usable = Math.max(20, width);
    const border = theme.fg("borderMuted", "─".repeat(Math.max(0, usable)));
    const rendered = [
      border,
      truncatePlain(`${theme.fg("accent", theme.bold(` pm ${this.title} `))}${theme.fg("dim", "q/esc closes")}`, usable),
      border,
      ...this.lines.map((line) => truncatePlain(line, usable)),
      border,
    ];
    this.cachedWidth = width;
    this.cachedLines = rendered;
    return rendered;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function makeItemLine(item, theme) {
  const id = theme.fg("accent", item.id ?? "unknown");
  const type = theme.fg("muted", item.type ?? "Item");
  const status = statusIcon(item.status, theme);
  const priority = item.priority === undefined ? "" : theme.fg("dim", ` p${item.priority}`);
  const owner = item.assignee ? theme.fg("dim", ` @${item.assignee}`) : "";
  return `${status} ${id} ${type}${priority}${owner} ${item.title ?? "(untitled)"}`;
}

function contextLines(result, theme) {
  const lines = [];
  const summary = result?.summary;
  if (summary) {
    lines.push(
      `${theme.fg("muted", "summary")} active=${summary.active_items ?? 0} open=${summary.open ?? 0} in_progress=${summary.in_progress ?? 0} blocked=${summary.blocked ?? 0}`,
    );
  }
  const high = Array.isArray(result?.high_level) ? result.high_level : [];
  const low = Array.isArray(result?.low_level) ? result.low_level : [];
  if (high.length > 0) {
    lines.push("", theme.fg("accent", "High level"));
    lines.push(...high.map((item) => makeItemLine(item, theme)));
  }
  if (low.length > 0) {
    lines.push("", theme.fg("accent", "Tasks"));
    lines.push(...low.map((item) => makeItemLine(item, theme)));
  }
  if (lines.length === 0) lines.push(theme.fg("dim", "No pm context items found."));
  return lines;
}

function listLines(result, theme) {
  const items = Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [];
  if (items.length === 0) return [theme.fg("dim", "No items.")];
  return items.map((entry) => makeItemLine(entry.item ?? entry, theme));
}

function historyLines(result, theme) {
  const entries = Array.isArray(result?.history) ? result.history : Array.isArray(result?.entries) ? result.entries : [];
  if (entries.length === 0) return [theme.fg("dim", "No history entries.")];
  return entries.slice(0, 30).map((entry) => {
    const at = entry.timestamp ?? entry.created_at ?? "";
    const op = entry.op ?? entry.operation ?? entry.type ?? "history";
    const author = entry.author ? ` ${theme.fg("dim", `@${entry.author}`)}` : "";
    const message = entry.message ?? entry.text ?? entry.reason ?? "";
    return `${theme.fg("muted", at)} ${theme.fg("accent", op)}${author} ${message}`;
  });
}

function getItemLines(result, theme) {
  const item = result?.item ?? result;
  if (!item || typeof item !== "object") return [theme.fg("dim", "No item details.")];
  const lines = [makeItemLine(item, theme)];
  if (item.description) lines.push("", item.description);
  if (item.acceptance_criteria) lines.push("", `${theme.fg("accent", "Acceptance")}: ${item.acceptance_criteria}`);
  if (Array.isArray(item.comments) && item.comments.length > 0) {
    lines.push("", theme.fg("accent", "Recent comments"));
    for (const comment of item.comments.slice(-5)) {
      lines.push(`${theme.fg("muted", comment.created_at ?? "")} ${comment.author ?? "unknown"}: ${comment.text ?? ""}`);
    }
  }
  return lines;
}

function resultLines(details, theme) {
  const action = details?.action;
  const result = details?.result;
  if (action === "context") return contextLines(result, theme);
  if (String(action ?? "").startsWith("list") || action === "search") return listLines(result, theme);
  if (action === "history" || action === "activity") return historyLines(result, theme);
  if (action === "get") return getItemLines(result, theme);
  const raw = contentText(result);
  return raw.split("\n").slice(0, 40);
}

function errorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof error?.exitCode === "number" ? error.exitCode : 1,
  };
}

function uiTheme(ctx) {
  return ctx.ui?.theme ?? {
    fg: (_name, text) => String(text),
    bold: (text) => String(text),
  };
}

async function showPanel(ctx, title, lines, overlay = true) {
  if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }
  await ctx.ui.custom((_tui, theme, _keybindings, done) => new PmPanelComponent(title, lines, theme, () => done(undefined)), {
    overlay,
    overlayOptions: { anchor: "right-center", width: "70%", minWidth: 60, maxHeight: "85%", margin: 1 },
  });
}

async function runForCommand(ctx, params) {
  return runNativePmAction({ cwd: ctx.cwd, ...params });
}

export function createPmToolDefinition() {
  return {
    name: "pm",
    label: "pm",
    description:
      "Use pm natively from Pi without shelling out to the pm CLI. Supports pm project context, search, lifecycle mutations, links, tests, validation, extension management, templates, calendar, guide, audit, beads, todos, and managed test-run workflows.",
    promptSnippet: "Run native pm project-management operations without bash or the pm CLI.",
    promptGuidelines: [
      "Use the pm tool instead of bash pm commands for project-management operations when this tool is available.",
      "Use pm action=context/list-open/list-in-progress/search before creating new work items.",
      "For mutations, set author explicitly and link changed files/tests/docs through pm actions before closing work.",
      "Use pm action=contracts or guide when you need exact action/flag support instead of guessing parameters.",
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
    renderCall(args, theme) {
      const action = args?.action ?? "action";
      const target = args?.id ?? args?.query ?? args?.target ?? args?.title ?? "";
      return new PmPanelComponent("tool", [`${theme.fg("toolTitle", theme.bold("pm"))} ${theme.fg("accent", action)} ${theme.fg("dim", target)}`], theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new PmPanelComponent("running", [theme.fg("warning", "Running…")], theme);
      const details = result?.details;
      if (!details?.ok) return new PmPanelComponent("result", [firstText(result) || contentText(result)], theme);
      const lines = resultLines(details, theme);
      const visible = expanded ? lines : lines.slice(0, 12);
      if (!expanded && lines.length > visible.length) visible.push(theme.fg("dim", `… ${lines.length - visible.length} more; expand tool output for details`));
      return new PmPanelComponent(String(details.action ?? "result"), visible, theme);
    },
  };
}

export function registerPmCommands(pi) {
  pi.registerCommand("pm-context", {
    description: "Show pm context snapshot using the native pm integration",
    handler: async (args, ctx) => {
      const limit = args?.trim() || "10";
      const result = await runForCommand(ctx, { action: "context", limit, json: true });
      await showPanel(ctx, "context", contextLines(result, uiTheme(ctx)));
    },
  });

  pi.registerCommand("pm-board", {
    description: "Open an interactive pm dashboard panel: /pm-board [limit]",
    handler: async (args, ctx) => {
      const limit = args?.trim() || "12";
      const result = await runForCommand(ctx, { action: "context", limit, depth: "standard", json: true });
      await showPanel(ctx, "board", contextLines(result, uiTheme(ctx)));
    },
  });

  pi.registerCommand("pm-item", {
    description: "Open pm item details: /pm-item <id>",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) return ctx.ui.notify("Usage: /pm-item <id>", "error");
      const result = await runForCommand(ctx, { action: "get", id, json: true });
      await showPanel(ctx, id, getItemLines(result, uiTheme(ctx)));
    },
  });

  pi.registerCommand("pm-history", {
    description: "Open pm item history/activity panel: /pm-history <id>",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) return ctx.ui.notify("Usage: /pm-history <id>", "error");
      const result = await runForCommand(ctx, { action: "history", id, limit: 30, json: true });
      await showPanel(ctx, `${id} history`, historyLines(result, uiTheme(ctx)));
    },
  });

  pi.registerCommand("pm-start", {
    description: "Start/claim a pm item: /pm-start <id>",
    handler: async (args, ctx) => {
      const id = args?.trim();
      if (!id) return ctx.ui.notify("Usage: /pm-start <id>", "error");
      const result = await runForCommand(ctx, { action: "start-task", id, author: "pi-agent" });
      ctx.ui.notify(contentText(result), "success");
    },
  });

  pi.registerCommand("pm-close", {
    description: "Close and release a pm item: /pm-close <id> <reason>",
    handler: async (args, ctx) => {
      const [id, ...reasonParts] = (args ?? "").trim().split(/\s+/);
      const reason = reasonParts.join(" ");
      if (!id || !reason) return ctx.ui.notify("Usage: /pm-close <id> <reason>", "error");
      const result = await runForCommand(ctx, { action: "close-task", id, text: reason, author: "pi-agent", validateClose: "warn" });
      ctx.ui.notify(contentText(result), "success");
    },
  });

  pi.registerCommand("pm-actions", {
    description: "List native pm tool actions",
    handler: async (_args, ctx) => {
      await showPanel(ctx, "actions", PM_TOOL_ACTIONS.map((action) => `• ${action}`));
    },
  });

  pi.registerCommand("pm-workflows", {
    description: "Show native pm workflow shortcuts and bundled Pi resources",
    handler: async (_args, ctx) => {
      await showPanel(ctx, "workflows", [
        "1. /pm-board to inspect focus/context items.",
        "2. Use the pm tool action=search/list-open/list-in-progress before creating work.",
        "3. /pm-start <id> or pm action=start-task to claim and move in_progress.",
        "4. Use pm action=files/docs/test to link implementation evidence.",
        "5. Run pm action=test/validate and close with pm action=close-task.",
        "Bundled resources: pm-native and pm-release skills, pm-workflow prompt, pm subagent templates in .pi/agents.",
      ]);
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

function installPmAutocomplete(ctx) {
  if (typeof ctx.ui?.addAutocompleteProvider !== "function") return;
  ctx.ui.addAutocompleteProvider((current) => ({
    async getSuggestions(lines, line, col, options) {
      const beforeCursor = (lines[line] ?? "").slice(0, col);
      const match = beforeCursor.match(/(?:^|[\s(])@(pm-[a-z0-9-]*)$/i);
      if (!match) return current.getSuggestions(lines, line, col, options);
      try {
        const result = await runNativePmAction({ cwd: ctx.cwd, action: "list-open", limit: 20, json: true });
        const items = Array.isArray(result?.items) ? result.items : [];
        return {
          prefix: `@${match[1] ?? ""}`,
          items: items.map((item) => ({ value: `@${item.id}`, label: item.id, description: item.title ?? item.status ?? "pm item" })),
        };
      } catch {
        return current.getSuggestions(lines, line, col, options);
      }
    },
    applyCompletion(lines, line, col, item, prefix) {
      return current.applyCompletion(lines, line, col, item, prefix);
    },
    shouldTriggerFileCompletion(lines, line, col) {
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
    },
  }));
}

export default function pmCliPiExtension(pi) {
  pi.registerTool(createPmToolDefinition());
  pi.on("before_provider_request", (event) => patchPmToolParametersInProviderPayload(event.payload));
  registerPmCommands(pi);
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus?.("pm", ctx.ui.theme?.fg ? ctx.ui.theme.fg("accent", "pm native") : "pm native");
    ctx.ui.setWidget?.("pm-native", ["pm native ready • /pm-board • /pm-actions • @pm-id autocomplete"], { placement: "belowEditor" });
    installPmAutocomplete(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus?.("pm", undefined);
    ctx.ui.setWidget?.("pm-native", undefined);
  });
}
