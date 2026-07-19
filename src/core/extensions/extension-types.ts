/**
 * @module core/extensions/extension-types
 *
 * Implements extension runtime contracts and governance for Extension Types.
 */
import type {
  ExtensionPolicyOverrideSettings,
  ExtensionPolicySettings,
  ItemDocument,
  ItemMetadata,
  ItemStatus,
  PmSettings,
} from "../../types/index.js";
import type { GlobalOptions } from "../shared/command-types.js";
import type {
  ProjectProfileDefinition,
  ProjectProfileRegistrationInput,
} from "../profile/profile-presets.js";
import type { RelationshipKindDefinition } from "../../sdk/relationships.js";
import type { PmClient } from "../../sdk/runtime.js";
import type {
  GetItemAtResult,
} from "../../sdk/history-read.js";
import type {
  RelationshipEventStore,
} from "../../sdk/relationship-history.js";
import type {
  CommitWorkspaceTransactionOptions,
  WorkspaceTransactionCommitResult,
} from "../../sdk/workspace-transaction.js";

/** Public contract for known extension capabilities, shared by SDK and presentation-layer consumers. */
export const KNOWN_EXTENSION_CAPABILITIES = [
  "commands",
  "renderers",
  "hooks",
  "schema",
  "importers",
  "search",
  "parser",
  "preflight",
  "services",
] as const;
/** Restricts extension capability values accepted by command, SDK, and storage contracts. */
export type ExtensionCapability = (typeof KNOWN_EXTENSION_CAPABILITIES)[number];
/** Public contract for extension capability contract version, shared by SDK and presentation-layer consumers. */
export const EXTENSION_CAPABILITY_CONTRACT_VERSION = 2;
/** Public contract for extension capability legacy aliases, shared by SDK and presentation-layer consumers. */
export const EXTENSION_CAPABILITY_LEGACY_ALIASES: Readonly<
  Record<string, ExtensionCapability>
> = Object.freeze({
  migration: "schema",
  validation: "schema",
});
/** Public contract for extension capability contract, shared by SDK and presentation-layer consumers. */
export const EXTENSION_CAPABILITY_CONTRACT = Object.freeze({
  version: EXTENSION_CAPABILITY_CONTRACT_VERSION,
  capabilities: [...KNOWN_EXTENSION_CAPABILITIES],
  legacy_aliases: { ...EXTENSION_CAPABILITY_LEGACY_ALIASES },
});

/** Public contract for known extension policy modes, shared by SDK and presentation-layer consumers. */
export const KNOWN_EXTENSION_POLICY_MODES = ["off", "warn", "enforce"] as const;
/** Restricts extension policy mode values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicyMode = (typeof KNOWN_EXTENSION_POLICY_MODES)[number];
/** Public contract for known extension trust modes, shared by SDK and presentation-layer consumers. */
export const KNOWN_EXTENSION_TRUST_MODES = ["off", "warn", "enforce"] as const;
/** Restricts extension trust mode values accepted by command, SDK, and storage contracts. */
export type ExtensionTrustMode = (typeof KNOWN_EXTENSION_TRUST_MODES)[number];
/** Public contract for known extension sandbox profiles, shared by SDK and presentation-layer consumers. */
export const KNOWN_EXTENSION_SANDBOX_PROFILES = [
  "none",
  "restricted",
  "strict",
] as const;
/** Restricts extension sandbox profile values accepted by command, SDK, and storage contracts. */
export type ExtensionSandboxProfile =
  (typeof KNOWN_EXTENSION_SANDBOX_PROFILES)[number];

/** Public contract for known pm max version exceeded modes, shared by SDK and presentation-layer consumers. */
export const KNOWN_PM_MAX_VERSION_EXCEEDED_MODES = ["block", "warn"] as const;
/** How a `pm_max_version` violation is handled for an extension layer. */
export type PmMaxVersionExceededMode =
  (typeof KNOWN_PM_MAX_VERSION_EXCEEDED_MODES)[number];
/** Optional per-layer override map for `extensions.policy.pm_max_version_exceeded_mode`. */
export interface PmMaxVersionExceededModeByLayer {
  /** Value that configures or reports global for this contract. */
  global?: PmMaxVersionExceededMode;
  /** Value that configures or reports project for this contract. */
  project?: PmMaxVersionExceededMode;
}
/** Settings value for `extensions.policy.pm_max_version_exceeded_mode`: either a single mode applied to both layers, or a per-layer override map. Unset (and any unset layer key) defaults to `"block"`. */
export type PmMaxVersionExceededModeSetting =
  | PmMaxVersionExceededMode
  | PmMaxVersionExceededModeByLayer;

/** Public contract for known extension policy surfaces, shared by SDK and presentation-layer consumers. */
export const KNOWN_EXTENSION_POLICY_SURFACES = [
  "commands.override",
  "commands.handler",
  "hooks.beforecommand",
  "hooks.aftercommand",
  "hooks.onwrite",
  "hooks.onread",
  "hooks.onindex",
  "schema.flags",
  "schema.itemfields",
  "schema.itemtypes",
  "schema.relationshipkinds",
  "schema.migrations",
  "schema.profiles",
  "parser.override",
  "preflight.override",
  "services.override",
  "renderers.override",
  "importers.importer",
  "importers.exporter",
  "search.provider",
  "search.vectorstore",
] as const;
/** Restricts extension policy surface values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicySurface =
  (typeof KNOWN_EXTENSION_POLICY_SURFACES)[number];

/** Public contract for known extension service names, shared by SDK and presentation-layer consumers. */
export const KNOWN_EXTENSION_SERVICE_NAMES = [
  "output_format",
  "error_format",
  "help_format",
  "lock_acquire",
  "lock_release",
  "history_append",
  "item_store_write",
  "item_store_delete",
  "context_relevance",
  "command_result",
] as const;
/** Restricts extension service name values accepted by command, SDK, and storage contracts. */
export type ExtensionServiceName =
  (typeof KNOWN_EXTENSION_SERVICE_NAMES)[number];

/** Documents the extension provenance metadata payload exchanged by command, SDK, and package integrations. */
export interface ExtensionProvenanceMetadata {
  /** Value that configures or reports source for this contract. */
  source?: string;
  /** Value that configures or reports signature for this contract. */
  signature?: string;
  /** Value that configures or reports attestation for this contract. */
  attestation?: string;
  /** Value that configures or reports verified for this contract. */
  verified?: boolean;
}

/** Documents the extension runtime permission declaration payload exchanged by command, SDK, and package integrations. */
export interface ExtensionRuntimePermissionDeclaration {
  /** Value that configures or reports fs read for this contract. */
  fs_read?: boolean;
  /** Value that configures or reports fs write for this contract. */
  fs_write?: boolean;
  /** Value that configures or reports network for this contract. */
  network?: boolean;
  /** Value that configures or reports env read for this contract. */
  env_read?: boolean;
  /** Value that configures or reports env write for this contract. */
  env_write?: boolean;
  /** Value that configures or reports process spawn for this contract. */
  process_spawn?: boolean;
}

/** Documents the extension activation metadata payload exchanged by command, SDK, and package integrations. */
export interface ExtensionActivationMetadata {
  /** Value that configures or reports commands for this contract. */
  commands?: string[];
}

