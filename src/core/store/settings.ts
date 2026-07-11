/**
 * @module core/store/settings
 *
 * Reads and writes tracker storage with format-aware helpers for Settings.
 */
import { validateSettings, type ParsedSettings } from "./settings-validator.js";
import {
  runActiveOnReadHooks,
  runActiveOnWriteHooks,
} from "../extensions/index.js";
import {
  GOVERNANCE_PRESET_DEFAULTS,
  SETTINGS_DEFAULTS,
} from "../shared/constants.js";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import {
  DEFAULT_RUNTIME_SCHEMA_FILE_PATHS,
  ensureRuntimeSchemaFileScaffold,
  filePathForSchemaSection,
  loadRuntimeSchemaFromOptionalFiles,
  normalizeRuntimeSchemaSettings,
} from "../schema/runtime-schema.js";
import { getSettingsPath } from "./paths.js";
import { orderObject, stableValueEquals } from "../shared/serialization.js";
import { normalizeItemTypeDefinition } from "../item/item-type-definition.js";
import { normalizeEstimateDefaultOverrides } from "../validate/estimate-defaults.js";
import {
  clearSettingsReadCache,
  collectSettingsReadCacheSignatures,
  getSettingsReadCacheEntry,
  setSettingsReadCacheEntry,
  settingsReadCacheSignaturesEqual,
} from "./settings-read-cache.js";
import type {
  ExtensionGovernancePolicy,
  PmMaxVersionExceededMode,
  PmMaxVersionExceededModeSetting,
} from "../extensions/extension-types.js";
import type {
  ExtensionSandboxProfile,
  ExtensionPolicyMode,
  ExtensionPolicyOverrideSettings,
  ExtensionPolicySettings,
  ExtensionTrustMode,
  GovernanceSettings,
  ItemTypeDefinition,
  PmSettings,
  GovernancePreset,
  SearchMutationRefreshPolicy,
  ValidateMetadataRequiredField,
} from "../../types/index.js";

const SETTINGS_WRITE_OP = "settings:write";
const SETTINGS_PERSIST_SOURCE_SYMBOL = Symbol("pm.settings.persist_source");
const MAX_VECTOR_STORE_COLLECTION_NAME_LENGTH = 128;

interface SettingsPersistSourceSnapshot {
  has_source_item_type_definitions: boolean;
  source_item_type_definitions: ItemTypeDefinition[];
  has_source_schema_statuses: boolean;
  source_schema_statuses: PmSettings["schema"]["statuses"];
  has_source_schema_fields: boolean;
  source_schema_fields: PmSettings["schema"]["fields"];
  has_source_schema_type_workflows: boolean;
  source_schema_type_workflows: NonNullable<
    PmSettings["schema"]["type_workflows"]
  >;
  runtime_item_type_definitions: ItemTypeDefinition[];
  runtime_schema_statuses: PmSettings["schema"]["statuses"];
  runtime_schema_fields: PmSettings["schema"]["fields"];
  runtime_schema_type_workflows: NonNullable<
    PmSettings["schema"]["type_workflows"]
  >;
}

interface SerializeSettingsOptions {
  persist_source?: SettingsPersistSourceSnapshot;
}

/** Documents the settings read metadata payload exchanged by command, SDK, and package integrations. */
export interface SettingsReadMetadata {
  /** Whether explicit item format applies to this operation. */
  has_explicit_item_format: boolean;
}

