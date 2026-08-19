/**
 * @module sdk/agent-capability-contracts
 *
 * Declares the agent-facing command, MCP profile, resource, and workflow prompt
 * surfaces from one public SDK contract.
 */
import { PM_CORE_COMMAND_NAMES } from "./cli-contracts/enum-contracts.js";

/** Visibility tiers shared by CLI help, completions, docs, extensions, and MCP. */
export type PmCommandVisibilityTier =
  | "core"
  | "standard"
  | "full"
  | "internal";

/** Stable capability families shared by every agent-facing command surface. */
export type PmCommandCapabilityFamily =
  | "workspace"
  | "intake"
  | "context"
  | "lifecycle"
  | "evidence"
  | "graph"
  | "quality"
  | "automation"
  | "extensions"
  | "internal";

/** One command's canonical agent-surface visibility declaration. */
export interface PmCommandVisibilityContract {
  /** Canonical command path. */
  command: string;
  /** Minimum surface tier that advertises the command. */
  tier: PmCommandVisibilityTier;
}

/** Complete command capability contract with visibility and family ownership. */
export interface PmCommandCapabilityContract
  extends PmCommandVisibilityContract {
  /** Exactly one stable capability family used to group the command. */
  family: PmCommandCapabilityFamily;
}

const CORE_COMMANDS = new Set([
  "claim",
  "close",
  "context",
  "create",
  "get",
  "help",
  "list",
  "next",
  "plan",
  "release",
  "search",
  "update",
  "validate",
]);

const STANDARD_COMMANDS = new Set([
  "append",
  "comments",
  "config",
  "contracts",
  "deps",
  "docs",
  "events",
  "files",
  "focus",
  "graph",
  "health",
  "history",
  "learnings",
  "list-all",
  "list-blocked",
  "list-closed",
  "list-in-progress",
  "list-open",
  "notes",
  "profile",
  "schema",
  "test",
]);

const COMMANDS_BY_FAMILY: Readonly<
  Record<Exclude<PmCommandCapabilityFamily, "extensions" | "internal">, ReadonlySet<string>>
> = Object.freeze({
  workspace: new Set([
    "config",
    "gc",
    "health",
    "init",
    "merge",
    "profile",
    "schema",
    "telemetry",
    "workspace",
  ]),
  intake: new Set(["copy", "create", "focus", "item", "restore"]),
  context: new Set([
    "activity",
    "aggregate",
    "context",
    "ctx",
    "duplicates",
    "eval",
    "get",
    "help",
    "list",
    "list-all",
    "list-blocked",
    "list-canceled",
    "list-closed",
    "list-draft",
    "list-in-progress",
    "list-open",
    "next",
    "search",
    "stats",
  ]),
  lifecycle: new Set([
    "claim",
    "close",
    "close-many",
    "close-task",
    "delete",
    "pause-task",
    "item-reopen",
    "release",
    "start-task",
    "update",
    "update-many",
  ]),
  evidence: new Set([
    "append",
    "comments",
    "docs",
    "events",
    "files",
    "history",
    "history-author-acknowledge",
    "history-compact",
    "history-redact",
    "history-repair",
    "learnings",
    "notes",
  ]),
  graph: new Set(["deps", "graph", "plan"]),
  quality: new Set([
    "assurance",
    "contracts",
    "test",
    "test-all",
    "validate",
  ]),
  automation: new Set(["event", "meet", "remind"]),
});

const EXTENSION_COMMANDS = new Set([
  "extension",
  "install",
  "package",
  "packages",
  "upgrade",
]);

/** Resolve one command's stable capability family. */
export function resolvePmCommandCapabilityFamily(
  command: string,
): PmCommandCapabilityFamily {
  const normalized = command.trim().toLowerCase();
  for (const [family, commands] of Object.entries(COMMANDS_BY_FAMILY)) {
    if (commands.has(normalized)) return family as PmCommandCapabilityFamily;
  }
  return EXTENSION_COMMANDS.has(normalized) ? "extensions" : "internal";
}

/**
 * Canonical visibility contract for every built-in command.
 *
 * Commands not explicitly promoted to core or standard remain in the full
 * surface. Internal worker/helper paths are appended below and never advertised
 * by normal help or completion projections.
 */