/** Restricts extension policy override values accepted by command, SDK, and storage contracts. */
export type ExtensionPolicyOverride = ExtensionPolicyOverrideSettings;
/** Extension governance policy as read from / serialized to settings. Extends the stored settings shape with `pm_max_version_exceeded_mode` (pm-k5e8), which relaxes the default-BLOCK on `pm_max_version` violations to warn-only — globally or per extension layer. */
export type ExtensionGovernancePolicy = ExtensionPolicySettings & {
  pm_max_version_exceeded_mode?: PmMaxVersionExceededModeSetting;
};

/** Documents the extension manifest engines payload exchanged by command, SDK, and package integrations. */
export interface ExtensionManifestEngines {
  /** Value that configures or reports pm for this contract. */
  pm?: string;
  /** Value that configures or reports node for this contract. */
  node?: string;
  [engine: string]: string | undefined;
}

/** Implements create default extension governance policy for the public runtime surface of this module. */
export function createDefaultExtensionGovernancePolicy(): ExtensionGovernancePolicy {
  return {
    mode: "off",
    trust_mode: "off",
    require_provenance: false,
    trusted_extensions: [],
    default_sandbox_profile: "none",
    allowed_extensions: [],
    blocked_extensions: [],
    allowed_capabilities: [],
    blocked_capabilities: [],
    allowed_surfaces: [],
    blocked_surfaces: [],
    allowed_commands: [],
    blocked_commands: [],
    allowed_actions: [],
    blocked_actions: [],
    allowed_services: [],
    blocked_services: [],
    extension_overrides: [],
  };
}

/** Restricts extension layer values accepted by command, SDK, and storage contracts. */
export type ExtensionLayer = "global" | "project";
/** Restricts extension status values accepted by command, SDK, and storage contracts. */
export type ExtensionStatus = "ok" | "warn";

/** Documents the extension manifest payload exchanged by command, SDK, and package integrations. */
export interface ExtensionManifest {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports version for this contract. */
  version: string;
  /** Value that configures or reports entry for this contract. */
  entry: string;
  /** Value that configures or reports priority for this contract. */
  priority: number;
  /** Value that configures or reports capabilities for this contract. */
  capabilities: string[];
  /** Value that configures or reports manifest version for this contract. */
  manifest_version?: number;
  /** Value that configures or reports pm min version for this contract. */
  pm_min_version?: string;
  /** Value that configures or reports pm max version for this contract. */
  pm_max_version?: string;
  /** Value that configures or reports engines for this contract. */
  engines?: ExtensionManifestEngines;
  /** Value that configures or reports trusted for this contract. */
  trusted?: boolean;
  /** Value that configures or reports provenance for this contract. */
  provenance?: ExtensionProvenanceMetadata;
  /** Value that configures or reports sandbox profile for this contract. */
  sandbox_profile?: ExtensionSandboxProfile;
  /** Value that configures or reports permissions for this contract. */
  permissions?: ExtensionRuntimePermissionDeclaration;
  /** Value that configures or reports activation for this contract. */
  activation?: ExtensionActivationMetadata;
  /** Value that configures or reports legacy capability aliases for this contract. */
  legacy_capability_aliases?: LegacyExtensionCapabilityAliasMapping[];
}

/** Documents the extension diagnostic payload exchanged by command, SDK, and package integrations. */
export interface ExtensionDiagnostic {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports directory for this contract. */
  directory: string;
  /** Filesystem path used for manifest resolution. */
  manifest_path: string;
  /** Value that configures or reports name for this contract. */
  name: string | null;
  /** Value that configures or reports version for this contract. */
  version: string | null;
  /** Value that configures or reports entry for this contract. */
  entry: string | null;
  /** Value that configures or reports priority for this contract. */
  priority: number | null;
  /** Filesystem path used for entry resolution. */
  entry_path: string | null;
  /** Whether enabled applies to this operation. */
  enabled: boolean | null;
  /** Lifecycle state reported for status. */
  status: ExtensionStatus;
}

/** Documents the effective extension payload exchanged by command, SDK, and package integrations. */
export interface EffectiveExtension {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports directory for this contract. */
  directory: string;
  /** Filesystem path used for manifest resolution. */
  manifest_path: string;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports source package for this contract. */
  source_package?: string;
  /** Value that configures or reports version for this contract. */
  version: string;
  /** Value that configures or reports entry for this contract. */
  entry: string;
  /** Value that configures or reports priority for this contract. */
  priority: number;
  /** Filesystem path used for entry resolution. */
  entry_path: string;
  /** Value that configures or reports manifest version for this contract. */
  manifest_version?: number;
  /** Value that configures or reports pm min version for this contract. */
  pm_min_version?: string;
  /** Value that configures or reports pm max version for this contract. */
  pm_max_version?: string;
  /** Value that configures or reports engines for this contract. */
  engines?: ExtensionManifestEngines;
  /** Value that configures or reports trusted for this contract. */
  trusted?: boolean;
  /** Value that configures or reports provenance for this contract. */
  provenance?: ExtensionProvenanceMetadata;
  /** Value that configures or reports sandbox profile for this contract. */
  sandbox_profile?: ExtensionSandboxProfile;
  /** Value that configures or reports permissions for this contract. */
  permissions?: ExtensionRuntimePermissionDeclaration;
  /** Value that configures or reports capabilities for this contract. */
  capabilities?: string[];
  /** Value that configures or reports activation for this contract. */
  activation?: ExtensionActivationMetadata;
}

