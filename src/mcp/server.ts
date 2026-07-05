#!/usr/bin/env node
/**
 * @module mcp/server
 *
 * Runs the MCP server adapter that exposes pm actions and contracts to external agents.
 */
import { realpathSync } from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { resolvePmCliVersion } from "../core/packages/root.js";
import { PmCliError } from "../core/shared/errors.js";
import { decodeHtmlEntitiesInOptions } from "../core/shared/html-entity-decode.js";
import { levenshteinDistanceWithinLimit } from "../core/shared/levenshtein.js";
import { asRecordClone } from "../core/shared/primitives.js";
import { createSerialQueue } from "../core/shared/serial-queue.js";
import { readRequiredString, runAction, type PmActionInput } from "../sdk/runtime.js";
import { TOOLS } from "./tool-definitions.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

if (typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" || process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
}

// Reflect the real package.json version so agents/telemetry can identify the
// build serving requests (was hard-coded "1.0.0"; see pm-2nvw).
const PM_MCP_SERVER_VERSION = resolvePmCliVersion(import.meta.url, ["../.."]) ?? "0.0.0";

// Tool definitions (TOOLS) live in ./tool-definitions.ts so the `pm contracts`
// golden-file snapshot can import the surface without loading the server
// runtime (pm-4os2). This file owns dispatch, normalization, and transport.

// pm-qxwu: TOOL_SCHEMA_BASE keeps additionalProperties:true so legitimate
// passthrough keeps working, which means a typo'd top-level arg (e.g.
// "fullChangedField" missing the trailing "s") is silently swallowed and the
// agent gets default behavior with no signal. We precompute the declared
// top-level property keys for each tool and, on every tools/call, warn (without
// rejecting) when an unexpected top-level key appears. The warning is surfaced
// to stderr and additively in structuredContent.warnings.
const TOOL_DECLARED_KEYS: Map<string, string[]> = new Map(
  TOOLS.map((tool) => {
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    const properties = schema.properties ?? {};
    return [tool.name, Object.keys(properties)] as const;
  }),
);

function nearestDeclaredKey(unexpected: string, declared: string[]): string | undefined {
  // Cheap did-you-mean: budget grows with key length but stays small so we only
  // suggest genuine near-misses (a single typo / transposition for short keys).
  const limit = Math.max(1, Math.min(3, Math.floor(unexpected.length / 4) + 1));
  let best: { key: string; distance: number } | undefined;
  for (const candidate of declared) {
    const distance = levenshteinDistanceWithinLimit(unexpected, candidate, limit);
    if (distance === null) {
      continue;
    }
    if (best === undefined || distance < best.distance) {
      best = { key: candidate, distance };
    }
  }
  return best?.key;
}

// pm_run is the explicit catch-all passthrough tool: extension/package actions
// accept arbitrary top-level keys (see extensionOptionsFromArgs), so unexpected
// keys there are by-design rather than typos and must not be flagged.
const UNEXPECTED_KEY_WARNING_EXEMPT_TOOLS = new Set(["pm_run"]);

function detectUnexpectedTopLevelKeys(toolName: string, args: Record<string, unknown>): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [];
  }
  if (UNEXPECTED_KEY_WARNING_EXEMPT_TOOLS.has(toolName)) {
    return [];
  }
  const declared = TOOL_DECLARED_KEYS.get(toolName);
  if (declared === undefined) {
    return [];
  }
  const declaredSet = new Set(declared);
  const warnings: string[] = [];
  for (const key of Object.keys(args)) {
    if (declaredSet.has(key)) {
      continue;
    }
    const suggestion = nearestDeclaredKey(key, declared);
    warnings.push(
      suggestion !== undefined
        ? `Unexpected top-level argument "${key}" for ${toolName} (did you mean "${suggestion}"?). It was passed through unchanged; declared arguments are: ${declared.join(", ")}.`
        : `Unexpected top-level argument "${key}" for ${toolName}. It was passed through unchanged; declared arguments are: ${declared.join(", ")}.`,
    );
  }
  return warnings;
}


const HANDLERS: Record<string, ToolHandler> = {
  pm_run: (args) => runAction(args as PmActionInput),
  pm_context: (args) => runAction({ ...args, action: "context" }),
  pm_next: (args) => runAction({ ...args, action: "next" }),
  pm_search: (args) => runAction({ ...args, action: "search" }),
  pm_list: (args) => runAction({ ...args, action: "list" }),
  pm_get: (args) => runAction({ ...args, action: "get" }),
  pm_create: (args) => runAction({ ...args, action: "create" }),
  pm_copy: (args) => runAction({ ...args, action: "copy" }),
  pm_focus: (args) => runAction({ ...args, action: "focus" }),
  pm_update: (args) => runAction({ ...args, action: "update" }),
  pm_append: (args) => runAction({ ...args, action: "append" }),
  pm_claim: (args) => runAction({ ...args, action: "claim" }),
  pm_release: (args) => runAction({ ...args, action: "release" }),
  pm_close: (args) => runAction({ ...args, action: "close" }),
  pm_comments: (args) => runAction({ ...args, action: "comments" }),
  pm_files: (args) => runAction({ ...args, action: "files" }),
  pm_docs: (args) => runAction({ ...args, action: "docs" }),
  pm_notes: (args) => runAction({ ...args, action: "notes" }),
  pm_learnings: (args) => runAction({ ...args, action: "learnings" }),
  pm_deps: (args) => runAction({ ...args, action: "deps" }),
  pm_test: (args) => runAction({ ...args, action: "test" }),
  pm_validate: (args) => runAction({ ...args, action: "validate" }),
  pm_health: (args) => runAction({ ...args, action: "health" }),
  pm_contracts: (args) => runAction({ ...args, action: "contracts" }),
  pm_schema: (args) => runAction({ ...args, action: "schema" }),
  pm_profile: (args) => runAction({ ...args, action: "profile" }),
  pm_config: (args) => runAction({ ...args, action: "config" }),
  pm_plan: (args) => runAction({ ...args, action: "plan" }),
};

