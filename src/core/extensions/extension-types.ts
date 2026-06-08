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
export type ExtensionPolicyMode = (typeof KNOWN_EXTENSION_POLICY_MODES)[number];
export const KNOWN_EXTENSION_TRUST_MODES = ["off", "warn", "enforce"] as const;
export type ExtensionTrustMode = (typeof KNOWN_EXTENSION_TRUST_MODES)[number];
export const KNOWN_EXTENSION_SANDBOX_PROFILES = ["none", "restricted", "strict"] as const;
export type ExtensionSandboxProfile = (typeof KNOWN_EXTENSION_SANDBOX_PROFILES)[number];

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
export type ExtensionServiceName = (typeof KNOWN_EXTENSION_SERVICE_NAMES)[number];

export interface ExtensionProvenanceMetadata {
  source?: string;
  signature?: string;
  attestation?: string;
  verified?: boolean;
}

export interface ExtensionRuntimePermissionDeclaration {
  fs_read?: boolean;
  fs_write?: boolean;
  network?: boolean;
  env_read?: boolean;
  env_write?: boolean;
  process_spawn?: boolean;
}

export interface ExtensionActivationMetadata {
  commands?: string[];
}

export type ExtensionPolicyOverride = ExtensionPolicyOverrideSettings;
export type ExtensionGovernancePolicy = ExtensionPolicySettings;

export interface ExtensionManifestEngines {
  pm?: string;
  node?: string;
  [engine: string]: string | undefined;
}

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

export type ExtensionLayer = "global" | "project";
export type ExtensionStatus = "ok" | "warn";

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

export interface LoadedExtension extends EffectiveExtension {
  module: unknown;
}

export interface FailedExtensionLoad {
  layer: ExtensionLayer;
  name: string;
  entry_path: string;
  error: string;
}

export interface ExtensionLoadResult extends ExtensionDiscoveryResult {
  loaded: LoadedExtension[];
  failed: FailedExtensionLoad[];
}

export interface BeforeCommandHookContext {
  command: string;
  args: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root: string;
}

export interface AfterCommandHookContext extends BeforeCommandHookContext {
  ok: boolean;
  error?: string;
  result?: unknown;
  affected?: AfterCommandAffectedItem[];
}

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

export interface OnReadHookContext {
  path: string;
  scope: "project" | "global";
}

export interface OnIndexHookContext {
  mode: string;
  total_items?: number;
}

export type BeforeCommandHook = (context: BeforeCommandHookContext) => Promise<void> | void;
export type AfterCommandHook = (context: AfterCommandHookContext) => Promise<void> | void;
export type OnWriteHook = (context: OnWriteHookContext) => Promise<void> | void;
export type OnReadHook = (context: OnReadHookContext) => Promise<void> | void;
export type OnIndexHook = (context: OnIndexHookContext) => Promise<void> | void;
export type OutputRendererFormat = "toon" | "json";
export type CommandOverride = (context: CommandOverrideContext) => unknown;
export type RendererOverride = (context: RendererOverrideContext) => string | null | undefined;
export type CommandHandler = (context: CommandHandlerContext) => unknown;
export type ParserOverride = (context: ParserOverrideContext) => ParserOverrideDelta | Promise<ParserOverrideDelta>;
export type PreflightOverride = (context: PreflightOverrideContext) => PreflightOverrideDelta | Promise<PreflightOverrideDelta>;
export type ServiceOverride = (context: ServiceOverrideContext) => unknown;

export interface RegisteredExtensionHook<THook> {
  layer: ExtensionLayer;
  name: string;
  run: THook;
}

export interface ExtensionHookRegistry {
  beforeCommand: Array<RegisteredExtensionHook<BeforeCommandHook>>;
  afterCommand: Array<RegisteredExtensionHook<AfterCommandHook>>;
  onWrite: Array<RegisteredExtensionHook<OnWriteHook>>;
  onRead: Array<RegisteredExtensionHook<OnReadHook>>;
  onIndex: Array<RegisteredExtensionHook<OnIndexHook>>;
}

export interface CommandOverrideContext {
  command: string;
  args: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root: string;
  result: unknown;
}

export interface RendererOverrideContext {
  format: OutputRendererFormat;
  command?: string;
  args?: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root?: string;
  result: unknown;
}

export interface CommandHandlerContext {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
  pm_root: string;
}

export interface ParserOverrideContext extends CommandHandlerContext {}

export interface ParserOverrideDelta {
  args?: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
}

export interface PreflightOverrideContext extends CommandHandlerContext {
  decision: PreflightRuntimeDecision;
}

export interface PreflightRuntimeDecision {
  enforce_item_format_gate: boolean;
  run_preflight_item_format_sync: boolean;
  run_extension_migrations: boolean;
  enforce_mandatory_migration_gate: boolean;
}