/** Documents the extension discovery result payload exchanged by command, SDK, and package integrations. */
export interface ExtensionDiscoveryResult {
  /** Value that configures or reports disabled by flag for this contract. */
  disabled_by_flag: boolean;
  /** Value that configures or reports roots for this contract. */
  roots: {
    global: string;
    project: string;
  };
  /** Value that configures or reports configured enabled for this contract. */
  configured_enabled: string[];
  /** Value that configures or reports configured disabled for this contract. */
  configured_disabled: string[];
  /** Value that configures or reports discovered for this contract. */
  discovered: ExtensionDiagnostic[];
  /** Value that configures or reports effective for this contract. */
  effective: EffectiveExtension[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports policy for this contract. */
  policy: ExtensionGovernancePolicy;
}

/** Documents the loaded extension payload exchanged by command, SDK, and package integrations. */
export interface LoadedExtension extends EffectiveExtension {
  /** Value that configures or reports module for this contract. */
  module: unknown;
}

/** Documents the failed extension load payload exchanged by command, SDK, and package integrations. */
export interface FailedExtensionLoad {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Filesystem path used for entry resolution. */
  entry_path: string;
  /** Value that configures or reports error for this contract. */
  error: string;
}

/** Documents the extension load result payload exchanged by command, SDK, and package integrations. */
export interface ExtensionLoadResult extends ExtensionDiscoveryResult {
  /** Value that configures or reports loaded for this contract. */
  loaded: LoadedExtension[];
  /** Value that configures or reports failed for this contract. */
  failed: FailedExtensionLoad[];
}

/** Documents the before command hook context payload exchanged by command, SDK, and package integrations. */
export interface BeforeCommandHookContext {
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports args for this contract. */
  args: string[];
  /** Value that configures or reports options for this contract. */
  options?: Record<string, unknown>;
  /** Value that configures or reports global for this contract. */
  global?: GlobalOptions;
  /** Value that configures or reports pm root for this contract. */
  pm_root: string;
}

/** Documents the after command hook context payload exchanged by command, SDK, and package integrations. */
export interface AfterCommandHookContext extends BeforeCommandHookContext {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Value that configures or reports error for this contract. */
  error?: string;
  /** Value that configures or reports result for this contract. */
  result?: unknown;
  /** Value that configures or reports affected for this contract. */
  affected?: AfterCommandAffectedItem[];
}

/** Documents the after command affected item payload exchanged by command, SDK, and package integrations. */
export interface AfterCommandAffectedItem {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports op for this contract. */
  op?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  item_type?: string;
  /** Status id the item held before this mutation. */
  previous_status?: ItemStatus;
  /** Lifecycle state reported for status. */
  status?: ItemStatus;
  /** Value that configures or reports previous for this contract. */
  previous?: Partial<ItemMetadata>;
  /** Value that configures or reports current for this contract. */
  current?: Partial<ItemMetadata>;
  /** Value that configures or reports changed fields for this contract. */
  changed_fields?: string[];
}

/** Documents the on write hook context payload exchanged by command, SDK, and package integrations. */
export interface OnWriteHookContext {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope: "project" | "global";
  /** Value that configures or reports op for this contract. */
  op: string;
  /** Value that configures or reports item id for this contract. */
  item_id?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  item_type?: string;
  /** Value that configures or reports before for this contract. */
  before?: ItemDocument;
  /** Value that configures or reports after for this contract. */
  after?: ItemDocument;
  /** Value that configures or reports changed fields for this contract. */
  changed_fields?: string[];
}

/** Documents the on read hook context payload exchanged by command, SDK, and package integrations. */
export interface OnReadHookContext {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports scope for this contract. */
  scope: "project" | "global";
}

/** Documents the on index hook context payload exchanged by command, SDK, and package integrations. */
export interface OnIndexHookContext {
  /** Value that configures or reports mode for this contract. */
  mode: string;
  /** Value that configures or reports total items for this contract. */
  total_items?: number;
}

/** Restricts before command hook values accepted by command, SDK, and storage contracts. */
export type BeforeCommandHook = (
  context: BeforeCommandHookContext,
) => Promise<void> | void;
/** Restricts after command hook values accepted by command, SDK, and storage contracts. */
export type AfterCommandHook = (
  context: AfterCommandHookContext,
) => Promise<void> | void;
/** Restricts on write hook values accepted by command, SDK, and storage contracts. */
export type OnWriteHook = (context: OnWriteHookContext) => Promise<void> | void;
/** Restricts on read hook values accepted by command, SDK, and storage contracts. */
export type OnReadHook = (context: OnReadHookContext) => Promise<void> | void;
/** Restricts on index hook values accepted by command, SDK, and storage contracts. */
export type OnIndexHook = (context: OnIndexHookContext) => Promise<void> | void;
/** Restricts output renderer format values accepted by command, SDK, and storage contracts. */
export type OutputRendererFormat = "toon" | "json";
/** Restricts command override values accepted by command, SDK, and storage contracts. */
export type CommandOverride = (context: CommandOverrideContext) => unknown;
/** Restricts renderer override values accepted by command, SDK, and storage contracts. */
export type RendererOverride = (
  context: RendererOverrideContext,
) => string | null | undefined;
/** Restricts command handler values accepted by command, SDK, and storage contracts. */
export type CommandHandler = (context: CommandHandlerContext) => unknown;
/** Restricts parser override values accepted by command, SDK, and storage contracts. */
export type ParserOverride = (
  context: ParserOverrideContext,
) => ParserOverrideDelta | Promise<ParserOverrideDelta>;
/** Restricts preflight override values accepted by command, SDK, and storage contracts. */
export type PreflightOverride = (
  context: PreflightOverrideContext,
) => PreflightOverrideDelta | Promise<PreflightOverrideDelta>;
/** Restricts service override values accepted by command, SDK, and storage contracts. */
export type ServiceOverride = (context: ServiceOverrideContext) => unknown;

/** Documents the registered extension hook payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionHook<THook> {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports run for this contract. */
  run: THook;
}

/** Documents the extension hook registry payload exchanged by command, SDK, and package integrations. */
export interface ExtensionHookRegistry {
  /** Value that configures or reports before command for this contract. */
  beforeCommand: Array<RegisteredExtensionHook<BeforeCommandHook>>;
  /** Value that configures or reports after command for this contract. */
  afterCommand: Array<RegisteredExtensionHook<AfterCommandHook>>;
  /** Value that configures or reports on write for this contract. */
  onWrite: Array<RegisteredExtensionHook<OnWriteHook>>;
  /** Value that configures or reports on read for this contract. */
  onRead: Array<RegisteredExtensionHook<OnReadHook>>;
  /** Value that configures or reports on index for this contract. */
  onIndex: Array<RegisteredExtensionHook<OnIndexHook>>;
}

/** Documents the command override context payload exchanged by command, SDK, and package integrations. */
export interface CommandOverrideContext {
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports args for this contract. */
  args: string[];
  /** Value that configures or reports options for this contract. */
  options?: Record<string, unknown>;
  /** Value that configures or reports global for this contract. */
  global?: GlobalOptions;
  /** Value that configures or reports pm root for this contract. */
  pm_root: string;
  /** Value that configures or reports result for this contract. */
  result: unknown;
}

/** Documents the renderer override context payload exchanged by command, SDK, and package integrations. */
export interface RendererOverrideContext {
  /** Value that configures or reports format for this contract. */
  format: OutputRendererFormat;
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Value that configures or reports args for this contract. */
  args?: string[];
  /** Value that configures or reports options for this contract. */
  options?: Record<string, unknown>;
  /** Value that configures or reports global for this contract. */
  global?: GlobalOptions;
  /** Value that configures or reports pm root for this contract. */
  pm_root?: string;
  /** Value that configures or reports result for this contract. */
  result: unknown;
}

/** Documents the command handler context payload exchanged by command, SDK, and package integrations. */
export interface CommandHandlerContext {
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports args for this contract. */
  args: string[];
  /** Value that configures or reports options for this contract. */
  options: Record<string, unknown>;
  /** Value that configures or reports global for this contract. */
  global: GlobalOptions;
  /** Value that configures or reports pm root for this contract. */
  pm_root: string;
  /** Host-bound SDK runtime that avoids package-resolution and private-import coupling. */
  sdk?: ExtensionCommandSdk;
}

/** Runtime SDK services injected into every extension command invocation. */
export interface ExtensionCommandSdk {
  /** Tracker-bound client using the invocation author and workspace. */
  client: PmClient;
  /** Reconstruct one item at a history version or timestamp. */
  getItemAt(id: string, target: string): Promise<GetItemAtResult>;
  /** Open a durable event store with package-contributed relationship semantics. */
  openRelationshipEventStore(options: {
    nodes: Iterable<string>;
    definitions: readonly RelationshipKindDefinition[];
    relativePath?: string;
  }): Promise<RelationshipEventStore>;
  /** Commit idempotent item and relationship mutations under one durable journal. */
  commitWorkspaceTransaction(
    options: Omit<CommitWorkspaceTransactionOptions, "pmRoot">,
  ): Promise<WorkspaceTransactionCommitResult>;
}