function resultContent(result: unknown, warnings?: string[]): Record<string, unknown> {
  // pm-qxwu: warnings is additive — existing fields (content, structuredContent.result)
  // are never removed or renamed. The warnings array only appears when non-empty.
  const structuredContent: Record<string, unknown> =
    warnings !== undefined && warnings.length > 0 ? { result, warnings } : { result };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent,
  };
}

function errorContent(error: unknown): Record<string, unknown> {
  const code = error instanceof PmCliError ? error.exitCode : 1;
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, code }, null, 2),
      },
    ],
    // Keep `result` present on the error envelope so consumers can read
    // `structuredContent.result` uniformly across success and failure (pm-l40h).
    structuredContent: { result: null, error: message, code },
  };
}

/**
 * Implements handle request for the public runtime surface of this module.
 */
export async function handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
  if (!request.id && request.method?.startsWith("notifications/")) {
    return undefined;
  }
  if (request.method === "ping") {
    return {};
  }
  if (request.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pm-mcp", version: PM_MCP_SERVER_VERSION },
      instructions:
        "You have access to native pm CLI tools for git-based project management. " +
        "Use pm_next to pick the next actionable item, or pm_context or pm_search before creating new work. " +
        "Prefer narrow tools (pm_next, pm_context, pm_list, pm_get, pm_search, pm_create, pm_copy, pm_focus, pm_update, pm_append, pm_claim, pm_release, pm_close, pm_comments, pm_files, pm_docs, pm_notes, pm_learnings, pm_deps, pm_test, pm_validate, pm_health, pm_contracts, pm_schema, pm_profile, pm_config, pm_plan) over pm_run when they cover the operation. " +
        "Use pm_plan for agent harness Plan workflows: it provides Codex/Claude/Cursor-style planning with durable steps, dependencies, decisions, discoveries, validation, and materialization. " +
        "Use pm_schema and pm_config for workspace configuration: pm_schema manages custom item types/statuses and pm_config reads or writes settings keys. " +
        "Use pm_run with an explicit action for package-owned operations (calendar/templates/guide/dedupe-audit/normalize/reindex/comments-audit/completion/test-runs-list/test-runs-status/test-runs-logs/test-runs-stop/test-runs-resume), plus activity, aggregate, history, stats, test-all, and gc. " +
        "Use history-redact for audited history-stream redaction workflows, history-repair to re-anchor a drifted history chain, and history-compact to checkpoint/prune long history streams while preserving replay integrity. " +
        "Set author to 'claude-code-agent' on all mutations. " +
        "Do not pass path during real repository tracking — only pass path for sandbox or test runs.",
    };
  }
  if (request.method === "tools/list") {
    return { tools: TOOLS };
  }
  if (request.method === "tools/call") {
    const params = asRecordClone(request.params);
    const name = readRequiredString(params, "name");
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : undefined;
    if (!handler) {
      throw new PmCliError(`Unknown pm MCP tool: ${name}`, 64);
    }
    // pm-ydkl: defensive HTML-entity decode for free-text fields. Claude / the
    // Anthropic MCP SDK HTML-encodes `<` / `>` (and friends) in tool arguments
    // before they reach pm-cli, which would otherwise leak `&lt;type&gt;` into
    // stored pm comments / notes / item bodies. Direct CLI calls are not
    // affected; decoding at the MCP boundary normalizes the agent path while
    // leaving normal text untouched.
    const args = decodeHtmlEntitiesInOptions(asRecordClone(params.arguments));
    // pm-qxwu: non-breaking detection of typo'd / unexpected top-level keys.
    // additionalProperties stays true so passthrough still works; we only warn.
    const warnings = detectUnexpectedTopLevelKeys(name, args);
    for (const warning of warnings) {
      console.error(`[pm-mcp] ${warning}`);
    }
    // cwd is applied inside the serialized activation cycle (see withActiveExtensions),
    // so the chdir/restore is exclusive per request and cannot race a concurrent caller.
    const result = await handler(args);
    return resultContent(result, warnings);
  }
  throw new PmCliError(`Unsupported MCP method: ${request.method ?? "(missing)"}`, 64);
}

