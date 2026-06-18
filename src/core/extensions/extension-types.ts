/**
 * @module core/extensions/extension-types
 *
 * Implements extension runtime contracts and governance for Extension Types.
 */
import type {
  ExtensionPolicyOverrideSettings,
  ExtensionPolicySettings,
  ItemDocument,
  ItemFrontMatter,
  ItemStatus,
  PmSettings,
} from "../../types/index.js";
import type { GlobalOptions } from "../shared/command-types.js";

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
/**
 * Restricts extension capability values accepted by command, SDK, and storage contracts.
 */
export type ExtensionCapability = (typeof KNOWN_EXTENSION_CAPABILITIES)[number];
export const EXTENSION_CAPABILITY_CONTRACT_VERSION = 2;
export const EXTENSION_CAPABILITY_LEGACY_ALIASES: Readonly<Record<string, ExtensionCapability>> = Object.freeze({
  migration: "schema",
  validation: "schema",
});
export const EXTENSION_CAPABILITY_CONTRACT = Object.freeze({
  version: EXTENSION_CAPABILITY_CONTRACT_VERSION,
  capabilities: [...KNOWN_EXTENSION_CAPABILITIES],
  legacy_aliases: { ...EXTENSION_CAPABILITY_LEGACY_ALIASES },
});

export const KNOWN_EXTENSION_POLICY_MODES = ["off", "warn", "enforce"] as const;
/**
 * Restricts extension policy mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionPolicyMode = (typeof KNOWN_EXTENSION_POLICY_MODES)[number];
export const KNOWN_EXTENSION_TRUST_MODES = ["off", "warn", "enforce"] as const;
/**
 * Restricts extension trust mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionTrustMode = (typeof KNOWN_EXTENSION_TRUST_MODES)[number];
export const KNOWN_EXTENSION_SANDBOX_PROFILES = ["none", "restricted", "strict"] as const;
/**
 * Restricts extension sandbox profile values accepted by command, SDK, and storage contracts.
 */
export type ExtensionSandboxProfile = (typeof KNOWN_EXTENSION_SANDBOX_PROFILES)[number];

export const KNOWN_PM_MAX_VERSION_EXCEEDED_MODES = ["block", "warn"] as const;
/** How a `pm_max_version` violation is handled for an extension layer. */
export type PmMaxVersionExceededMode = (typeof KNOWN_PM_MAX_VERSION_EXCEEDED_MODES)[number];
/** Optional per-layer override map for `extensions.policy.pm_max_version_exceeded_mode`. */
export interface PmMaxVersionExceededModeByLayer {
  global?: PmMaxVersionExceededMode;
  project?: PmMaxVersionExceededMode;
}
/**
 * Settings value for `extensions.policy.pm_max_version_exceeded_mode`: either a
 * single mode applied to both layers, or a per-layer override map. Unset (and
 * any unset layer key) defaults to `"block"`.
 */
export type PmMaxVersionExceededModeSetting = PmMaxVersionExceededMode | PmMaxVersionExceededModeByLayer;

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
  "schema.migrations",
  "parser.override",
  "preflight.override",
  "services.override",
  "renderers.override",
  "importers.importer",
  "importers.exporter",
  "search.provider",
  "search.vectorstore",
] as const;
/**
 * Restricts extension policy surface values accepted by command, SDK, and storage contracts.
 */
export type ExtensionPolicySurface = (typeof KNOWN_EXTENSION_POLICY_SURFACES)[number];

export const KNOWN_EXTENSION_SERVICE_NAMES = [
  "output_format",
  "error_format",
  "help_format",
  "lock_acquire",
  "lock_release",
  "history_append",
  "item_store_write",
  "item_store_delete",
] as const;
/**
 * Restricts extension service name values accepted by command, SDK, and storage contracts.
 */
export type ExtensionServiceName = (typeof KNOWN_EXTENSION_SERVICE_NAMES)[number];

/**
 * Documents the extension provenance metadata payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionProvenanceMetadata {
  source?: string;
  signature?: string;
  attestation?: string;
  verified?: boolean;
}

/**
 * Documents the extension runtime permission declaration payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionRuntimePermissionDeclaration {
  fs_read?: boolean;
  fs_write?: boolean;
  network?: boolean;
  env_read?: boolean;
  env_write?: boolean;
  process_spawn?: boolean;
}

/**
 * Documents the extension activation metadata payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionActivationMetadata {
  commands?: string[];
}

/**
 * Restricts extension policy override values accepted by command, SDK, and storage contracts.
 */
export type ExtensionPolicyOverride = ExtensionPolicyOverrideSettings;
/**
 * Extension governance policy as read from / serialized to settings. Extends the
 * stored settings shape with `pm_max_version_exceeded_mode` (pm-k5e8), which
 * relaxes the default-BLOCK on `pm_max_version` violations to warn-only —
 * globally or per extension layer.
 */
