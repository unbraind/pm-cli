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
  "eval",
  "next",
  "history",
  "history-redact",
  "history-repair",
  "history-compact",
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
  "gc",
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
] as const;

/** Restricts graph subcommand values accepted by command, SDK, and MCP contracts. */
export type GraphSubcommand = (typeof GRAPH_SUBCOMMAND_VALUES)[number];

/** Public contract for pm tool actions, shared by SDK and presentation-layer consumers. */
export const PM_TOOL_ACTIONS = [
  "init",
  "config",
  "extension-init",
  "extension-install",
  "extension-uninstall",
  "extension-explore",
  "extension-manage",
  "extension-describe",
  "extension-reload",
  "extension-doctor",
  "extension-catalog",
  "extension-adopt",
  "extension-adopt-all",
  "extension-activate",
  "extension-deactivate",
  "extension",
  "package-init",
  "package-install",
  "package-uninstall",
  "package-explore",
  "package-manage",
  "package-describe",
  "package-reload",
  "package-doctor",
  "package-catalog",
  "package-adopt",
  "package-adopt-all",
  "package-activate",
  "package-deactivate",
  "package",
  "install",
  "upgrade",
  "create",
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
  "search",
  "next",
  "history",
  "history-redact",
  "history-repair",
  "history-compact",
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
  "plan",
  "notes",
  "learnings",
  "files",
  "docs",
  "deps",
  "graph",
  "test",
  "test-all",
  "telemetry",
  "stats",
  "health",
  "validate",
  "gc",
  "contracts",
  "claim",
  "release",
  "start-task",
  "pause-task",
  "close-task",
] as const;

/** Restricts pm tool action values accepted by command, SDK, and storage contracts. */
export type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];

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