function writeResponse(id: JsonRpcRequest["id"], payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: payload })}\n`);
}

function writeError(id: JsonRpcRequest["id"], error: unknown): void {
  const code = error instanceof PmCliError ? error.exitCode : -32603;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

// pm-3puw: parse one JSON-RPC line, dispatch it, and write the response. Kept
// as a standalone async unit so the stdio loop can enqueue it onto a serial
// queue (process lines in arrival order) and tests can drive it directly.
/**
 * Implements process rpc line for the public runtime surface of this module.
 */
export async function processRpcLine(line: string): Promise<void> {
  if (line.trim().length === 0) {
    return;
  }
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(null, new PmCliError(`Parse error: ${message}`, -32700));
    return;
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    writeError(null, new PmCliError("Invalid JSON-RPC request: expected an object", -32600));
    return;
  }
  const shouldRespond = Object.prototype.hasOwnProperty.call(request, "id");
  try {
    const result = await handleRequest(request);
    if (shouldRespond && result !== undefined) {
      writeResponse(request.id, result);
    }
  } catch (error) {
    if (!shouldRespond) {
      return;
    }
    if (request.method === "tools/call") {
      writeResponse(request.id, errorContent(error));
    } else {
      writeError(request.id, error);
    }
  }
}

/**
 * Implements start mcp server for the public runtime surface of this module.
 */
export function startMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // pm-3puw: serialize line handling so pipelined requests are processed in
  // arrival order. The previous fire-and-forget handler ran requests
  // concurrently, so a client that pipelined two mutations on the same item
  // (without awaiting the first response) hit a lock conflict on the second.
  const queue = createSerialQueue();
  rl.on("line", (line) => {
    void queue.enqueue(() => processRpcLine(line));
  });
}

// npm bin entries are symlinks (node_modules/.bin/pm-mcp -> dist/mcp/server.js),
// so argv[1] must be realpath-resolved before comparing against this module's
// path — a plain equality check made the published `pm-mcp` bin exit 0 without
// ever starting the server (pm-qtbc).
/**
 * Implements check whether invoked as mcp main module for the public runtime surface of this module.
 */
export function isInvokedAsMcpMainModule(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) {
    return false;
  }
  const selfPath = fileURLToPath(moduleUrl);
  if (argvPath === selfPath) {
    return true;
  }
  try {
    return realpathSync(argvPath) === realpathSync(selfPath);
  } catch {
    return false;
  }
}

type RuntimeTestHooks = NonNullable<typeof globalThis.__pmCliActionRunnerTestHooks>;
type RuntimeTestHookKey = keyof RuntimeTestHooks;

function readRuntimeTestHook<Key extends RuntimeTestHookKey>(key: Key): RuntimeTestHooks[Key] {
  const runtimeTestHooks = globalThis.__pmCliActionRunnerTestHooks;
  if (runtimeTestHooks === undefined) {
    throw new PmCliError(`MCP runtime test hook "${String(key)}" is only available in test environments.`, 64);
  }
  return runtimeTestHooks[key];
}

export const _testOnly = {
  get closeManyOptionsFromFlat() {
    return readRuntimeTestHook("closeManyOptionsFromFlat");
  },
  detectUnexpectedTopLevelKeys,
  errorContent,
  get extensionOptionsFromArgs() {
    return readRuntimeTestHook("extensionOptionsFromArgs");
  },
  get globalOptions() {
    return readRuntimeTestHook("globalOptions");
  },
  get mutationListOptions() {
    return readRuntimeTestHook("mutationListOptions");
  },
  nearestDeclaredKey,
  get normalizeActionName() {
    return readRuntimeTestHook("normalizeActionName");
  },
  get normalizeCommandPath() {
    return readRuntimeTestHook("normalizeCommandPath");
  },
  get normalizeMcpOptionsArrays() {
    return readRuntimeTestHook("normalizeMcpOptionsArrays");
  },
  get normalizeMcpUpdateOptions() {
    return readRuntimeTestHook("normalizeMcpUpdateOptions");
  },
  get optionsWithAuthor() {
    return readRuntimeTestHook("optionsWithAuthor");
  },
  get readRequiredString() {
    return readRuntimeTestHook("readRequiredString");
  },
  get readScalarString() {
    return readRuntimeTestHook("readScalarString");
  },
  get readScalarStringAllowBlank() {
    return readRuntimeTestHook("readScalarStringAllowBlank");
  },
  get readStringArray() {
    return readRuntimeTestHook("readStringArray");
  },
  runAction,
  get updateManyOptionsFromFlat() {
    return readRuntimeTestHook("updateManyOptionsFromFlat");
  },
  get withAddNoteOption() {
    return readRuntimeTestHook("withAddNoteOption");
  },
  get withFilesDiscoveryOptions() {
    return readRuntimeTestHook("withFilesDiscoveryOptions");
  },
  get withMutationCompaction() {
    return readRuntimeTestHook("withMutationCompaction");
  },
  writeError,
};

/* c8 ignore start */
if (isInvokedAsMcpMainModule(process.argv[1], import.meta.url)) {
  startMcpServer();
}
/* c8 ignore stop */
