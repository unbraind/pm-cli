import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pathExists } from "../fs/fs-utils.js";
import { resolveGlobalPmRoot } from "../store/paths.js";
import type { ItemDocument, PmSettings } from "../../types/index.js";
import type { GlobalOptions } from "../shared/command-types.js";

const DEFAULT_EXTENSION_PRIORITY = 100;
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
type ExtensionCapability = (typeof KNOWN_EXTENSION_CAPABILITIES)[number];
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

export type ExtensionLayer = "global" | "project";
type ExtensionStatus = "ok" | "warn";

export interface ExtensionManifest {
  name: string;
  version: string;
  entry: string;
  priority: number;
  capabilities: string[];
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
  version: string;
  entry: string;
  priority: number;
  entry_path: string;
  capabilities?: string[];
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
}

export interface OnWriteHookContext {
  path: string;
  scope: "project" | "global";
  op: string;
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
export type RendererOverride = (context: RendererOverrideContext) => string;
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

export type ExtensionServiceName =
  | "output_format"
  | "error_format"
  | "help_format"
  | "lock_acquire"
  | "lock_release"
  | "history_append"
  | "item_store_write"
  | "item_store_delete";

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

export type FlagValueType = "string" | "number" | "boolean";

export interface FlagDefinition {
  long?: string;
  short?: string;
  value_name?: string;
  description?: string;
  required?: boolean;
  enabled?: boolean;
  visible?: boolean;
  type?: FlagValueType;
  value_type?: FlagValueType;
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

export interface ExtensionApi {
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
  registerImporter(name: string, importer: Importer): void;
  registerExporter(name: string, exporter: Exporter): void;
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
  registration_index: number;
  command?: string;
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

interface ExtensionCandidate {
  layer: ExtensionLayer;
  directory: string;
  manifest_path: string;
  entry_path: string;
  manifest: ExtensionManifest;
}

interface ExtensionLayerScanResult {
  diagnostics: ExtensionDiagnostic[];
  warnings: string[];
  candidates: ExtensionCandidate[];
}

interface ScannedExtensionDirectory {
  diagnostic: ExtensionDiagnostic;
  warnings: string[];
  candidate: ExtensionCandidate | null;
}

export interface LegacyExtensionCapabilityAliasMapping {
  alias: string;
  target: ExtensionCapability;
}

function normalizeNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function isKnownExtensionCapability(value: string): value is ExtensionCapability {
  return (KNOWN_EXTENSION_CAPABILITIES as readonly string[]).includes(value);
}

function collectUnknownExtensionCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.filter((capability) => !isKnownExtensionCapability(capability));
}

function resolveLegacyExtensionCapabilityAlias(capability: string): ExtensionCapability | null {
  const normalized = capability.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  return EXTENSION_CAPABILITY_LEGACY_ALIASES[normalized] ?? null;
}

function normalizeManifestCapabilities(rawCapabilities: readonly string[]): {
  capabilities: string[];
  legacy_aliases: LegacyExtensionCapabilityAliasMapping[];
} {
  const normalizedCapabilities = normalizeNames([...rawCapabilities].map((value) => value.toLowerCase()));
  const remappedCapabilities: string[] = [];
  const legacyAliases: LegacyExtensionCapabilityAliasMapping[] = [];
  for (const capability of normalizedCapabilities) {
    const legacyAliasTarget = resolveLegacyExtensionCapabilityAlias(capability);
    if (legacyAliasTarget) {
      remappedCapabilities.push(legacyAliasTarget);
      legacyAliases.push({
        alias: capability,
        target: legacyAliasTarget,
      });
      continue;
    }
    remappedCapabilities.push(capability);
  }
  const dedupedLegacyAliases = [...new Map(legacyAliases.map((entry) => [`${entry.alias}>${entry.target}`, entry])).values()].sort(
    (left, right) => left.alias.localeCompare(right.alias),
  );
  return {
    capabilities: normalizeNames(remappedCapabilities),
    legacy_aliases: dedupedLegacyAliases,
  };
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }
  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[right.length] ?? left.length;
}

function suggestKnownExtensionCapability(capability: string): string | null {
  const normalized = capability.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const legacyAlias = resolveLegacyExtensionCapabilityAlias(normalized);
  if (legacyAlias) {
    return legacyAlias;
  }
  let bestMatch: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of KNOWN_EXTENSION_CAPABILITIES) {
    const distance = levenshteinDistance(normalized, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }
  const maxDistance = Math.max(1, Math.floor(normalized.length * 0.34));
  return bestMatch !== null && bestDistance <= maxDistance ? bestMatch : null;
}

function formatUnknownExtensionCapabilityWarning(layer: ExtensionLayer, name: string, capability: string): string {
  const allowed = KNOWN_EXTENSION_CAPABILITIES.join(",");
  const suggested = suggestKnownExtensionCapability(capability) ?? "none";
  return `extension_capability_unknown:${layer}:${name}:${capability}:allowed=${allowed}:suggested=${suggested}`;
}

function formatLegacyExtensionCapabilityAliasWarning(
  layer: ExtensionLayer,
  name: string,
  aliases: readonly LegacyExtensionCapabilityAliasMapping[],
): string {
  const aliasesToken = aliases.map((entry) => `${entry.alias}>${entry.target}`).join(",");
  return `extension_capability_legacy_alias:${layer}:${name}:aliases=${aliasesToken}`;
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

export function parseUnknownExtensionCapabilityWarning(
  warning: string,
): UnknownExtensionCapabilityWarningDetails | null {
  const match = /^extension_capability_unknown:(global|project):([^:]+):([^:]+):allowed=([^:]+):suggested=([^:]+)$/.exec(
    warning.trim(),
  );
  if (!match) {
    return null;
  }
  const [, layerRaw, name, capability, allowedRaw, suggestedRaw] = match;
  const layer = layerRaw as ExtensionLayer;
  const allowed_capabilities = allowedRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const legacyAlias = resolveLegacyExtensionCapabilityAlias(capability);
  const suggestedFromWarning = suggestedRaw === "none" ? undefined : suggestedRaw;
  const suggested_capability = suggestedFromWarning ?? legacyAlias ?? undefined;
  const suggestion_source = suggested_capability
    ? legacyAlias === suggested_capability
      ? "legacy_alias"
      : "nearest_match"
    : undefined;
  return {
    layer,
    name,
    capability,
    allowed_capabilities,
    capability_contract_version: EXTENSION_CAPABILITY_CONTRACT_VERSION,
    suggested_capability,
    suggestion_source,
    legacy_alias_target: legacyAlias ?? undefined,
  };
}

export function parseLegacyExtensionCapabilityAliasWarning(warning: string): UnknownExtensionCapabilityWarningDetails[] {
  const match = /^extension_capability_legacy_alias:(global|project):([^:]+):aliases=(.+)$/.exec(warning.trim());
  if (!match) {
    return [];
  }
  const [, layerRaw, name, aliasesRaw] = match;
  const layer = layerRaw as ExtensionLayer;
  const allowedCapabilities = [...KNOWN_EXTENSION_CAPABILITIES];
  const parsed: UnknownExtensionCapabilityWarningDetails[] = [];
  for (const token of aliasesRaw.split(",")) {
    const [rawAlias, rawTarget] = token.split(">");
    const alias = rawAlias?.trim();
    const target = rawTarget?.trim().toLowerCase();
    if (!alias || !target || !isKnownExtensionCapability(target)) {
      continue;
    }
    parsed.push({
      layer,
      name,
      capability: alias,
      allowed_capabilities: allowedCapabilities,
      capability_contract_version: EXTENSION_CAPABILITY_CONTRACT_VERSION,
      suggested_capability: target,
      suggestion_source: "legacy_alias",
      legacy_alias_target: target,
    });
  }
  return parsed;
}

function parseManifest(raw: unknown): ExtensionManifest | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    return null;
  }
  if (typeof candidate.version !== "string" || candidate.version.trim().length === 0) {
    return null;
  }
  if (typeof candidate.entry !== "string" || candidate.entry.trim().length === 0) {
    return null;
  }

  let priority = DEFAULT_EXTENSION_PRIORITY;
  if ("priority" in candidate && candidate.priority !== undefined && candidate.priority !== null) {
    if (typeof candidate.priority !== "number" || !Number.isInteger(candidate.priority)) {
      return null;
    }
    priority = candidate.priority;
  }

