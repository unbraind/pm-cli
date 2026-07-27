/**
 * @module mcp/runtime-capabilities
 *
 * Resolves bounded MCP profiles and workspace-customized tool schemas from the
 * public SDK contracts.
 */
import {
  PM_MCP_TOOL_COMMAND_CONTRACTS,
  listPmMcpToolsForProfile,
  type PmMcpToolProfile,
} from "../sdk/agent-capability-contracts.js";
import {
  getWorkspaceContracts,
  type WorkspaceContracts,
  type WorkspaceExtensionCommandContract,
} from "../sdk/runtime.js";
import {
  PmCliError,
  getSettingsPath,
  pathExists,
  resolvePmRoot,
} from "../sdk/runtime-primitives.js";
import {
  TOOLS,
  type ToolDefinition,
} from "./tool-definitions.js";

/** Environment configuration accepted by the MCP profile resolver. */
export interface McpProfileEnvironment {
  /** Named built-in or custom MCP surface profile. */
  PM_MCP_PROFILE?: string;
  /** Comma-separated exact tool allowlist used by the custom profile. */
  PM_MCP_TOOLS?: string;
}

/** Fully resolved MCP tool surface for one request workspace. */
export interface ResolvedMcpToolSurface {
  /** Resolved profile after environment validation. */
  profile: PmMcpToolProfile;
  /** Runtime-filtered and workspace-enriched MCP definitions. */
  tools: ToolDefinition[];
  /** Extension action names reachable through the selected surface. */
  extensionActions: string[];
}

/** Profile decision for one tool call without projecting every tool schema. */
export interface ResolvedMcpToolAccess {
  /** Resolved profile after environment validation. */
  profile: PmMcpToolProfile;
  /** Whether the requested tool is callable in that profile and workspace. */
  available: boolean;
}

function workspaceFields(
  workspace: Pick<WorkspaceContracts, "fields">,
): NonNullable<WorkspaceContracts["fields"]> {
  return workspace.fields ?? [];
}

function workspaceExtensionCommands(
  workspace: Pick<WorkspaceContracts, "extensionCommands">,
): NonNullable<WorkspaceContracts["extensionCommands"]> {
  return workspace.extensionCommands ?? [];
}

function compactSchemaDescriptions<Value>(
  value: Value,
  inProperties = false,
): Value {
  if (Array.isArray(value)) {
    return value.map((entry) => compactSchemaDescriptions(entry)) as Value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => inProperties || key !== "description")
      .map(([key, entry]) => [
        key,
        compactSchemaDescriptions(entry, key === "properties"),
      ]),
  ) as Value;
}

