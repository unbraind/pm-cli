/**
 * @module sdk/cli-contracts/enum-contracts
 *
 * Defines SDK command-contract metadata for Enum Contracts.
 */
import {
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_SERVICE_NAMES,
  KNOWN_EXTENSION_TRUST_MODES,
} from "../../core/extensions/extension-types.js";
import { PM_COMMAND_ALIAS_CONTRACTS } from "./command-aliases.js";

/** Public contract for pm extension capability contracts, shared by SDK and presentation-layer consumers. */
export const PM_EXTENSION_CAPABILITY_CONTRACTS = [
  ...KNOWN_EXTENSION_CAPABILITIES,
] as const;

/** Restricts pm extension capability contract values accepted by command, SDK, and storage contracts. */
export type PmExtensionCapabilityContract =
  (typeof PM_EXTENSION_CAPABILITY_CONTRACTS)[number];

/** Public contract for pm extension service name contracts, shared by SDK and presentation-layer consumers. */
export const PM_EXTENSION_SERVICE_NAME_CONTRACTS = [
  ...KNOWN_EXTENSION_SERVICE_NAMES,
] as const;

/** Restricts pm extension service name contract values accepted by command, SDK, and storage contracts. */
export type PmExtensionServiceNameContract =
  (typeof PM_EXTENSION_SERVICE_NAME_CONTRACTS)[number];

/** Public contract for pm extension policy mode contracts, shared by SDK and presentation-layer consumers. */
export const PM_EXTENSION_POLICY_MODE_CONTRACTS = [
  ...KNOWN_EXTENSION_POLICY_MODES,
] as const;
/** Restricts pm extension policy mode contract values accepted by command, SDK, and storage contracts. */
export type PmExtensionPolicyModeContract =
  (typeof PM_EXTENSION_POLICY_MODE_CONTRACTS)[number];
/** Public contract for pm extension trust mode contracts, shared by SDK and presentation-layer consumers. */
export const PM_EXTENSION_TRUST_MODE_CONTRACTS = [
  ...KNOWN_EXTENSION_TRUST_MODES,
] as const;
/** Restricts pm extension trust mode contract values accepted by command, SDK, and storage contracts. */
export type PmExtensionTrustModeContract =
  (typeof PM_EXTENSION_TRUST_MODE_CONTRACTS)[number];
/** Public contract for pm extension sandbox profile contracts, shared by SDK and presentation-layer consumers. */
export const PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS = [
  ...KNOWN_EXTENSION_SANDBOX_PROFILES,
] as const;
/** Restricts pm extension sandbox profile contract values accepted by command, SDK, and storage contracts. */
export type PmExtensionSandboxProfileContract =
  (typeof PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS)[number];

/** Public contract for pm extension policy surface contracts, shared by SDK and presentation-layer consumers. */
export const PM_EXTENSION_POLICY_SURFACE_CONTRACTS = [
  ...KNOWN_EXTENSION_POLICY_SURFACES,
] as const;
/** Restricts pm extension policy surface contract values accepted by command, SDK, and storage contracts. */
export type PmExtensionPolicySurfaceContract =
  (typeof PM_EXTENSION_POLICY_SURFACE_CONTRACTS)[number];

/** Public contract for pm core command names, shared by SDK and presentation-layer consumers. */
export const PM_CORE_COMMAND_NAMES = [
  "init",
  "config",
  "extension",
  "package",
  "packages",
  "install",
  "upgrade",
  "create",
  "item",
  "copy",
  "focus",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "aggregate",
  "context",
  "ctx",
  "get",
  "graph",
  "search",
  "duplicates",
  "eval",
  "next",
  "history",
  "events",
  "history-redact",
  "history-repair",
  "history-compact",
  "history-author-acknowledge",
  "merge",
  "schema",
  "profile",
  "activity",
  "restore",
  "update",
  "update-many",
  "close",
  "close-many",
  "delete",
  "append",
  "comments",
  "notes",
  "learnings",
  "files",
  "docs",
  "deps",
  "plan",
  "test",
  "test-all",
  "telemetry",
  "stats",
  "health",
  "validate",
  "assurance",
  "gc",
  "workspace",
  "contracts",
  "claim",
  "release",
  "start-task",
  "pause-task",
  "close-task",
  "meet",
  "event",
  "remind",
  "help",
] as const;

/** Supported values accepted by the graph subcommand contract across CLI, SDK, and MCP surfaces. */
export const GRAPH_SUBCOMMAND_VALUES = [
  "ancestors",
  "descendants",
  "predecessors",
  "successors",
  "paths",
  "impact",
  "analyze",
  "audit",
  "communities",
  "redundancy",
  "dominators",
  "slack",
  "centrality",
  "articulation",
  "plan",
  "index",
] as const;

/** Restricts graph subcommand values accepted by command, SDK, and MCP contracts. */
export type GraphSubcommand = (typeof GRAPH_SUBCOMMAND_VALUES)[number];

/** Nested lifecycle verbs flattened by SDK and MCP package actions. */
export const PM_EXTENSION_PACKAGE_ACTION_SUBCOMMANDS = [
  "init",
  "install",
  "uninstall",
  "explore",
  "manage",
  "describe",
  "reload",
  "doctor",
  "catalog",
  "adopt",
  "adopt-all",
  "activate",
  "deactivate",
] as const;

/** Noun-first item lifecycle verbs flattened for SDK and MCP dispatch. */
export const PM_ITEM_ACTION_SUBCOMMANDS = ["reopen"] as const;