  let capabilities: string[] = [];
  let legacyCapabilityAliases: LegacyExtensionCapabilityAliasMapping[] = [];
  if ("capabilities" in candidate && candidate.capabilities !== undefined && candidate.capabilities !== null) {
    if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((value) => typeof value !== "string")) {
      return null;
    }
    const normalizedCapabilities = normalizeManifestCapabilities(candidate.capabilities as string[]);
    capabilities = normalizedCapabilities.capabilities;
    legacyCapabilityAliases = normalizedCapabilities.legacy_aliases;
  }

  return {
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    entry: candidate.entry.trim(),
    priority,
    capabilities,
    legacy_capability_aliases: legacyCapabilityAliases.length > 0 ? legacyCapabilityAliases : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function shouldEnable(name: string, enabled: Set<string>, disabled: Set<string>): boolean {
  if (disabled.has(name)) {
    return false;
  }
  if (enabled.size === 0) {
    return true;
  }
  return enabled.has(name);
}

function isPathWithinDirectory(directory: string, targetPath: string): boolean {
  const relative = path.relative(directory, targetPath);
  if (relative.length === 0) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function isCanonicalPathWithinDirectory(directory: string, targetPath: string): Promise<boolean> {
  const [resolvedDirectory, resolvedTargetPath] = await Promise.all([fs.realpath(directory), fs.realpath(targetPath)]);
  return isPathWithinDirectory(resolvedDirectory, resolvedTargetPath);
}

export function resolveExtensionRoots(pmRoot: string, cwd = process.cwd()): { global: string; project: string } {
  return {
    global: path.join(resolveGlobalPmRoot(cwd), "extensions"),
    project: path.join(pmRoot, "extensions"),
  };
}

export function createEmptyExtensionHookRegistry(): ExtensionHookRegistry {
  return {
    beforeCommand: [],
    afterCommand: [],
    onWrite: [],
    onRead: [],
    onIndex: [],
  };
}

export function createEmptyExtensionCommandRegistry(): ExtensionCommandRegistry {
  return {
    overrides: [],
    handlers: [],
  };
}

export function createEmptyExtensionParserRegistry(): ExtensionParserRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionPreflightRegistry(): ExtensionPreflightRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionServiceRegistry(): ExtensionServiceRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionRendererRegistry(): ExtensionRendererRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionRegistrationRegistry(): ExtensionRegistrationRegistry {
  return {
    commands: [],
    flags: [],
    item_fields: [],
    item_types: [],
    migrations: [],
    importers: [],
    exporters: [],
    search_providers: [],
    vector_store_adapters: [],
  };
}

async function listExtensionDirectories(extensionsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function summarizeCandidate(candidate: ExtensionCandidate): EffectiveExtension {
  return {
    layer: candidate.layer,
    directory: candidate.directory,
    manifest_path: candidate.manifest_path,
    name: candidate.manifest.name,
    version: candidate.manifest.version,
    entry: candidate.manifest.entry,
    priority: candidate.manifest.priority,
    entry_path: candidate.entry_path,
    capabilities: [...candidate.manifest.capabilities],
  };
}

function sortCandidates(candidates: ExtensionCandidate[]): ExtensionCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.manifest.priority !== right.manifest.priority) {
      return left.manifest.priority - right.manifest.priority;
    }
    const byName = left.manifest.name.localeCompare(right.manifest.name);
    if (byName !== 0) {
      return byName;
    }
    return left.directory.localeCompare(right.directory);
  });
}

function buildEffectiveExtensions(
  globalCandidates: ExtensionCandidate[],
  projectCandidates: ExtensionCandidate[],
): ExtensionCandidate[] {
  const ordered = [...sortCandidates(globalCandidates), ...sortCandidates(projectCandidates)];
  const effective: ExtensionCandidate[] = [];
  for (const candidate of ordered) {
    const existingIndex = effective.findIndex((entry) => entry.manifest.name === candidate.manifest.name);
    if (existingIndex >= 0) {
      effective.splice(existingIndex, 1);
    }
    effective.push(candidate);
  }
  return effective;
}

async function scanExtensionLayer(
  layer: ExtensionLayer,
  extensionsRoot: string,
  enabled: Set<string>,
  disabled: Set<string>,
): Promise<ExtensionLayerScanResult> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const warnings: string[] = [];
  const candidates: ExtensionCandidate[] = [];
  const directories = await listExtensionDirectories(extensionsRoot);

  for (const directory of directories) {
    const scanned = await scanExtensionDirectory(layer, extensionsRoot, directory, enabled, disabled);
    diagnostics.push(scanned.diagnostic);
    warnings.push(...scanned.warnings);
    if (scanned.candidate) {
      candidates.push(scanned.candidate);
    }
  }

  return { diagnostics, warnings, candidates };
}

async function scanExtensionDirectory(
  layer: ExtensionLayer,
  extensionsRoot: string,
  directory: string,
  enabled: Set<string>,
  disabled: Set<string>,
): Promise<ScannedExtensionDirectory> {
  const extensionDir = path.join(extensionsRoot, directory);
  const manifestPath = path.join(extensionDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    return {
      diagnostic: {
        layer,
        directory,
        manifest_path: manifestPath,
        name: null,
        version: null,
        entry: null,
        priority: null,
        entry_path: null,
        enabled: null,
        status: "warn",
      },
      warnings: [`extension_manifest_missing:${layer}:${directory}`],
      candidate: null,
    };
  }

  let manifest: ExtensionManifest | null = null;
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    manifest = parseManifest(parsed);
  } catch {
    manifest = null;
  }

  if (!manifest) {
    return {
      diagnostic: {
        layer,
        directory,
        manifest_path: manifestPath,
        name: null,
        version: null,
        entry: null,
        priority: null,
        entry_path: null,
        enabled: null,
        status: "warn",
      },
      warnings: [`extension_manifest_invalid:${layer}:${directory}`],
      candidate: null,
    };
  }

  const entryPath = path.resolve(extensionDir, manifest.entry);
  const entryWithinDirectoryByPath = isPathWithinDirectory(extensionDir, entryPath);
  const entryExists = entryWithinDirectoryByPath ? await pathExists(entryPath) : false;
  const entryWithinDirectory =
    entryWithinDirectoryByPath && entryExists
      ? await isCanonicalPathWithinDirectory(extensionDir, entryPath)
      : entryWithinDirectoryByPath;
  const enabledForLoad = shouldEnable(manifest.name, enabled, disabled);
  const extensionWarnings: string[] = [];
  if (Array.isArray(manifest.legacy_capability_aliases) && manifest.legacy_capability_aliases.length > 0) {
    extensionWarnings.push(
      formatLegacyExtensionCapabilityAliasWarning(layer, manifest.name, manifest.legacy_capability_aliases),
    );
  }
  for (const capability of collectUnknownExtensionCapabilities(manifest.capabilities)) {
    extensionWarnings.push(formatUnknownExtensionCapabilityWarning(layer, manifest.name, capability));
  }
  if (!entryWithinDirectory) {
    extensionWarnings.push(`extension_entry_outside_extension:${layer}:${manifest.name}`);
  } else if (!entryExists) {
    extensionWarnings.push(`extension_entry_missing:${layer}:${manifest.name}`);
  }

  return {
    diagnostic: {
      layer,
      directory,
      manifest_path: manifestPath,
      name: manifest.name,
      version: manifest.version,
      entry: manifest.entry,
      priority: manifest.priority,
      entry_path: entryPath,
      enabled: enabledForLoad,
      status: entryWithinDirectory && entryExists ? "ok" : "warn",
    },
    warnings: extensionWarnings,
    candidate:
      entryWithinDirectory && entryExists && enabledForLoad
        ? {
            layer,
            directory,
            manifest_path: manifestPath,
            entry_path: entryPath,
            manifest,
          }
        : null,
  };
}

interface DiscoverExtensionsOptions {
  pmRoot: string;
  settings: PmSettings;
  cwd?: string;
  noExtensions?: boolean;
}