export type ExtensionGovernancePolicy = ExtensionPolicySettings & {
  pm_max_version_exceeded_mode?: PmMaxVersionExceededModeSetting;
};

/**
 * Documents the extension manifest engines payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionManifestEngines {
  pm?: string;
  node?: string;
  [engine: string]: string | undefined;
}

/**
 * Implements create default extension governance policy for the public runtime surface of this module.
 */
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

/**
 * Restricts extension layer values accepted by command, SDK, and storage contracts.
 */
export type ExtensionLayer = "global" | "project";
/**
 * Restricts extension status values accepted by command, SDK, and storage contracts.
 */
export type ExtensionStatus = "ok" | "warn";

/**
 * Documents the extension manifest payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionManifest {
  name: string;
  version: string;
  entry: string;
  priority: number;
  capabilities: string[];
  manifest_version?: number;
  pm_min_version?: string;
  pm_max_version?: string;
  engines?: ExtensionManifestEngines;
  trusted?: boolean;
  provenance?: ExtensionProvenanceMetadata;
  sandbox_profile?: ExtensionSandboxProfile;
  permissions?: ExtensionRuntimePermissionDeclaration;
  activation?: ExtensionActivationMetadata;
  legacy_capability_aliases?: LegacyExtensionCapabilityAliasMapping[];
}

/**
 * Author-facing `manifest.json` fields recognized by the extension loader, plus
 * `$schema` (tolerated for inline IDE validation against
 * `docs/schemas/extension-manifest.schema.json`). `legacy_capability_aliases`
 * is loader-derived, never authored, so it is intentionally absent. A
 * governance test keeps the published JSON Schema's `properties` in sync with
 * this list.
 */
export const KNOWN_EXTENSION_MANIFEST_FIELDS = Object.freeze([
  "$schema",
  "name",
  "version",
  "entry",
  "priority",
  "manifest_version",
  "pm_min_version",
  "pm_max_version",
  "engines",
  "trusted",
  "provenance",
  "sandbox_profile",
  "permissions",
  "capabilities",
  "activation",
] as const) satisfies readonly (Exclude<keyof ExtensionManifest, "legacy_capability_aliases"> | "$schema")[];

/**
 * Documents the extension diagnostic payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionDiagnostic {
  layer: ExtensionLayer;
  directory: string;
  manifest_path: string;
  name: string | null;
  version: string | null;
  entry: string | null;
  priority: number | null;
  entry_path: string | null;
  enabled: boolean | null;
  status: ExtensionStatus;
}

/**
 * Documents the effective extension payload exchanged by command, SDK, and package integrations.
 */
export interface EffectiveExtension {
  layer: ExtensionLayer;
  directory: string;
  manifest_path: string;
  name: string;
  source_package?: string;
  version: string;
  entry: string;
  priority: number;
  entry_path: string;
  manifest_version?: number;
  pm_min_version?: string;
  pm_max_version?: string;
  engines?: ExtensionManifestEngines;
  trusted?: boolean;
  provenance?: ExtensionProvenanceMetadata;
  sandbox_profile?: ExtensionSandboxProfile;
  permissions?: ExtensionRuntimePermissionDeclaration;
  capabilities?: string[];
  activation?: ExtensionActivationMetadata;
}

/**
 * Documents the extension discovery result payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionDiscoveryResult {
  disabled_by_flag: boolean;
  roots: {
    global: string;
    project: string;
  };
  configured_enabled: string[];
  configured_disabled: string[];
  discovered: ExtensionDiagnostic[];
  effective: EffectiveExtension[];
  warnings: string[];
  policy: ExtensionGovernancePolicy;
}

/**
 * Documents the loaded extension payload exchanged by command, SDK, and package integrations.
 */
export interface LoadedExtension extends EffectiveExtension {
  module: unknown;
}

/**
 * Documents the failed extension load payload exchanged by command, SDK, and package integrations.
 */
export interface FailedExtensionLoad {
  layer: ExtensionLayer;
  name: string;
  entry_path: string;
  error: string;
}

/**
 * Documents the extension load result payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionLoadResult extends ExtensionDiscoveryResult {
  loaded: LoadedExtension[];
  failed: FailedExtensionLoad[];
}

/**
 * Documents the before command hook context payload exchanged by command, SDK, and package integrations.
 */
export interface BeforeCommandHookContext {
  command: string;
  args: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root: string;
}

/**
 * Documents the after command hook context payload exchanged by command, SDK, and package integrations.
 */
