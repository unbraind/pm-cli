#!/usr/bin/env node
/**
 * @module mcp/server
 *
 * Runs the MCP server adapter that exposes pm actions and contracts to external agents.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  resolvePmCliVersion,
  PmCliError,
  decodeHtmlEntitiesInOptions,
  levenshteinDistanceWithinLimit,
  asRecordClone,
  createSerialQueue,
  evaluateMutationGuard,
  getSettingsPath,
  isMutationAction,
  pathExists,
  readSettings,
  runWithHarnessDetectionSignals,
  runWithWorkspaceHarnessSignalDescriptors,
  type AgentClientInfo,
  boundAgentEpisodeIdentity,
} from "../sdk/runtime-primitives.js";
import { pmToolActionNestedOptionKeys } from "../sdk/cli-contracts/tool-schema.js";
import {
  readRequiredString,
  runAction,
  runWithActiveExtensions,
  type PmActionInput,
} from "../sdk/runtime.js";
import { NARROW_TOOL_ACTIONS, TOOLS } from "./tool-definitions.js";
import {
  normalizeWorkspaceToolArguments,
  resolveMcpToolAccess,
  resolveMcpToolSurface,
} from "./runtime-capabilities.js";
import {
  PM_MCP_PROMPT_CONTRACTS,
  PM_MCP_RESOURCE_CONTRACTS,
} from "../sdk/agent-capability-contracts.js";
import {
  PM_MCP_ENTRY_TOOL_NAMES,
  PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION,
  PM_MCP_PROGRESSIVE_DISCOVERY_SERVER_CAPABILITY,
  discoverPmTools,
  type PmToolDiscoveryOptions,
} from "../sdk/mcp/discovery.js";
import { commitItemMutations } from "../sdk/item-transaction.js";
import {
  isRuntimeRecord,
  markMcpMutationTransportInput,
} from "../sdk/runtime-input.js";
import { attachOutputTokenAccounting } from "../sdk/output-token-accounting.js";
import {
  createReproducibleProcessRunner,
  runWithReproducibleProcessEnvironment,
} from "../sdk/reproducibility/process.js";
import {
  parseAtomicMutationControls,
  resolveItemMutationDocument,
} from "../sdk/structured-mutations.js";
import {
  resolveAuthor,
  resolvePmRoot,
  resolveWorkspaceRoot,
} from "../sdk/runtime-primitives.js";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpProtocolError,
  attachMcpServerInfo,
  buildMcpCompleteResult,
  buildMcpDiscoverResult,
  hasMcpClientExtension,
  isMcpRecord,
  resolveMcpRequestContext,
  type PmMcpImplementation,
  type PmMcpRequestContext,
  type PmMcpServerCapabilities,
} from "../sdk/mcp/protocol.js";
import {
  PmMcpInputRequiredError,
  buildMcpInputRequiredResult,
  parseMcpInputResponses,
  validateMcpJsonSchema,
  withMcpCachePolicy,
  type PmMcpCachePolicy,
  type PmMcpInputResponses,
} from "../sdk/mcp/interactions.js";
import {
  PM_MCP_TASKS_EXTENSION,
  PmMcpTaskStore,
  createMcpTaskStore,
} from "../sdk/mcp/tasks.js";
import {
  PmMcpSubscriptionRegistry,
  type PmMcpSubscriptionId,
  type PmMcpSubscriptionSink,
} from "../sdk/mcp/subscriptions.js";
import {
  extractMcpTraceContext,
  runWithMcpTraceContext,
} from "../sdk/mcp/authorization.js";
import { LegacyMcpAdapter } from "./legacy-adapter.js";
import {
  PM_MCP_APP_CONTRACTS,
  PM_MCP_APP_MIME_TYPE,
  PM_MCP_APPS_EXTENSION,
  PM_MCP_APPS_SERVER_CAPABILITY,
  decoratePmMcpToolsWithApps,
  findPmMcpAppByUri,
  hasPmMcpAppsCapability,
  renderPmMcpAppHtml,
} from "../sdk/mcp/apps.js";
import {
  PM_MCP_SKILLS_EXTENSION,
  PM_MCP_SKILLS_SERVER_CAPABILITY,
  PmMcpSkillRegistry,
  assertPmMcpSkillsCapability,
  type ListPmMcpSkillsOptions,
} from "../sdk/mcp/skills.js";

/** JSON-RPC request shape accepted by pm MCP transport adapters. */
export interface JsonRpcRequest {
  /** JSON-RPC revision marker when supplied by the transport. */
  jsonrpc?: string;
  /** Correlation identifier omitted only for notifications. */
  id?: string | number | null;
  /** Protocol operation selected by the caller. */
  method?: string;
  /** Operation inputs including request-local MCP metadata. */
  params?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function runMcpAction(args: PmActionInput): Promise<unknown> {
  return runAction(markMcpMutationTransportInput(args));
}

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

function resolvePmPackageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

if (
  typeof process.env[PM_PACKAGE_ROOT_ENV] !== "string" ||
  process.env[PM_PACKAGE_ROOT_ENV]?.trim().length === 0
) {
  process.env[PM_PACKAGE_ROOT_ENV] = resolvePmPackageRoot();
}

// Reflect the real package.json version so agents/telemetry can identify the
// build serving requests (was hard-coded "1.0.0"; see pm-2nvw).
const PM_MCP_SERVER_VERSION =
  resolvePmCliVersion(import.meta.url, ["../.."]) ?? "0.0.0";
const PM_MCP_SERVER_INFO: PmMcpImplementation = {
  name: "pm-mcp",
  version: PM_MCP_SERVER_VERSION,
  description: "Stateless project-context management through pm SDK contracts.",
  websiteUrl: "https://github.com/unbraind/pm-cli",
};
const PM_MCP_SERVER_CAPABILITIES: PmMcpServerCapabilities = {
  prompts: { listChanged: true },
  resources: { listChanged: true, subscribe: true },
  tools: { listChanged: true },
  extensions: {
    [PM_MCP_TASKS_EXTENSION]: {},
    [PM_MCP_APPS_EXTENSION]: PM_MCP_APPS_SERVER_CAPABILITY,
    [PM_MCP_SKILLS_EXTENSION]: PM_MCP_SKILLS_SERVER_CAPABILITY,
    [PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION]:
      PM_MCP_PROGRESSIVE_DISCOVERY_SERVER_CAPABILITY,
  },
};
type PmMcpTransportSubscriptionKey = PmMcpSubscriptionId | symbol;
interface PmMcpTransportSubscription {
  id: PmMcpSubscriptionId;
  registry: PmMcpSubscriptionRegistry;
}
const PM_MCP_SUBSCRIPTIONS = new Map<
  PmMcpTransportSubscriptionKey,
  PmMcpTransportSubscription
>();

function createMcpSubscriptionRegistry(): PmMcpSubscriptionRegistry {
  return new PmMcpSubscriptionRegistry({
    capabilities: PM_MCP_SERVER_CAPABILITIES,
    serverInfo: PM_MCP_SERVER_INFO,
  });
}

function pruneClosedMcpSubscriptionRegistries(): void {
  for (const [key, subscription] of PM_MCP_SUBSCRIPTIONS) {
    if (subscription.registry.size === 0) PM_MCP_SUBSCRIPTIONS.delete(key);
  }
}
const PM_MCP_CACHE_POLICIES = {
  prompts: { ttlMs: 60_000, cacheScope: "public" },
  resource: { ttlMs: 0, cacheScope: "private" },
  resources: { ttlMs: 60_000, cacheScope: "public" },
  tools: { ttlMs: 30_000, cacheScope: "private" },
} as const satisfies Record<string, PmMcpCachePolicy>;
const PM_MCP_DIRECT_TASK_TOOLS = new Set([
  "pm_graph",
  "pm_health",
  "pm_validate",
]);
const PM_MCP_RUN_TASK_ACTIONS = new Set([
  "graph",
  "health",
  "import",
  "reindex",
  "test-all",
  "validate",
]);
const PM_MCP_SKILL_METHODS = new Set([
  "skills/list",
  "skills/get",
  "resources/directory/read",
]);
const PM_MCP_INSTRUCTIONS =
  "You have access to native pm CLI tools for git-based project management. " +
  "When progressive discovery is negotiated, use pm_discover to expand the small entry catalog by intent and request schemas only when needed. " +
  "Use pm_next to pick the next actionable item, or pm_context or pm_search before creating new work. " +
  "Prefer narrow tools (pm_next, pm_context, pm_list, pm_get, pm_search, pm_events, pm_create, pm_mutate, pm_copy, pm_focus, pm_update, pm_append, pm_claim, pm_release, pm_close, pm_comments, pm_files, pm_docs, pm_notes, pm_learnings, pm_deps, pm_graph, pm_test, pm_validate, pm_health, pm_contracts, pm_schema, pm_profile, pm_config, pm_plan) over pm_run when they cover the operation. " +
  "Use pm_plan for agent harness Plan workflows: it provides Codex/Claude/Cursor-style planning with durable steps, dependencies, decisions, discoveries, validation, and materialization. " +
  "Use pm_schema and pm_config for workspace configuration: pm_schema manages custom item types/statuses and pm_config reads or writes settings keys. " +
  "Use pm_run with an explicit action for active package-owned operations, plus activity, aggregate, history, stats, test-all, and gc. " +
  "Use history-redact for audited history-stream redaction workflows, history-repair to re-anchor a drifted history chain, and history-compact to checkpoint/prune long history streams while preserving replay integrity. " +
  "Agent harness and model provenance are detected automatically; pass author only for an intentional identity override. " +
  "Do not pass path during real repository tracking — only pass path for sandbox or test runs.";

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
function declaredToolKeys(tools = TOOLS): Map<string, string[]> {
  return new Map(
    tools.map((tool) => {
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
      };
      const properties = schema.properties ?? {};
      return [tool.name, Object.keys(properties)] as const;
    }),
  );
}