/** Documents the settings read result payload exchanged by command, SDK, and package integrations. */
export interface SettingsReadResult {
  /** Value that configures or reports settings for this contract. */
  settings: PmSettings;
  /** Value that configures or reports metadata for this contract. */
  metadata: SettingsReadMetadata;
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

function resolveGovernanceKnobsFromPreset(
  preset: Exclude<GovernancePreset, "custom">,
): Omit<GovernanceSettings, "preset"> {
  return structuredClone(GOVERNANCE_PRESET_DEFAULTS[preset]);
}

function normalizeGovernancePreset(
  value: GovernancePreset | undefined,
): GovernancePreset {
  if (
    value === "minimal" ||
    value === "default" ||
    value === "strict" ||
    value === "custom"
  ) {
    return value;
  }
  return SETTINGS_DEFAULTS.governance.preset;
}

// `create_default_type` and `workflow_enforcement` are orthogonal to the
// governance preset (they tune create/update behavior, not the preset knobs),
// so they must survive a write regardless of preset — otherwise a project on a
// non-custom preset would silently drop them on every settings write.
function withGovernanceExtras(
  base: Partial<GovernanceSettings> & { preset: GovernancePreset },
  governance: GovernanceSettings,
): Partial<GovernanceSettings> & { preset: GovernancePreset } {
  const createDefaultType =
    typeof governance.create_default_type === "string"
      ? governance.create_default_type.trim()
      : undefined;
  if (createDefaultType && createDefaultType.length > 0) {
    base.create_default_type = createDefaultType;
  }
  if (
    governance.workflow_enforcement === "off" ||
    governance.workflow_enforcement === "warn" ||
    governance.workflow_enforcement === "strict"
  ) {
    base.workflow_enforcement = governance.workflow_enforcement;
  }
  if (governance.require_close_reason === false) {
    base.require_close_reason = false;
  }
  return base;
}

function normalizeGovernanceForPersist(
  governance: GovernanceSettings,
): Partial<GovernanceSettings> & { preset: GovernancePreset } {
  if (governance.preset === "custom") {
    return withGovernanceExtras(
      {
        preset: "custom",
        ownership_enforcement: governance.ownership_enforcement,
        create_mode_default: governance.create_mode_default,
        close_validation_default: governance.close_validation_default,
        parent_reference: governance.parent_reference,
        metadata_profile: governance.metadata_profile,
        force_required_for_stale_lock: governance.force_required_for_stale_lock,
      },
      governance,
    );
  }
  return withGovernanceExtras(
    {
      preset: governance.preset,
    },
    governance,
  );
}

// Preset-orthogonal knobs that must be carried through resolve from the raw
// governance regardless of preset (see normalizeGovernanceForPersist).
function resolveGovernanceExtras(
  rawGovernance: Partial<GovernanceSettings>,
): Partial<
  Pick<
    GovernanceSettings,
    "create_default_type" | "workflow_enforcement" | "require_close_reason"
  >
> {
  const createDefaultType =
    typeof rawGovernance.create_default_type === "string"
      ? rawGovernance.create_default_type.trim()
      : undefined;
  const extras: Partial<
    Pick<
      GovernanceSettings,
      "create_default_type" | "workflow_enforcement" | "require_close_reason"
    >
  > = {};
  if (createDefaultType && createDefaultType.length > 0) {
    extras.create_default_type = createDefaultType;
  }
  if (
    rawGovernance.workflow_enforcement === "off" ||
    rawGovernance.workflow_enforcement === "warn" ||
    rawGovernance.workflow_enforcement === "strict"
  ) {
    extras.workflow_enforcement = rawGovernance.workflow_enforcement;
  }
  if (typeof rawGovernance.require_close_reason === "boolean") {
    extras.require_close_reason = rawGovernance.require_close_reason;
  }
  return extras;
}

/** Implements resolve governance knobs for the public runtime surface of this module. */
export function resolveGovernanceKnobs(
  settings:
    | Pick<PmSettings, "governance">
    | { governance?: Partial<GovernanceSettings> },
): GovernanceSettings {
  const rawGovernance = settings.governance ?? {};
  const preset = normalizeGovernancePreset(rawGovernance.preset);
  const extras = resolveGovernanceExtras(rawGovernance);
  if (preset === "custom") {
    const baseline = resolveGovernanceKnobsFromPreset("default");
    const requireCloseReason =
      extras.require_close_reason ?? baseline.require_close_reason;
    return {
      preset,
      ownership_enforcement:
        rawGovernance.ownership_enforcement ?? baseline.ownership_enforcement,
      create_mode_default:
        rawGovernance.create_mode_default ?? baseline.create_mode_default,
      close_validation_default:
        rawGovernance.close_validation_default ??
        baseline.close_validation_default,
      parent_reference:
        rawGovernance.parent_reference ?? baseline.parent_reference,
      metadata_profile:
        rawGovernance.metadata_profile ?? baseline.metadata_profile,
      force_required_for_stale_lock:
        rawGovernance.force_required_for_stale_lock ??
        baseline.force_required_for_stale_lock,
      ...extras,
      require_close_reason: requireCloseReason,
    };
  }
  const baseline = resolveGovernanceKnobsFromPreset(preset);
  const requireCloseReason =
    extras.require_close_reason ?? baseline.require_close_reason;
  return {
    preset,
    ...baseline,
    ...extras,
    require_close_reason: requireCloseReason,
  };
}

function cloneDefaults(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

function normalizeSearchMutationRefreshPolicy(
  value: unknown,
): SearchMutationRefreshPolicy {
  if (
    value === "cache_only" ||
    value === "semantic_configured" ||
    value === "semantic_auto"
  ) {
    return value;
  }
  return SETTINGS_DEFAULTS.search.mutation_refresh_policy;
}

function normalizeSearchQueryExpansionEnabled(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return SETTINGS_DEFAULTS.search.query_expansion.enabled;
}

function normalizeSearchQueryExpansionProvider(value: unknown): string {
  if (typeof value !== "string") {
    return SETTINGS_DEFAULTS.search.query_expansion.provider;
  }
  return value.trim();
}

function normalizeSearchRerankEnabled(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return SETTINGS_DEFAULTS.search.rerank.enabled;
}

function normalizeSearchRerankModel(value: unknown): string {
  if (typeof value !== "string") {
    return SETTINGS_DEFAULTS.search.rerank.model;
  }
  return value.trim();
}

function normalizeSearchRerankTopK(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  ) {
    return value;
  }
  return SETTINGS_DEFAULTS.search.rerank.top_k;
}

function normalizeVectorStoreCollectionName(value: unknown): string {
  if (typeof value !== "string") {
    return SETTINGS_DEFAULTS.vector_store.collection_name;
  }
  const sanitized = value.trim().replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const truncated = sanitized.slice(0, MAX_VECTOR_STORE_COLLECTION_NAME_LENGTH);
  return truncated.length > 0
    ? truncated
    : SETTINGS_DEFAULTS.vector_store.collection_name;
}

function buildSettingsPersistSourceSnapshot(
  parsedSettings: ParsedSettings,
  runtimeSettings: PmSettings,
): SettingsPersistSourceSnapshot {
  const sourceSchema = parsedSettings.schema;
  const sourceStatuses = Array.isArray(sourceSchema?.statuses)
    ? sourceSchema?.statuses
    : undefined;
  const sourceFields = Array.isArray(sourceSchema?.fields)
    ? sourceSchema?.fields
    : undefined;
  const sourceTypeWorkflows = Array.isArray(sourceSchema?.type_workflows)
    ? sourceSchema?.type_workflows
    : undefined;
  return {
    has_source_item_type_definitions: Array.isArray(
      parsedSettings.item_types?.definitions,
    ),
    source_item_type_definitions: normalizeItemTypeDefinitions(
      parsedSettings.item_types?.definitions,
    ),
    has_source_schema_statuses: sourceStatuses !== undefined,
    source_schema_statuses: sourceStatuses
      ? structuredClone(sourceStatuses)
      : [],
    has_source_schema_fields: sourceFields !== undefined,
    source_schema_fields: sourceFields ? structuredClone(sourceFields) : [],
    has_source_schema_type_workflows: sourceTypeWorkflows !== undefined,
    source_schema_type_workflows: sourceTypeWorkflows
      ? structuredClone(sourceTypeWorkflows)
      : [],
    runtime_item_type_definitions: normalizeItemTypeDefinitions(
      runtimeSettings.item_types?.definitions,
    ),
    runtime_schema_statuses: structuredClone(runtimeSettings.schema.statuses),
    runtime_schema_fields: structuredClone(runtimeSettings.schema.fields),
    runtime_schema_type_workflows: structuredClone(
      runtimeSettings.schema.type_workflows ?? [],
    ),
  };
}

function attachSettingsPersistSourceSnapshot(
  settings: PmSettings,
  source: SettingsPersistSourceSnapshot,
): void {
  Object.defineProperty(
    settings as unknown as Record<PropertyKey, unknown>,
    SETTINGS_PERSIST_SOURCE_SYMBOL,
    {
      value: source,
      writable: true,
      configurable: true,
      enumerable: false,
    },
  );
}

function getSettingsPersistSourceSnapshot(
  settings: PmSettings,
): SettingsPersistSourceSnapshot | undefined {
  const candidate = (settings as unknown as Record<PropertyKey, unknown>)[
    SETTINGS_PERSIST_SOURCE_SYMBOL
  ];
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  return candidate as SettingsPersistSourceSnapshot;
}

function cloneSettingsReadResult(
  result: SettingsReadResult,
): SettingsReadResult {
  const clonedSettings = structuredClone(result.settings);
  const persistSource = getSettingsPersistSourceSnapshot(result.settings);
  if (persistSource) {
    attachSettingsPersistSourceSnapshot(
      clonedSettings,
      structuredClone(persistSource),
    );
  }
  return {
    settings: clonedSettings,
    metadata: {
      has_explicit_item_format: result.metadata.has_explicit_item_format,
    },
    warnings: [...result.warnings],
  };
}

function resolveSettingsReadTrackedPaths(
  pmRoot: string,
  schema: PmSettings["schema"],
  settingsPath: string,
): string[] {
  const normalizedSchema = normalizeRuntimeSchemaSettings(schema);
  return [
    settingsPath,
    filePathForSchemaSection(
      pmRoot,
      normalizedSchema.files.types,
      DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.types,
    ),
    filePathForSchemaSection(
      pmRoot,
      normalizedSchema.files.statuses,
      DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.statuses,
    ),
    filePathForSchemaSection(
      pmRoot,
      normalizedSchema.files.fields,
      DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.fields,
    ),
    filePathForSchemaSection(
      pmRoot,
      normalizedSchema.files.workflows,
      DEFAULT_RUNTIME_SCHEMA_FILE_PATHS.workflows,
    ),
  ];
}

async function cacheSettingsReadResult(
  pmRoot: string,
  trackedPaths: string[],
  result: SettingsReadResult,
): Promise<void> {
  const signatures = await collectSettingsReadCacheSignatures(trackedPaths);
  setSettingsReadCacheEntry(pmRoot, {
    tracked_paths: trackedPaths,
    signatures,
    value: cloneSettingsReadResult(result),
  });
}

async function cacheSettingsReadResultSafe(
  pmRoot: string,
  trackedPaths: string[],
  result: SettingsReadResult,
): Promise<void> {
  try {
    await cacheSettingsReadResult(pmRoot, trackedPaths, result);
  } catch {
    clearSettingsReadCache(pmRoot);
  }
}

type SettingsReadCacheSignatures = Awaited<
  ReturnType<typeof collectSettingsReadCacheSignatures>
>;

function findSettingsReadCacheSignature(
  signatures: SettingsReadCacheSignatures,
  targetPath: string,
) {
  return signatures.find((signature) => signature.path === targetPath);
}

function selectedSettingsReadCacheSignaturesEqual(
  before: SettingsReadCacheSignatures,
  after: SettingsReadCacheSignatures,
  targetPaths: string[],
): boolean {
  for (const targetPath of targetPaths) {
    const beforeSignature = findSettingsReadCacheSignature(before, targetPath);
    const afterSignature = findSettingsReadCacheSignature(after, targetPath);
    if (
      !beforeSignature ||
      !afterSignature ||
      !settingsReadCacheSignaturesEqual([beforeSignature], [afterSignature])
    ) {
      return false;
    }
  }
  return true;
}

async function cacheSettingsReadResultIfStable(
  pmRoot: string,
  trackedPaths: string[],
  result: SettingsReadResult,
  stableSignatures: SettingsReadCacheSignatures,
  stablePaths: string[],
): Promise<void> {
  try {
    const currentSignatures =
      await collectSettingsReadCacheSignatures(trackedPaths);
    if (
      !selectedSettingsReadCacheSignaturesEqual(
        stableSignatures,
        currentSignatures,
        stablePaths,
      )
    ) {
      clearSettingsReadCache(pmRoot);
      return;
    }
    setSettingsReadCacheEntry(pmRoot, {
      tracked_paths: trackedPaths,
      signatures: currentSignatures,
      value: cloneSettingsReadResult(result),
    });
  } catch {
    clearSettingsReadCache(pmRoot);
  }
}

function resolvePersistedFileBackedSchemaSections(
  settings: PmSettings,
  source: SettingsPersistSourceSnapshot | undefined,
): {
  item_type_definitions: ItemTypeDefinition[];
  schema_statuses: PmSettings["schema"]["statuses"];
  schema_fields: PmSettings["schema"]["fields"];
  schema_type_workflows: PmSettings["schema"]["type_workflows"];
} {
  const normalizedSchema = normalizeRuntimeSchemaSettings(settings.schema);
  const currentItemTypeDefinitions = normalizeItemTypeDefinitions(
    settings.item_types?.definitions,
  );
  if (!source) {
    return {
      item_type_definitions: currentItemTypeDefinitions,
      schema_statuses: normalizedSchema.statuses,
      schema_fields: normalizedSchema.fields,
      schema_type_workflows: normalizedSchema.type_workflows,
    };
  }

  const currentTypeWorkflows = normalizedSchema.type_workflows ?? [];
  const itemTypeDefinitionsUnchanged = stableValueEquals(
    currentItemTypeDefinitions,
    source.runtime_item_type_definitions,
  );
  const schemaStatusesUnchanged = stableValueEquals(
    normalizedSchema.statuses,
    source.runtime_schema_statuses,
  );
  const schemaFieldsUnchanged = stableValueEquals(
    normalizedSchema.fields,
    source.runtime_schema_fields,
  );
  const schemaTypeWorkflowsUnchanged = stableValueEquals(
    currentTypeWorkflows,
    source.runtime_schema_type_workflows,
  );

  return {
    item_type_definitions: itemTypeDefinitionsUnchanged
      ? source.has_source_item_type_definitions
        ? normalizeItemTypeDefinitions(source.source_item_type_definitions)
        : []
      : currentItemTypeDefinitions,
    schema_statuses: schemaStatusesUnchanged
      ? source.has_source_schema_statuses
        ? structuredClone(source.source_schema_statuses)
        : []
      : normalizedSchema.statuses,
    schema_fields: schemaFieldsUnchanged
      ? source.has_source_schema_fields
        ? structuredClone(source.source_schema_fields)
        : []
      : normalizedSchema.fields,
    schema_type_workflows: schemaTypeWorkflowsUnchanged
      ? source.has_source_schema_type_workflows
        ? structuredClone(source.source_schema_type_workflows)
        : undefined
      : normalizedSchema.type_workflows,
  };
}

function buildFallbackSettingsReadResult(warning?: string): SettingsReadResult {
  return {
    settings: cloneDefaults(),
    metadata: {
      has_explicit_item_format: false,
    },
    warnings: warning ? [warning] : [],
  };
}

function hasExplicitItemFormat(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const itemFormat = (raw as Record<string, unknown>).item_format;
  return itemFormat === "toon" || itemFormat === "json_markdown";
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeAgentGuidanceSettings(
  value: Partial<PmSettings["agent_guidance"]> | undefined,
): PmSettings["agent_guidance"] {
  const defaults = SETTINGS_DEFAULTS.agent_guidance;
  const templateVersion = value?.template_version;
  return {
    prompt_completed: value?.prompt_completed === true,
    declined: value?.declined === true,
    declined_at:
      typeof value?.declined_at === "string"
        ? value.declined_at
        : defaults.declined_at,
    template_version:
      typeof templateVersion === "number" &&
      Number.isInteger(templateVersion) &&
      templateVersion > 0
        ? templateVersion
        : defaults.template_version,
    last_checked_files: normalizeStringList(
      value?.last_checked_files ?? defaults.last_checked_files,
    ),
  };
}

function normalizeLowerStringList(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeExtensionPolicyMode(
  value: ExtensionPolicyMode | undefined,
): ExtensionPolicyMode {
  if (value === "off" || value === "warn" || value === "enforce") {
    return value;
  }
  return SETTINGS_DEFAULTS.extensions.policy.mode;
}

function normalizeExtensionTrustMode(
  value: ExtensionTrustMode | undefined,
): ExtensionTrustMode {
  if (value === "off" || value === "warn" || value === "enforce") {
    return value;
  }
  return SETTINGS_DEFAULTS.extensions.policy.trust_mode;
}

function normalizeExtensionSandboxProfile(
  value: ExtensionSandboxProfile | undefined,
): ExtensionSandboxProfile {
  if (value === "none" || value === "restricted" || value === "strict") {
    return value;
  }
  return SETTINGS_DEFAULTS.extensions.policy.default_sandbox_profile;
}

function normalizeExtensionPolicyOverride(
  override: ExtensionPolicyOverrideSettings,
): ExtensionPolicyOverrideSettings | null {
  const name = override.name.trim().toLowerCase();
  if (name.length === 0) {
    return null;
  }
  const normalized: ExtensionPolicyOverrideSettings = {
    name,
  };
  if (override.disabled === true) {
    normalized.disabled = true;
  }
  if (override.require_trusted === true) {
    normalized.require_trusted = true;
  }
  if (override.require_provenance === true) {
    normalized.require_provenance = true;
  }
  if (override.sandbox_profile !== undefined) {
    normalized.sandbox_profile = normalizeExtensionSandboxProfile(
      override.sandbox_profile,
    );
  }
  const allowedCapabilities = normalizeLowerStringList(
    override.allowed_capabilities,
  );
  const blockedCapabilities = normalizeLowerStringList(
    override.blocked_capabilities,
  );
  const allowedSurfaces = normalizeLowerStringList(override.allowed_surfaces);
  const blockedSurfaces = normalizeLowerStringList(override.blocked_surfaces);
  const allowedCommands = normalizeLowerStringList(override.allowed_commands);
  const blockedCommands = normalizeLowerStringList(override.blocked_commands);
  const allowedActions = normalizeLowerStringList(override.allowed_actions);
  const blockedActions = normalizeLowerStringList(override.blocked_actions);
  const allowedServices = normalizeLowerStringList(override.allowed_services);
  const blockedServices = normalizeLowerStringList(override.blocked_services);
  if (allowedCapabilities.length > 0) {
    normalized.allowed_capabilities = allowedCapabilities;
  }
  if (blockedCapabilities.length > 0) {
    normalized.blocked_capabilities = blockedCapabilities;
  }
  if (allowedSurfaces.length > 0) {
    normalized.allowed_surfaces = allowedSurfaces;
  }
  if (blockedSurfaces.length > 0) {
    normalized.blocked_surfaces = blockedSurfaces;
  }
  if (allowedCommands.length > 0) {
    normalized.allowed_commands = allowedCommands;
  }
  if (blockedCommands.length > 0) {
    normalized.blocked_commands = blockedCommands;
  }
  if (allowedActions.length > 0) {
    normalized.allowed_actions = allowedActions;
  }
  if (blockedActions.length > 0) {
    normalized.blocked_actions = blockedActions;
  }
  if (allowedServices.length > 0) {
    normalized.allowed_services = allowedServices;
  }
  if (blockedServices.length > 0) {
    normalized.blocked_services = blockedServices;
  }
  return normalized;
}

function normalizeExtensionPolicyOverrides(
  overrides: ExtensionPolicyOverrideSettings[] | undefined,
): ExtensionPolicyOverrideSettings[] {
  const dedupedByName = new Map<string, ExtensionPolicyOverrideSettings>();
  for (const override of overrides ?? []) {
    const normalized = normalizeExtensionPolicyOverride(override);
    if (!normalized) {
      continue;
    }
    dedupedByName.set(normalized.name, normalized);
  }
  return [...dedupedByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function normalizePmMaxVersionExceededModeValue(
  value: unknown,
): PmMaxVersionExceededMode | undefined {
  return value === "block" || value === "warn" ? value : undefined;
}

/** Preserve a configured `pm_max_version_exceeded_mode` (string mode or per-layer override object) through settings normalization. Unset/invalid values are omitted so existing settings.json files round-trip byte-identically and the loader applies its safe default ("block"). */
function normalizePmMaxVersionExceededModeSetting(
  value: PmMaxVersionExceededModeSetting | undefined,
): PmMaxVersionExceededModeSetting | undefined {
  if (typeof value === "string") {
    return normalizePmMaxVersionExceededModeValue(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const global = normalizePmMaxVersionExceededModeValue(value.global);
    const project = normalizePmMaxVersionExceededModeValue(value.project);
    if (global === undefined && project === undefined) {
      return undefined;
    }
    return {
      ...(global !== undefined ? { global } : {}),
      ...(project !== undefined ? { project } : {}),
    };
  }
  return undefined;
}

type ExtensionPolicyListKey =
  | "trusted_extensions"
  | "allowed_extensions"
  | "blocked_extensions"
  | "allowed_capabilities"
  | "blocked_capabilities"
  | "allowed_surfaces"
  | "blocked_surfaces"
  | "allowed_commands"
  | "blocked_commands"
  | "allowed_actions"
  | "blocked_actions"
  | "allowed_services"
  | "blocked_services";

function normalizeExtensionPolicyList(
  policy: Partial<ExtensionGovernancePolicy> | undefined,
  key: ExtensionPolicyListKey,
): string[] {
  return normalizeLowerStringList(
    policy?.[key] ?? SETTINGS_DEFAULTS.extensions.policy[key],
  );
}

function normalizeExtensionPolicySettings(
  policy: Partial<ExtensionGovernancePolicy> | undefined,
): ExtensionGovernancePolicy {
  const pmMaxVersionExceededMode = normalizePmMaxVersionExceededModeSetting(
    policy?.pm_max_version_exceeded_mode,
  );
  return {
    mode: normalizeExtensionPolicyMode(policy?.mode),
    trust_mode: normalizeExtensionTrustMode(policy?.trust_mode),
    ...(pmMaxVersionExceededMode !== undefined
      ? { pm_max_version_exceeded_mode: pmMaxVersionExceededMode }
      : {}),
    require_provenance: policy?.require_provenance === true,
    trusted_extensions: normalizeExtensionPolicyList(
      policy,
      "trusted_extensions",
    ),
    default_sandbox_profile: normalizeExtensionSandboxProfile(
      policy?.default_sandbox_profile,
    ),
    allowed_extensions: normalizeExtensionPolicyList(
      policy,
      "allowed_extensions",
    ),
    blocked_extensions: normalizeExtensionPolicyList(
      policy,
      "blocked_extensions",
    ),
    allowed_capabilities: normalizeExtensionPolicyList(
      policy,
      "allowed_capabilities",
    ),
    blocked_capabilities: normalizeExtensionPolicyList(
      policy,
      "blocked_capabilities",
    ),
    allowed_surfaces: normalizeExtensionPolicyList(policy, "allowed_surfaces"),
    blocked_surfaces: normalizeExtensionPolicyList(policy, "blocked_surfaces"),
    allowed_commands: normalizeExtensionPolicyList(policy, "allowed_commands"),
    blocked_commands: normalizeExtensionPolicyList(policy, "blocked_commands"),
    allowed_actions: normalizeExtensionPolicyList(policy, "allowed_actions"),
    blocked_actions: normalizeExtensionPolicyList(policy, "blocked_actions"),
    allowed_services: normalizeExtensionPolicyList(policy, "allowed_services"),
    blocked_services: normalizeExtensionPolicyList(policy, "blocked_services"),
    extension_overrides: normalizeExtensionPolicyOverrides(
      policy?.extension_overrides ??
        SETTINGS_DEFAULTS.extensions.policy.extension_overrides,
    ),
  };
}

function normalizeValidationMetadataRequiredFields(
  values: string[] | undefined,
): ValidateMetadataRequiredField[] {
  const normalized = [
    ...new Set(
      (values ?? []).map((value) =>
        value.trim().toLowerCase().replaceAll("-", "_"),
      ),
    ),
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return normalized.filter((value): value is ValidateMetadataRequiredField =>
    [
      "author",
      "acceptance_criteria",
      "estimated_minutes",
      "close_reason",
      "reviewer",
      "risk",
      "confidence",
      "sprint",
      "release",
    ].includes(value),
  );
}

function normalizeValidationPatternList(
  values: string[] | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function valueOrDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function buildValidationSettings(
  settings: ParsedSettings,
  defaults: PmSettings,
  governance: GovernanceSettings,
): PmSettings["validation"] {
  return {
    ...defaults.validation,
    ...settings.validation,
    parent_reference: governance.parent_reference,
    metadata_profile: governance.metadata_profile,
    metadata_required_fields: normalizeValidationMetadataRequiredFields(
      settings.validation?.metadata_required_fields,
    ),
    lifecycle_stale_blocker_reason_patterns: normalizeValidationPatternList(
      settings.validation?.lifecycle_stale_blocker_reason_patterns ??
        defaults.validation.lifecycle_stale_blocker_reason_patterns,
    ),
    lifecycle_closure_like_blocked_reason_patterns:
      normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_blocked_reason_patterns ??
          defaults.validation.lifecycle_closure_like_blocked_reason_patterns,
      ),
    lifecycle_closure_like_resolution_patterns: normalizeValidationPatternList(
      settings.validation?.lifecycle_closure_like_resolution_patterns ??
        defaults.validation.lifecycle_closure_like_resolution_patterns,
    ),
    lifecycle_closure_like_actual_result_patterns:
      normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_actual_result_patterns ??
          defaults.validation.lifecycle_closure_like_actual_result_patterns,
      ),
    estimate_defaults_by_type: normalizeEstimateDefaultOverrides(
      settings.validation?.estimate_defaults_by_type,
    ),
  };
}

function buildTelemetrySettings(
  settings: ParsedSettings,
  defaults: PmSettings,
): PmSettings["telemetry"] {
  return {
    enabled: settings.telemetry?.enabled ?? defaults.telemetry.enabled,
    first_run_prompt_completed:
      settings.telemetry?.first_run_prompt_completed ??
      defaults.telemetry.first_run_prompt_completed,
    capture_level:
      settings.telemetry?.capture_level ?? defaults.telemetry.capture_level,
    endpoint: settings.telemetry?.endpoint ?? defaults.telemetry.endpoint,
    installation_id:
      settings.telemetry?.installation_id ?? defaults.telemetry.installation_id,
    retention_days:
      settings.telemetry?.retention_days ?? defaults.telemetry.retention_days,
  };
}

function buildSearchSettings(
  settings: ParsedSettings,
  defaults: PmSettings,
): PmSettings["search"] {
  return {
    ...defaults.search,
    ...settings.search,
    mutation_refresh_policy: normalizeSearchMutationRefreshPolicy(
      settings.search?.mutation_refresh_policy,
    ),
    query_expansion: {
      ...defaults.search.query_expansion,
      ...settings.search?.query_expansion,
      enabled: normalizeSearchQueryExpansionEnabled(
        settings.search?.query_expansion?.enabled,
      ),
      provider: normalizeSearchQueryExpansionProvider(
        settings.search?.query_expansion?.provider,
      ),
    },
    rerank: {
      ...defaults.search.rerank,
      ...settings.search?.rerank,
      enabled: normalizeSearchRerankEnabled(settings.search?.rerank?.enabled),
      model: normalizeSearchRerankModel(settings.search?.rerank?.model),
      top_k: normalizeSearchRerankTopK(settings.search?.rerank?.top_k),
    },
  };
}

function buildVectorStoreSettings(
  settings: ParsedSettings,
  defaults: PmSettings,
): PmSettings["vector_store"] {
  return {
    adapter: settings.vector_store.adapter ?? defaults.vector_store.adapter,
    collection_name: normalizeVectorStoreCollectionName(
      settings.vector_store.collection_name,
    ),
    qdrant: {
      ...defaults.vector_store.qdrant,
      ...settings.vector_store.qdrant,
    },
    lancedb: {
      ...defaults.vector_store.lancedb,
      ...settings.vector_store.lancedb,
    },
  };
}

function normalizeSettingsItemFormat(
  settings: ParsedSettings,
  defaults: PmSettings,
): PmSettings["item_format"] {
  if (settings.item_format === "json_markdown") {
    return "toon";
  }
  return settings.item_format ?? defaults.item_format;
}

function buildContextSettings(
  settings: ParsedSettings,
  defaults: PmSettings,
): PmSettings["context"] {
  return {
    default_depth:
      settings.context?.default_depth ?? defaults.context.default_depth,
    activity_limit:
      settings.context?.activity_limit ?? defaults.context.activity_limit,
    stale_threshold_days:
      settings.context?.stale_threshold_days ??
      defaults.context.stale_threshold_days,
    sections: {
      ...defaults.context.sections,
      ...settings.context?.sections,
    },
  };
}

function buildProviderSettings(
  settings: ParsedSettings,
  defaults: PmSettings,
): PmSettings["providers"] {
  return {
    openai: { ...defaults.providers.openai, ...settings.providers.openai },
    ollama: { ...defaults.providers.ollama, ...settings.providers.ollama },
  };
}

/** Implements normalize item type definitions for the public runtime surface of this module. */
export function normalizeItemTypeDefinitions(
  definitions: ItemTypeDefinition[] | undefined,
): ItemTypeDefinition[] {
  const normalized = (definitions ?? [])
    .map((definition) => normalizeItemTypeDefinition(definition))
    .filter(
      (definition): definition is ItemTypeDefinition => definition !== null,
    );
  const dedupedByName = new Map<string, ItemTypeDefinition>();
  for (const definition of normalized) {
    dedupedByName.set(definition.name.toLowerCase(), definition);
  }
  return [...dedupedByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function mergeSettings(settings: ParsedSettings): PmSettings {
  const defaults = cloneDefaults();
  const governance = resolveGovernanceKnobs({
    governance: settings.governance ?? { preset: "default" },
  });
  return {
    ...defaults,
    ...settings,
    item_format: normalizeSettingsItemFormat(settings, defaults),
    locks: { ...defaults.locks, ...settings.locks },
    checkpoints: { ...defaults.checkpoints, ...settings.checkpoints },
    output: { ...defaults.output, ...settings.output },
    history: {
      ...defaults.history,
      ...settings.history,
      compact_policy: {
        ...defaults.history.compact_policy,
        ...settings.history?.compact_policy,
      },
    },
    validation: buildValidationSettings(settings, defaults, governance),
    governance,
    workflow: {
      definition_of_done: [
        ...(settings.workflow?.definition_of_done ??
          defaults.workflow.definition_of_done),
      ],
    },
    testing: {
      record_results_to_items:
        settings.testing?.record_results_to_items ??
        defaults.testing.record_results_to_items,
    },
    telemetry: buildTelemetrySettings(settings, defaults),
    agent_guidance: normalizeAgentGuidanceSettings(
      settings.agent_guidance ?? defaults.agent_guidance,
    ),
    item_types: {
      definitions: normalizeItemTypeDefinitions(
        settings.item_types?.definitions,
      ),
    },
    schema: normalizeRuntimeSchemaSettings(settings.schema ?? defaults.schema),
    context: buildContextSettings(settings, defaults),
    extensions: {
      enabled: [...settings.extensions.enabled],
      disabled: [...settings.extensions.disabled],
      policy: normalizeExtensionPolicySettings(
        settings.extensions.policy ?? defaults.extensions.policy,
      ),
    },
    search: buildSearchSettings(settings, defaults),
    providers: buildProviderSettings(settings, defaults),
    vector_store: buildVectorStoreSettings(settings, defaults),
  };
}

function orderSerializedSettingsSections(
  ordered: Record<string, unknown>,
): void {
  ordered.locks = orderObject(ordered.locks as Record<string, unknown>, [
    "ttl_seconds",
    "wait_ms",
  ]);
  ordered.checkpoints = orderObject(
    ordered.checkpoints as Record<string, unknown>,
    ["retention_days"],
  );
  ordered.output = orderObject(ordered.output as Record<string, unknown>, [
    "default_format",
  ]);
  ordered.history = orderObject(ordered.history as Record<string, unknown>, [
    "missing_stream",
    "compact_policy",
  ]);
  ordered.validation = orderObject(
    ordered.validation as Record<string, unknown>,
    [
      "sprint_release_format",
      "parent_reference",
      "metadata_profile",
      "metadata_required_fields",
      "lifecycle_stale_blocker_reason_patterns",
      "lifecycle_closure_like_blocked_reason_patterns",
      "lifecycle_closure_like_resolution_patterns",
      "lifecycle_closure_like_actual_result_patterns",
      "estimate_defaults_by_type",
    ],
  );
  ordered.governance = orderObject(
    ordered.governance as Record<string, unknown>,
    [
      "preset",
      "ownership_enforcement",
      "create_mode_default",
      "close_validation_default",
      "require_close_reason",
      "parent_reference",
      "metadata_profile",
      "force_required_for_stale_lock",
      "create_default_type",
      "workflow_enforcement",
    ],
  );
  ordered.workflow = orderObject(ordered.workflow as Record<string, unknown>, [
    "definition_of_done",
  ]);
  ordered.testing = orderObject(ordered.testing as Record<string, unknown>, [
    "record_results_to_items",
  ]);
  ordered.telemetry = orderObject(
    ordered.telemetry as Record<string, unknown>,
    [
      "enabled",
      "first_run_prompt_completed",
      "capture_level",
      "endpoint",
      "installation_id",
      "retention_days",
    ],
  );
  ordered.agent_guidance = orderObject(
    ordered.agent_guidance as Record<string, unknown>,
    [
      "prompt_completed",
      "declined",
      "declined_at",
      "template_version",
      "last_checked_files",
    ],
  );
  ordered.item_types = orderObject(
    ordered.item_types as Record<string, unknown>,
    ["definitions"],
  );
  ordered.schema = orderObject(ordered.schema as Record<string, unknown>, [
    "version",
    "files",
    "statuses",
    "fields",
    "workflow",
    "type_workflows",
    "unknown_field_policy",
  ]);
  (ordered.schema as Record<string, unknown>).files = orderObject(
    recordOrEmpty((ordered.schema as Record<string, unknown>).files),
    ["types", "statuses", "fields", "workflows"],
  );
  (ordered.schema as Record<string, unknown>).workflow = orderObject(
    recordOrEmpty((ordered.schema as Record<string, unknown>).workflow),
    [
      "draft_status",
      "open_status",
      "in_progress_status",
      "blocked_status",
      "close_status",
      "canceled_status",
    ],
  );
  ordered.context = orderObject(ordered.context as Record<string, unknown>, [
    "default_depth",
    "activity_limit",
    "stale_threshold_days",
    "sections",
  ]);
  (ordered.context as Record<string, unknown>).sections = orderObject(
    recordOrEmpty((ordered.context as Record<string, unknown>).sections),
    [
      "hierarchy",
      "activity",
      "progress",
      "blockers",
      "files",
      "workload",
      "staleness",
      "tests",
    ],
  );
  ordered.extensions = orderObject(
    ordered.extensions as Record<string, unknown>,
    ["enabled", "disabled", "policy"],
  );
  (ordered.extensions as Record<string, unknown>).policy = orderObject(
    recordOrEmpty((ordered.extensions as Record<string, unknown>).policy),
    [
      "mode",
      "trust_mode",
      "pm_max_version_exceeded_mode",
      "require_provenance",
      "trusted_extensions",
      "default_sandbox_profile",
      "allowed_extensions",
      "blocked_extensions",
      "allowed_capabilities",
      "blocked_capabilities",
      "allowed_surfaces",
      "blocked_surfaces",
      "allowed_commands",
      "blocked_commands",
      "allowed_actions",
      "blocked_actions",
      "allowed_services",
      "blocked_services",
      "extension_overrides",
    ],
  );
  (
    (ordered.extensions as Record<string, unknown>).policy as Record<
      string,
      unknown
    >
  ).extension_overrides = arrayOrEmpty(
    (
      (ordered.extensions as Record<string, unknown>).policy as Record<
        string,
        unknown
      >
    ).extension_overrides,
  ).map((entry) =>
    orderObject(recordOrEmpty(entry), [
      "name",
      "disabled",
      "require_trusted",
      "require_provenance",
      "sandbox_profile",
      "allowed_capabilities",
      "blocked_capabilities",
      "allowed_surfaces",
      "blocked_surfaces",
      "allowed_commands",
      "blocked_commands",
      "allowed_actions",
      "blocked_actions",
      "allowed_services",
      "blocked_services",
    ]),
  );
  ordered.search = orderObject(ordered.search as Record<string, unknown>, [
    "score_threshold",
    "hybrid_semantic_weight",
    "max_results",
    "embedding_model",
    "embedding_corpus_max_characters",
    "embedding_batch_size",
    "embedding_timeout_ms",
    "scanner_max_batch_retries",
    "provider",
    "mutation_refresh_policy",
    "query_expansion",
    "rerank",
  ]);
  (ordered.search as Record<string, unknown>).query_expansion = orderObject(
    recordOrEmpty((ordered.search as Record<string, unknown>).query_expansion),
    ["enabled", "provider"],
  );
  (ordered.search as Record<string, unknown>).rerank = orderObject(
    recordOrEmpty((ordered.search as Record<string, unknown>).rerank),
    ["enabled", "model", "top_k"],
  );
  ordered.providers = orderObject(
    ordered.providers as Record<string, unknown>,
    ["openai", "ollama"],
  );
  (ordered.providers as Record<string, unknown>).openai = orderObject(
    recordOrEmpty((ordered.providers as Record<string, unknown>).openai),
    ["base_url", "api_key", "model"],
  );
  (ordered.providers as Record<string, unknown>).ollama = orderObject(
    recordOrEmpty((ordered.providers as Record<string, unknown>).ollama),
    ["base_url", "model"],
  );
  ordered.vector_store = orderObject(
    ordered.vector_store as Record<string, unknown>,
    ["adapter", "collection_name", "qdrant", "lancedb"],
  );
  (ordered.vector_store as Record<string, unknown>).qdrant = orderObject(
    recordOrEmpty((ordered.vector_store as Record<string, unknown>).qdrant),
    ["url", "api_key"],
  );
  (ordered.vector_store as Record<string, unknown>).lancedb = orderObject(
    recordOrEmpty((ordered.vector_store as Record<string, unknown>).lancedb),
    ["path"],
  );
}

function buildSerializeBaseSettings(settings: PmSettings): PmSettings {
  return {
    ...settings,
    locks: valueOrDefault(settings.locks, SETTINGS_DEFAULTS.locks),
    checkpoints: valueOrDefault(
      settings.checkpoints,
      SETTINGS_DEFAULTS.checkpoints,
    ),
    output: valueOrDefault(settings.output, SETTINGS_DEFAULTS.output),
    history: valueOrDefault(settings.history, SETTINGS_DEFAULTS.history),
    validation: valueOrDefault(
      settings.validation,
      SETTINGS_DEFAULTS.validation,
    ),
    workflow: valueOrDefault(settings.workflow, SETTINGS_DEFAULTS.workflow),
    testing: valueOrDefault(settings.testing, SETTINGS_DEFAULTS.testing),
    telemetry: valueOrDefault(settings.telemetry, SETTINGS_DEFAULTS.telemetry),
    agent_guidance: valueOrDefault(
      settings.agent_guidance,
      SETTINGS_DEFAULTS.agent_guidance,
    ),
    item_types: valueOrDefault(
      settings.item_types,
      SETTINGS_DEFAULTS.item_types,
    ),
    schema: valueOrDefault(settings.schema, SETTINGS_DEFAULTS.schema),
    context: valueOrDefault(settings.context, SETTINGS_DEFAULTS.context),
    extensions: valueOrDefault(
      settings.extensions,
      SETTINGS_DEFAULTS.extensions,
    ),
    search: valueOrDefault(settings.search, SETTINGS_DEFAULTS.search),
    providers: valueOrDefault(settings.providers, SETTINGS_DEFAULTS.providers),
    vector_store: valueOrDefault(
      settings.vector_store,
      SETTINGS_DEFAULTS.vector_store,
    ),
  } as PmSettings;
}

function buildSerializedValidationSettings(
  baseSettings: PmSettings,
  governance: GovernanceSettings,
): PmSettings["validation"] {
  return {
    ...baseSettings.validation,
    parent_reference: governance.parent_reference,
    metadata_profile: governance.metadata_profile,
    metadata_required_fields: normalizeValidationMetadataRequiredFields(
      baseSettings.validation?.metadata_required_fields,
    ),
    lifecycle_stale_blocker_reason_patterns: normalizeValidationPatternList(
      baseSettings.validation?.lifecycle_stale_blocker_reason_patterns ??
        SETTINGS_DEFAULTS.validation.lifecycle_stale_blocker_reason_patterns,
    ),
    lifecycle_closure_like_blocked_reason_patterns:
      normalizeValidationPatternList(
        baseSettings.validation
          ?.lifecycle_closure_like_blocked_reason_patterns ??
          SETTINGS_DEFAULTS.validation
            .lifecycle_closure_like_blocked_reason_patterns,
      ),
    lifecycle_closure_like_resolution_patterns: normalizeValidationPatternList(
      baseSettings.validation?.lifecycle_closure_like_resolution_patterns ??
        SETTINGS_DEFAULTS.validation.lifecycle_closure_like_resolution_patterns,
    ),
    lifecycle_closure_like_actual_result_patterns:
      normalizeValidationPatternList(
        baseSettings.validation
          ?.lifecycle_closure_like_actual_result_patterns ??
          SETTINGS_DEFAULTS.validation
            .lifecycle_closure_like_actual_result_patterns,
      ),
    estimate_defaults_by_type: normalizeEstimateDefaultOverrides(
      baseSettings.validation?.estimate_defaults_by_type,
    ),
  };
}

function buildSerializedSearchSettings(
  baseSettings: PmSettings,
): PmSettings["search"] {
  return {
    ...SETTINGS_DEFAULTS.search,
    ...baseSettings.search,
    mutation_refresh_policy: normalizeSearchMutationRefreshPolicy(
      baseSettings.search?.mutation_refresh_policy,
    ),
    query_expansion: {
      ...SETTINGS_DEFAULTS.search.query_expansion,
      ...baseSettings.search?.query_expansion,
      enabled: normalizeSearchQueryExpansionEnabled(
        baseSettings.search?.query_expansion?.enabled,
      ),
      provider: normalizeSearchQueryExpansionProvider(
        baseSettings.search?.query_expansion?.provider,
      ),
    },
    rerank: {
      ...SETTINGS_DEFAULTS.search.rerank,
      ...baseSettings.search?.rerank,
      enabled: normalizeSearchRerankEnabled(
        baseSettings.search?.rerank?.enabled,
      ),
      model: normalizeSearchRerankModel(baseSettings.search?.rerank?.model),
      top_k: normalizeSearchRerankTopK(baseSettings.search?.rerank?.top_k),
    },
  };
}

function buildSerializedContextSettings(
  baseSettings: PmSettings,
): PmSettings["context"] {
  return {
    default_depth:
      baseSettings.context?.default_depth ??
      SETTINGS_DEFAULTS.context.default_depth,
    activity_limit:
      baseSettings.context?.activity_limit ??
      SETTINGS_DEFAULTS.context.activity_limit,
    stale_threshold_days:
      baseSettings.context?.stale_threshold_days ??
      SETTINGS_DEFAULTS.context.stale_threshold_days,
    sections: {
      ...SETTINGS_DEFAULTS.context.sections,
      ...baseSettings.context?.sections,
    },
  };
}

function buildSerializedVectorStoreSettings(
  baseSettings: PmSettings,
): PmSettings["vector_store"] {
  return {
    ...baseSettings.vector_store,
    adapter:
      baseSettings.vector_store?.adapter ??
      SETTINGS_DEFAULTS.vector_store.adapter,
    collection_name: normalizeVectorStoreCollectionName(
      baseSettings.vector_store?.collection_name,
    ),
    qdrant: { ...baseSettings.vector_store?.qdrant },
    lancedb: { ...baseSettings.vector_store?.lancedb },
  };
}

function buildNormalizedSettingsForSerialization(
  baseSettings: PmSettings,
  governance: GovernanceSettings,
  normalizedSchema: PmSettings["schema"],
  persistedFileBackedSections: ReturnType<
    typeof resolvePersistedFileBackedSchemaSections
  >,
): PmSettings {
  return {
    ...baseSettings,
    item_format: "toon",
    validation: buildSerializedValidationSettings(baseSettings, governance),
    governance,
    agent_guidance: normalizeAgentGuidanceSettings(baseSettings.agent_guidance),
    item_types: {
      definitions: persistedFileBackedSections.item_type_definitions,
    },
    schema: {
      ...normalizedSchema,
      statuses: persistedFileBackedSections.schema_statuses,
      fields: persistedFileBackedSections.schema_fields,
      type_workflows: persistedFileBackedSections.schema_type_workflows,
    },
    search: buildSerializedSearchSettings(baseSettings),
    context: buildSerializedContextSettings(baseSettings),
    extensions: {
      enabled: normalizeStringList(baseSettings.extensions?.enabled),
      disabled: normalizeStringList(baseSettings.extensions?.disabled),
      policy: normalizeExtensionPolicySettings(baseSettings.extensions?.policy),
    },
    vector_store: buildSerializedVectorStoreSettings(baseSettings),
  };
}

/** Implements serialize settings for the public runtime surface of this module. */
export function serializeSettings(
  settings: PmSettings,
  options: SerializeSettingsOptions = {},
): string {
  const baseSettings = buildSerializeBaseSettings(settings);
  const governance = resolveGovernanceKnobs(baseSettings);
  const normalizedSchema = normalizeRuntimeSchemaSettings(baseSettings.schema);
  const persistedFileBackedSections = resolvePersistedFileBackedSchemaSections(
    baseSettings,
    options.persist_source,
  );
  const normalizedSettings = buildNormalizedSettingsForSerialization(
    baseSettings,
    governance,
    normalizedSchema,
    persistedFileBackedSections,
  );
  const ordered = orderObject(
    {
      ...(normalizedSettings as unknown as Record<string, unknown>),
      governance: normalizeGovernanceForPersist(governance) as unknown,
    },
    [
      "version",
      "id_prefix",
      "author_default",
      "item_format",
      "locks",
      "checkpoints",
      "output",
      "history",
      "validation",
      "governance",
      "workflow",
      "testing",
      "telemetry",
      "agent_guidance",
      "item_types",
      "schema",
      "context",
      "extensions",
      "search",
      "providers",
      "vector_store",
    ],
  );
  orderSerializedSettingsSections(ordered);

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Implements read settings with metadata for the public runtime surface of this module. */
export async function readSettingsWithMetadata(
  pmRoot: string,
): Promise<SettingsReadResult> {
  const settingsPath = getSettingsPath(pmRoot);
  let trackedPathsForFailure: string[] = [settingsPath];
  await runActiveOnReadHooks({
    path: settingsPath,
    scope: "project",
  });

  const cachedResult = getSettingsReadCacheEntry<SettingsReadResult>(pmRoot);
  if (cachedResult) {
    const currentSignatures = await collectSettingsReadCacheSignatures(
      cachedResult.tracked_paths,
    );
    if (
      settingsReadCacheSignaturesEqual(
        currentSignatures,
        cachedResult.signatures,
      )
    ) {
      return cloneSettingsReadResult(cachedResult.value);
    }
  }

  const settingsOnlySignatures = await collectSettingsReadCacheSignatures([
    settingsPath,
  ]);
  const raw = await readFileIfExists(settingsPath);
  if (raw === null) {
    const fallback = buildFallbackSettingsReadResult();
    await cacheSettingsReadResultIfStable(
      pmRoot,
      [settingsPath],
      fallback,
      settingsOnlySignatures,
      [settingsPath],
    );
    return fallback;
  }

  const settingsSignaturesAfterRead = await collectSettingsReadCacheSignatures([
    settingsPath,
  ]);
  if (
    !settingsReadCacheSignaturesEqual(
      settingsOnlySignatures,
      settingsSignaturesAfterRead,
    )
  ) {
    clearSettingsReadCache(pmRoot);
    return readSettingsWithMetadata(pmRoot);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    const fallback = buildFallbackSettingsReadResult(
      "settings_read_invalid_json",
    );
    await cacheSettingsReadResultIfStable(
      pmRoot,
      [settingsPath],
      fallback,
      settingsSignaturesAfterRead,
      [settingsPath],
    );
    return fallback;
  }

  const validated = validateSettings(parsed);
  if (!validated.success) {
    const fallback = buildFallbackSettingsReadResult(
      "settings_read_invalid_schema",
    );
    await cacheSettingsReadResultIfStable(
      pmRoot,
      [settingsPath],
      fallback,
      settingsSignaturesAfterRead,
      [settingsPath],
    );
    return fallback;
  }

  try {
    const mergedSettings = mergeSettings(validated.data);
    const trackedPaths = resolveSettingsReadTrackedPaths(
      pmRoot,
      mergedSettings.schema,
      settingsPath,
    );
    trackedPathsForFailure = trackedPaths;
    const signaturesBeforeSchemaLoad =
      await collectSettingsReadCacheSignatures(trackedPaths);
    const schemaScaffold = await ensureRuntimeSchemaFileScaffold(
      pmRoot,
      mergedSettings.schema,
    );
    const loadedSchemaSections = await loadRuntimeSchemaFromOptionalFiles(
      pmRoot,
      mergedSettings.schema,
    );
    const signaturesAfterSchemaLoad =
      await collectSettingsReadCacheSignatures(trackedPaths);
    const settings: PmSettings = {
      ...mergedSettings,
      item_types: {
        definitions: normalizeItemTypeDefinitions([
          ...mergedSettings.item_types.definitions,
          ...arrayOrEmpty<ItemTypeDefinition>(
            loadedSchemaSections.type_definitions_from_file,
          ),
        ]),
      },
      schema: loadedSchemaSections.schema,
    };
    attachSettingsPersistSourceSnapshot(
      settings,
      buildSettingsPersistSourceSnapshot(validated.data, settings),
    );
    const result: SettingsReadResult = {
      settings,
      metadata: {
        has_explicit_item_format: hasExplicitItemFormat(parsed),
      },
      warnings: [
        ...(validated.data.item_format === "json_markdown"
          ? ["settings_item_format_legacy_json_markdown_coerced_to_toon"]
          : []),
        ...schemaScaffold.created_paths.map(
          (createdPath) => `runtime_schema_bootstrap_created:${createdPath}`,
        ),
        ...loadedSchemaSections.warnings,
      ],
    };
    if (schemaScaffold.created_paths.length === 0) {
      if (
        !settingsReadCacheSignaturesEqual(
          signaturesBeforeSchemaLoad,
          signaturesAfterSchemaLoad,
        )
      ) {
        clearSettingsReadCache(pmRoot);
      } else {
        setSettingsReadCacheEntry(pmRoot, {
          tracked_paths: trackedPaths,
          signatures: signaturesAfterSchemaLoad,
          value: cloneSettingsReadResult(result),
        });
      }
    } else {
      // Bootstrap warnings are intentionally one-shot and should not be replayed from cache.
      clearSettingsReadCache(pmRoot);
    }
    return result;
  } catch {
    const fallback = buildFallbackSettingsReadResult(
      "settings_read_merge_failed",
    );
    await cacheSettingsReadResultSafe(pmRoot, trackedPathsForFailure, fallback);
    return fallback;
  }
}

/** Implements read settings for the public runtime surface of this module. */
export async function readSettings(pmRoot: string): Promise<PmSettings> {
  return (await readSettingsWithMetadata(pmRoot)).settings;
}

/** Implements write settings for the public runtime surface of this module. */
export async function writeSettings(
  pmRoot: string,
  settings: PmSettings,
  op = SETTINGS_WRITE_OP,
): Promise<void> {
  const settingsPath = getSettingsPath(pmRoot);
  await writeFileAtomic(
    settingsPath,
    serializeSettings(settings, {
      persist_source: getSettingsPersistSourceSnapshot(settings),
    }),
  );
  try {
    await runActiveOnWriteHooks({
      path: settingsPath,
      scope: "project",
      op,
    });
  } finally {
    clearSettingsReadCache(pmRoot);
  }
}

/** Public contract for settings store test only, shared by SDK and presentation-layer consumers. */
export const settingsStoreTestOnly = {
  hasExplicitItemFormat,
  buildSettingsPersistSourceSnapshot,
  cacheSettingsReadResultIfStable,
  cacheSettingsReadResultSafe,
  mergeSettings,
  normalizeExtensionPolicySettings,
  normalizeExtensionPolicyOverride,
  normalizeExtensionPolicyOverrides,
  normalizeExtensionPolicyMode,
  normalizePmMaxVersionExceededModeSetting,
  normalizeExtensionSandboxProfile,
  normalizeExtensionTrustMode,
  normalizeLowerStringList,
  normalizeStringList,
  valueOrDefault,
  arrayOrEmpty,
  normalizeValidationPatternList,
  normalizeValidationMetadataRequiredFields,
  resolveSettingsReadTrackedPaths,
  resolvePersistedFileBackedSchemaSections,
  selectedSettingsReadCacheSignaturesEqual,
};
