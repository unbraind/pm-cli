import {
  KNOWN_EXTENSION_CAPABILITIES,
  KNOWN_EXTENSION_POLICY_MODES,
  KNOWN_EXTENSION_POLICY_SURFACES,
  KNOWN_EXTENSION_SANDBOX_PROFILES,
  KNOWN_EXTENSION_SERVICE_NAMES,
  KNOWN_EXTENSION_TRUST_MODES,
} from "../../core/extensions/extension-types.js";

export const PM_EXTENSION_CAPABILITY_CONTRACTS = [...KNOWN_EXTENSION_CAPABILITIES] as const;

export type PmExtensionCapabilityContract = (typeof PM_EXTENSION_CAPABILITY_CONTRACTS)[number];

export const PM_EXTENSION_SERVICE_NAME_CONTRACTS = [...KNOWN_EXTENSION_SERVICE_NAMES] as const;

export type PmExtensionServiceNameContract = (typeof PM_EXTENSION_SERVICE_NAME_CONTRACTS)[number];

export const PM_EXTENSION_POLICY_MODE_CONTRACTS = [...KNOWN_EXTENSION_POLICY_MODES] as const;
export type PmExtensionPolicyModeContract = (typeof PM_EXTENSION_POLICY_MODE_CONTRACTS)[number];
export const PM_EXTENSION_TRUST_MODE_CONTRACTS = [...KNOWN_EXTENSION_TRUST_MODES] as const;
export type PmExtensionTrustModeContract = (typeof PM_EXTENSION_TRUST_MODE_CONTRACTS)[number];
export const PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS = [...KNOWN_EXTENSION_SANDBOX_PROFILES] as const;
export type PmExtensionSandboxProfileContract = (typeof PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS)[number];

export const PM_EXTENSION_POLICY_SURFACE_CONTRACTS = [...KNOWN_EXTENSION_POLICY_SURFACES] as const;
export type PmExtensionPolicySurfaceContract = (typeof PM_EXTENSION_POLICY_SURFACE_CONTRACTS)[number];

export const PM_CORE_COMMAND_NAMES = [
  "init",
  "config",
  "extension",
  "package",
  "packages",
  "install",
  "upgrade",
  "create",
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
  "history",
  "history-redact",
  "history-repair",
  "schema",
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
  "help",
] as const;

export const PM_TOOL_ACTIONS = [
  "init",
  "config",
  "extension-init",
  "extension-install",
  "extension-uninstall",
  "extension-explore",
  "extension-manage",
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
  "history",
  "history-redact",
  "history-repair",
  "schema",
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
  "test",
  "test-all",
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

export type PmToolAction = (typeof PM_TOOL_ACTIONS)[number];

export function isPmToolAction(value: string): value is PmToolAction {
  return PM_TOOL_ACTIONS.includes(value as PmToolAction);
}

export function isPmExtensionCapabilityContract(value: string): value is PmExtensionCapabilityContract {
  return PM_EXTENSION_CAPABILITY_CONTRACTS.includes(value as PmExtensionCapabilityContract);
}

export function isPmExtensionServiceNameContract(value: string): value is PmExtensionServiceNameContract {
  return PM_EXTENSION_SERVICE_NAME_CONTRACTS.includes(value as PmExtensionServiceNameContract);
}

export function isPmExtensionPolicyModeContract(value: string): value is PmExtensionPolicyModeContract {
  return PM_EXTENSION_POLICY_MODE_CONTRACTS.includes(value as PmExtensionPolicyModeContract);
}

export function isPmExtensionPolicySurfaceContract(value: string): value is PmExtensionPolicySurfaceContract {
  return PM_EXTENSION_POLICY_SURFACE_CONTRACTS.includes(value as PmExtensionPolicySurfaceContract);
}