export interface AfterCommandHookContext extends BeforeCommandHookContext {
  ok: boolean;
  error?: string;
  result?: unknown;
  affected?: AfterCommandAffectedItem[];
}

/**
 * Documents the after command affected item payload exchanged by command, SDK, and package integrations.
 */
export interface AfterCommandAffectedItem {
  id: string;
  op?: string;
  item_type?: string;
  previous_status?: ItemStatus;
  status?: ItemStatus;
  previous?: Partial<ItemFrontMatter>;
  current?: Partial<ItemFrontMatter>;
  changed_fields?: string[];
}

/**
 * Documents the on write hook context payload exchanged by command, SDK, and package integrations.
 */
export interface OnWriteHookContext {
  path: string;
  scope: "project" | "global";
  op: string;
  item_id?: string;
  item_type?: string;
  before?: ItemDocument;
  after?: ItemDocument;
  changed_fields?: string[];
}

/**
 * Documents the on read hook context payload exchanged by command, SDK, and package integrations.
 */
export interface OnReadHookContext {
  path: string;
  scope: "project" | "global";
}

/**
 * Documents the on index hook context payload exchanged by command, SDK, and package integrations.
 */
export interface OnIndexHookContext {
  mode: string;
  total_items?: number;
}

/**
 * Restricts before command hook values accepted by command, SDK, and storage contracts.
 */
export type BeforeCommandHook = (context: BeforeCommandHookContext) => Promise<void> | void;
/**
 * Restricts after command hook values accepted by command, SDK, and storage contracts.
 */
export type AfterCommandHook = (context: AfterCommandHookContext) => Promise<void> | void;
/**
 * Restricts on write hook values accepted by command, SDK, and storage contracts.
 */
export type OnWriteHook = (context: OnWriteHookContext) => Promise<void> | void;
/**
 * Restricts on read hook values accepted by command, SDK, and storage contracts.
 */
export type OnReadHook = (context: OnReadHookContext) => Promise<void> | void;
/**
 * Restricts on index hook values accepted by command, SDK, and storage contracts.
 */
export type OnIndexHook = (context: OnIndexHookContext) => Promise<void> | void;
/**
 * Restricts output renderer format values accepted by command, SDK, and storage contracts.
 */
export type OutputRendererFormat = "toon" | "json";
/**
 * Restricts command override values accepted by command, SDK, and storage contracts.
 */
export type CommandOverride = (context: CommandOverrideContext) => unknown;
/**
 * Restricts renderer override values accepted by command, SDK, and storage contracts.
 */
export type RendererOverride = (context: RendererOverrideContext) => string | null | undefined;
/**
 * Restricts command handler values accepted by command, SDK, and storage contracts.
 */
export type CommandHandler = (context: CommandHandlerContext) => unknown;
/**
 * Restricts parser override values accepted by command, SDK, and storage contracts.
 */
export type ParserOverride = (context: ParserOverrideContext) => ParserOverrideDelta | Promise<ParserOverrideDelta>;
/**
 * Restricts preflight override values accepted by command, SDK, and storage contracts.
 */
export type PreflightOverride = (context: PreflightOverrideContext) => PreflightOverrideDelta | Promise<PreflightOverrideDelta>;
/**
 * Restricts service override values accepted by command, SDK, and storage contracts.
 */
export type ServiceOverride = (context: ServiceOverrideContext) => unknown;

/**
 * Documents the registered extension hook payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionHook<THook> {
  layer: ExtensionLayer;
  name: string;
  run: THook;
}

/**
 * Documents the extension hook registry payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionHookRegistry {
  beforeCommand: Array<RegisteredExtensionHook<BeforeCommandHook>>;
  afterCommand: Array<RegisteredExtensionHook<AfterCommandHook>>;
  onWrite: Array<RegisteredExtensionHook<OnWriteHook>>;
  onRead: Array<RegisteredExtensionHook<OnReadHook>>;
  onIndex: Array<RegisteredExtensionHook<OnIndexHook>>;
}

/**
 * Documents the command override context payload exchanged by command, SDK, and package integrations.
 */
export interface CommandOverrideContext {
  command: string;
  args: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root: string;
  result: unknown;
}

/**
 * Documents the renderer override context payload exchanged by command, SDK, and package integrations.
 */
export interface RendererOverrideContext {
  format: OutputRendererFormat;
  command?: string;
  args?: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root?: string;
  result: unknown;
}

/**
 * Documents the command handler context payload exchanged by command, SDK, and package integrations.
 */
export interface CommandHandlerContext {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
  pm_root: string;
}

/**
 * Documents the parser override context payload exchanged by command, SDK, and package integrations.
 */
export interface ParserOverrideContext extends CommandHandlerContext {}

/**
 * Documents the parser override delta payload exchanged by command, SDK, and package integrations.
 */