/** Documents the parser override context payload exchanged by command, SDK, and package integrations. */
export type ParserOverrideContext = CommandHandlerContext;

/** Documents the parser override delta payload exchanged by command, SDK, and package integrations. */
export interface ParserOverrideDelta {
  /** Value that configures or reports args for this contract. */
  args?: string[];
  /** Value that configures or reports options for this contract. */
  options?: Record<string, unknown>;
  /** Value that configures or reports global for this contract. */
  global?: GlobalOptions;
}

/** Documents the preflight override context payload exchanged by command, SDK, and package integrations. */
export interface PreflightOverrideContext extends CommandHandlerContext {
  /** Value that configures or reports decision for this contract. */
  decision: PreflightRuntimeDecision;
}

/** Documents the preflight runtime decision payload exchanged by command, SDK, and package integrations. */
export interface PreflightRuntimeDecision {
  /** Value that configures or reports enforce item format gate for this contract. */
  enforce_item_format_gate: boolean;
  /** Executes the preflight item format sync operation through the package runtime. */
  run_preflight_item_format_sync: boolean;
  /** Executes the extension migrations operation through the package runtime. */
  run_extension_migrations: boolean;
  /** Value that configures or reports enforce mandatory migration gate for this contract. */
  enforce_mandatory_migration_gate: boolean;
}

/** Documents the preflight override delta payload exchanged by command, SDK, and package integrations. */
export interface PreflightOverrideDelta extends ParserOverrideDelta {
  /** Value that configures or reports enforce item format gate for this contract. */
  enforce_item_format_gate?: boolean;
  /** Executes the preflight item format sync operation through the package runtime. */
  run_preflight_item_format_sync?: boolean;
  /** Executes the extension migrations operation through the package runtime. */
  run_extension_migrations?: boolean;
  /** Value that configures or reports enforce mandatory migration gate for this contract. */
  enforce_mandatory_migration_gate?: boolean;
}

/** Documents the service override context payload exchanged by command, SDK, and package integrations. */
export interface ServiceOverrideContext {
  /** Value that configures or reports service for this contract. */
  service: ExtensionServiceName;
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Value that configures or reports args for this contract. */
  args?: string[];
  /** Value that configures or reports options for this contract. */
  options?: Record<string, unknown>;
  /** Value that configures or reports global for this contract. */
  global?: GlobalOptions;
  /** Value that configures or reports pm root for this contract. */
  pm_root?: string;
  /** Value that configures or reports payload for this contract. */
  payload: unknown;
}

/** Documents the extension command argument definition payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCommandArgumentDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports variadic for this contract. */
  variadic?: boolean;
  /** Value that configures or reports description for this contract. */
  description?: string;
}

/** Documents the command definition payload exchanged by command, SDK, and package integrations. */
export interface CommandDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports run for this contract. */
  run?: CommandHandler;
  /**
   * @deprecated Use `run` instead. This alias remains for backward compatibility.
   */
  handler?: CommandHandler;
  /** Value that configures or reports action for this contract. */
  action?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports intent for this contract. */
  intent?: string;
  /** Value that configures or reports examples for this contract. */
  examples?: string[];
  /** Value that configures or reports failure hints for this contract. */
  failure_hints?: string[];
  /** Value that configures or reports arguments for this contract. */
  arguments?: ExtensionCommandArgumentDefinition[];
  /** Value that configures or reports flags for this contract. */
  flags?: FlagDefinition[];
}

/**
 * Optional command-definition metadata for first-class importer/exporter
 * registration.
 *
 * `registerImporter`/`registerExporter` always create a `<name> import` /
 * `<name> export` command path. By default that path only has a handler. When
 * these options are supplied, the auto-created command also gains a full command
 * definition (description, flags, intent, examples, failure hints, positional
 * arguments) — surfaced in help and runtime contracts exactly like
 * `registerCommand`. The registration `name` and `run` handler are implicit, so
 * they are not part of this options object.
 */
export interface ImportExportRegistrationOptions {
  /** Value that configures or reports action for this contract. */
  action?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports intent for this contract. */
  intent?: string;
  /** Value that configures or reports examples for this contract. */
  examples?: string[];
  /** Value that configures or reports failure hints for this contract. */
  failure_hints?: string[];
  /** Value that configures or reports arguments for this contract. */
  arguments?: ExtensionCommandArgumentDefinition[];
  /** Value that configures or reports flags for this contract. */
  flags?: FlagDefinition[];
}

/** Restricts flag value type values accepted by command, SDK, and storage contracts. */
export type FlagValueType = "string" | "number" | "boolean";

/** Documents the flag definition payload exchanged by command, SDK, and package integrations. */
export interface FlagDefinition {
  /** Value that configures or reports long for this contract. */
  long?: string;
  /** Value that configures or reports short for this contract. */
  short?: string;
  /** Value that configures or reports value name for this contract. */
  value_name?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Whether enabled applies to this operation. */
  enabled?: boolean;
  /** Value that configures or reports visible for this contract. */
  visible?: boolean;
  /** Canonical flag value type. Prefer this field; it is the one runtime contracts and help output read first. */
  value_type?: FlagValueType;
  /**
   * @deprecated Use `value_type`. Retained for backward compatibility: when
   * both are present `value_type` wins, and `type` resolves only when
   * `value_type` is absent (`value_type ?? type`).
   */
  type?: FlagValueType;
  /** When true, a repeated comma-list flag accumulates values across repeats — parity with core list flags such as `--tags` — instead of the last value winning. Mirrors the core `CliFlagContract.list` field so extension-registered list flags coalesce through the same bootstrap path. */
  list?: boolean;
  /** Default value applied when the flag is omitted. Surfaced to runtime contracts and help output. A `list` flag may default to an array of scalars (e.g. `["a", "b"]`); the array is flattened/coerced like any list value. */
  default?: string | number | boolean | Array<string | number | boolean>;
  [key: string]: unknown;
}

/** Documents the schema field definition payload exchanged by command, SDK, and package integrations. */
export interface SchemaFieldDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type: string;
  /** Value that configures or reports optional for this contract. */
  optional?: boolean;
  [key: string]: unknown;
}

/** Documents the schema item type command option policy definition payload exchanged by command, SDK, and package integrations. */
export interface SchemaItemTypeCommandOptionPolicyDefinition {
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports option for this contract. */
  option: string;
  /** Whether enabled applies to this operation. */
  enabled?: boolean;
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports visible for this contract. */
  visible?: boolean;
  [key: string]: unknown;
}

/** Documents the schema item type option definition payload exchanged by command, SDK, and package integrations. */
export interface SchemaItemTypeOptionDefinition {
  /** Value that configures or reports key for this contract. */
  key: string;
  /** Value that configures or reports values for this contract. */
  values?: string[];
  /** Value that configures or reports required for this contract. */
  required?: boolean;
  /** Value that configures or reports aliases for this contract. */
  aliases?: string[];
  [key: string]: unknown;
}