export async function discoverExtensions(options: DiscoverExtensionsOptions): Promise<ExtensionDiscoveryResult> {
  const roots = resolveExtensionRoots(options.pmRoot, options.cwd ?? process.cwd());
  const configured_enabled = normalizeNames(options.settings.extensions.enabled);
  const configured_disabled = normalizeNames(options.settings.extensions.disabled);

  if (options.noExtensions) {
    return {
      disabled_by_flag: true,
      roots,
      configured_enabled,
      configured_disabled,
      discovered: [],
      effective: [],
      warnings: [],
    };
  }

  const enabled = new Set(configured_enabled);
  const disabled = new Set(configured_disabled);
  const globalScan = await scanExtensionLayer("global", roots.global, enabled, disabled);
  const projectScan = await scanExtensionLayer("project", roots.project, enabled, disabled);
  const effective = buildEffectiveExtensions(globalScan.candidates, projectScan.candidates).map(summarizeCandidate);

  return {
    disabled_by_flag: false,
    roots,
    configured_enabled,
    configured_disabled,
    discovered: [...globalScan.diagnostics, ...projectScan.diagnostics],
    effective,
    warnings: [...globalScan.warnings, ...projectScan.warnings],
  };
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export async function loadExtensions(options: DiscoverExtensionsOptions): Promise<ExtensionLoadResult> {
  const discovery = await discoverExtensions(options);
  const loaded: LoadedExtension[] = [];
  const failed: FailedExtensionLoad[] = [];
  const warnings = [...discovery.warnings];

  if (discovery.disabled_by_flag) {
    return {
      ...discovery,
      warnings,
      loaded,
      failed,
    };
  }

  for (const extension of discovery.effective) {
    try {
      const module = await import(pathToFileURL(extension.entry_path).href);
      loaded.push({
        ...extension,
        module,
      });
    } catch (error: unknown) {
      warnings.push(`extension_load_failed:${extension.layer}:${extension.name}`);
      failed.push({
        layer: extension.layer,
        name: extension.name,
        entry_path: extension.entry_path,
        error: formatUnknownError(error),
      });
    }
  }

  return {
    ...discovery,
    warnings,
    loaded,
    failed,
  };
}

type HookName = keyof ExtensionHookRegistry;

type ActivatableExtension = {
  activate: (api: ExtensionApi) => Promise<void> | void;
};

function resolveActivatableExtension(module: unknown): ActivatableExtension | null {
  const moduleRecord = asRecord(module);
  if (!moduleRecord) {
    return null;
  }

  if (typeof moduleRecord.activate === "function") {
    return {
      activate: moduleRecord.activate as ActivatableExtension["activate"],
    };
  }

  const defaultExport = asRecord(moduleRecord.default);
  if (defaultExport && typeof defaultExport.activate === "function") {
    return {
      activate: defaultExport.activate as ActivatableExtension["activate"],
    };
  }

  return null;
}

function normalizeCommandName(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function defaultGlobalOptions(): GlobalOptions {
  return {
    json: false,
    quiet: false,
    noExtensions: false,
    profile: false,
  };
}

function cloneCommandOptionsSnapshot(options: Record<string, unknown> | undefined): Record<string, unknown> {
  return options ? cloneContextSnapshot(options) : {};
}

function cloneGlobalOptionsSnapshot(options: GlobalOptions | undefined): GlobalOptions {
  return options ? cloneContextSnapshot(options) : defaultGlobalOptions();
}

function cloneContextSnapshot<T>(value: T): T {
  return structuredClone(value);
}

function isOutputRendererFormat(value: string): value is OutputRendererFormat {
  return value === "toon" || value === "json";
}

const EXTENSION_SERVICE_NAMES: readonly ExtensionServiceName[] = [
  "output_format",
  "error_format",
  "help_format",
  "lock_acquire",
  "lock_release",
  "history_append",
  "item_store_write",
  "item_store_delete",
];

function isExtensionServiceName(value: string): value is ExtensionServiceName {
  return EXTENSION_SERVICE_NAMES.includes(value as ExtensionServiceName);
}

function assertHookHandler(hookName: string, hook: unknown): void {
  if (typeof hook !== "function") {
    throw new TypeError(`api.hooks.${hookName} requires a function handler`);
  }
}

function assertNonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} requires a non-empty string`);
  }
  return value.trim();
}

function assertFunctionHandler(name: string, value: unknown): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} requires a function handler`);
  }
}

function normalizeRegistrationName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function toRegistrationCommandPath(name: string, action: "import" | "export"): string {
  return normalizeCommandName(`${name} ${action}`);
}

function sanitizeRegistrationValue(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRegistrationValue(entry));
  }
  if (typeof value === "function") {
    return "[Function]";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
    for (const key of keys) {
      normalized[key] = sanitizeRegistrationValue(record[key]);
    }
    return normalized;
  }
  return value;
}

function cloneRuntimeRegistrationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneRuntimeRegistrationValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
      cloned[key] = cloneRuntimeRegistrationValue(record[key]);
    }
    return cloned;
  }
  return value;
}

const EXTENSION_REGISTRATION_TRACE_SYMBOL = Symbol("extension_registration_trace");

type RegistrationTraceCarrier = Error & {
  [EXTENSION_REGISTRATION_TRACE_SYMBOL]?: ExtensionActivationFailureTrace;
};

function createRegistrationValidationError(message: string, trace: ExtensionActivationFailureTrace): TypeError {
  const error = new TypeError(message) as RegistrationTraceCarrier;
  Object.defineProperty(error, EXTENSION_REGISTRATION_TRACE_SYMBOL, {
    value: trace,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

function extractRegistrationValidationTrace(error: unknown): ExtensionActivationFailureTrace | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (error as RegistrationTraceCarrier)[EXTENSION_REGISTRATION_TRACE_SYMBOL];
}

function normalizeRegistrationRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return sanitizeRegistrationValue(value) as Record<string, unknown>;
}

function normalizeRuntimeRegistrationRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return cloneRuntimeRegistrationValue(value) as Record<string, unknown>;
}

function normalizeRegistrationRecordList(name: string, value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} requires an array of object definitions`);
  }
  return value.map((entry) => normalizeRegistrationRecord(name, entry));
}

function asRegistrationRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return value as Record<string, unknown>;
}

function assertOptionalBooleanField(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean when provided`);
  }
}

function assertOptionalStringField(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string when provided`);
  }
}

function assertOptionalStringArrayField(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array of non-empty strings when provided`);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`${name}[${index}] must be a non-empty string`);
    }
  }
}

function normalizeOptionalStringArrayField(name: string, value: unknown): string[] {
  assertOptionalStringArrayField(name, value);
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeCommandActionName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveCommandDefinitionAction(commandPath: string, action: unknown): string {
  if (action === undefined) {
    return commandPath.replace(/\s+/g, "-");
  }
  if (typeof action !== "string" || action.trim().length === 0) {
    throw new TypeError("registerCommand definition.action must be a non-empty string when provided");
  }
  const normalized = normalizeCommandActionName(action);
  if (normalized.length === 0) {
    throw new TypeError("registerCommand definition.action must contain alphanumeric characters");
  }
  return normalized;
}

function normalizeCommandDefinitionArguments(value: unknown): ExtensionCommandArgumentDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("registerCommand definition.arguments must be an array when provided");
  }
  const normalized: ExtensionCommandArgumentDefinition[] = [];
  for (const [index, entry] of value.entries()) {
    const record = asRegistrationRecord(`registerCommand definition.arguments[${index}]`, entry);
    const name = assertNonEmptyString(`registerCommand definition.arguments[${index}].name`, record.name);
    assertOptionalBooleanField(`registerCommand definition.arguments[${index}].required`, record.required);
    assertOptionalBooleanField(`registerCommand definition.arguments[${index}].variadic`, record.variadic);
    assertOptionalStringField(`registerCommand definition.arguments[${index}].description`, record.description);
    if (name.includes(" ")) {
      throw new TypeError(`registerCommand definition.arguments[${index}].name must not contain spaces`);
    }
    const definition: ExtensionCommandArgumentDefinition = {
      name,
    };
    if (record.required === true) {
      definition.required = true;
    }
    if (record.variadic === true) {
      definition.variadic = true;
    }
    if (typeof record.description === "string") {
      const trimmedDescription = record.description.trim();
      if (trimmedDescription.length > 0) {
        definition.description = trimmedDescription;
      }
    }
    normalized.push(definition);
  }

  let variadicCount = 0;
  for (const [index, argument] of normalized.entries()) {
    if (!argument.variadic) {
      continue;
    }
    variadicCount += 1;
    if (variadicCount > 1) {
      throw new TypeError("registerCommand definition.arguments supports at most one variadic argument");
    }
    if (index !== normalized.length - 1) {
      throw new TypeError("registerCommand definition.arguments variadic argument must be the final argument");
    }
  }

  return normalized;
}