export interface PreflightOverrideDelta extends ParserOverrideDelta {
  enforce_item_format_gate?: boolean;
  run_preflight_item_format_sync?: boolean;
  run_extension_migrations?: boolean;
  enforce_mandatory_migration_gate?: boolean;
}

export interface ServiceOverrideContext {
  service: ExtensionServiceName;
  command?: string;
  args?: string[];
  options?: Record<string, unknown>;
  global?: GlobalOptions;
  pm_root?: string;
  payload: unknown;
}

export interface ExtensionCommandArgumentDefinition {
  name: string;
  required?: boolean;
  variadic?: boolean;
  description?: string;
}

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

export type FlagValueType = "string" | "number" | "boolean";

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
   * contracts and help output.
   */
  default?: string | number | boolean;
  [key: string]: unknown;
}

export interface SchemaFieldDefinition {
  name: string;
  type: string;
  optional?: boolean;
  [key: string]: unknown;
}

export interface SchemaItemTypeCommandOptionPolicyDefinition {
  command: string;
  option: string;
  enabled?: boolean;
  required?: boolean;
  visible?: boolean;
  [key: string]: unknown;
}

export interface SchemaItemTypeOptionDefinition {
  key: string;
  values?: string[];
  required?: boolean;
  aliases?: string[];
  [key: string]: unknown;
}

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

export interface SchemaMigrationRunContext {
  id: string;
  command: "migration";
  layer: ExtensionLayer;
  extension: string;
  pm_root: string;
  status: string;
}

export type SchemaMigrationRunner = (context: SchemaMigrationRunContext) => unknown | Promise<unknown>;

export interface SchemaMigrationDefinition {
  id?: string;
  description?: string;
  status?: string;
  mandatory?: boolean;
  run?: SchemaMigrationRunner;
  [key: string]: unknown;
}

export interface ImportExportContext {
  registration: string;
  action: "import" | "export";
  command: string;
  args: string[];
  options: Record<string, unknown>;
  global: GlobalOptions;
  pm_root: string;
}

export type Importer = (context: ImportExportContext) => unknown | Promise<unknown>;
export type Exporter = (context: ImportExportContext) => unknown | Promise<unknown>;

export type ExtensionSearchMode = "keyword" | "semantic" | "hybrid";

export interface SearchProviderQueryContext {
  query: string;
  mode: ExtensionSearchMode;
  tokens: string[];
  options: Record<string, unknown>;
  settings: PmSettings;
  documents: ItemDocument[];
  [key: string]: unknown;
}

export interface SearchProviderHit {
  id: string;
  score: number;
  matched_fields?: string[];
  [key: string]: unknown;
}

export type SearchProviderQueryResult = SearchProviderHit[] | { hits?: SearchProviderHit[] };

export interface SearchProviderQueryExpansionContext {
  query: string;
  mode: Exclude<ExtensionSearchMode, "keyword">;
  settings: PmSettings;
  [key: string]: unknown;
}

export type SearchProviderQueryExpansionResult = string[] | { queries?: string[] };

export interface SearchProviderRerankCandidate {
  id: string;
  text: string;
  score: number;
}

export interface SearchProviderRerankHit {
  id: string;
  score: number;
}

export type SearchProviderRerankResult = SearchProviderRerankHit[] | { hits?: SearchProviderRerankHit[] };

export interface SearchProviderRerankContext {
  query: string;
  mode: "hybrid";
  model: string;
  top_k: number;
  settings: PmSettings;
  candidates: SearchProviderRerankCandidate[];
  [key: string]: unknown;
}

export interface SearchProviderEmbedBatchContext {
  inputs: string[];
  settings: PmSettings;
  model: string;
  [key: string]: unknown;
}

export interface SearchProviderEmbedContext {
  input: string;
  settings: PmSettings;
  model: string;
  [key: string]: unknown;
}

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