export interface ParserOverrideDelta {
  args?: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
}

/**
 * Documents the preflight override context payload exchanged by command, SDK, and package integrations.
 */
export interface PreflightOverrideContext extends CommandHandlerContext {
  decision: PreflightRuntimeDecision;
}

/**
 * Documents the preflight runtime decision payload exchanged by command, SDK, and package integrations.
 */
export interface PreflightRuntimeDecision {
  enforce_item_format_gate: boolean;
  run_preflight_item_format_sync: boolean;
  run_extension_migrations: boolean;
  enforce_mandatory_migration_gate: boolean;
}

/**
 * Documents the preflight override delta payload exchanged by command, SDK, and package integrations.
 */
export interface PreflightOverrideDelta extends ParserOverrideDelta {
  enforce_item_format_gate?: boolean;
  run_preflight_item_format_sync?: boolean;
  run_extension_migrations?: boolean;
  enforce_mandatory_migration_gate?: boolean;
}

/**
 * Documents the service override context payload exchanged by command, SDK, and package integrations.
 */
export interface ServiceOverrideContext {
  service: ExtensionServiceName;
  command?: string;
  args?: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root?: string;
  payload: unknown;
}

/**
 * Documents the extension command argument definition payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionCommandArgumentDefinition {
  name: string;
  required?: boolean;
  variadic?: boolean;
  description?: string;
}

/**
 * Documents the command definition payload exchanged by command, SDK, and package integrations.
 */
export interface CommandDefinition {
  name: string;
  run?: CommandHandler;
  /**
   * @deprecated Use `run` instead. This alias remains for backward compatibility.
   */
  handler?: CommandHandler;
  action?: string;
  description?: string;
  intent?: string;
  examples?: string[];
  failure_hints?: string[];
  arguments?: ExtensionCommandArgumentDefinition[];
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
  action?: string;
  description?: string;
  intent?: string;
  examples?: string[];
  failure_hints?: string[];
  arguments?: ExtensionCommandArgumentDefinition[];
  flags?: FlagDefinition[];
}

/**
 * Restricts flag value type values accepted by command, SDK, and storage contracts.
 */
export type FlagValueType = "string" | "number" | "boolean";

/**
 * Documents the flag definition payload exchanged by command, SDK, and package integrations.
 */
export interface FlagDefinition {
  long?: string;
  short?: string;
  value_name?: string;
  description?: string;
  required?: boolean;
  enabled?: boolean;
  visible?: boolean;
  /**
   * Canonical flag value type. Prefer this field; it is the one runtime
   * contracts and help output read first.
   */
  value_type?: FlagValueType;
  /**
   * @deprecated Use `value_type`. Retained for backward compatibility: when
   * both are present `value_type` wins, and `type` resolves only when
   * `value_type` is absent (`value_type ?? type`).
   */
  type?: FlagValueType;
  /**
   * When true, a repeated comma-list flag accumulates values across repeats
   * — parity with core list flags such as `--tags` — instead of the last
   * value winning. Mirrors the core `CliFlagContract.list` field so
   * extension-registered list flags coalesce through the same bootstrap path.
   */
  list?: boolean;
  /**
   * Default value applied when the flag is omitted. Surfaced to runtime
   * contracts and help output. A `list` flag may default to an array of scalars
   * (e.g. `["a", "b"]`); the array is flattened/coerced like any list value.
   */
  default?: string | number | boolean | Array<string | number | boolean>;
  [key: string]: unknown;
}

/**
 * Documents the schema field definition payload exchanged by command, SDK, and package integrations.
 */
export interface SchemaFieldDefinition {
  name: string;
  type: string;
  optional?: boolean;
  [key: string]: unknown;
}

/**
 * Documents the schema item type command option policy definition payload exchanged by command, SDK, and package integrations.
 */
export interface SchemaItemTypeCommandOptionPolicyDefinition {
  command: string;
  option: string;
  enabled?: boolean;
  required?: boolean;
  visible?: boolean;
  [key: string]: unknown;
}

/**
 * Documents the schema item type option definition payload exchanged by command, SDK, and package integrations.
 */
export interface SchemaItemTypeOptionDefinition {
  key: string;
  values?: string[];
  required?: boolean;
  aliases?: string[];
  [key: string]: unknown;
}

/**
 * Documents the schema item type definition payload exchanged by command, SDK, and package integrations.
 */
export interface SchemaItemTypeDefinition {
  name: string;
  folder?: string;
  aliases?: string[];
  required_create_fields?: string[];
  required_create_repeatables?: string[];
  command_option_policies?: SchemaItemTypeCommandOptionPolicyDefinition[];
  options?: SchemaItemTypeOptionDefinition[];
  [key: string]: unknown;
}