function nearestDeclaredKey(
  unexpected: string,
  declared: string[],
): string | undefined {
  // Cheap did-you-mean: budget grows with key length but stays small so we only
  // suggest genuine near-misses (a single typo / transposition for short keys).
  const limit = Math.max(1, Math.min(3, Math.floor(unexpected.length / 4) + 1));
  let best: { key: string; distance: number } | undefined;
  for (const candidate of declared) {
    const distance = levenshteinDistanceWithinLimit(
      unexpected,
      candidate,
      limit,
    );
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
const MCP_RETRY_ARGUMENT_KEYS = new Set(["inputResponses", "requestState"]);

function detectUnexpectedTopLevelKeys(
  toolName: string,
  args: Record<string, unknown>,
  toolDeclaredKeys = declaredToolKeys(),
): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [];
  }
  if (UNEXPECTED_KEY_WARNING_EXEMPT_TOOLS.has(toolName)) {
    return [];
  }
  const declared = toolDeclaredKeys.get(toolName);
  if (declared === undefined) {
    return [];
  }
  const declaredSet = new Set([...declared, ...MCP_RETRY_ARGUMENT_KEYS]);
  const warnings: string[] = [];
  for (const key of Object.keys(args)) {
    if (declaredSet.has(key)) {
      continue;
    }
    const suggestion = nearestDeclaredKey(key, declared);
    warnings.push(
      suggestion !== undefined
        ? `Unexpected top-level argument "${key}" for ${toolName} (did you mean "${suggestion}"?). It is not declared and may be ignored; declared arguments are: ${declared.join(", ")}.`
        : `Unexpected top-level argument "${key}" for ${toolName}. It is not declared and may be ignored; declared arguments are: ${declared.join(", ")}.`,
    );
  }
  return warnings;
}

const HANDLERS: Record<string, ToolHandler> = {
  pm_run: (args) => runMcpAction(args as PmActionInput),
  pm_discover: async (args) => {
    const surface = await resolveMcpToolSurface(TOOLS, args);
    return discoverPmTools(
      surface.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        authorized: true,
        signals: {
          freshness: 1,
          usage: PM_MCP_ENTRY_TOOL_NAMES.includes(tool.name) ? 1 : 0,
        },
      })),
      {
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.family === "string"
          ? {
              family: args.family as PmToolDiscoveryOptions["family"],
            }
          : {}),
        ...(typeof args.tier === "string"
          ? { tier: args.tier as PmToolDiscoveryOptions["tier"] }
          : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        includeSchema: args.includeSchema === true,
        ...(typeof args.outputBudget === "number" ||
        args.outputBudget === "unbounded"
          ? { outputBudget: args.outputBudget }
          : {}),
        profile: surface.profile,
      },
    );
  },
  pm_mutate: async (args) => {
    const transactionId = readRequiredString(args, "transactionId");
    const controls = parseAtomicMutationControls(args);
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    const pmRoot = resolvePmRoot(
      cwd,
      typeof args.path === "string" ? args.path : undefined,
    );
    const resolved = resolveItemMutationDocument(
      JSON.stringify({ schema_version: 1, mutations: args.mutations }),
      {
        transactionId,
        idPrefix: (await readSettings(pmRoot)).id_prefix,
      },
    );
    const { mutations, references } = resolved;
    if (args.dryRun === true) {
      return {
        transaction_id: transactionId,
        dry_run: true,
        mutation_count: mutations.length,
        mutations,
        references,
      };
    }
    const result = await runWithActiveExtensions(
      {
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        path: typeof args.path === "string" ? args.path : undefined,
        noExtensions: args.noExtensions === true,
      },
      () =>
        commitItemMutations({
          pmRoot,
          transactionId,
          author: resolveAuthor(
            typeof args.author === "string" ? args.author : undefined,
            "unknown",
          ),
          mutations,
          ...controls,
        }),
    );
    const { transactionId: committedTransactionId, ...commitResult } = result;
    return {
      ...commitResult,
      transaction_id: committedTransactionId,
      mutation_count: mutations.length,
      references,
    };
  },
  ...Object.fromEntries(
    Object.entries(NARROW_TOOL_ACTIONS).map(([tool, action]) => [
      tool,
      (args: Record<string, unknown>) => runMcpAction({ ...args, action }),
    ]),
  ),
};