/** Documents the schema item type definition payload exchanged by command, SDK, and package integrations. */
export interface SchemaItemTypeDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports folder for this contract. */
  folder?: string;
  /** Value that configures or reports aliases for this contract. */
  aliases?: string[];
  /** Value that configures or reports required create fields for this contract. */
  required_create_fields?: string[];
  /** Value that configures or reports required create repeatables for this contract. */
  required_create_repeatables?: string[];
  /** Value that configures or reports command option policies for this contract. */
  command_option_policies?: SchemaItemTypeCommandOptionPolicyDefinition[];
  /** Value that configures or reports options for this contract. */
  options?: SchemaItemTypeOptionDefinition[];
  [key: string]: unknown;
}

/** Documents the schema migration run context payload exchanged by command, SDK, and package integrations. */
export interface SchemaMigrationRunContext {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports command for this contract. */
  command: "migration";
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports extension for this contract. */
  extension: string;
  /** Value that configures or reports pm root for this contract. */
  pm_root: string;
  /** Lifecycle state reported for status. */
  status: string;
}

/** Restricts schema migration runner values accepted by command, SDK, and storage contracts. */
export type SchemaMigrationRunner = (
  context: SchemaMigrationRunContext,
) => unknown | Promise<unknown>;

/** Documents the schema migration definition payload exchanged by command, SDK, and package integrations. */
export interface SchemaMigrationDefinition {
  /** Stable identifier used to reference this record across commands and storage. */
  id?: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports mandatory for this contract. */
  mandatory?: boolean;
  /** Value that configures or reports run for this contract. */
  run?: SchemaMigrationRunner;
  [key: string]: unknown;
}

/** Documents the import export context payload exchanged by command, SDK, and package integrations. */
export interface ImportExportContext {
  /** Value that configures or reports registration for this contract. */
  registration: string;
  /** Value that configures or reports action for this contract. */
  action: "import" | "export";
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports args for this contract. */
  args: string[];
  /** Value that configures or reports options for this contract. */
  options: Record<string, unknown>;
  /** Value that configures or reports global for this contract. */
  global: GlobalOptions;
  /** Value that configures or reports pm root for this contract. */
  pm_root: string;
}

/** Restricts importer values accepted by command, SDK, and storage contracts. */
export type Importer = (
  context: ImportExportContext,
) => unknown | Promise<unknown>;
/** Restricts exporter values accepted by command, SDK, and storage contracts. */
export type Exporter = (
  context: ImportExportContext,
) => unknown | Promise<unknown>;

/** Restricts extension search mode values accepted by command, SDK, and storage contracts. */
export type ExtensionSearchMode = "keyword" | "semantic" | "hybrid";

/** Documents the search provider query context payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderQueryContext {
  /** Value that configures or reports query for this contract. */
  query: string;
  /** Value that configures or reports mode for this contract. */
  mode: ExtensionSearchMode;
  /** Value that configures or reports tokens for this contract. */
  tokens: string[];
  /** Value that configures or reports options for this contract. */
  options: Record<string, unknown>;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  /** Value that configures or reports documents for this contract. */
  documents: ItemDocument[];
  [key: string]: unknown;
}

/** Documents the search provider hit payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderHit {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports score for this contract. */
  score: number;
  /** Value that configures or reports matched fields for this contract. */
  matched_fields?: string[];
  [key: string]: unknown;
}

/** Restricts search provider query result values accepted by command, SDK, and storage contracts. */
export type SearchProviderQueryResult =
  | SearchProviderHit[]
  | { hits?: SearchProviderHit[] };

/** Documents the search provider query expansion context payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderQueryExpansionContext {
  /** Value that configures or reports query for this contract. */
  query: string;
  /** Value that configures or reports mode for this contract. */
  mode: Exclude<ExtensionSearchMode, "keyword">;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  [key: string]: unknown;
}

/** Restricts search provider query expansion result values accepted by command, SDK, and storage contracts. */
export type SearchProviderQueryExpansionResult =
  | string[]
  | { queries?: string[] };

/** Documents the search provider rerank candidate payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderRerankCandidate {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports text for this contract. */
  text: string;
  /** Value that configures or reports score for this contract. */
  score: number;
}

/** Documents the search provider rerank hit payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderRerankHit {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports score for this contract. */
  score: number;
}

/** Restricts search provider rerank result values accepted by command, SDK, and storage contracts. */
export type SearchProviderRerankResult =
  | SearchProviderRerankHit[]
  | { hits?: SearchProviderRerankHit[] };

/** Documents the search provider rerank context payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderRerankContext {
  /** Value that configures or reports query for this contract. */
  query: string;
  /** Value that configures or reports mode for this contract. */
  mode: "hybrid";
  /** Value that configures or reports model for this contract. */
  model: string;
  /** Value that configures or reports top k for this contract. */
  top_k: number;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  /** Value that configures or reports candidates for this contract. */
  candidates: SearchProviderRerankCandidate[];
  [key: string]: unknown;
}

/** Documents the search provider embed batch context payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderEmbedBatchContext {
  /** Value that configures or reports inputs for this contract. */
  inputs: string[];
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  /** Value that configures or reports model for this contract. */
  model: string;
  [key: string]: unknown;
}

/** Documents the search provider embed context payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderEmbedContext {
  /** Value that configures or reports input for this contract. */
  input: string;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  /** Value that configures or reports model for this contract. */
  model: string;
  [key: string]: unknown;
}

/** Documents the search provider definition payload exchanged by command, SDK, and package integrations. */
export interface SearchProviderDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports query for this contract. */
  query?: (
    context: SearchProviderQueryContext,
  ) => SearchProviderQueryResult | Promise<SearchProviderQueryResult>;
  /** Value that configures or reports query expansion for this contract. */
  queryExpansion?: (
    context: SearchProviderQueryExpansionContext,
  ) =>
    | SearchProviderQueryExpansionResult
    | Promise<SearchProviderQueryExpansionResult>;
  /** Value that configures or reports query expansion for this contract. */
  query_expansion?: (
    context: SearchProviderQueryExpansionContext,
  ) =>
    | SearchProviderQueryExpansionResult
    | Promise<SearchProviderQueryExpansionResult>;
  /** Value that configures or reports rerank for this contract. */
  rerank?: (
    context: SearchProviderRerankContext,
  ) => SearchProviderRerankResult | Promise<SearchProviderRerankResult>;
  /** Value that configures or reports embed batch for this contract. */
  embedBatch?: (
    context: SearchProviderEmbedBatchContext,
  ) => number[][] | Promise<number[][]>;
  /** Value that configures or reports embed batch for this contract. */
  embed_batch?: (
    context: SearchProviderEmbedBatchContext,
  ) => number[][] | Promise<number[][]>;
  /** Value that configures or reports embed for this contract. */
  embed?: (context: SearchProviderEmbedContext) => number[] | Promise<number[]>;
  [key: string]: unknown;
}