/**
 * Documents the schema migration run context payload exchanged by command, SDK, and package integrations.
 */
export interface SchemaMigrationRunContext {
  id: string;
  command: "migration";
  layer: ExtensionLayer;
  extension: string;
  pm_root: string;
  status: string;
}

/**
 * Restricts schema migration runner values accepted by command, SDK, and storage contracts.
 */
export type SchemaMigrationRunner = (context: SchemaMigrationRunContext) => unknown | Promise<unknown>;

/**
 * Documents the schema migration definition payload exchanged by command, SDK, and package integrations.
 */
export interface SchemaMigrationDefinition {
  id?: string;
  description?: string;
  status?: string;
  mandatory?: boolean;
  run?: SchemaMigrationRunner;
  [key: string]: unknown;
}

/**
 * Documents the import export context payload exchanged by command, SDK, and package integrations.
 */
export interface ImportExportContext {
  registration: string;
  action: "import" | "export";
  command: string;
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
  pm_root: string;
}

/**
 * Restricts importer values accepted by command, SDK, and storage contracts.
 */
export type Importer = (context: ImportExportContext) => unknown | Promise<unknown>;
/**
 * Restricts exporter values accepted by command, SDK, and storage contracts.
 */
export type Exporter = (context: ImportExportContext) => unknown | Promise<unknown>;

/**
 * Restricts extension search mode values accepted by command, SDK, and storage contracts.
 */
export type ExtensionSearchMode = "keyword" | "semantic" | "hybrid";

/**
 * Documents the search provider query context payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderQueryContext {
  query: string;
  mode: ExtensionSearchMode;
  tokens: string[];
  options: Record<string, unknown>;
  settings: PmSettings;
  documents: ItemDocument[];
  [key: string]: unknown;
}

/**
 * Documents the search provider hit payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderHit {
  id: string;
  score: number;
  matched_fields?: string[];
  [key: string]: unknown;
}

/**
 * Restricts search provider query result values accepted by command, SDK, and storage contracts.
 */
export type SearchProviderQueryResult = SearchProviderHit[] | { hits?: SearchProviderHit[] };

/**
 * Documents the search provider query expansion context payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderQueryExpansionContext {
  query: string;
  mode: Exclude<ExtensionSearchMode, "keyword">;
  settings: PmSettings;
  [key: string]: unknown;
}

/**
 * Restricts search provider query expansion result values accepted by command, SDK, and storage contracts.
 */
export type SearchProviderQueryExpansionResult = string[] | { queries?: string[] };

/**
 * Documents the search provider rerank candidate payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderRerankCandidate {
  id: string;
  text: string;
  score: number;
}

/**
 * Documents the search provider rerank hit payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderRerankHit {
  id: string;
  score: number;
}

/**
 * Restricts search provider rerank result values accepted by command, SDK, and storage contracts.
 */
export type SearchProviderRerankResult = SearchProviderRerankHit[] | { hits?: SearchProviderRerankHit[] };

/**
 * Documents the search provider rerank context payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderRerankContext {
  query: string;
  mode: "hybrid";
  model: string;
  top_k: number;
  settings: PmSettings;
  candidates: SearchProviderRerankCandidate[];
  [key: string]: unknown;
}

/**
 * Documents the search provider embed batch context payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderEmbedBatchContext {
  inputs: string[];
  settings: PmSettings;
  model: string;
  [key: string]: unknown;
}

/**
 * Documents the search provider embed context payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderEmbedContext {
  input: string;
  settings: PmSettings;
  model: string;
  [key: string]: unknown;
}

/**
 * Documents the search provider definition payload exchanged by command, SDK, and package integrations.
 */
export interface SearchProviderDefinition {
  name: string;
  query?: (context: SearchProviderQueryContext) => SearchProviderQueryResult | Promise<SearchProviderQueryResult>;
  queryExpansion?: (
    context: SearchProviderQueryExpansionContext,
  ) => SearchProviderQueryExpansionResult | Promise<SearchProviderQueryExpansionResult>;
  query_expansion?: (
    context: SearchProviderQueryExpansionContext,
  ) => SearchProviderQueryExpansionResult | Promise<SearchProviderQueryExpansionResult>;
  rerank?: (context: SearchProviderRerankContext) => SearchProviderRerankResult | Promise<SearchProviderRerankResult>;
  embedBatch?: (context: SearchProviderEmbedBatchContext) => number[][] | Promise<number[][]>;
  embed_batch?: (context: SearchProviderEmbedBatchContext) => number[][] | Promise<number[][]>;
  embed?: (context: SearchProviderEmbedContext) => number[] | Promise<number[]>;
  [key: string]: unknown;
}