function parseCustomToolAllowlist(
  value: string | undefined,
  availableNames: Set<string>,
): Set<string> {
  const requested = new Set(
    (value ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (requested.size === 0) {
    throw new PmCliError(
      "PM_MCP_PROFILE=custom requires a non-empty PM_MCP_TOOLS allowlist.",
      64,
    );
  }
  const unknown = [...requested].filter((name) => !availableNames.has(name));
  if (unknown.length > 0) {
    throw new PmCliError(
      `PM_MCP_TOOLS contains unknown tools: ${unknown.join(", ")}.`,
      64,
    );
  }
  return requested;
}

function resolveSelectedToolNames(
  availableTools: readonly ToolDefinition[],
  profile: PmMcpToolProfile,
  environment: McpProfileEnvironment,
): Set<string> {
  const availableNames = new Set(availableTools.map((tool) => tool.name));
  return profile === "custom"
    ? parseCustomToolAllowlist(environment.PM_MCP_TOOLS, availableNames)
    : new Set(listPmMcpToolsForProfile([...availableNames], profile));
}

/** Resolve and validate the configured MCP profile. */
export function resolveMcpToolProfile(
  environment: McpProfileEnvironment = process.env,
): PmMcpToolProfile {
  const value = environment.PM_MCP_PROFILE?.trim().toLowerCase() || "core";
  if (
    value !== "core" &&
    value !== "standard" &&
    value !== "full" &&
    value !== "custom"
  ) {
    throw new PmCliError(
      `Invalid PM_MCP_PROFILE "${value}"; expected core, standard, full, or custom.`,
      64,
    );
  }
  return value;
}

/** Select extension actions visible to one validated MCP profile. */
export function selectMcpExtensionActions(
  commands: readonly WorkspaceExtensionCommandContract[],
  profile: PmMcpToolProfile,
  selectedNames: ReadonlySet<string>,
): string[] {
  const profileRanks = { core: 0, standard: 1, full: 2 } as const;
  const tierRanks = { core: 0, standard: 1, full: 2, internal: 3 } as const;
  return commands
    .filter((command) =>
      profile === "custom"
        ? selectedNames.has("pm_run")
        : tierRanks[command.tier] <= profileRanks[profile],
    )
    .map((command) => command.action);
}

function fieldProperty(
  type: "string" | "number" | "boolean" | "string_array",
  description: string | undefined,
): Record<string, unknown> {
  const scalar: Record<string, unknown> = {
    type: type === "string_array" ? "string" : type,
    description,
  };
  return type === "string_array"
    ? {
        type: "array",
        items: scalar,
        description,
      }
    : scalar;
}

function projectWorkspaceToolDefinition(
  tool: ToolDefinition,
  workspace: WorkspaceContracts | null,
  extensionActions: string[],
  compact: boolean,
): ToolDefinition {
  const inputSchema = structuredClone(tool.inputSchema);
  const properties = inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const command = PM_MCP_TOOL_COMMAND_CONTRACTS[tool.name];
  if (workspace && command) {
    if (properties.type) properties.type.enum = [...workspace.types];
    if (properties.status) properties.status.enum = [...workspace.statuses];
    for (const field of workspaceFields(workspace)) {
      if (
        field.commands.includes(command) &&
        !Object.prototype.hasOwnProperty.call(properties, field.optionName)
      ) {
        properties[field.optionName] = fieldProperty(
          field.type,
          field.description,
        );
      }
    }
  }
  if (tool.name === "pm_run" && extensionActions.length > 0) {
    const action = properties.action;
    action.enum = [
      ...new Set([...(action.enum as unknown[]), ...extensionActions]),
    ];
  }
  return {
    ...tool,
    inputSchema: compact ? compactSchemaDescriptions(inputSchema) : inputSchema,
  };
}

/**
 * Resolve a profile-filtered tool list and enrich schemas with live workspace
 * types, statuses, custom fields, and extension actions.
 */
export async function resolveMcpToolSurface(
  availableTools: readonly ToolDefinition[],
  args: Record<string, unknown> = {},
  environment: McpProfileEnvironment = process.env,
): Promise<ResolvedMcpToolSurface> {
  const profile = resolveMcpToolProfile(environment);
  const selectedNames = resolveSelectedToolNames(
    availableTools,
    profile,
    environment,
  );
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const pmRoot = resolvePmRoot(
    cwd,
    typeof args.path === "string" ? args.path : undefined,
  );
  const workspace = (await pathExists(getSettingsPath(pmRoot)))
    ? await getWorkspaceContracts(pmRoot, { cwd })
    : null;
  const extensionActions = selectMcpExtensionActions(
    workspace ? workspaceExtensionCommands(workspace) : [],
    profile,
    selectedNames,
  );
  if (extensionActions.length > 0 && profile !== "custom") {
    selectedNames.add("pm_run");
  }
  const tools = availableTools
    .filter((tool) => selectedNames.has(tool.name))
    .map((tool) =>
      projectWorkspaceToolDefinition(
        tool,
        workspace,
        extensionActions,
        profile === "core",
      ),
    );
  return { profile, tools, extensionActions };
}

/**
 * Resolve one tool's callability without cloning and enriching the complete
 * schema surface. Only compact/standard `pm_run` calls need workspace
 * contracts because an activated extension action can promote that dispatcher.
 */
export async function resolveMcpToolAccess(
  availableTools: readonly ToolDefinition[],
  toolName: string,
  args: Record<string, unknown> = {},
  environment: McpProfileEnvironment = process.env,
): Promise<ResolvedMcpToolAccess> {
  const profile = resolveMcpToolProfile(environment);
  const selectedNames = resolveSelectedToolNames(
    availableTools,
    profile,
    environment,
  );
  if (selectedNames.has(toolName)) return { profile, available: true };
  if (toolName !== "pm_run" || profile === "custom") {
    return { profile, available: false };
  }
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const pmRoot = resolvePmRoot(
    cwd,
    typeof args.path === "string" ? args.path : undefined,
  );
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    return { profile, available: false };
  }
  const workspace = await getWorkspaceContracts(pmRoot, { cwd });
  return {
    profile,
    available:
      selectMcpExtensionActions(
        workspaceExtensionCommands(workspace),
        profile,
        selectedNames,
      ).length > 0,
  };
}

/** Move declared custom-field inputs into the runtime action option bag. */
export async function normalizeWorkspaceToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const command = PM_MCP_TOOL_COMMAND_CONTRACTS[toolName];
  if (command !== "create" && command !== "update") return args;
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const pmRoot = resolvePmRoot(
    cwd,
    typeof args.path === "string" ? args.path : undefined,
  );
  if (!(await pathExists(getSettingsPath(pmRoot)))) return args;
  const workspace = await getWorkspaceContracts(pmRoot, { cwd });
  const options =
    typeof args.options === "object" &&
    args.options !== null &&
    !Array.isArray(args.options)
      ? { ...(args.options as Record<string, unknown>) }
      : {};
  const normalizedArgs = { ...args };
  const canonicalTool = TOOLS.find((tool) => tool.name === toolName)!;
  const canonicalProperties = new Set(
    Object.keys(
      canonicalTool.inputSchema.properties as Record<string, unknown>,
    ),
  );
  let changed = false;
  for (const field of workspaceFields(workspace)) {
    if (
      field.commands.includes(command) &&
      !canonicalProperties.has(field.optionName) &&
      Object.prototype.hasOwnProperty.call(args, field.optionName)
    ) {
      options[field.optionName] = args[field.optionName];
      delete normalizedArgs[field.optionName];
      changed = true;
    }
  }
  return changed ? { ...normalizedArgs, options } : args;
}

/** Internal compatibility helpers exposed only for exhaustive fallback tests. */
export const _testOnlyMcpRuntimeCapabilities = {
  workspaceExtensionCommands,
  workspaceFields,
};