function validateFlagDefinitions(flags: unknown): void {
  if (!Array.isArray(flags)) {
    throw new TypeError("registerFlags flags requires an array of object definitions");
  }
  for (const [index, raw] of flags.entries()) {
    const record = asRegistrationRecord(`registerFlags flags[${index}]`, raw);
    const long = record.long;
    const short = record.short;
    if (long === undefined && short === undefined) {
      throw new TypeError(`registerFlags flags[${index}] requires at least one of long or short`);
    }
    assertOptionalStringField(`registerFlags flags[${index}].long`, long);
    assertOptionalStringField(`registerFlags flags[${index}].short`, short);
    assertOptionalStringField(`registerFlags flags[${index}].value_name`, record.value_name);
    assertOptionalStringField(`registerFlags flags[${index}].description`, record.description);
    assertOptionalBooleanField(`registerFlags flags[${index}].required`, record.required);
    assertOptionalBooleanField(`registerFlags flags[${index}].enabled`, record.enabled);
    assertOptionalBooleanField(`registerFlags flags[${index}].visible`, record.visible);
  }
}

function validateItemFieldDefinitions(fields: unknown): void {
  if (!Array.isArray(fields)) {
    throw new TypeError("registerItemFields fields requires an array of object definitions");
  }
  for (const [index, raw] of fields.entries()) {
    const record = asRegistrationRecord(`registerItemFields fields[${index}]`, raw);
    assertNonEmptyString(`registerItemFields fields[${index}].name`, record.name);
    assertNonEmptyString(`registerItemFields fields[${index}].type`, record.type);
    assertOptionalBooleanField(`registerItemFields fields[${index}].optional`, record.optional);
  }
}