/**
 * Documents the vector store query hit payload exchanged by command, SDK, and package integrations.
 */
export interface VectorStoreQueryHit {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Documents the vector store query context payload exchanged by command, SDK, and package integrations.
 */
export interface VectorStoreQueryContext {
  vector: number[];
  limit: number;
  settings: PmSettings;
  [key: string]: unknown;
}

/**
 * Documents the vector store upsert point payload exchanged by command, SDK, and package integrations.
 */
export interface VectorStoreUpsertPoint {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Documents the vector store upsert context payload exchanged by command, SDK, and package integrations.
 */
export interface VectorStoreUpsertContext {
  points: VectorStoreUpsertPoint[];
  settings: PmSettings;
  [key: string]: unknown;
}

/**
 * Documents the vector store delete context payload exchanged by command, SDK, and package integrations.
 */
export interface VectorStoreDeleteContext {
  ids: string[];
  settings: PmSettings;
  [key: string]: unknown;
}

/**
 * Documents the vector store adapter definition payload exchanged by command, SDK, and package integrations.
 */
export interface VectorStoreAdapterDefinition {
  name: string;
  query?: (context: VectorStoreQueryContext) => VectorStoreQueryHit[] | Promise<VectorStoreQueryHit[]>;
  upsert?: (context: VectorStoreUpsertContext) => unknown | Promise<unknown>;
  delete?: (context: VectorStoreDeleteContext) => unknown | Promise<unknown>;
  [key: string]: unknown;
}

/**
 * Documents the registered extension command override payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionCommandOverride {
  layer: ExtensionLayer;
  name: string;
  command: string;
  run: CommandOverride;
}

/**
 * Documents the registered extension command handler payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionCommandHandler {
  layer: ExtensionLayer;
  name: string;
  command: string;
  run: CommandHandler;
}

/**
 * Documents the registered extension parser override payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionParserOverride {
  layer: ExtensionLayer;
  name: string;
  command: string;
  run: ParserOverride;
}

/**
 * Documents the registered extension preflight override payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionPreflightOverride {
  layer: ExtensionLayer;
  name: string;
  run: PreflightOverride;
}

/**
 * Documents the registered extension service override payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionServiceOverride {
  layer: ExtensionLayer;
  name: string;
  service: ExtensionServiceName;
  run: ServiceOverride;
}

/**
 * Documents the registered extension renderer override payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionRendererOverride {
  layer: ExtensionLayer;
  name: string;
  format: OutputRendererFormat;
  run: RendererOverride;
}

/**
 * Documents the extension command registry payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionCommandRegistry {
  overrides: RegisteredExtensionCommandOverride[];
  handlers: RegisteredExtensionCommandHandler[];
}

/**
 * Documents the extension parser registry payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionParserRegistry {
  overrides: RegisteredExtensionParserOverride[];
}

/**
 * Documents the extension preflight registry payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionPreflightRegistry {
  overrides: RegisteredExtensionPreflightOverride[];
}

/**
 * Documents the extension service registry payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionServiceRegistry {
  overrides: RegisteredExtensionServiceOverride[];
}

/**
 * Documents the extension renderer registry payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionRendererRegistry {
  overrides: RegisteredExtensionRendererOverride[];
}

/**
 * Documents the registered extension flag definitions payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionFlagDefinitions {
  layer: ExtensionLayer;
  name: string;
  target_command: string;
  flags: FlagDefinition[];
}

/**
 * Documents the registered extension command definition payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionCommandDefinition {
  layer: ExtensionLayer;
  name: string;
  source_package?: string;
  command: string;
  action: string;
  description?: string;
  intent?: string;
  examples: string[];
  failure_hints: string[];
  arguments: ExtensionCommandArgumentDefinition[];
}

/**
 * Documents the registered extension schema field definitions payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionSchemaFieldDefinitions {
  layer: ExtensionLayer;
  name: string;
  fields: SchemaFieldDefinition[];
}

/**
 * Documents the registered extension schema item type definitions payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionSchemaItemTypeDefinitions {
  layer: ExtensionLayer;
  name: string;
  types: SchemaItemTypeDefinition[];
}

/**
 * Documents the registered extension schema migration definition payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionSchemaMigrationDefinition {
  layer: ExtensionLayer;
  name: string;
  definition: SchemaMigrationDefinition;
  runtime_definition: SchemaMigrationDefinition;
}

/**
 * Documents the registered extension importer payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionImporter {
  layer: ExtensionLayer;
  name: string;
  importer: string;
}

/**
 * Documents the registered extension exporter payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionExporter {
  layer: ExtensionLayer;
  name: string;
  exporter: string;
}

/**
 * Documents the registered extension search provider payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionSearchProvider {
  layer: ExtensionLayer;
  name: string;
  definition: SearchProviderDefinition;
  runtime_definition: SearchProviderDefinition;
}

/**
 * Documents the registered extension vector store adapter payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExtensionVectorStoreAdapter {
  layer: ExtensionLayer;
  name: string;
  definition: VectorStoreAdapterDefinition;
  runtime_definition: VectorStoreAdapterDefinition;
}

/**
 * Documents the extension registration registry payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionRegistrationRegistry {
  commands: RegisteredExtensionCommandDefinition[];
  flags: RegisteredExtensionFlagDefinitions[];
  item_fields: RegisteredExtensionSchemaFieldDefinitions[];
  item_types: RegisteredExtensionSchemaItemTypeDefinitions[];
  migrations: RegisteredExtensionSchemaMigrationDefinition[];
  importers: RegisteredExtensionImporter[];
  exporters: RegisteredExtensionExporter[];
  search_providers: RegisteredExtensionSearchProvider[];
  vector_store_adapters: RegisteredExtensionVectorStoreAdapter[];
}

/**
 * Documents the extension registration counts payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionRegistrationCounts {
  commands: number;
  flags: number;
  item_fields: number;
  item_types: number;
  migrations: number;
  importers: number;
  exporters: number;
  search_providers: number;
  vector_store_adapters: number;
}

/**
 * Read-only identity an extension's `activate(api)` receives about itself, so
 * authors can emit self-identifying logs, gate on their own version, and build
 * better error messages without re-reading the on-disk manifest or duplicating
 * metadata in-module. Exposed as `api.extension`.
 */
export interface ExtensionSelfIdentity {
  readonly name: string;
  readonly layer: ExtensionLayer;
  readonly version: string;
  readonly capabilities: readonly ExtensionCapability[];
  readonly pm_min_version?: string;
  readonly pm_max_version?: string;
  readonly source_package?: string;
}

/**
 * Documents the extension api payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionApi {
  /** Read-only identity of the extension this `api` was created for. */
  readonly extension: ExtensionSelfIdentity;
  registerCommand(command: string, override: CommandOverride): void;
  registerCommand(definition: CommandDefinition): void;
  registerParser(command: string, override: ParserOverride): void;
  registerPreflight(override: PreflightOverride): void;
  registerService(service: ExtensionServiceName, override: ServiceOverride): void;
  registerFlags(targetCommand: string, flags: FlagDefinition[]): void;
  registerItemFields(fields: SchemaFieldDefinition[]): void;
  registerItemTypes(types: SchemaItemTypeDefinition[]): void;
  registerMigration(definition: SchemaMigrationDefinition): void;
  registerRenderer(format: OutputRendererFormat, renderer: RendererOverride): void;
  registerImporter(name: string, importer: Importer, options?: ImportExportRegistrationOptions): void;
  registerExporter(name: string, exporter: Exporter, options?: ImportExportRegistrationOptions): void;
  registerSearchProvider(provider: SearchProviderDefinition): void;
  registerVectorStoreAdapter(adapter: VectorStoreAdapterDefinition): void;
  hooks: {
    beforeCommand(hook: BeforeCommandHook): void;
    afterCommand(hook: AfterCommandHook): void;
    onWrite(hook: OnWriteHook): void;
    onRead(hook: OnReadHook): void;
    onIndex(hook: OnIndexHook): void;
  };
}

/**
 * Documents the failed extension activation payload exchanged by command, SDK, and package integrations.
 */
export interface FailedExtensionActivation {
  layer: ExtensionLayer;
  name: string;
  entry_path: string;
  error: string;
  trace?: ExtensionActivationFailureTrace;
}

/**
 * Documents the extension activation failure trace payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionActivationFailureTrace {
  method: string;
  /** `-1` means the failure happened before a numbered registration was accepted. */
  registration_index: number;
  command?: string;
  capability?: ExtensionCapability;
  missing_capability?: ExtensionCapability;
  expected_schema: string;
  received?: unknown;
  hint?: string;
}