export const PM_COMMAND_CAPABILITY_CONTRACTS: readonly PmCommandCapabilityContract[] =
  Object.freeze([
    ...PM_CORE_COMMAND_NAMES.map((command) => ({
      command,
      tier: CORE_COMMANDS.has(command)
        ? ("core" as const)
        : STANDARD_COMMANDS.has(command)
          ? ("standard" as const)
          : ("full" as const),
      family: resolvePmCommandCapabilityFamily(command),
    })),
    {
      command: "completion-statuses",
      tier: "internal" as const,
      family: "internal" as const,
    },
    {
      command: "completion-tags",
      tier: "internal" as const,
      family: "internal" as const,
    },
    {
      command: "completion-types",
      tier: "internal" as const,
      family: "internal" as const,
    },
    {
      command: "test-runs-worker",
      tier: "internal" as const,
      family: "internal" as const,
    },
  ]);

/** Backward-compatible tier-only projection of the capability contract. */
export const PM_COMMAND_VISIBILITY_CONTRACTS: readonly PmCommandVisibilityContract[] =
  PM_COMMAND_CAPABILITY_CONTRACTS;

const TIER_ORDER: Readonly<Record<PmCommandVisibilityTier, number>> = {
  core: 0,
  standard: 1,
  full: 2,
  internal: 3,
};

const COMMAND_TIER_BY_NAME = new Map(
  PM_COMMAND_VISIBILITY_CONTRACTS.map(({ command, tier }) => [command, tier]),
);

/** Resolve one command's declared tier; extension commands default to standard. */
export function resolvePmCommandVisibilityTier(
  command: string,
  extensionTier: PmCommandVisibilityTier = "standard",
): PmCommandVisibilityTier {
  return COMMAND_TIER_BY_NAME.get(command.trim().toLowerCase()) ?? extensionTier;
}

/** Return commands visible at a requested tier, preserving contract order. */
export function listPmCommandsForTier(
  tier: Exclude<PmCommandVisibilityTier, "internal">,
): string[] {
  const maximum = TIER_ORDER[tier];
  return PM_COMMAND_VISIBILITY_CONTRACTS.filter(
    (entry) =>
      entry.tier !== "internal" && TIER_ORDER[entry.tier] <= maximum,
  ).map((entry) => entry.command);
}

/** Return commands in one capability family, preserving contract order. */
export function listPmCommandsForFamily(
  family: PmCommandCapabilityFamily,
): string[] {
  return PM_COMMAND_CAPABILITY_CONTRACTS.filter(
    (entry) => entry.family === family,
  ).map((entry) => entry.command);
}

/** MCP profile names accepted by the server and embedding hosts. */
export type PmMcpToolProfile = "core" | "standard" | "full" | "custom";

/** Mapping from one narrow MCP tool to the command contract that tiers it. */
export const PM_MCP_TOOL_COMMAND_CONTRACTS: Readonly<
  Record<string, string>
> = Object.freeze({
  pm_append: "append",
  pm_claim: "claim",
  pm_close: "close",
  pm_comments: "comments",
  pm_config: "config",
  pm_context: "context",
  pm_contracts: "contracts",
  pm_copy: "copy",
  pm_create: "create",
  pm_deps: "deps",
  pm_docs: "docs",
  pm_events: "history",
  pm_files: "files",
  pm_focus: "focus",
  pm_get: "get",
  pm_graph: "graph",
  pm_health: "health",
  pm_learnings: "learnings",
  pm_list: "list",
  pm_mutate: "update",
  pm_next: "next",
  pm_notes: "notes",
  pm_plan: "plan",
  pm_profile: "profile",
  pm_release: "release",
  pm_run: "package",
  pm_schema: "schema",
  pm_search: "search",
  pm_test: "test",
  pm_update: "update",
  pm_validate: "validate",
});

/** Resolve the tools visible in a named MCP profile from command tiers. */
export function listPmMcpToolsForProfile(
  availableTools: readonly string[],
  profile: Exclude<PmMcpToolProfile, "custom">,
): string[] {
  if (profile === "full") return [...availableTools];
  const visibleCommands = new Set(listPmCommandsForTier(profile));
  return availableTools.filter((tool) => {
    const command = PM_MCP_TOOL_COMMAND_CONTRACTS[tool];
    return command !== undefined && visibleCommands.has(command);
  });
}