function validateItemTypeDefinitions(types: unknown): void {
  if (!Array.isArray(types)) {
    throw new TypeError("registerItemTypes types requires an array of object definitions");
  }
  for (const [typeIndex, raw] of types.entries()) {
    const record = asRegistrationRecord(`registerItemTypes types[${typeIndex}]`, raw);
    assertNonEmptyString(`registerItemTypes types[${typeIndex}].name`, record.name);
    assertOptionalStringField(`registerItemTypes types[${typeIndex}].folder`, record.folder);
    assertOptionalStringArrayField(`registerItemTypes types[${typeIndex}].aliases`, record.aliases);
    assertOptionalStringArrayField(
      `registerItemTypes types[${typeIndex}].required_create_fields`,
      record.required_create_fields,
    );
    assertOptionalStringArrayField(
      `registerItemTypes types[${typeIndex}].required_create_repeatables`,
      record.required_create_repeatables,
    );

    if (record.command_option_policies !== undefined) {
      if (!Array.isArray(record.command_option_policies)) {
        throw new TypeError(
          `registerItemTypes types[${typeIndex}].command_option_policies must be an array when provided`,
        );
      }
      for (const [policyIndex, rawPolicy] of record.command_option_policies.entries()) {
        const policy = asRegistrationRecord(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}]`,
          rawPolicy,
        );
        assertNonEmptyString(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].command`,
          policy.command,
        );
        assertNonEmptyString(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].option`,
          policy.option,
        );
        assertOptionalBooleanField(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].enabled`,
          policy.enabled,
        );
        assertOptionalBooleanField(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].required`,
          policy.required,
        );
        assertOptionalBooleanField(
          `registerItemTypes types[${typeIndex}].command_option_policies[${policyIndex}].visible`,
          policy.visible,
        );
      }
    }

    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) {
        throw new TypeError(`registerItemTypes types[${typeIndex}].options must be an array when provided`);
      }
      for (const [optionIndex, rawOption] of record.options.entries()) {
        const option = asRegistrationRecord(`registerItemTypes types[${typeIndex}].options[${optionIndex}]`, rawOption);
        assertNonEmptyString(`registerItemTypes types[${typeIndex}].options[${optionIndex}].key`, option.key);
        assertOptionalStringArrayField(`registerItemTypes types[${typeIndex}].options[${optionIndex}].values`, option.values);
        assertOptionalBooleanField(`registerItemTypes types[${typeIndex}].options[${optionIndex}].required`, option.required);
        assertOptionalStringArrayField(
          `registerItemTypes types[${typeIndex}].options[${optionIndex}].aliases`,
          option.aliases,
        );
      }
    }
  }
}

function validateMigrationDefinition(definition: unknown): void {
  const record = asRegistrationRecord("registerMigration definition", definition);
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new TypeError("registerMigration definition.id must be a string when provided");
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new TypeError("registerMigration definition.description must be a string when provided");
  }
  if (record.status !== undefined && typeof record.status !== "string") {
    throw new TypeError("registerMigration definition.status must be a string when provided");
  }
  assertOptionalBooleanField("registerMigration definition.mandatory", record.mandatory);
  if (record.run !== undefined && typeof record.run !== "function") {
    throw new TypeError("registerMigration definition.run must be a function when provided");
  }
}

function attachRuntimeDefinition<TEntry extends { definition: Record<string, unknown> }>(
  entry: TEntry,
  runtimeDefinition: Record<string, unknown>,
): TEntry {
  Object.defineProperty(entry, "runtime_definition", {
    value: runtimeDefinition,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return entry;
}

function getDeclaredExtensionCapabilities(extension: LoadedExtension): Set<ExtensionCapability> | null {
  if (!Array.isArray(extension.capabilities)) {
    return null;
  }
  const declared = new Set<ExtensionCapability>();
  for (const capability of extension.capabilities) {
    const normalized = capability.trim().toLowerCase();
    if (isKnownExtensionCapability(normalized)) {
      declared.add(normalized);
    }
  }
  return declared;
}

function assertExtensionCapability(extension: LoadedExtension, capability: ExtensionCapability, method: string): void {
  const declared = getDeclaredExtensionCapabilities(extension);
  // Keep direct unit tests that construct LoadedExtension fixtures without
  // capability metadata backwards-compatible while enforcing manifest-declared
  // capabilities for runtime-loaded extensions.
  if (declared === null) {
    return;
  }
  if (!declared.has(capability)) {
    throw new TypeError(
      `${method} requires capability '${capability}' in extension manifest capabilities`,
    );
  }
}

function createExtensionApi(
  extension: LoadedExtension,
  hooks: ExtensionHookRegistry,
  commands: ExtensionCommandRegistry,
  parsers: ExtensionParserRegistry,
  preflight: ExtensionPreflightRegistry,
  services: ExtensionServiceRegistry,
  renderers: ExtensionRendererRegistry,
  registrations: ExtensionRegistrationRegistry,
  activationWarnings: string[],
): ExtensionApi {
  const registerCommandTrace = (
    mode: "override" | "definition",
    command: string | undefined,
    expectedSchema: string,
    received: unknown,
    hint?: string,
  ): ExtensionActivationFailureTrace => ({
    method: "registerCommand",
    registration_index: mode === "override" ? commands.overrides.length : commands.handlers.length,
    command,
    expected_schema: expectedSchema,
    received: sanitizeRegistrationValue(received),
    hint,
  });

  const registerCommand = (commandOrDefinition: string | CommandDefinition, override?: CommandOverride): void => {
    assertExtensionCapability(extension, "commands", "registerCommand");
    if (typeof commandOrDefinition === "string") {
      const normalizedCommand = normalizeCommandName(commandOrDefinition);
      if (normalizedCommand.length === 0) {
        throw createRegistrationValidationError(
          "registerCommand requires a non-empty command name",
          registerCommandTrace(
            "override",
            commandOrDefinition,
            'registerCommand("<command>", (context) => unknown)',
            commandOrDefinition,
            "Provide a non-empty command path as the first argument.",
          ),
        );
      }
      if (typeof override !== "function") {
        const trace = registerCommandTrace(
          "override",
          normalizedCommand,
          'registerCommand("<command>", (context) => unknown)',
          { command: commandOrDefinition, override },
          "Provide a function as the second registerCommand argument.",
        );
        throw createRegistrationValidationError(
          `registerCommand requires an override function when command name is provided (command="${normalizedCommand}", registration_index=${trace.registration_index})`,
          trace,
        );
      }
      commands.overrides.push({
        layer: extension.layer,
        name: extension.name,
        command: normalizedCommand,
        run: override,
      });
      return;
    }

    if (typeof commandOrDefinition !== "object" || commandOrDefinition === null) {
      throw createRegistrationValidationError(
        "registerCommand requires a command definition object",
        registerCommandTrace(
          "definition",
          undefined,
          "{ name: string; run: (context) => unknown; }",
          commandOrDefinition,
          "Use registerCommand({ name: \"command path\", run: (context) => ... }).",
        ),
      );
    }
    if (typeof commandOrDefinition.name !== "string") {
      throw createRegistrationValidationError(
        "registerCommand requires a command definition name",
        registerCommandTrace(
          "definition",
          undefined,
          "{ name: string; run: (context) => unknown; }",
          commandOrDefinition,
          "Set command definition.name to a non-empty string command path.",
        ),
      );
    }

    const normalizedCommand = normalizeCommandName(commandOrDefinition.name);
    if (normalizedCommand.length === 0) {
      throw createRegistrationValidationError(
        "registerCommand requires a non-empty command definition name",
        registerCommandTrace(
          "definition",
          commandOrDefinition.name,
          "{ name: string; run: (context) => unknown; }",
          commandOrDefinition,
          "Ensure command definition.name contains a non-empty command path.",
        ),
      );
    }
    const runHandler = typeof commandOrDefinition.run === "function" ? commandOrDefinition.run : undefined;
    const legacyHandler = typeof commandOrDefinition.handler === "function" ? commandOrDefinition.handler : undefined;
    if (!runHandler && legacyHandler) {
      activationWarnings.push(
        `extension_command_definition_legacy_handler_alias:${extension.layer}:${extension.name}:${normalizedCommand}`,
      );
    }
    const resolvedHandler = runHandler ?? legacyHandler;
    if (typeof resolvedHandler !== "function") {
      const trace = registerCommandTrace(
        "definition",
        normalizedCommand,
        "{ name: string; run: (context) => unknown; }",
        commandOrDefinition,
        "Define command definition.run as a function.",
      );
      throw createRegistrationValidationError(
        `registerCommand requires a command definition run handler (command="${normalizedCommand}", registration_index=${trace.registration_index})`,
        trace,
      );
    }
    try {
      assertOptionalStringField("registerCommand definition.action", commandOrDefinition.action);
      assertOptionalStringField("registerCommand definition.description", commandOrDefinition.description);
      assertOptionalStringField("registerCommand definition.intent", commandOrDefinition.intent);
      const action = resolveCommandDefinitionAction(normalizedCommand, commandOrDefinition.action);
      const description = commandOrDefinition.description?.trim();
      const intent = commandOrDefinition.intent?.trim();
      const examples = normalizeOptionalStringArrayField("registerCommand definition.examples", commandOrDefinition.examples);
      const failureHints = normalizeOptionalStringArrayField(
        "registerCommand definition.failure_hints",
        commandOrDefinition.failure_hints,
      );
      const argumentsDefinition = normalizeCommandDefinitionArguments(commandOrDefinition.arguments);

      if (commandOrDefinition.flags !== undefined) {
        assertExtensionCapability(extension, "schema", "registerCommand flags");
        validateFlagDefinitions(commandOrDefinition.flags);
        registrations.flags.push({
          layer: extension.layer,
          name: extension.name,
          target_command: normalizedCommand,
          flags: normalizeRegistrationRecordList("registerCommand definition.flags", commandOrDefinition.flags),
        });
      }

      const registration: RegisteredExtensionCommandDefinition = {
        layer: extension.layer,
        name: extension.name,
        command: normalizedCommand,
        action,
        examples,
        failure_hints: failureHints,
        arguments: argumentsDefinition,
      };
      if (description) {
        registration.description = description;
      }
      if (intent) {
        registration.intent = intent;
      }
      registrations.commands.push(registration);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "registerCommand definition validation failed";
      const trace = registerCommandTrace(
        "definition",
        normalizedCommand,
        "{ name: string; run: (context) => unknown; action?: string; arguments?: object[]; flags?: object[]; }",
        commandOrDefinition,
        "Use schema-style metadata (action/arguments/flags/examples/intent) with valid values.",
      );
      throw createRegistrationValidationError(
        `registerCommand definition metadata invalid (command="${normalizedCommand}", registration_index=${trace.registration_index}): ${reason}`,
        trace,
      );
    }
    commands.handlers.push({
      layer: extension.layer,
      name: extension.name,
      command: normalizedCommand,
      run: resolvedHandler,
    });
  };
  const registerParser = (command: string, override: ParserOverride): void => {
    assertExtensionCapability(extension, "parser", "registerParser");
    const normalizedCommand = normalizeCommandName(assertNonEmptyString("registerParser command", command));
    assertFunctionHandler("registerParser override", override);
    parsers.overrides.push({
      layer: extension.layer,
      name: extension.name,
      command: normalizedCommand,
      run: override,
    });
  };
  const registerPreflight = (override: PreflightOverride): void => {
    assertExtensionCapability(extension, "preflight", "registerPreflight");
    assertFunctionHandler("registerPreflight override", override);
    preflight.overrides.push({
      layer: extension.layer,
      name: extension.name,
      run: override,
    });
  };
  const registerService = (service: ExtensionServiceName, override: ServiceOverride): void => {
    assertExtensionCapability(extension, "services", "registerService");
    const normalizedService = String(service).trim().toLowerCase();
    if (!isExtensionServiceName(normalizedService)) {
      throw new TypeError(`registerService service must be one of: ${EXTENSION_SERVICE_NAMES.join(", ")}`);
    }
    assertFunctionHandler("registerService override", override);
    services.overrides.push({
      layer: extension.layer,
      name: extension.name,
      service: normalizedService as ExtensionServiceName,
      run: override,
    });
  };
  const registerRenderer = (format: OutputRendererFormat, renderer: RendererOverride): void => {
    assertExtensionCapability(extension, "renderers", "registerRenderer");
    if (typeof renderer !== "function") {
      throw new TypeError("registerRenderer requires a renderer function");
    }
    const normalizedFormat = String(format).trim().toLowerCase();
    if (!isOutputRendererFormat(normalizedFormat)) {
      throw new Error(`registerRenderer format must be toon|json, received: ${String(format)}`);
    }
    renderers.overrides.push({
      layer: extension.layer,
      name: extension.name,
      format: normalizedFormat,
      run: renderer,
    });
  };
  const registerFlags = (targetCommand: string, flags: FlagDefinition[]): void => {
    assertExtensionCapability(extension, "schema", "registerFlags");
    const normalizedTargetCommand = normalizeCommandName(assertNonEmptyString("registerFlags targetCommand", targetCommand));
    validateFlagDefinitions(flags);
    const normalizedFlags = normalizeRegistrationRecordList("registerFlags flags", flags);
    if (normalizedFlags.length === 0) {
      throw new TypeError("registerFlags requires at least one flag definition");
    }
    registrations.flags.push({
      layer: extension.layer,
      name: extension.name,
      target_command: normalizedTargetCommand,
      flags: normalizedFlags,
    });
  };
  const registerItemFields = (fields: SchemaFieldDefinition[]): void => {
    assertExtensionCapability(extension, "schema", "registerItemFields");
    validateItemFieldDefinitions(fields);
    const normalizedFields = normalizeRegistrationRecordList(
      "registerItemFields fields",
      fields,
    ) as SchemaFieldDefinition[];
    if (normalizedFields.length === 0) {
      throw new TypeError("registerItemFields requires at least one field definition");
    }
    registrations.item_fields.push({
      layer: extension.layer,
      name: extension.name,
      fields: normalizedFields,
    });
  };
  const registerItemTypes = (types: SchemaItemTypeDefinition[]): void => {
    assertExtensionCapability(extension, "schema", "registerItemTypes");
    validateItemTypeDefinitions(types);
    const normalizedTypes = normalizeRegistrationRecordList(
      "registerItemTypes types",
      types,
    ) as SchemaItemTypeDefinition[];
    if (normalizedTypes.length === 0) {
      throw new TypeError("registerItemTypes requires at least one type definition");
    }
    registrations.item_types.push({
      layer: extension.layer,
      name: extension.name,
      types: normalizedTypes,
    });
  };
  const registerMigration = (definition: SchemaMigrationDefinition): void => {
    assertExtensionCapability(extension, "schema", "registerMigration");
    validateMigrationDefinition(definition);
    const runtimeDefinition = normalizeRuntimeRegistrationRecord("registerMigration definition", definition);
    registrations.migrations.push(
      attachRuntimeDefinition(
        {
          layer: extension.layer,
          name: extension.name,
          definition: normalizeRegistrationRecord("registerMigration definition", definition),
        },
        runtimeDefinition,
      ) as RegisteredExtensionSchemaMigrationDefinition,
    );
  };
  const registerImporter = (name: string, importer: Importer): void => {
    assertExtensionCapability(extension, "importers", "registerImporter");
    const normalizedName = normalizeRegistrationName(assertNonEmptyString("registerImporter name", name));
    assertFunctionHandler("registerImporter importer", importer);
    const commandPath = toRegistrationCommandPath(normalizedName, "import");
    registrations.importers.push({
      layer: extension.layer,
      name: extension.name,
      importer: normalizedName,
    });
    commands.handlers.push({
      layer: extension.layer,
      name: extension.name,
      command: commandPath,
      run: async (context) =>
        importer({
          registration: normalizedName,
          action: "import",
          command: context.command,
          args: cloneContextSnapshot(context.args),
          options: cloneContextSnapshot(context.options),
          global: cloneContextSnapshot(context.global),
          pm_root: context.pm_root,
        }),
    });
  };
  const registerExporter = (name: string, exporter: Exporter): void => {
    assertExtensionCapability(extension, "importers", "registerExporter");
    const normalizedName = normalizeRegistrationName(assertNonEmptyString("registerExporter name", name));
    assertFunctionHandler("registerExporter exporter", exporter);
    const commandPath = toRegistrationCommandPath(normalizedName, "export");
    registrations.exporters.push({
      layer: extension.layer,
      name: extension.name,
      exporter: normalizedName,
    });
    commands.handlers.push({
      layer: extension.layer,
      name: extension.name,
      command: commandPath,
      run: async (context) =>
        exporter({
          registration: normalizedName,
          action: "export",
          command: context.command,
          args: cloneContextSnapshot(context.args),
          options: cloneContextSnapshot(context.options),
          global: cloneContextSnapshot(context.global),
          pm_root: context.pm_root,
        }),
    });
  };
  const registerSearchProvider = (provider: SearchProviderDefinition): void => {
    assertExtensionCapability(extension, "search", "registerSearchProvider");
    const runtimeDefinition = normalizeRuntimeRegistrationRecord("registerSearchProvider provider", provider);
    registrations.search_providers.push(
      attachRuntimeDefinition(
        {
          layer: extension.layer,
          name: extension.name,
          definition: normalizeRegistrationRecord("registerSearchProvider provider", provider),
        },
        runtimeDefinition,
      ) as RegisteredExtensionSearchProvider,
    );
  };
  const registerVectorStoreAdapter = (adapter: VectorStoreAdapterDefinition): void => {
    assertExtensionCapability(extension, "search", "registerVectorStoreAdapter");
    const runtimeDefinition = normalizeRuntimeRegistrationRecord("registerVectorStoreAdapter adapter", adapter);
    registrations.vector_store_adapters.push(
      attachRuntimeDefinition(
        {
          layer: extension.layer,
          name: extension.name,
          definition: normalizeRegistrationRecord("registerVectorStoreAdapter adapter", adapter),
        },
        runtimeDefinition,
      ) as RegisteredExtensionVectorStoreAdapter,
    );
  };
  const registerBeforeCommand = (hook: BeforeCommandHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.beforeCommand");
    assertHookHandler("beforeCommand", hook);
    hooks.beforeCommand.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerAfterCommand = (hook: AfterCommandHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.afterCommand");
    assertHookHandler("afterCommand", hook);
    hooks.afterCommand.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerOnWrite = (hook: OnWriteHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.onWrite");
    assertHookHandler("onWrite", hook);
    hooks.onWrite.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerOnRead = (hook: OnReadHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.onRead");
    assertHookHandler("onRead", hook);
    hooks.onRead.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };
  const registerOnIndex = (hook: OnIndexHook): void => {
    assertExtensionCapability(extension, "hooks", "api.hooks.onIndex");
    assertHookHandler("onIndex", hook);
    hooks.onIndex.push({
      layer: extension.layer,
      name: extension.name,
      run: hook,
    });
  };

  return {
    registerCommand,
    registerParser,
    registerPreflight,
    registerService,
    registerFlags,
    registerItemFields,
    registerItemTypes,
    registerMigration,
    registerRenderer,
    registerImporter,
    registerExporter,
    registerSearchProvider,
    registerVectorStoreAdapter,
    hooks: {
      beforeCommand: registerBeforeCommand,
      afterCommand: registerAfterCommand,
      onWrite: registerOnWrite,
      onRead: registerOnRead,
      onIndex: registerOnIndex,
    },
  };
}

async function executeRegisteredHooks<TContext>(
  entries: Array<RegisteredExtensionHook<(context: TContext) => Promise<void> | void>>,
  hookName: HookName,
  context: TContext,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of entries) {
    try {
      await entry.run(cloneContextSnapshot(context));
    } catch {
      warnings.push(`extension_hook_failed:${entry.layer}:${entry.name}:${hookName}`);
    }
  }
  return warnings;
}

function getRegistrationCounts(registrations: ExtensionRegistrationRegistry): ExtensionRegistrationCounts {
  const commandCount = registrations.commands.length;
  const flagCount = registrations.flags.reduce((total, entry) => total + entry.flags.length, 0);
  const itemFieldCount = registrations.item_fields.reduce((total, entry) => total + entry.fields.length, 0);
  const itemTypeCount = registrations.item_types.reduce((total, entry) => total + entry.types.length, 0);
  return {
    commands: commandCount,
    flags: flagCount,
    item_fields: itemFieldCount,
    item_types: itemTypeCount,
    migrations: registrations.migrations.length,
    importers: registrations.importers.length,
    exporters: registrations.exporters.length,
    search_providers: registrations.search_providers.length,
    vector_store_adapters: registrations.vector_store_adapters.length,
  };
}

function collectCommandCollisionWarnings(commands: ExtensionCommandRegistry): string[] {
  const warnings: string[] = [];
  const collectByCommand = <TEntry extends { layer: ExtensionLayer; name: string; command: string }>(
    entries: TEntry[],
    codePrefix: string,
  ): void => {
    const grouped = new Map<string, TEntry[]>();
    for (const entry of entries) {
      const bucket = grouped.get(entry.command) ?? [];
      bucket.push(entry);
      grouped.set(entry.command, bucket);
    }
    for (const command of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
      const bucket = grouped.get(command) ?? [];
      if (bucket.length <= 1) {
        continue;
      }
      const winner = bucket[bucket.length - 1];
      for (const displaced of bucket.slice(0, -1)) {
        warnings.push(
          `${codePrefix}:${command}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
        );
      }
    }
  };

  collectByCommand(commands.handlers, "extension_command_handler_collision");
  collectByCommand(commands.overrides, "extension_command_override_collision");

  const handlerCommands = new Set(commands.handlers.map((entry) => entry.command));
  const overlapCommands = [...new Set(commands.overrides.map((entry) => entry.command))]
    .filter((command) => handlerCommands.has(command))
    .sort((left, right) => left.localeCompare(right));
  for (const command of overlapCommands) {
    warnings.push(`extension_command_override_handler_overlap:${command}`);
  }

  return warnings;
}