/** Documents the vector store query hit payload exchanged by command, SDK, and package integrations. */
export interface VectorStoreQueryHit {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports score for this contract. */
  score: number;
  /** Value that configures or reports payload for this contract. */
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Documents the vector store query context payload exchanged by command, SDK, and package integrations. */
export interface VectorStoreQueryContext {
  /** Value that configures or reports vector for this contract. */
  vector: number[];
  /** Value that configures or reports limit for this contract. */
  limit: number;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  [key: string]: unknown;
}

/** Documents the vector store upsert point payload exchanged by command, SDK, and package integrations. */
export interface VectorStoreUpsertPoint {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports vector for this contract. */
  vector: number[];
  /** Value that configures or reports payload for this contract. */
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Documents the vector store upsert context payload exchanged by command, SDK, and package integrations. */
export interface VectorStoreUpsertContext {
  /** Value that configures or reports points for this contract. */
  points: VectorStoreUpsertPoint[];
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  [key: string]: unknown;
}

/** Documents the vector store delete context payload exchanged by command, SDK, and package integrations. */
export interface VectorStoreDeleteContext {
  /** Value that configures or reports ids for this contract. */
  ids: string[];
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  [key: string]: unknown;
}

/** Documents the vector store adapter definition payload exchanged by command, SDK, and package integrations. */
export interface VectorStoreAdapterDefinition {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports query for this contract. */
  query?: (
    context: VectorStoreQueryContext,
  ) => VectorStoreQueryHit[] | Promise<VectorStoreQueryHit[]>;
  /** Value that configures or reports upsert for this contract. */
  upsert?: (context: VectorStoreUpsertContext) => unknown | Promise<unknown>;
  /** Value that configures or reports delete for this contract. */
  delete?: (context: VectorStoreDeleteContext) => unknown | Promise<unknown>;
  [key: string]: unknown;
}

/** Documents the registered extension command override payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionCommandOverride {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports run for this contract. */
  run: CommandOverride;
}

/** Documents the registered extension command handler payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionCommandHandler {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports run for this contract. */
  run: CommandHandler;
}

/** Documents the registered extension parser override payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionParserOverride {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports run for this contract. */
  run: ParserOverride;
}

/** Documents the registered extension preflight override payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionPreflightOverride {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports run for this contract. */
  run: PreflightOverride;
}

/** Documents the registered extension service override payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionServiceOverride {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports service for this contract. */
  service: ExtensionServiceName;
  /** Value that configures or reports run for this contract. */
  run: ServiceOverride;
}

/** Documents the registered extension renderer override payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionRendererOverride {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports format for this contract. */
  format: OutputRendererFormat;
  /** Value that configures or reports run for this contract. */
  run: RendererOverride;
}

/** Documents the extension command registry payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCommandRegistry {
  /** Value that configures or reports overrides for this contract. */
  overrides: RegisteredExtensionCommandOverride[];
  /** Value that configures or reports handlers for this contract. */
  handlers: RegisteredExtensionCommandHandler[];
}

/** Documents the extension parser registry payload exchanged by command, SDK, and package integrations. */
export interface ExtensionParserRegistry {
  /** Value that configures or reports overrides for this contract. */
  overrides: RegisteredExtensionParserOverride[];
}

/** Documents the extension preflight registry payload exchanged by command, SDK, and package integrations. */
export interface ExtensionPreflightRegistry {
  /** Value that configures or reports overrides for this contract. */
  overrides: RegisteredExtensionPreflightOverride[];
}

/** Documents the extension service registry payload exchanged by command, SDK, and package integrations. */
export interface ExtensionServiceRegistry {
  /** Value that configures or reports overrides for this contract. */
  overrides: RegisteredExtensionServiceOverride[];
}

/** Documents the extension renderer registry payload exchanged by command, SDK, and package integrations. */
export interface ExtensionRendererRegistry {
  /** Value that configures or reports overrides for this contract. */
  overrides: RegisteredExtensionRendererOverride[];
}

/** Documents the registered extension flag definitions payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionFlagDefinitions {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports target command for this contract. */
  target_command: string;
  /** Value that configures or reports flags for this contract. */
  flags: FlagDefinition[];
}

/** Documents the registered extension command definition payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionCommandDefinition {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports source package for this contract. */
  source_package?: string;
  /** Value that configures or reports command for this contract. */
  command: string;
  /** Value that configures or reports action for this contract. */
  action: string;
  /** Value that configures or reports description for this contract. */
  description?: string;
  /** Value that configures or reports intent for this contract. */
  intent?: string;
  /** Value that configures or reports examples for this contract. */
  examples: string[];
  /** Value that configures or reports failure hints for this contract. */
  failure_hints: string[];
  /** Value that configures or reports arguments for this contract. */
  arguments: ExtensionCommandArgumentDefinition[];
}

/** Documents the registered extension schema field definitions payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionSchemaFieldDefinitions {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports fields for this contract. */
  fields: SchemaFieldDefinition[];
}

/** Documents the registered extension schema item type definitions payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionSchemaItemTypeDefinitions {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports types for this contract. */
  types: SchemaItemTypeDefinition[];
}

/** Relationship ontology definitions contributed by one active extension. */
export interface RegisteredExtensionRelationshipKindDefinitions {
  /** Extension layer that owns these definitions. */
  layer: ExtensionLayer;
  /** Extension name that owns these definitions. */
  name: string;
  /** Validated immutable relationship-kind definitions. */
  definitions: RelationshipKindDefinition[];
}

/** Documents the registered extension schema migration definition payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionSchemaMigrationDefinition {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports definition for this contract. */
  definition: SchemaMigrationDefinition;
  /** Value that configures or reports runtime definition for this contract. */
  runtime_definition: SchemaMigrationDefinition;
}

/** Documents the registered extension importer payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionImporter {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports importer for this contract. */
  importer: string;
}

/** Documents the registered extension exporter payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionExporter {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports exporter for this contract. */
  exporter: string;
}

/** Documents the registered extension search provider payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionSearchProvider {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports definition for this contract. */
  definition: SearchProviderDefinition;
  /** Value that configures or reports runtime definition for this contract. */
  runtime_definition: SearchProviderDefinition;
}

/** Documents the registered extension vector store adapter payload exchanged by command, SDK, and package integrations. */
export interface RegisteredExtensionVectorStoreAdapter {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports definition for this contract. */
  definition: VectorStoreAdapterDefinition;
  /** Value that configures or reports runtime definition for this contract. */
  runtime_definition: VectorStoreAdapterDefinition;
}

/**
 * Documents a project profile contributed by an extension via
 * `api.registerProfile(profile)`.
 *
 * A profile is the broadest customization primitive an extension can ship: it
 * bundles item types, custom statuses, fields, per-type workflows, config knobs,
 * create templates, and package recommendations into one declarative archetype
 * that `pm profile apply` stages idempotently — the same shape as the
 * core-baked archetypes. Registering one makes it resolvable by name through
 * `pm profile list/show/apply` for as long as the owning package is active.
 */
export interface RegisteredExtensionProjectProfile {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports profile for this contract. */
  profile: ProjectProfileDefinition;
}