/** Stable MCP resource contract generated from the same agent surface table. */
export interface PmMcpResourceContract {
  /** Stable resource URI. */
  uri: string;
  /** Human-readable resource name. */
  name: string;
  /** Agent-facing resource description. */
  description: string;
  /** Resource MIME type. */
  mimeType: "application/json" | "text/markdown";
}

/** Addressable, bounded workspace context resources. */
export const PM_MCP_RESOURCE_CONTRACTS: readonly PmMcpResourceContract[] =
  Object.freeze([
    {
      uri: "pm://workspace/context",
      name: "Workspace context",
      description:
        "Bounded project context for orientation, including active hierarchy and progress.",
      mimeType: "application/json",
    },
    {
      uri: "pm://workspace/focus",
      name: "Active focus",
      description: "The session focus that supplies the default create parent.",
      mimeType: "application/json",
    },
    {
      uri: "pm://workspace/claims",
      name: "Active claims",
      description: "Bounded in-progress work and active ownership context.",
      mimeType: "application/json",
    },
    {
      uri: "pm://workspace/agent-guide",
      name: "Agent guidance",
      description:
        "Repository-local AGENTS.md instructions, bounded for safe host attachment.",
      mimeType: "text/markdown",
    },
  ]);

/** One parameter accepted by a canonical MCP workflow prompt. */
export interface PmMcpPromptArgumentContract {
  /** Stable prompt argument name. */
  name: string;
  /** Argument description shown by the MCP host. */
  description: string;
  /** Whether the host must provide the argument. */
  required: boolean;
}

/** Canonical MCP workflow prompt generated from the agent operating contract. */
export interface PmMcpPromptContract {
  /** Stable prompt name. */
  name: string;
  /** Agent-facing workflow description. */
  description: string;
  /** Parameters accepted by the workflow. */
  arguments: readonly PmMcpPromptArgumentContract[];
  /** Template rendered into a user message after argument substitution. */
  template: string;
}

/** Canonical orient, start, and evidence-close workflows. */
export const PM_MCP_PROMPT_CONTRACTS: readonly PmMcpPromptContract[] =
  Object.freeze([
    {
      name: "orient",
      description:
        "Build bounded live context, search all statuses, and select canonical work without creating duplicates.",
      arguments: [
        {
          name: "request",
          description: "The user's requested outcome or topic.",
          required: true,
        },
        {
          name: "scope",
          description: "Optional bounded workspace or subsystem scope.",
          required: false,
        },
      ],
      template:
        "Orient to the live pm workspace for: {{request}}. Scope hint: {{scope}}. Read context, search all statuses, inspect full metadata for relevant items, and select canonical lineage before any mutation.",
    },
    {
      name: "claim-and-start",
      description:
        "Claim one canonical item and begin implementation with linked context.",
      arguments: [
        {
          name: "id",
          description: "Canonical pm item id.",
          required: true,
        },
      ],
      template:
        "Read {{id}} in full, claim it, set it in_progress, then implement only its acceptance scope while linking files, docs, tests, and evidence.",
    },
    {
      name: "record-evidence-and-close",
      description:
        "Record exact verification evidence, close the item, and release ownership.",
      arguments: [
        {
          name: "id",
          description: "Canonical pm item id.",
          required: true,
        },
        {
          name: "evidence",
          description: "Exact verification and outcome evidence.",
          required: true,
        },
      ],
      template:
        "For {{id}}, record this evidence: {{evidence}}. Verify linked tests, close only if acceptance is met, then release the claim.",
    },
  ]);

/** Render the generated command visibility reference used by docs drift gates. */
export function renderPmCommandVisibilityMarkdown(): string {
  const rows = PM_COMMAND_CAPABILITY_CONTRACTS.map(
    ({ command, tier, family }) => `| \`${command}\` | ${tier} | ${family} |`,
  );
  return [
    "# Generated agent command surface",
    "",
    "This file is generated from `PM_COMMAND_CAPABILITY_CONTRACTS`. Do not edit it manually.",
    "",
    "| Command | Minimum visibility tier | Capability family |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