function collectRendererCollisionWarnings(renderers: ExtensionRendererRegistry): string[] {
  const grouped = new Map<OutputRendererFormat, RegisteredExtensionRendererOverride[]>();
  for (const entry of renderers.overrides) {
    const bucket = grouped.get(entry.format) ?? [];
    bucket.push(entry);
    grouped.set(entry.format, bucket);
  }
  const warnings: string[] = [];
  for (const format of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    const bucket = grouped.get(format) ?? [];
    if (bucket.length <= 1) {
      continue;
    }
    const winner = bucket[bucket.length - 1];
    for (const displaced of bucket.slice(0, -1)) {
      warnings.push(
        `extension_renderer_collision:${format}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
      );
    }
  }
  return warnings;
}

function collectParserCollisionWarnings(parsers: ExtensionParserRegistry): string[] {
  const warnings: string[] = [];
  const grouped = new Map<string, RegisteredExtensionParserOverride[]>();
  for (const entry of parsers.overrides) {
    const bucket = grouped.get(entry.command) ?? [];
    bucket.push(entry);
    grouped.set(entry.command, bucket);
  }
  for (const command of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    const bucket = grouped.get(command) ?? [];
    if (bucket.length <= 1) {
      continue;
    }
    const winner = bucket[bucket.length - 1];
    for (const displaced of bucket.slice(0, -1)) {
      warnings.push(
        `extension_parser_override_collision:${command}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
      );
    }
  }
  return warnings;
}