/** Resolve the pm action a tools/call invocation will dispatch, when knowable. */
function resolveInvokedAction(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === "pm_run") {
    return typeof args.action === "string" ? args.action : undefined;
  }
  return NARROW_TOOL_ACTIONS[toolName];
}

async function collectMutationGuardWarnings(
  toolName: string,
  action: string | undefined,
  args: Record<string, unknown>,
): Promise<string[]> {
  if (toolName !== "pm_mutate" && !isMutationAction(action ?? "")) {
    return [];
  }
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const pmRoot = resolvePmRoot(
    cwd,
    typeof args.path === "string" ? args.path : undefined,
  );
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return [];
  }
  const settings = await readSettings(pmRoot);
  const nestedOptions =
    typeof args.options === "object" &&
    args.options !== null &&
    !Array.isArray(args.options)
      ? (args.options as Record<string, unknown>)
      : {};
  const result = evaluateMutationGuard({
    author: resolveAuthor(
      typeof args.author === "string"
        ? args.author
        : typeof nestedOptions.author === "string"
          ? nestedOptions.author
          : undefined,
      settings.author_default,
    ),
    payload: args,
    settings: settings.mutation_guard,
    force: args.force === true || nestedOptions.force === true,
  });
  return result.warnings;
}

// pm-upi0: the pm-qxwu top-level detection cannot see inside the `options`
// object, so a mutation-shaped key on a read tool (pm_deps options.dep) is
// silently dropped before dispatch and the agent builds on state it never
// created. Warn (without rejecting) on every options key absent from the
// invoked action's contract; extension- and package-owned actions have no
// contract table and keep arbitrary passthrough options.
function detectUnexpectedOptionKeys(
  toolName: string,
  action: string | undefined,
  args: Record<string, unknown>,
): string[] {
  const options = args.options;
  if (
    action === undefined ||
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    return [];
  }
  const declared = pmToolActionNestedOptionKeys(action);
  if (declared === undefined) {
    return [];
  }
  const declaredSet = new Set(declared);
  const warnings: string[] = [];
  for (const key of Object.keys(options)) {
    if (declaredSet.has(key)) {
      continue;
    }
    const suggestion = nearestDeclaredKey(key, declared);
    warnings.push(
      suggestion !== undefined
        ? `Unknown option "${key}" for ${toolName} action "${action}" (did you mean "${suggestion}"?). The ${action} contract does not read it, so it has no effect; declared keys are: ${declared.join(", ")}.`
        : `Unknown option "${key}" for ${toolName} action "${action}". The ${action} contract does not read it, so it has no effect; declared keys are: ${declared.join(", ")}.`,
    );
  }
  return warnings;
}

function resultContent(
  result: unknown,
  warnings?: string[],
  tokenAccounting = false,
  canonicalStructuredResult = false,
): Record<string, unknown> {
  const effectiveResult = tokenAccounting
    ? attachOutputTokenAccounting(result, (value) =>
        JSON.stringify(value, null, 2),
      )
    : result;
  // pm-qxwu: warnings is additive — existing fields (content, structuredContent.result)
  // are never removed or renamed. The warnings array only appears when non-empty.
  const structuredContent: Record<string, unknown> =
    warnings !== undefined && warnings.length > 0
      ? { result: effectiveResult, warnings }
      : { result: effectiveResult };
  return {
    content: [
      {
        type: "text",
        text: canonicalStructuredResult
          ? "Canonical result: structuredContent.result"
          : JSON.stringify(effectiveResult, null, 2),
      },
    ],
    structuredContent,
  };
}

function errorContent(
  error: unknown,
  canonicalStructuredResult = false,
): Record<string, unknown> {
  const code = error instanceof PmCliError ? error.exitCode : 1;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof PmCliError ? error.context : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: canonicalStructuredResult
          ? "Canonical error: structuredContent"
          : JSON.stringify({ error: message, code, details }, null, 2),
      },
    ],
    // Keep `result` present on the error envelope so consumers can read
    // `structuredContent.result` uniformly across success and failure (pm-l40h).
    structuredContent: { result: null, error: message, code, details },
  };
}

/** Retain at most 32 own, valid provenance values without cloning unbounded input. */
function boundMcpClientProvenance(value: unknown): Record<string, string> {
  const provenance = isRuntimeRecord(value) ? value : {};
  const bounded: Record<string, string> = {};
  let acceptedCount = 0;
  for (const key in provenance) {
    if (acceptedCount >= 32) break;
    if (!Object.prototype.hasOwnProperty.call(provenance, key)) continue;
    const entry = provenance[key];
    if (
      /^[a-z][a-z0-9_-]{0,63}$/u.test(key) &&
      typeof entry === "string" &&
      entry.trim().length > 0
    ) {
      bounded[key] = entry.trim().slice(0, 256);
      acceptedCount += 1;
    }
  }
  return bounded;
}

function readMcpClientInfo(value: unknown): AgentClientInfo | undefined {
  const clientInfo = isRuntimeRecord(value) ? value : {};
  const clientName =
    typeof clientInfo.name === "string" ? clientInfo.name.trim() : "";
  if (clientName.length === 0) return undefined;
  const optionalValues = [
    ["version", clientInfo.version, 128],
    ["model", clientInfo.model, 256],
    ["session", clientInfo.session, 256],
  ] as const;
  const result: AgentClientInfo = { name: clientName.slice(0, 128) };
  for (const [key, value, limit] of optionalValues) {
    if (typeof value === "string" && value.trim().length > 0) {
      result[key] = value.trim().slice(0, limit);
    }
  }
  const boundedProvenance = boundMcpClientProvenance(clientInfo.provenance);
  if (Object.keys(boundedProvenance).length > 0) {
    result.provenance = boundedProvenance;
  }
  const episode = boundAgentEpisodeIdentity(clientInfo.episode, false);
  if (episode !== undefined) result.episode = episode;
  return result;
}