export interface VectorStoreQueryHit {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VectorStoreQueryContext {
  vector: number[];
  limit: number;
  settings: PmSettings;
  [key: string]: unknown;
}

export interface VectorStoreUpsertPoint {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface VectorStoreUpsertContext {
  points: VectorStoreUpsertPoint[];
  settings: PmSettings;
  [key: string]: unknown;
}

export interface VectorStoreDeleteContext {
  ids: string[];
  settings: PmSettings;
  [key: string]: unknown;
}

export interface VectorStoreAdapterDefinition {
  name: string;
  query?: (context: VectorStoreQueryContext) => VectorStoreQueryHit[] | Promise<VectorStoreQueryHit[]>;
  upsert?: (context: VectorStoreUpsertContext) => unknown | Promise<unknown>;
  delete?: (context: VectorStoreDeleteContext) => unknown | Promise<unknown>;
  [key: string]: unknown;
}

export interface RegisteredExtensionCommandOverride {
  layer: ExtensionLayer;
  name: string;
  command: string;
  run: CommandOverride;
}

export interface RegisteredExtensionCommandHandler {
  layer: ExtensionLayer;
  name: string;
  command: string;
  run: CommandHandler;
}

export interface RegisteredExtensionParserOverride {
  layer: ExtensionLayer;
  name: string;
  command: string;
  run: ParserOverride;
}

export interface RegisteredExtensionPreflightOverride {
  layer: ExtensionLayer;
  name: string;
  run: PreflightOverride;
}

export interface RegisteredExtensionServiceOverride {
  layer: ExtensionLayer;
  name: string;
  service: ExtensionServiceName;
  run: ServiceOverride;
}

export interface RegisteredExtensionRendererOverride {
  layer: ExtensionLayer;
  name: string;
  format: OutputRendererFormat;
  run: RendererOverride;
}

export interface ExtensionCommandRegistry {
  overrides: RegisteredExtensionCommandOverride[];
  handlers: RegisteredExtensionCommandHandler[];
}

export interface ExtensionParserRegistry {
  overrides: RegisteredExtensionParserOverride[];
}

export interface ExtensionPreflightRegistry {
  overrides: RegisteredExtensionPreflightOverride[];
}

export interface ExtensionServiceRegistry {
  overrides: RegisteredExtensionServiceOverride[];
}

export interface ExtensionRendererRegistry {
  overrides: RegisteredExtensionRendererOverride[];
}

export interface RegisteredExtensionFlagDefinitions {
  layer: ExtensionLayer;
  name: string;
  target_command: string;
  flags: FlagDefinition[];
}

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

export interface RegisteredExtensionSchemaFieldDefinitions {
  layer: ExtensionLayer;
  name: string;
  fields: SchemaFieldDefinition[];
}

export interface RegisteredExtensionSchemaItemTypeDefinitions {
  layer: ExtensionLayer;
  name: string;
  types: SchemaItemTypeDefinition[];
}

export interface RegisteredExtensionSchemaMigrationDefinition {
  layer: ExtensionLayer;
  name: string;
  definition: SchemaMigrationDefinition;
  runtime_definition: SchemaMigrationDefinition;
}

export interface RegisteredExtensionImporter {
  layer: ExtensionLayer;
  name: string;
  importer: string;
}

export interface RegisteredExtensionExporter {
  layer: ExtensionLayer;
  name: string;
  exporter: string;
}

export interface RegisteredExtensionSearchProvider {
  layer: ExtensionLayer;
  name: string;
  definition: SearchProviderDefinition;
  runtime_definition: SearchProviderDefinition;
}

export interface RegisteredExtensionVectorStoreAdapter {
  layer: ExtensionLayer;
  name: string;
  definition: VectorStoreAdapterDefinition;
  runtime_definition: VectorStoreAdapterDefinition;
}

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
  name: string;
  layer: ExtensionLayer;
  version: string;
  capabilities: ExtensionCapability[];
  pm_min_version?: string;
  pm_max_version?: string;
  source_package?: string;
}

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

export interface FailedExtensionActivation {
  layer: ExtensionLayer;
  name: string;
  entry_path: string;
  error: string;
  trace?: ExtensionActivationFailureTrace;
}

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

export interface ExtensionCandidate {
  layer: ExtensionLayer;
  directory: string;
  manifest_path: string;
  entry_path: string;
  manifest: ExtensionManifest;
  source_package?: string;
}

export interface ExtensionLayerScanResult {
  diagnostics: ExtensionDiagnostic[];
  warnings: string[];
  candidates: ExtensionCandidate[];
}

export interface ScannedExtensionDirectory {
  diagnostic: ExtensionDiagnostic;
  warnings: string[];
  candidate: ExtensionCandidate | null;
}

export interface LegacyExtensionCapabilityAliasMapping {
  alias: string;
  target: ExtensionCapability;
}

export interface DiscoverExtensionsOptions {
  pmRoot: string;
  settings: PmSettings;
  cwd?: string;
  noExtensions?: boolean;
  reload_token?: string;
  cache_bust?: boolean;
}

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

export interface ExtensionDeactivationFailure {
  layer: ExtensionLayer;
  name: string;
  error: string;
}

export interface ExtensionDeactivationResult {
  /** Count of loaded extensions whose `deactivate` hook ran without throwing. */
  deactivated: number;
  warnings: string[];
  failed: ExtensionDeactivationFailure[];
}

export interface ServiceOverrideResult {
  handled: boolean;
  result: unknown;
  warnings: string[];
}

export interface CommandOverrideResult {
  overridden: boolean;
  result: unknown;
  warnings: string[];
}

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

export interface ParserOverrideResult {
  overridden: boolean;
  context: CommandHandlerContext;
  warnings: string[];
}

export interface PreflightOverrideResult {
  overridden: boolean;
  context: CommandHandlerContext;
  decision: PreflightRuntimeDecision;
  warnings: string[];
}

export interface RendererOverrideResult {
  overridden: boolean;
  rendered: string | null;
  warnings: string[];
}

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