/**
 * Documents the extension activation result payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionActivationResult {
  hooks: ExtensionHookRegistry;
  commands: ExtensionCommandRegistry;
  parsers: ExtensionParserRegistry;
  preflight: ExtensionPreflightRegistry;
  services: ExtensionServiceRegistry;
  renderers: ExtensionRendererRegistry;
  registrations: ExtensionRegistrationRegistry;
  failed: FailedExtensionActivation[];
  warnings: string[];
  hook_counts: {
    before_command: number;
    after_command: number;
    on_write: number;
    on_read: number;
    on_index: number;
  };
  command_override_count: number;
  command_handler_count: number;
  parser_override_count: number;
  preflight_override_count: number;
  service_override_count: number;
  renderer_override_count: number;
  registration_counts: ExtensionRegistrationCounts;
}

/**
 * Documents the extension candidate payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionCandidate {
  layer: ExtensionLayer;
  directory: string;
  manifest_path: string;
  entry_path: string;
  manifest: ExtensionManifest;
  source_package?: string;
}

/**
 * Documents the extension layer scan result payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionLayerScanResult {
  diagnostics: ExtensionDiagnostic[];
  warnings: string[];
  candidates: ExtensionCandidate[];
}

/**
 * Documents the scanned extension directory payload exchanged by command, SDK, and package integrations.
 */