async function emitMcpChangeNotifications(
  action: string | undefined,
): Promise<void> {
  if (isMutationAction(action ?? "")) {
    await Promise.all(
      [...PM_MCP_SUBSCRIPTIONS.values()].flatMap(({ registry }) =>
        PM_MCP_RESOURCE_CONTRACTS.map((resource) =>
          registry.emitResourceUpdated(resource.uri),
        ),
      ),
    );
  }
  if (["extension", "install", "package", "uninstall"].includes(action ?? "")) {
    await Promise.all(
      [...PM_MCP_SUBSCRIPTIONS.values()].map(({ registry }) =>
        registry.emitListChanged("tools"),
      ),
    );
  }
  pruneClosedMcpSubscriptionRegistries();
}

async function handleToolCall(
  paramsInput: Record<string, unknown> | undefined,
  clientInfo: AgentClientInfo | undefined,
  canonicalStructuredResult = false,
): Promise<Record<string, unknown>> {
  return runWithHarnessDetectionSignals(
    {
      env: process.env,
      argv: process.argv,
      ...(clientInfo ? { client_info: clientInfo } : {}),
    },
    async () => {
      const params = asRecordClone(paramsInput);
      const name = readRequiredString(params, "name");
      const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name)
        ? HANDLERS[name]
        : undefined;
      if (!handler) {
        throw new PmCliError(`Unknown pm MCP tool: ${name}`, 64);
      }
      const inputResponses =
        params.inputResponses === undefined
          ? undefined
          : parseMcpInputResponses(params.inputResponses);
      const requestedArgs = {
        ...decodeHtmlEntitiesInOptions(asRecordClone(params.arguments)),
        ...(inputResponses ? { inputResponses } : {}),
        ...(typeof params.requestState === "string"
          ? { requestState: params.requestState }
          : {}),
      };
      const access = await resolveMcpToolAccess(TOOLS, name, requestedArgs);
      if (!access.available) {
        throw new PmCliError(
          `pm MCP tool "${name}" is unavailable in the ${access.profile} profile.`,
          64,
        );
      }
      // pm-ydkl: defensive HTML-entity decode for free-text fields. Claude / the
      // Anthropic MCP SDK HTML-encodes `<` / `>` (and friends) in tool arguments
      // before they reach pm-cli, which would otherwise leak `&lt;type&gt;` into
      // stored pm comments / notes / item bodies. Direct CLI calls are not
      // affected; decoding at the MCP boundary normalizes the agent path while
      // leaving normal text untouched.
      const args = await normalizeWorkspaceToolArguments(name, requestedArgs);
      const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
      const pmRoot = resolvePmRoot(
        cwd,
        typeof args.path === "string" ? args.path : undefined,
      );
      const workspaceIdentity = (await pathExists(getSettingsPath(pmRoot)))
        ? (await readSettings(pmRoot)).agent_identity
        : undefined;
      return runWithWorkspaceHarnessSignalDescriptors(
        workspaceIdentity?.harness_signals ?? [],
        async () => {
          // pm-qxwu: non-breaking detection of typo'd / unexpected top-level keys.
          // additionalProperties stays true so passthrough still works; we only warn.
          // pm-upi0 extends the same mechanism into the nested options object.
          const action = resolveInvokedAction(name, args);
          const warnings = [
            ...detectUnexpectedTopLevelKeys(name, args, declaredToolKeys()),
            ...detectUnexpectedOptionKeys(name, action, args),
            ...(await collectMutationGuardWarnings(name, action, args)),
          ];
          for (const warning of warnings) {
            console.error(`[pm-mcp] ${warning}`);
          }
          // cwd is applied inside the serialized activation cycle (see withActiveExtensions),
          // so the chdir/restore is exclusive per request and cannot race a concurrent caller.
          const result = await handler(args);
          void emitMcpChangeNotifications(action);
          return resultContent(
            result,
            warnings,
            args.tokenAccounting === true,
            canonicalStructuredResult,
          );
        },
        { probesEnabled: workspaceIdentity?.probes_enabled },
      );
    },
  );
}

/** Open one modern subscription through a concrete transport-owned sink. */
export async function openMcpSubscription(input: {
  request: JsonRpcRequest;
  key?: PmMcpTransportSubscriptionKey;
  sink: PmMcpSubscriptionSink;
}): Promise<void> {
  if (
    (typeof input.request.id !== "string" &&
      typeof input.request.id !== "number") ||
    input.request.method !== "subscriptions/listen"
  ) {
    throw new PmMcpProtocolError(
      "Invalid MCP subscriptions/listen request",
      PM_MCP_ERROR_CODES.invalidParams,
      { required: ["id", "method", "params.notifications"] },
    );
  }
  resolveMcpRequestContext(input.request.params);
  const key = input.key ?? input.request.id;
  if (PM_MCP_SUBSCRIPTIONS.has(key)) {
    throw new PmMcpProtocolError(
      "MCP subscription id is already active",
      PM_MCP_ERROR_CODES.invalidParams,
      { subscriptionId: input.request.id },
    );
  }
  const registry = createMcpSubscriptionRegistry();
  await registry.open({
    id: input.request.id,
    notifications: input.request.params?.notifications,
    sink: input.sink,
  });
  PM_MCP_SUBSCRIPTIONS.set(key, { id: input.request.id, registry });
}

/** Gracefully close one active subscription by its request identifier. */
export function closeMcpSubscription(
  id: PmMcpSubscriptionId,
  key: PmMcpTransportSubscriptionKey = id,
): Record<string, unknown> | undefined {
  const subscription = PM_MCP_SUBSCRIPTIONS.get(key);
  if (!subscription || subscription.id !== id) return undefined;
  PM_MCP_SUBSCRIPTIONS.delete(key);
  return subscription.registry.close(id);
}

function closeStdioMcpSubscriptions(): Array<{
  id: PmMcpSubscriptionId;
  result: Record<string, unknown>;
}> {
  const closed: Array<{
    id: PmMcpSubscriptionId;
    result: Record<string, unknown>;
  }> = [];
  for (const [key, subscription] of PM_MCP_SUBSCRIPTIONS) {
    if (key !== subscription.id) continue;
    const result = closeMcpSubscription(subscription.id, key);
    if (result) closed.push({ id: subscription.id, result });
  }
  return closed;
}

/** Resolve the current workspace-enriched tool schema for HTTP header checks. */
export async function resolveMcpToolSchemaForRequest(
  request: JsonRpcRequest,
): Promise<unknown> {
  if (request.method !== "tools/call") return undefined;
  const name = request.params?.name;
  if (typeof name !== "string") return undefined;
  const surface = await resolveMcpToolSurface(
    TOOLS,
    requestWorkspaceArgs(request.params),
  );
  return surface.tools.find((tool) => tool.name === name)?.inputSchema;
}