/** Documents the extension registration registry payload exchanged by command, SDK, and package integrations. */
export interface ExtensionRegistrationRegistry {
  /** Value that configures or reports commands for this contract. */
  commands: RegisteredExtensionCommandDefinition[];
  /** Value that configures or reports flags for this contract. */
  flags: RegisteredExtensionFlagDefinitions[];
  /** Value that configures or reports item fields for this contract. */
  item_fields: RegisteredExtensionSchemaFieldDefinitions[];
  /** Value that configures or reports item types for this contract. */
  item_types: RegisteredExtensionSchemaItemTypeDefinitions[];
  /** Value that configures application-defined relationship semantics. */
  relationship_kinds: RegisteredExtensionRelationshipKindDefinitions[];
  /** Value that configures or reports migrations for this contract. */
  migrations: RegisteredExtensionSchemaMigrationDefinition[];
  /** Value that configures or reports profiles for this contract. */
  profiles: RegisteredExtensionProjectProfile[];
  /** Value that configures or reports importers for this contract. */
  importers: RegisteredExtensionImporter[];
  /** Value that configures or reports exporters for this contract. */
  exporters: RegisteredExtensionExporter[];
  /** Value that configures or reports search providers for this contract. */
  search_providers: RegisteredExtensionSearchProvider[];
  /** Value that configures or reports vector store adapters for this contract. */
  vector_store_adapters: RegisteredExtensionVectorStoreAdapter[];
}

/** Documents the extension registration counts payload exchanged by command, SDK, and package integrations. */
export interface ExtensionRegistrationCounts {
  /** Value that configures or reports commands for this contract. */
  commands: number;
  /** Value that configures or reports flags for this contract. */
  flags: number;
  /** Value that configures or reports item fields for this contract. */
  item_fields: number;
  /** Value that configures or reports item types for this contract. */
  item_types: number;
  /** Number of application-defined relationship kinds. */
  relationship_kinds?: number;
  /** Value that configures or reports migrations for this contract. */
  migrations: number;
  /** Value that configures or reports profiles for this contract. */
  profiles: number;
  /** Value that configures or reports importers for this contract. */
  importers: number;
  /** Value that configures or reports exporters for this contract. */
  exporters: number;
  /** Value that configures or reports search providers for this contract. */
  search_providers: number;
  /** Value that configures or reports vector store adapters for this contract. */
  vector_store_adapters: number;
}

/** Read-only identity an extension's `activate(api)` receives about itself, so authors can emit self-identifying logs, gate on their own version, and build better error messages without re-reading the on-disk manifest or duplicating metadata in-module. Exposed as `api.extension`. */
export interface ExtensionSelfIdentity {
  /** Value that configures or reports name for this contract. */
  readonly name: string;
  /** Value that configures or reports layer for this contract. */
  readonly layer: ExtensionLayer;
  /** Value that configures or reports version for this contract. */
  readonly version: string;
  /** Value that configures or reports capabilities for this contract. */
  readonly capabilities: readonly ExtensionCapability[];
  /** Value that configures or reports pm min version for this contract. */
  readonly pm_min_version?: string;
  /** Value that configures or reports pm max version for this contract. */
  readonly pm_max_version?: string;
  /** Value that configures or reports source package for this contract. */
  readonly source_package?: string;
}

/** Documents the extension api payload exchanged by command, SDK, and package integrations. */
export interface ExtensionApi {
  /** Read-only identity of the extension this `api` was created for. */
  readonly extension: ExtensionSelfIdentity;
  /** Value that configures or reports register command for this contract. */
  registerCommand(command: string, override: CommandOverride): void;
  /** Value that configures or reports register command for this contract. */
  registerCommand(definition: CommandDefinition): void;
  /** Value that configures or reports register parser for this contract. */
  registerParser(command: string, override: ParserOverride): void;
  /** Value that configures or reports register preflight for this contract. */
  registerPreflight(override: PreflightOverride): void;
  /** Value that configures or reports register service for this contract. */
  registerService(
    service: ExtensionServiceName,
    override: ServiceOverride,
  ): void;
  /** Value that configures or reports register flags for this contract. */
  registerFlags(targetCommand: string, flags: FlagDefinition[]): void;
  /** Value that configures or reports register item fields for this contract. */
  registerItemFields(fields: SchemaFieldDefinition[]): void;
  /** Value that configures or reports register item types for this contract. */
  registerItemTypes(types: SchemaItemTypeDefinition[]): void;
  /** Register versioned relationship semantics consumed by every graph surface. */
  registerRelationshipKinds(definitions: RelationshipKindDefinition[]): void;
  /** Value that configures or reports register migration for this contract. */
  registerMigration(definition: SchemaMigrationDefinition): void;
  /** Value that configures or reports register profile for this contract. */
  registerProfile(profile: ProjectProfileRegistrationInput): void;
  /** Value that configures or reports register renderer for this contract. */
  registerRenderer(
    format: OutputRendererFormat,
    renderer: RendererOverride,
  ): void;
  /** Value that configures or reports register importer for this contract. */
  registerImporter(
    name: string,
    importer: Importer,
    options?: ImportExportRegistrationOptions,
  ): void;
  /** Value that configures or reports register exporter for this contract. */
  registerExporter(
    name: string,
    exporter: Exporter,
    options?: ImportExportRegistrationOptions,
  ): void;
  /** Value that configures or reports register search provider for this contract. */
  registerSearchProvider(provider: SearchProviderDefinition): void;
  /** Value that configures or reports register vector store adapter for this contract. */
  registerVectorStoreAdapter(adapter: VectorStoreAdapterDefinition): void;
  /** Value that configures or reports hooks for this contract. */
  hooks: {
    beforeCommand(hook: BeforeCommandHook): void;
    afterCommand(hook: AfterCommandHook): void;
    onWrite(hook: OnWriteHook): void;
    onRead(hook: OnReadHook): void;
    onIndex(hook: OnIndexHook): void;
  };
}

/** Documents the failed extension activation payload exchanged by command, SDK, and package integrations. */
export interface FailedExtensionActivation {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Filesystem path used for entry resolution. */
  entry_path: string;
  /** Value that configures or reports error for this contract. */
  error: string;
  /** Value that configures or reports trace for this contract. */
  trace?: ExtensionActivationFailureTrace;
}

/** Documents the extension activation failure trace payload exchanged by command, SDK, and package integrations. */
export interface ExtensionActivationFailureTrace {
  /** Value that configures or reports method for this contract. */
  method: string;
  /** `-1` means the failure happened before a numbered registration was accepted. */
  registration_index: number;
  /** Value that configures or reports command for this contract. */
  command?: string;
  /** Value that configures or reports capability for this contract. */
  capability?: ExtensionCapability;
  /** Value that configures or reports missing capability for this contract. */
  missing_capability?: ExtensionCapability;
  /** Value that configures or reports expected schema for this contract. */
  expected_schema: string;
  /** Value that configures or reports received for this contract. */
  received?: unknown;
  /** Value that configures or reports hint for this contract. */
  hint?: string;
}