function collectPreflightCollisionWarnings(preflight: ExtensionPreflightRegistry): string[] {
  if (preflight.overrides.length <= 1) {
    return [];
  }
  const winner = preflight.overrides[preflight.overrides.length - 1];
  return preflight.overrides.slice(0, -1).map(
    (displaced) =>
      `extension_preflight_override_collision:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
  );
}

function collectServiceCollisionWarnings(services: ExtensionServiceRegistry): string[] {
  const warnings: string[] = [];
  const grouped = new Map<ExtensionServiceName, RegisteredExtensionServiceOverride[]>();
  for (const entry of services.overrides) {
    const bucket = grouped.get(entry.service) ?? [];
    bucket.push(entry);
    grouped.set(entry.service, bucket);
  }
  for (const service of [...grouped.keys()].sort((left, right) => left.localeCompare(right))) {
    const bucket = grouped.get(service) ?? [];
    if (bucket.length <= 1) {
      continue;
    }
    const winner = bucket[bucket.length - 1];
    for (const displaced of bucket.slice(0, -1)) {
      warnings.push(
        `extension_service_override_collision:${service}:${winner.layer}:${winner.name}:${displaced.layer}:${displaced.name}`,
      );
    }
  }
  return warnings;
}

export async function activateExtensions(loadResult: ExtensionLoadResult): Promise<ExtensionActivationResult> {
  const hooks = createEmptyExtensionHookRegistry();
  const commands = createEmptyExtensionCommandRegistry();
  const parsers = createEmptyExtensionParserRegistry();
  const preflight = createEmptyExtensionPreflightRegistry();
  const services = createEmptyExtensionServiceRegistry();
  const renderers = createEmptyExtensionRendererRegistry();
  const registrations = createEmptyExtensionRegistrationRegistry();
  const failed: FailedExtensionActivation[] = [];
  const warnings: string[] = [];

  for (const extension of loadResult.loaded) {
    const activatable = resolveActivatableExtension(extension.module);
    if (!activatable) {
      continue;
    }

    try {
      await activatable.activate(
        createExtensionApi(extension, hooks, commands, parsers, preflight, services, renderers, registrations, warnings),
      );
    } catch (error: unknown) {
      warnings.push(`extension_activate_failed:${extension.layer}:${extension.name}`);
      const trace = extractRegistrationValidationTrace(error);
      failed.push({
        layer: extension.layer,
        name: extension.name,
        entry_path: extension.entry_path,
        error: formatUnknownError(error),
        trace,
      });
    }
  }

  const collisionWarnings = [
    ...collectCommandCollisionWarnings(commands),
    ...collectParserCollisionWarnings(parsers),
    ...collectPreflightCollisionWarnings(preflight),
    ...collectServiceCollisionWarnings(services),
    ...collectRendererCollisionWarnings(renderers),
  ];
  const mergedWarnings = [...new Set([...warnings, ...collisionWarnings])];

  return {
    hooks,
    commands,
    parsers,
    preflight,
    services,
    renderers,
    registrations,
    failed,
    warnings: mergedWarnings,
    hook_counts: {
      before_command: hooks.beforeCommand.length,
      after_command: hooks.afterCommand.length,
      on_write: hooks.onWrite.length,
      on_read: hooks.onRead.length,
      on_index: hooks.onIndex.length,
    },
    command_override_count: commands.overrides.length,
    command_handler_count: commands.handlers.length,
    parser_override_count: parsers.overrides.length,
    preflight_override_count: preflight.overrides.length,
    service_override_count: services.overrides.length,
    renderer_override_count: renderers.overrides.length,
    registration_counts: getRegistrationCounts(registrations),
  };
}

export async function runBeforeCommandHooks(
  hooks: ExtensionHookRegistry,
  context: BeforeCommandHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.beforeCommand, "beforeCommand", context);
}

export async function runAfterCommandHooks(
  hooks: ExtensionHookRegistry,
  context: AfterCommandHookContext,
): Promise<string[]> {
  return executeRegisteredHooks(hooks.afterCommand, "afterCommand", context);
}

export async function runOnWriteHooks(hooks: ExtensionHookRegistry, context: OnWriteHookContext): Promise<string[]> {
  return executeRegisteredHooks(hooks.onWrite, "onWrite", context);
}

export async function runOnReadHooks(hooks: ExtensionHookRegistry, context: OnReadHookContext): Promise<string[]> {
  return executeRegisteredHooks(hooks.onRead, "onRead", context);
}

export async function runOnIndexHooks(hooks: ExtensionHookRegistry, context: OnIndexHookContext): Promise<string[]> {
  return executeRegisteredHooks(hooks.onIndex, "onIndex", context);
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
}

export async function runCommandHandler(
  commands: ExtensionCommandRegistry,
  context: CommandHandlerContext,
): Promise<CommandHandlerResult> {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }

  const matched = [...commands.handlers].reverse().find((entry) => entry.command === command);
  if (!matched) {
    return {
      handled: false,
      result: null,
      warnings: [],
    };
  }

  try {
    const result = await matched.run({
      command,
      args: cloneContextSnapshot(context.args),
      options: cloneContextSnapshot(context.options),
      global: cloneContextSnapshot(context.global),
      pm_root: context.pm_root,
    });
    return {
      handled: true,
      result,
      warnings: [],
    };
  } catch {
    return {
      handled: false,
      result: null,
      warnings: [`extension_command_handler_failed:${matched.layer}:${matched.name}:${matched.command}`],
    };
  }
}

export interface ParserOverrideResult {
  overridden: boolean;
  context: CommandHandlerContext;
  warnings: string[];
}

export async function runParserOverride(
  parsers: ExtensionParserRegistry,
  context: ParserOverrideContext,
): Promise<ParserOverrideResult> {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  }

  const matched = [...parsers.overrides].reverse().find((entry) => entry.command === command);
  if (!matched) {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  }

  try {
    const delta = (await Promise.resolve(
      matched.run({
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      }),
    )) ?? {};
    const nextArgs = Array.isArray(delta.args) ? cloneContextSnapshot(delta.args) : cloneContextSnapshot(context.args);
    const nextOptions = delta.options ? cloneCommandOptionsSnapshot(delta.options) : cloneCommandOptionsSnapshot(context.options);
    const nextGlobal = delta.global ? cloneGlobalOptionsSnapshot(delta.global) : cloneGlobalOptionsSnapshot(context.global);
    return {
      overridden: true,
      context: {
        command,
        args: nextArgs,
        options: nextOptions,
        global: nextGlobal,
        pm_root: context.pm_root,
      },
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      context: {
        command,
        args: cloneContextSnapshot(context.args),
        options: cloneCommandOptionsSnapshot(context.options),
        global: cloneGlobalOptionsSnapshot(context.global),
        pm_root: context.pm_root,
      },
      warnings: [`extension_parser_override_failed:${matched.layer}:${matched.name}:${matched.command}`],
    };
  }
}

export interface PreflightOverrideResult {
  overridden: boolean;
  context: CommandHandlerContext;
  decision: PreflightRuntimeDecision;
  warnings: string[];
}

export async function runPreflightOverride(
  preflight: ExtensionPreflightRegistry,
  context: PreflightOverrideContext,
): Promise<PreflightOverrideResult> {
  const matched = [...preflight.overrides].reverse()[0];
  const baseContext: CommandHandlerContext = {
    command: normalizeCommandName(context.command),
    args: cloneContextSnapshot(context.args),
    options: cloneCommandOptionsSnapshot(context.options),
    global: cloneGlobalOptionsSnapshot(context.global),
    pm_root: context.pm_root,
  };
  const baseDecision: PreflightRuntimeDecision = cloneContextSnapshot(context.decision);
  if (!matched) {
    return {
      overridden: false,
      context: baseContext,
      decision: baseDecision,
      warnings: [],
    };
  }

  try {
    const delta = (await Promise.resolve(
      matched.run({
        command: baseContext.command,
        args: cloneContextSnapshot(baseContext.args),
        options: cloneCommandOptionsSnapshot(baseContext.options),
        global: cloneGlobalOptionsSnapshot(baseContext.global),
        pm_root: baseContext.pm_root,
        decision: cloneContextSnapshot(baseDecision),
      }),
    )) ?? {};
    const nextContext: CommandHandlerContext = {
      command: baseContext.command,
      args: Array.isArray(delta.args) ? cloneContextSnapshot(delta.args) : baseContext.args,
      options: delta.options ? cloneCommandOptionsSnapshot(delta.options) : baseContext.options,
      global: delta.global ? cloneGlobalOptionsSnapshot(delta.global) : baseContext.global,
      pm_root: baseContext.pm_root,
    };
    const nextDecision: PreflightRuntimeDecision = {
      enforce_item_format_gate:
        typeof delta.enforce_item_format_gate === "boolean"
          ? delta.enforce_item_format_gate
          : baseDecision.enforce_item_format_gate,
      run_preflight_item_format_sync:
        typeof delta.run_preflight_item_format_sync === "boolean"
          ? delta.run_preflight_item_format_sync
          : baseDecision.run_preflight_item_format_sync,
      run_extension_migrations:
        typeof delta.run_extension_migrations === "boolean"
          ? delta.run_extension_migrations
          : baseDecision.run_extension_migrations,
      enforce_mandatory_migration_gate:
        typeof delta.enforce_mandatory_migration_gate === "boolean"
          ? delta.enforce_mandatory_migration_gate
          : baseDecision.enforce_mandatory_migration_gate,
    };
    return {
      overridden: true,
      context: nextContext,
      decision: nextDecision,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      context: baseContext,
      decision: baseDecision,
      warnings: [`extension_preflight_override_failed:${matched.layer}:${matched.name}`],
    };
  }
}

export interface ServiceOverrideResult {
  handled: boolean;
  result: unknown;
  warnings: string[];
}

function resolveDefaultServiceResult(context: ServiceOverrideContext): ServiceOverrideResult {
  return {
    handled: false,
    result: context.payload,
    warnings: [],
  };
}

export function runServiceOverrideSync(
  services: ExtensionServiceRegistry,
  context: ServiceOverrideContext,
): ServiceOverrideResult {
  const matched = [...services.overrides].reverse().find((entry) => entry.service === context.service);
  if (!matched) {
    return resolveDefaultServiceResult(context);
  }

  try {
    const result = matched.run({
      service: context.service,
      command: context.command ? normalizeCommandName(context.command) : undefined,
      args: context.args ? cloneContextSnapshot(context.args) : undefined,
      options: context.options ? cloneCommandOptionsSnapshot(context.options) : undefined,
      global: context.global ? cloneGlobalOptionsSnapshot(context.global) : undefined,
      pm_root: context.pm_root,
      payload: cloneContextSnapshot(context.payload),
    });
    if (result instanceof Promise) {
      return {
        handled: false,
        result: context.payload,
        warnings: [`extension_service_override_async_unsupported:${matched.layer}:${matched.name}:${matched.service}`],
      };
    }
    return {
      handled: true,
      result,
      warnings: [],
    };
  } catch {
    return {
      handled: false,
      result: context.payload,
      warnings: [`extension_service_override_failed:${matched.layer}:${matched.name}:${matched.service}`],
    };
  }
}

export async function runServiceOverride(
  services: ExtensionServiceRegistry,
  context: ServiceOverrideContext,
): Promise<ServiceOverrideResult> {
  const matched = [...services.overrides].reverse().find((entry) => entry.service === context.service);
  if (!matched) {
    return resolveDefaultServiceResult(context);
  }

  try {
    const result = await Promise.resolve(
      matched.run({
        service: context.service,
        command: context.command ? normalizeCommandName(context.command) : undefined,
        args: context.args ? cloneContextSnapshot(context.args) : undefined,
        options: context.options ? cloneCommandOptionsSnapshot(context.options) : undefined,
        global: context.global ? cloneGlobalOptionsSnapshot(context.global) : undefined,
        pm_root: context.pm_root,
        payload: cloneContextSnapshot(context.payload),
      }),
    );
    return {
      handled: true,
      result,
      warnings: [],
    };
  } catch {
    return {
      handled: false,
      result: context.payload,
      warnings: [`extension_service_override_failed:${matched.layer}:${matched.name}:${matched.service}`],
    };
  }
}

export function runCommandOverride(
  commands: ExtensionCommandRegistry,
  context: CommandOverrideContext,
): CommandOverrideResult {
  const command = normalizeCommandName(context.command);
  if (command.length === 0) {
    return {
      overridden: false,
      result: context.result,
      warnings: [],
    };
  }

  const matched = [...commands.overrides].reverse().find((entry) => entry.command === command);
  if (!matched) {
    return {
      overridden: false,
      result: context.result,
      warnings: [],
    };
  }

  try {
    const overrideOptions = cloneCommandOptionsSnapshot(context.options);
    const overrideGlobal = cloneGlobalOptionsSnapshot(context.global);
    const overrideResult = matched.run({
      command,
      args: cloneContextSnapshot(context.args),
      options: overrideOptions,
      global: overrideGlobal,
      pm_root: context.pm_root,
      result: cloneContextSnapshot(context.result),
    });
    if (overrideResult instanceof Promise) {
      return {
        overridden: false,
        result: context.result,
        warnings: [`extension_command_override_async_unsupported:${matched.layer}:${matched.name}:${matched.command}`],
      };
    }
    return {
      overridden: true,
      result: overrideResult,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      result: context.result,
      warnings: [`extension_command_override_failed:${matched.layer}:${matched.name}:${matched.command}`],
    };
  }
}

export interface RendererOverrideResult {
  overridden: boolean;
  rendered: string | null;
  warnings: string[];
}

export function runRendererOverride(
  renderers: ExtensionRendererRegistry,
  context: RendererOverrideContext,
): RendererOverrideResult {
  const matched = [...renderers.overrides].reverse().find((entry) => entry.format === context.format);
  if (!matched) {
    return {
      overridden: false,
      rendered: null,
      warnings: [],
    };
  }

  try {
    const rendererCommand = typeof context.command === "string" ? normalizeCommandName(context.command) : "";
    const rendererArgs = Array.isArray(context.args) ? cloneContextSnapshot(context.args) : [];
    const rendererOptions = cloneCommandOptionsSnapshot(context.options);
    const rendererGlobal = cloneGlobalOptionsSnapshot(context.global);
    const rendererPmRoot = typeof context.pm_root === "string" ? context.pm_root : "";
    const rendered = matched.run({
      format: context.format,
      command: rendererCommand,
      args: rendererArgs,
      options: rendererOptions,
      global: rendererGlobal,
      pm_root: rendererPmRoot,
      result: cloneContextSnapshot(context.result),
    });
    if (typeof rendered !== "string") {
      return {
        overridden: false,
        rendered: null,
        warnings: [`extension_renderer_invalid_result:${matched.layer}:${matched.name}:${matched.format}`],
      };
    }
    return {
      overridden: true,
      rendered,
      warnings: [],
    };
  } catch {
    return {
      overridden: false,
      rendered: null,
      warnings: [`extension_renderer_failed:${matched.layer}:${matched.name}:${matched.format}`],
    };
  }
}