/** Preserve MCP tool-result error semantics for non-protocol adapter failures. */
export function buildMcpToolCallErrorResult(
  request: JsonRpcRequest,
  error: unknown,
): Record<string, unknown> | undefined {
  if (request.method !== "tools/call" || error instanceof PmMcpProtocolError) {
    return undefined;
  }
  const content = errorContent(
    error,
    hasMcpProtocolVersionMetadata(request) &&
      hasMcpClientExtension(
        resolveMcpRequestContext(request.params),
        PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION,
      ),
  );
  return hasMcpProtocolVersionMetadata(request)
    ? buildMcpCompleteResult(content, PM_MCP_SERVER_INFO)
    : content;
}

function requestWorkspaceArgs(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const paramsRecord = asRecordClone(params);
  return asRecordClone(paramsRecord.arguments ?? paramsRecord);
}

async function readWorkspaceResource(
  uri: string,
  params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const args = requestWorkspaceArgs(params);
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const contract = PM_MCP_RESOURCE_CONTRACTS.find(
    (resource) => resource.uri === uri,
  );
  if (!contract) {
    throw new PmCliError(`Unknown pm MCP resource: ${uri}`, 64);
  }
  let value: unknown;
  if (uri === "pm://workspace/context") {
    value = await runMcpAction({ ...args, action: "context", limit: 10 });
  } else if (uri === "pm://workspace/claims") {
    value = await runMcpAction({
      ...args,
      action: "list",
      status: "in_progress",
      limit: 20,
    });
  } else if (uri === "pm://workspace/focus") {
    value = await runMcpAction({
      ...args,
      action: "focus",
      subcommand: "show",
    });
  } else {
    const guidePath = path.join(cwd, "AGENTS.md");
    value = (await pathExists(guidePath))
      ? (await readFile(guidePath, "utf8")).slice(0, 32_000)
      : "No repository-local AGENTS.md was found.";
  }
  return {
    contents: [
      {
        uri,
        mimeType: contract.mimeType,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function loadRequestSkillRegistry(
  params: Record<string, unknown> | undefined,
): Promise<PmMcpSkillRegistry> {
  const args = requestWorkspaceArgs(params);
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(
    resolvePmRoot(cwd, typeof args.path === "string" ? args.path : undefined),
  );
  return PmMcpSkillRegistry.load({
    packageRoot: resolvePmPackageRoot(),
    workspaceRoot,
    packageVersion: PM_MCP_SERVER_VERSION,
  });
}

function renderWorkflowPrompt(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const paramsRecord = asRecordClone(params);
  const name = readRequiredString(paramsRecord, "name");
  const prompt = PM_MCP_PROMPT_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (!prompt) {
    throw new PmCliError(`Unknown pm MCP prompt: ${name}`, 64);
  }
  const argumentsRecord = asRecordClone(paramsRecord.arguments);
  let text = prompt.template;
  for (const argument of prompt.arguments) {
    const value = argumentsRecord[argument.name];
    if (
      argument.required &&
      (typeof value !== "string" || value.trim().length === 0)
    ) {
      throw new PmCliError(
        `Missing required prompt argument: ${argument.name}`,
        64,
      );
    }
    text = text.replaceAll(
      `{{${argument.name}}}`,
      typeof value === "string" ? value : "",
    );
  }
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

const LEGACY_MCP_ADAPTER = new LegacyMcpAdapter({
  serverInfo: PM_MCP_SERVER_INFO,
  capabilities: PM_MCP_SERVER_CAPABILITIES,
  instructions: PM_MCP_INSTRUCTIONS,
  parseClientInfo: readMcpClientInfo,
  listTools: async (params) => ({
    tools: (await resolveMcpToolSurface(TOOLS, requestWorkspaceArgs(params)))
      .tools,
  }),
  callTool: handleToolCall,
  listResources: () => ({ resources: PM_MCP_RESOURCE_CONTRACTS }),
  readResource: (params) =>
    readWorkspaceResource(
      readRequiredString(asRecordClone(params), "uri"),
      params,
    ),
  listPrompts: () => ({
    prompts: PM_MCP_PROMPT_CONTRACTS.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  }),
  getPrompt: renderWorkflowPrompt,
});

function deterministicMcpTools(
  tools: Awaited<ReturnType<typeof resolveMcpToolSurface>>["tools"],
): Awaited<ReturnType<typeof resolveMcpToolSurface>>["tools"] {
  return tools
    .map((tool) => ({
      ...tool,
      inputSchema: validateMcpJsonSchema(tool.inputSchema) as Record<
        string,
        unknown
      >,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mcpTaskPrincipal(requestContext: PmMcpRequestContext): string {
  return requestContext.clientInfo
    ? `${requestContext.clientInfo.name}@${requestContext.clientInfo.version}`
    : "anonymous-stdio";
}

function mcpTaskStore(): PmMcpTaskStore {
  return createMcpTaskStore({
    pmRoot: resolvePmRoot(process.cwd()),
    owner: "pm-mcp-task-provider",
  });
}

function shouldCreateMcpTask(
  params: Record<string, unknown> | undefined,
  requestContext: PmMcpRequestContext,
): boolean {
  if (!hasMcpClientExtension(requestContext, PM_MCP_TASKS_EXTENSION)) {
    return false;
  }
  const requestParams = asRecordClone(params);
  const name = requestParams.name;
  const args = asRecordClone(requestParams.arguments);
  if (PM_MCP_DIRECT_TASK_TOOLS.has(name as string)) return true;
  if (
    name === "pm_test" &&
    (args.subcommand === "run" ||
      (isMcpRecord(args.options) && args.options.subcommand === "run"))
  ) {
    return true;
  }
  if (name !== "pm_run") return false;
  return (
    typeof args.action === "string" && PM_MCP_RUN_TASK_ACTIONS.has(args.action)
  );
}

interface PendingMcpTaskExecution {
  context: PmMcpRequestContext;
  params: Record<string, unknown>;
  principal: string;
  requestState?: string;
  store: PmMcpTaskStore;
  taskId: string;
}

const PENDING_MCP_TASKS = new Map<string, PendingMcpTaskExecution>();

async function executeMcpTask(
  execution: PendingMcpTaskExecution,
  inputResponses?: PmMcpInputResponses,
): Promise<void> {
  const params = {
    ...execution.params,
    ...(inputResponses ? { inputResponses } : {}),
    ...(execution.requestState ? { requestState: execution.requestState } : {}),
  };
  try {
    const result = await handleToolCall(
      params,
      execution.context.clientInfo,
      hasMcpClientExtension(
        execution.context,
        PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION,
      ),
    );
    await execution.store.complete(
      execution.taskId,
      execution.principal,
      buildMcpCompleteResult(result, PM_MCP_SERVER_INFO),
    );
    PENDING_MCP_TASKS.delete(execution.taskId);
  } catch (error: unknown) {
    if (error instanceof PmMcpInputRequiredError) {
      execution.requestState = error.requestState;
      await execution.store.requireInput({
        taskId: execution.taskId,
        principal: execution.principal,
        requestContext: execution.context,
        inputRequests: error.inputRequests,
        statusMessage: "Task requires additional client input.",
      });
      return;
    }
    if (error instanceof PmMcpProtocolError) {
      await execution.store.fail(execution.taskId, execution.principal, {
        code: error.code,
        message: error.message,
        data: error.data,
      });
    } else {
      await execution.store.complete(
        execution.taskId,
        execution.principal,
        buildMcpCompleteResult(
          errorContent(
            error,
            hasMcpClientExtension(
              execution.context,
              PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION,
            ),
          ),
          PM_MCP_SERVER_INFO,
        ),
      );
    }
    PENDING_MCP_TASKS.delete(execution.taskId);
  }
}

async function settleMcpTaskExecution(
  taskId: string,
  execution: Promise<void>,
): Promise<void> {
  try {
    await execution;
  } catch {
    // Persistence failures can outlive the request that created the detached
    // execution. Keep them from becoming process-level unhandled rejections;
    // the durable task record remains available for TTL-based recovery.
    PENDING_MCP_TASKS.delete(taskId);
  }
}

function scheduleMcpTaskExecution(
  execution: PendingMcpTaskExecution,
  inputResponses?: PmMcpInputResponses,
): void {
  void settleMcpTaskExecution(
    execution.taskId,
    executeMcpTask(execution, inputResponses),
  );
}

async function createMcpTaskForToolCall(
  params: Record<string, unknown> | undefined,
  requestContext: PmMcpRequestContext,
): Promise<Record<string, unknown>> {
  const store = mcpTaskStore();
  const principal = mcpTaskPrincipal(requestContext);
  const task = await store.create({
    principal,
    statusMessage: "pm operation accepted for asynchronous execution.",
  });
  const execution: PendingMcpTaskExecution = {
    context: requestContext,
    params: asRecordClone(params),
    principal,
    store,
    taskId: task.taskId,
  };
  PENDING_MCP_TASKS.set(task.taskId, execution);
  scheduleMcpTaskExecution(execution);
  return attachMcpServerInfo(task, PM_MCP_SERVER_INFO);
}

async function dispatchMcpTaskMethod(
  request: JsonRpcRequest,
  requestContext: PmMcpRequestContext,
): Promise<Record<string, unknown>> {
  if (!hasMcpClientExtension(requestContext, PM_MCP_TASKS_EXTENSION)) {
    throw new PmMcpProtocolError(
      "Missing required client capability",
      PM_MCP_ERROR_CODES.missingRequiredClientCapability,
      {
        requiredCapabilities: {
          extensions: { [PM_MCP_TASKS_EXTENSION]: {} },
        },
      },
    );
  }
  const params = asRecordClone(request.params);
  const taskId = readRequiredString(params, "taskId");
  const principal = mcpTaskPrincipal(requestContext);
  const store = mcpTaskStore();
  if (request.method === "tasks/get") {
    return buildMcpCompleteResult(
      await store.get(taskId, principal),
      PM_MCP_SERVER_INFO,
    );
  }
  if (request.method === "tasks/update") {
    const update = await store.update(taskId, principal, params.inputResponses);
    const execution = PENDING_MCP_TASKS.get(taskId);
    if (
      execution &&
      update.acceptedKeys.length > 0 &&
      update.remainingKeys.length === 0
    ) {
      scheduleMcpTaskExecution(
        execution,
        await store.takeInputResponses(taskId, principal),
      );
    }
    return buildMcpCompleteResult({}, PM_MCP_SERVER_INFO);
  }
  await store.cancel(taskId, principal);
  PENDING_MCP_TASKS.delete(taskId);
  return buildMcpCompleteResult({}, PM_MCP_SERVER_INFO);
}

async function dispatchModernToolMethod(
  request: JsonRpcRequest,
  requestContext: PmMcpRequestContext,
  clientInfo: ReturnType<typeof readMcpClientInfo>,
): Promise<Record<string, unknown>> {
  if (request.method === "tools/list") {
    const surface = await resolveMcpToolSurface(
      TOOLS,
      requestWorkspaceArgs(request.params),
    );
    const progressiveDiscovery = hasMcpClientExtension(
      requestContext,
      PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION,
    );
    const listedTools = progressiveDiscovery
      ? surface.tools.filter((tool) =>
          PM_MCP_ENTRY_TOOL_NAMES.includes(tool.name),
        )
      : surface.tools;
    return buildMcpCompleteResult(
      withMcpCachePolicy(
        {
          tools: hasCompatiblePmMcpAppsCapability(requestContext)
            ? decoratePmMcpToolsWithApps(deterministicMcpTools(listedTools))
            : deterministicMcpTools(listedTools),
        },
        PM_MCP_CACHE_POLICIES.tools,
      ),
      PM_MCP_SERVER_INFO,
    );
  }
  if (shouldCreateMcpTask(request.params, requestContext)) {
    return createMcpTaskForToolCall(request.params, requestContext);
  }
  try {
    return buildMcpCompleteResult(
      await handleToolCall(
        request.params,
        clientInfo,
        hasMcpClientExtension(
          requestContext,
          PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION,
        ),
      ),
      PM_MCP_SERVER_INFO,
    );
  } catch (error: unknown) {
    if (!(error instanceof PmMcpInputRequiredError)) throw error;
    return buildMcpInputRequiredResult({
      requestContext,
      serverInfo: PM_MCP_SERVER_INFO,
      inputRequests: error.inputRequests,
      requestState: error.requestState,
    });
  }
}

async function dispatchModernResourceMethod(
  request: JsonRpcRequest,
  requestContext: PmMcpRequestContext,
): Promise<Record<string, unknown>> {
  if (request.method === "resources/list") {
    const resources = [
      ...PM_MCP_RESOURCE_CONTRACTS,
      ...(hasCompatiblePmMcpAppsCapability(requestContext)
        ? PM_MCP_APP_CONTRACTS.map((contract) => ({
            uri: contract.uri,
            name: contract.name,
            description: contract.description,
            mimeType: PM_MCP_APP_MIME_TYPE,
            _meta: { ui: contract.resourceMeta },
          }))
        : []),
    ].sort((left, right) => left.uri.localeCompare(right.uri));
    return buildMcpCompleteResult(
      withMcpCachePolicy({ resources }, PM_MCP_CACHE_POLICIES.resources),
      PM_MCP_SERVER_INFO,
    );
  }
  if (request.method === "resources/templates/list") {
    return buildMcpCompleteResult(
      withMcpCachePolicy(
        { resourceTemplates: [] },
        PM_MCP_CACHE_POLICIES.resources,
      ),
      PM_MCP_SERVER_INFO,
    );
  }
  try {
    const uri = readRequiredString(asRecordClone(request.params), "uri");
    const app = findPmMcpAppByUri(uri);
    let resource: Record<string, unknown>;
    if (app) {
      if (!hasPmMcpAppsCapability(requestContext)) {
        throw new PmMcpProtocolError(
          "MCP App resource requires negotiated client capability",
          PM_MCP_ERROR_CODES.missingRequiredClientCapability,
          {
            requiredCapabilities: {
              extensions: {
                [PM_MCP_APPS_EXTENSION]: PM_MCP_APPS_SERVER_CAPABILITY,
              },
            },
          },
        );
      }
      resource = {
        contents: [
          {
            uri,
            mimeType: PM_MCP_APP_MIME_TYPE,
            text: renderPmMcpAppHtml(app),
            _meta: { ui: app.resourceMeta },
          },
        ],
      };
    } else if (uri.startsWith("skill://")) {
      assertPmMcpSkillsCapability(requestContext);
      resource = {
        ...(await loadRequestSkillRegistry(request.params)).read(uri),
      };
    } else {
      resource = await readWorkspaceResource(uri, request.params);
    }
    return buildMcpCompleteResult(
      withMcpCachePolicy(resource, PM_MCP_CACHE_POLICIES.resource),
      PM_MCP_SERVER_INFO,
    );
  } catch (error: unknown) {
    if (
      !(error instanceof PmCliError) ||
      !error.message.startsWith("Unknown pm MCP resource:")
    ) {
      throw error;
    }
    throw new PmMcpProtocolError(
      error.message,
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "uri" },
    );
  }
}

/** Treat an incompatible optional Apps declaration as absent during discovery. */
function hasCompatiblePmMcpAppsCapability(
  requestContext: PmMcpRequestContext,
): boolean {
  try {
    return hasPmMcpAppsCapability(requestContext);
  } catch (error: unknown) {
    if (error instanceof PmMcpProtocolError) return false;
    throw error;
  }
}

/** Validate Skills pagination inputs before handing them to the SDK registry. */
function readSkillPageOptions(
  params: Record<string, unknown>,
): ListPmMcpSkillsOptions {
  if (params.cursor !== undefined && typeof params.cursor !== "string") {
    throw new PmMcpProtocolError(
      "Skills cursor must be a string",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "cursor" },
    );
  }
  if (params.limit !== undefined && typeof params.limit !== "number") {
    throw new PmMcpProtocolError(
      "Skills limit must be a number",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "limit" },
    );
  }
  return {
    ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  };
}

async function dispatchModernSkillMethod(
  request: JsonRpcRequest,
  requestContext: PmMcpRequestContext,
): Promise<Record<string, unknown>> {
  const directoryRead = request.method === "resources/directory/read";
  assertPmMcpSkillsCapability(requestContext, directoryRead);
  const params = asRecordClone(request.params);
  const registry = await loadRequestSkillRegistry(request.params);
  let result: Record<string, unknown>;
  if (request.method === "skills/list") {
    result = { ...registry.list(readSkillPageOptions(params)) };
  } else if (request.method === "skills/get") {
    result = { skill: registry.get(readRequiredString(params, "uri")) };
  } else {
    result = {
      ...registry.readDirectory(
        readRequiredString(params, "uri"),
        readSkillPageOptions(params),
      ),
    };
  }
  return buildMcpCompleteResult(
    withMcpCachePolicy(result, PM_MCP_CACHE_POLICIES.resource),
    PM_MCP_SERVER_INFO,
  );
}

function dispatchModernPromptMethod(
  request: JsonRpcRequest,
): Record<string, unknown> {
  const result =
    request.method === "prompts/list"
      ? withMcpCachePolicy(
          {
            prompts: PM_MCP_PROMPT_CONTRACTS.map((prompt) => ({
              name: prompt.name,
              description: prompt.description,
              arguments: prompt.arguments,
            })).sort((left, right) => left.name.localeCompare(right.name)),
          },
          PM_MCP_CACHE_POLICIES.prompts,
        )
      : renderWorkflowPrompt(request.params);
  return buildMcpCompleteResult(result, PM_MCP_SERVER_INFO);
}

/** Dispatch one validated stateless request through the modern surface. */
async function dispatchModernMcpRequest(
  request: JsonRpcRequest,
  meta: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestContext = resolveMcpRequestContext(request.params);
  const clientInfo = readMcpClientInfo(meta[PM_MCP_META_KEYS.clientInfo]);
  if (request.method === "server/discover") {
    return buildMcpDiscoverResult({
      serverInfo: PM_MCP_SERVER_INFO,
      capabilities: PM_MCP_SERVER_CAPABILITIES,
      instructions: PM_MCP_INSTRUCTIONS,
    });
  }
  if (request.method === "ping") {
    // The preceding match is an mcp-deprecation-negative-control for modern callers.
    throw new PmMcpProtocolError("MCP method not found: ping", -32601, {
      removedIn: PM_MCP_PROTOCOL_VERSION,
    });
  }
  if (PM_MCP_SKILL_METHODS.has(request.method ?? "")) {
    return dispatchModernSkillMethod(request, requestContext);
  }
  if (
    request.method === "tasks/get" ||
    request.method === "tasks/update" ||
    request.method === "tasks/cancel"
  ) {
    return dispatchMcpTaskMethod(request, requestContext);
  }
  if (request.method === "tools/list" || request.method === "tools/call") {
    return dispatchModernToolMethod(request, requestContext, clientInfo);
  }
  if (
    request.method === "resources/list" ||
    request.method === "resources/templates/list" ||
    request.method === "resources/read"
  ) {
    return dispatchModernResourceMethod(request, requestContext);
  }
  if (request.method === "prompts/list" || request.method === "prompts/get") {
    return dispatchModernPromptMethod(request);
  }
  throw new PmMcpProtocolError(
    `MCP method not found: ${request.method ?? "(missing)"}`,
    -32601,
  );
}

/** Implements handle request for the public runtime surface of this module. */
async function handleRequestInReproducibleContext(
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | undefined> {
  if (!request.id && request.method?.startsWith("notifications/")) {
    return undefined;
  }
  if (hasMcpProtocolVersionMetadata(request)) {
    const allowlist = (process.env.PM_MCP_BAGGAGE_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return runWithMcpTraceContext(
      extractMcpTraceContext(request.params, { baggageAllowlist: allowlist }),
      () => dispatchModernMcpRequest(request, request.params._meta),
    );
  }
  if (request.method === "initialize") {
    // The preceding match is an mcp-legacy-boundary delegated to the isolated adapter.
    return LEGACY_MCP_ADAPTER.initialize(request.params);
  }
  return LEGACY_MCP_ADAPTER.dispatch(request);
}

/** Return whether a request explicitly supplies the modern version metadata key. */
function hasMcpProtocolVersionMetadata(
  request: JsonRpcRequest,
): request is JsonRpcRequest & {
  params: Record<string, unknown> & { _meta: Record<string, unknown> };
} {
  const meta = isMcpRecord(request.params) ? request.params._meta : undefined;
  return (
    isMcpRecord(meta) &&
    Object.prototype.hasOwnProperty.call(meta, PM_MCP_META_KEYS.protocolVersion)
  );
}

/** Dispatch one MCP request under supported process-level reproducibility settings. */
export async function handleRequest(
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | undefined> {
  return runWithReproducibleProcessEnvironment(process.env, () =>
    handleRequestInReproducibleContext(request),
  );
}

function writeResponse(
  id: JsonRpcRequest["id"],
  payload: Record<string, unknown>,
): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, result: payload })}\n`,
  );
}

function writeError(id: JsonRpcRequest["id"], error: unknown): void {
  const code =
    error instanceof PmMcpProtocolError
      ? error.code
      : error instanceof PmCliError
        ? error.exitCode
        : -32603;
  const message = error instanceof Error ? error.message : String(error);
  const data =
    error instanceof PmMcpProtocolError
      ? error.data
      : error instanceof PmCliError
        ? error.context
        : undefined;
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`,
  );
}

/** Write an MCP tool execution failure as a successful tool result envelope. */
function writeToolCallErrorResponse(
  request: JsonRpcRequest,
  error: unknown,
): boolean {
  if (request.method !== "tools/call" || error instanceof PmMcpProtocolError) {
    return false;
  }
  writeResponse(
    request.id,
    buildMcpToolCallErrorResult(request, error) as Record<string, unknown>,
  );
  return true;
}

async function handleStdioTransportControl(
  request: JsonRpcRequest,
): Promise<boolean> {
  if (request.method === "subscriptions/listen") {
    await openMcpSubscription({
      request,
      sink: (notification) => {
        process.stdout.write(`${JSON.stringify(notification)}\n`);
      },
    });
    return true;
  }
  if (request.method !== "notifications/cancelled") return false;
  const requestId = request.params?.requestId;
  if (typeof requestId === "string" || typeof requestId === "number") {
    const result = closeMcpSubscription(requestId);
    if (result) writeResponse(requestId, result);
  }
  return true;
}

// pm-3puw: parse one JSON-RPC line, dispatch it, and write the response. Kept
// as a standalone async unit so the stdio loop can enqueue it onto a serial
// queue (process lines in arrival order) and tests can drive it directly.
/** Implements process rpc line for the public runtime surface of this module. */
async function processRpcLineWithHandler(
  line: string,
  requestHandler:
    | typeof handleRequestInReproducibleContext
    | typeof handleRequest,
): Promise<void> {
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
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    writeError(
      null,
      new PmCliError("Invalid JSON-RPC request: expected an object", -32600),
    );
    return;
  }
  const shouldRespond = Object.prototype.hasOwnProperty.call(request, "id");
  try {
    if (await handleStdioTransportControl(request)) return;
    const result = await requestHandler(request);
    if (shouldRespond && result !== undefined) {
      writeResponse(request.id, result);
    }
  } catch (error) {
    if (!shouldRespond) {
      return;
    }
    if (!writeToolCallErrorResponse(request, error)) {
      writeError(request.id, error);
    }
  }
}

/** Implements process rpc line for the public runtime surface of this module. */
export async function processRpcLine(line: string): Promise<void> {
  await processRpcLineWithHandler(line, handleRequest);
}

/** Implements start mcp server for the public runtime surface of this module. */
export function startMcpServer(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  // pm-3puw: serialize line handling so pipelined requests are processed in
  // arrival order. The previous fire-and-forget handler ran requests
  // concurrently, so a client that pipelined two mutations on the same item
  // (without awaiting the first response) hit a lock conflict on the second.
  const queue = createSerialQueue();
  let processLine: (line: string) => Promise<void>;
  try {
    const runInProcessContext = createReproducibleProcessRunner(process.env);
    processLine = (line) =>
      runInProcessContext(() =>
        processRpcLineWithHandler(line, handleRequestInReproducibleContext),
      );
  } catch {
    // Preserve one typed JSON-RPC error per request when process configuration
    // is invalid; processRpcLine resolves the same configuration fail-closed.
    processLine = processRpcLine;
  }
  rl.on("line", (line) => {
    void queue.enqueue(() => processLine(line));
  });
  rl.on("close", () => {
    void queue.enqueue(() => {
      for (const closed of closeStdioMcpSubscriptions()) {
        writeResponse(closed.id, closed.result);
      }
    });
  });
}

// npm bin entries are symlinks (node_modules/.bin/pm-mcp -> dist/mcp/server.js),
// so argv[1] must be realpath-resolved before comparing against this module's
// path — a plain equality check made the published `pm-mcp` bin exit 0 without
// ever starting the server (pm-qtbc).
/** Implements check whether invoked as mcp main module for the public runtime surface of this module. */
export function isInvokedAsMcpMainModule(
  argvPath: string | undefined,
  moduleUrl: string,
): boolean {
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

type RuntimeTestHooks = NonNullable<
  typeof globalThis.__pmCliActionRunnerTestHooks
>;
type RuntimeTestHookKey = keyof RuntimeTestHooks;

function readRuntimeTestHook<Key extends RuntimeTestHookKey>(
  key: Key,
): RuntimeTestHooks[Key] {
  const runtimeTestHooks = globalThis.__pmCliActionRunnerTestHooks;
  if (runtimeTestHooks === undefined) {
    throw new PmCliError(
      `MCP runtime test hook "${String(key)}" is only available in test environments.`,
      64,
    );
  }
  return runtimeTestHooks[key];
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  boundMcpClientProvenance,
  createMcpInputRequiredError: (
    input: ConstructorParameters<typeof PmMcpInputRequiredError>[0],
  ) => new PmMcpInputRequiredError(input),
  createMcpProtocolError: (
    ...input: ConstructorParameters<typeof PmMcpProtocolError>
  ) => new PmMcpProtocolError(...input),
  get closeManyOptionsFromFlat() {
    return readRuntimeTestHook("closeManyOptionsFromFlat");
  },
  detectUnexpectedOptionKeys,
  detectUnexpectedTopLevelKeys,
  collectMutationGuardWarnings,
  closeStdioMcpSubscriptions,
  errorContent,
  emitMcpChangeNotifications,
  expireMcpSubscriptionRecord: (
    id: PmMcpSubscriptionId,
    key: PmMcpTransportSubscriptionKey = id,
  ) => PM_MCP_SUBSCRIPTIONS.get(key)!.registry.close(id),
  getMcpClientInfo: () => LEGACY_MCP_ADAPTER.getClientInfo(),
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
  mcpTaskPrincipal,
  resultContent,
  resolveMcpRequestContext,
  shouldCreateMcpTask,
  settleMcpTaskExecution,
  subscriptionCount: () => PM_MCP_SUBSCRIPTIONS.size,
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
  runAction: runMcpAction,
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