export interface ScannedExtensionDirectory {
  diagnostic: ExtensionDiagnostic;
  warnings: string[];
  candidate: ExtensionCandidate | null;
}

/**
 * Documents the legacy extension capability alias mapping payload exchanged by command, SDK, and package integrations.
 */
export interface LegacyExtensionCapabilityAliasMapping {
  alias: string;
  target: ExtensionCapability;
}

/**
 * Documents the discover extensions options payload exchanged by command, SDK, and package integrations.
 */
export interface DiscoverExtensionsOptions {
  pmRoot: string;
  settings: PmSettings;
  cwd?: string;
  noExtensions?: boolean;
  reload_token?: string;
  cache_bust?: boolean;
}

/**
 * Documents the activatable extension payload exchanged by command, SDK, and package integrations.
 */
export interface ActivatableExtension {
  activate: (api: ExtensionApi) => void | Promise<void>;
  /**
   * Optional teardown lifecycle hook, analogous to VS Code's `deactivate`
   * export. Invoked when the host tears the extension down — on long-running
   * MCP-server reload between requests, or via the `deactivateExtensions`
   * primitive — so an extension can close connections, clear timers, and
   * release buffers it opened during `activate`.
   */
  deactivate?: () => void | Promise<void>;
}

/**
 * Documents the extension deactivation failure payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionDeactivationFailure {
  layer: ExtensionLayer;
  name: string;
  error: string;
}

/**
 * Documents the extension deactivation options payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionDeactivationOptions {
  /**
   * Maximum time to wait for each extension's `deactivate` hook. Defaults to
   * 5000ms so a hanging teardown cannot block host shutdown or reload. Set to
   * 0 or Infinity only when the host intentionally wants to wait indefinitely.
   */
  deactivate_timeout_ms?: number;
}

/**
 * Documents the extension deactivation result payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionDeactivationResult {
  /** Count of loaded extensions whose `deactivate` hook ran without throwing. */
  deactivated: number;
  warnings: string[];
  failed: ExtensionDeactivationFailure[];
}

/**
 * Documents the service override result payload exchanged by command, SDK, and package integrations.
 */
export interface ServiceOverrideResult {
  handled: boolean;
  result: unknown;
  warnings: string[];
}

/**
 * Documents the command override result payload exchanged by command, SDK, and package integrations.
 */
export interface CommandOverrideResult {
  overridden: boolean;
  result: unknown;
  warnings: string[];
}

/**
 * Documents the command handler result payload exchanged by command, SDK, and package integrations.
 */
export interface CommandHandlerResult {
  handled: boolean;
  result: unknown;
  warnings: string[];
  /**
   * Human-readable, single-line, length-bounded message describing why an
   * extension command handler failed. Surfaced to the user/CI so the real cause
   * (e.g. "Changelog is out of date: CHANGELOG.md") is visible instead of only
   * the opaque `extension_command_handler_failed` warning code.
   */
  errorMessage?: string;
}

/**
 * Documents the parser override result payload exchanged by command, SDK, and package integrations.
 */
export interface ParserOverrideResult {
  overridden: boolean;
  context: CommandHandlerContext;
  warnings: string[];
}

/**
 * Documents the preflight override result payload exchanged by command, SDK, and package integrations.
 */
export interface PreflightOverrideResult {
  overridden: boolean;
  context: CommandHandlerContext;
  decision: PreflightRuntimeDecision;
  warnings: string[];
}

/**
 * Documents the renderer override result payload exchanged by command, SDK, and package integrations.
 */
export interface RendererOverrideResult {
  overridden: boolean;
  rendered: string | null;
  warnings: string[];
}

/**
 * Documents the unknown extension capability warning details payload exchanged by command, SDK, and package integrations.
 */
export interface UnknownExtensionCapabilityWarningDetails {
  layer: ExtensionLayer;
  name: string;
  capability: string;
  allowed_capabilities: string[];
  capability_contract_version: number;
  suggested_capability?: string;
  suggestion_source?: "legacy_alias" | "nearest_match";
  legacy_alias_target?: string;
}