/** Documents the extension activation result payload exchanged by command, SDK, and package integrations. */
export interface ExtensionActivationResult {
  /** Value that configures or reports hooks for this contract. */
  hooks: ExtensionHookRegistry;
  /** Value that configures or reports commands for this contract. */
  commands: ExtensionCommandRegistry;
  /** Value that configures or reports parsers for this contract. */
  parsers: ExtensionParserRegistry;
  /** Value that configures or reports preflight for this contract. */
  preflight: ExtensionPreflightRegistry;
  /** Value that configures or reports services for this contract. */
  services: ExtensionServiceRegistry;
  /** Value that configures or reports renderers for this contract. */
  renderers: ExtensionRendererRegistry;
  /** Value that configures or reports registrations for this contract. */
  registrations: ExtensionRegistrationRegistry;
  /** Value that configures or reports failed for this contract. */
  failed: FailedExtensionActivation[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports hook counts for this contract. */
  hook_counts: {
    before_command: number;
    after_command: number;
    on_write: number;
    on_read: number;
    on_index: number;
  };
  /** Number of command override entries represented by this result. */
  command_override_count: number;
  /** Number of command handler entries represented by this result. */
  command_handler_count: number;
  /** Number of parser override entries represented by this result. */
  parser_override_count: number;
  /** Number of preflight override entries represented by this result. */
  preflight_override_count: number;
  /** Number of service override entries represented by this result. */
  service_override_count: number;
  /** Number of renderer override entries represented by this result. */
  renderer_override_count: number;
  /** Value that configures or reports registration counts for this contract. */
  registration_counts: ExtensionRegistrationCounts;
}

/** Documents the extension candidate payload exchanged by command, SDK, and package integrations. */
export interface ExtensionCandidate {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports directory for this contract. */
  directory: string;
  /** Filesystem path used for manifest resolution. */
  manifest_path: string;
  /** Filesystem path used for entry resolution. */
  entry_path: string;
  /** Declarative package manifest consumed by the extension loader. */
  manifest: ExtensionManifest;
  /** Value that configures or reports source package for this contract. */
  source_package?: string;
}

/** Documents the extension layer scan result payload exchanged by command, SDK, and package integrations. */
export interface ExtensionLayerScanResult {
  /** Value that configures or reports diagnostics for this contract. */
  diagnostics: ExtensionDiagnostic[];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports candidates for this contract. */
  candidates: ExtensionCandidate[];
}

/** Documents the scanned extension directory payload exchanged by command, SDK, and package integrations. */
export interface ScannedExtensionDirectory {
  /** Value that configures or reports diagnostic for this contract. */
  diagnostic: ExtensionDiagnostic;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports candidate for this contract. */
  candidate: ExtensionCandidate | null;
}

/** Documents the legacy extension capability alias mapping payload exchanged by command, SDK, and package integrations. */
export interface LegacyExtensionCapabilityAliasMapping {
  /** Value that configures or reports alias for this contract. */
  alias: string;
  /** Value that configures or reports target for this contract. */
  target: ExtensionCapability;
}

/** Documents the discover extensions options payload exchanged by command, SDK, and package integrations. */
export interface DiscoverExtensionsOptions {
  /** Value that configures or reports pm root for this contract. */
  pmRoot: string;
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  /** Value that configures or reports cwd for this contract. */
  cwd?: string;
  /** Value that configures or reports no extensions for this contract. */
  noExtensions?: boolean;
  /** Value that configures or reports ignore global extensions for this contract. */
  ignoreGlobalExtensions?: boolean;
  /** Value that configures or reports reload token for this contract. */
  reload_token?: string;
  /** Value that configures or reports cache bust for this contract. */
  cache_bust?: boolean;
  /** Optional import-stage filter. Discovery still reports the full effective set, but `loadExtensions` imports only entries accepted by this predicate. */
  extensionFilter?: (extension: EffectiveExtension) => boolean;
}

/** Documents the activatable extension payload exchanged by command, SDK, and package integrations. */
export interface ActivatableExtension {
  /** Registers this package's commands, actions, and runtime hooks with the host. */
  activate: (api: ExtensionApi) => void | Promise<void>;
  /** Optional teardown lifecycle hook, analogous to VS Code's `deactivate` export. Invoked when the host tears the extension down — on long-running MCP-server reload between requests, or via the `deactivateExtensions` primitive — so an extension can close connections, clear timers, and release buffers it opened during `activate`. */
  deactivate?: () => void | Promise<void>;
}

/** Documents the extension deactivation failure payload exchanged by command, SDK, and package integrations. */
export interface ExtensionDeactivationFailure {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports error for this contract. */
  error: string;
}

/** Documents the extension deactivation options payload exchanged by command, SDK, and package integrations. */
export interface ExtensionDeactivationOptions {
  /** Maximum time to wait for each extension's `deactivate` hook. Defaults to 5000ms so a hanging teardown cannot block host shutdown or reload. Set to 0 or Infinity only when the host intentionally wants to wait indefinitely. */
  deactivate_timeout_ms?: number;
}

/** Documents the extension deactivation result payload exchanged by command, SDK, and package integrations. */
export interface ExtensionDeactivationResult {
  /** Count of loaded extensions whose `deactivate` hook ran without throwing. */
  deactivated: number;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Value that configures or reports failed for this contract. */
  failed: ExtensionDeactivationFailure[];
}

/** Documents the service override result payload exchanged by command, SDK, and package integrations. */
export interface ServiceOverrideResult {
  /** Value that configures or reports handled for this contract. */
  handled: boolean;
  /** Value that configures or reports result for this contract. */
  result: unknown;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Documents the command override result payload exchanged by command, SDK, and package integrations. */
export interface CommandOverrideResult {
  /** Value that configures or reports overridden for this contract. */
  overridden: boolean;
  /** Value that configures or reports result for this contract. */
  result: unknown;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Documents the command handler result payload exchanged by command, SDK, and package integrations. */
export interface CommandHandlerResult {
  /** Value that configures or reports handled for this contract. */
  handled: boolean;
  /** Value that configures or reports result for this contract. */
  result: unknown;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
  /** Human-readable, single-line, length-bounded message describing why an extension command handler failed. Surfaced to the user/CI so the real cause (e.g. "Changelog is out of date: CHANGELOG.md") is visible instead of only the opaque `extension_command_handler_failed` warning code. */
  errorMessage?: string;
}

/** Documents the parser override result payload exchanged by command, SDK, and package integrations. */
export interface ParserOverrideResult {
  /** Value that configures or reports overridden for this contract. */
  overridden: boolean;
  /** Value that configures or reports context for this contract. */
  context: CommandHandlerContext;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Documents the preflight override result payload exchanged by command, SDK, and package integrations. */
export interface PreflightOverrideResult {
  /** Value that configures or reports overridden for this contract. */
  overridden: boolean;
  /** Value that configures or reports context for this contract. */
  context: CommandHandlerContext;
  /** Value that configures or reports decision for this contract. */
  decision: PreflightRuntimeDecision;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Documents the renderer override result payload exchanged by command, SDK, and package integrations. */
export interface RendererOverrideResult {
  /** Value that configures or reports overridden for this contract. */
  overridden: boolean;
  /** Value that configures or reports rendered for this contract. */
  rendered: string | null;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Documents the unknown extension capability warning details payload exchanged by command, SDK, and package integrations. */
export interface UnknownExtensionCapabilityWarningDetails {
  /** Value that configures or reports layer for this contract. */
  layer: ExtensionLayer;
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports capability for this contract. */
  capability: string;
  /** Value that configures or reports allowed capabilities for this contract. */
  allowed_capabilities: string[];
  /** Value that configures or reports capability contract version for this contract. */
  capability_contract_version: number;
  /** Value that configures or reports suggested capability for this contract. */
  suggested_capability?: string;
  /** Value that configures or reports suggestion source for this contract. */
  suggestion_source?: "legacy_alias" | "nearest_match";
  /** Value that configures or reports legacy alias target for this contract. */
  legacy_alias_target?: string;
}