/** CLI-only presentation commands intentionally omitted from programmatic actions. */
export const PM_CLI_ONLY_TOOL_ACTION_WAIVERS = {
  help: "Commander help rendering has no SDK operation result.",
  packages: "The plural package alias only renders package-oriented help.",
} as const;

type PmCoreCommandName = (typeof PM_CORE_COMMAND_NAMES)[number];
type PmCliOnlyToolAction = keyof typeof PM_CLI_ONLY_TOOL_ACTION_WAIVERS;
type PmExtensionPackageAction =
  `${"extension" | "package"}-${(typeof PM_EXTENSION_PACKAGE_ACTION_SUBCOMMANDS)[number]}`;
type PmItemAction = `item-${(typeof PM_ITEM_ACTION_SUBCOMMANDS)[number]}`;

/** Restricts pm tool action values accepted by command, SDK, and storage contracts. */
export type PmToolAction =
  | Exclude<PmCoreCommandName, PmCliOnlyToolAction | "item">
  | PmExtensionPackageAction
  | PmItemAction;

/**
 * Public pm tool actions derived from the CLI vocabulary. Nested extension and
 * package verbs are flattened for transports that expose one action string.
 */
export const PM_TOOL_ACTIONS: readonly PmToolAction[] = Object.freeze(
  PM_CORE_COMMAND_NAMES.flatMap((command): PmToolAction[] => {
    if (command in PM_CLI_ONLY_TOOL_ACTION_WAIVERS) return [];
    if (command === "extension" || command === "package") {
      return [
        ...PM_EXTENSION_PACKAGE_ACTION_SUBCOMMANDS.map(
          (subcommand): PmExtensionPackageAction => `${command}-${subcommand}`,
        ),
        command,
      ];
    }
    if (command === "item") {
      return PM_ITEM_ACTION_SUBCOMMANDS.map(
        (subcommand): PmItemAction => `item-${subcommand}`,
      );
    }
    return [command as PmToolAction];
  }),
);

/** Deprecated compatibility actions accepted by the SDK but omitted from canonical MCP discovery. */
export const PM_DEPRECATED_TOOL_ACTIONS: readonly PmToolAction[] =
  Object.freeze(
    PM_COMMAND_ALIAS_CONTRACTS.filter(
      (contract) =>
        contract.lifecycle === "deprecated" &&
        contract.registration === "commander" &&
        PM_TOOL_ACTIONS.includes(contract.alias as PmToolAction),
    ).map((contract) => contract.alias as PmToolAction),
  );

/** Canonical actions presented to MCP clients and unscoped contract consumers. */
export const PM_DISCOVERABLE_TOOL_ACTIONS: readonly PmToolAction[] =
  Object.freeze(
    PM_TOOL_ACTIONS.filter(
      (action) => !PM_DEPRECATED_TOOL_ACTIONS.includes(action),
    ),
  );

/** Static CLI-to-tool action parity evidence used by quality gates and tests. */
export function analyzePmToolActionParity(
  cliCommands: readonly string[] = PM_CORE_COMMAND_NAMES,
  toolActions: readonly string[] = PM_TOOL_ACTIONS,
  waivers: Readonly<Record<string, string>> = PM_CLI_ONLY_TOOL_ACTION_WAIVERS,
): {
  missing_cli_actions: string[];
  waived_cli_actions: string[];
  stale_waivers: string[];
} {
  const toolActionSet = new Set(toolActions);
  const cliCommandSet = new Set(cliCommands);
  return {
    missing_cli_actions: cliCommands.filter(
      (command) =>
        !toolActionSet.has(command) &&
        !toolActions.some((action) => action.startsWith(`${command}-`)) &&
        waivers[command] === undefined,
    ),
    waived_cli_actions: cliCommands.filter(
      (command) =>
        !toolActionSet.has(command) &&
        !toolActions.some((action) => action.startsWith(`${command}-`)) &&
        waivers[command] !== undefined,
    ),
    stale_waivers: Object.keys(waivers).filter(
      (command) =>
        !cliCommandSet.has(command) ||
        toolActionSet.has(command) ||
        toolActions.some((action) => action.startsWith(`${command}-`)),
    ),
  };
}

/** Implements check whether pm tool action for the public runtime surface of this module. */
export function isPmToolAction(value: string): value is PmToolAction {
  return PM_TOOL_ACTIONS.includes(value as PmToolAction);
}

/** Implements check whether pm extension capability contract for the public runtime surface of this module. */
export function isPmExtensionCapabilityContract(
  value: string,
): value is PmExtensionCapabilityContract {
  return PM_EXTENSION_CAPABILITY_CONTRACTS.includes(
    value as PmExtensionCapabilityContract,
  );
}

/** Implements check whether pm extension service name contract for the public runtime surface of this module. */
export function isPmExtensionServiceNameContract(
  value: string,
): value is PmExtensionServiceNameContract {
  return PM_EXTENSION_SERVICE_NAME_CONTRACTS.includes(
    value as PmExtensionServiceNameContract,
  );
}

/** Implements check whether pm extension policy mode contract for the public runtime surface of this module. */
export function isPmExtensionPolicyModeContract(
  value: string,
): value is PmExtensionPolicyModeContract {
  return PM_EXTENSION_POLICY_MODE_CONTRACTS.includes(
    value as PmExtensionPolicyModeContract,
  );
}

/** Implements check whether pm extension policy surface contract for the public runtime surface of this module. */
export function isPmExtensionPolicySurfaceContract(
  value: string,
): value is PmExtensionPolicySurfaceContract {
  return PM_EXTENSION_POLICY_SURFACE_CONTRACTS.includes(
    value as PmExtensionPolicySurfaceContract,
  );
}
