import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pathExists } from "../fs/fs-utils.js";
import { resolveGlobalPmRoot } from "../store/paths.js";
import type { PmSettings } from "../../types/index.js";
import type { GlobalOptions } from "../shared/command-types.js";

const DEFAULT_EXTENSION_PRIORITY = 100;
const KNOWN_EXTENSION_CAPABILITIES = ["commands", "renderers", "hooks", "schema", "importers", "search"] as const;
type ExtensionCapability = (typeof KNOWN_EXTENSION_CAPABILITIES)[number];

export type ExtensionLayer = "global" | "project";
type ExtensionStatus = "ok" | "warn";

export interface ExtensionManifest {
  name: string;
  version: string;
  entry: string;
  priority: number;
  capabilities: string[];
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
  pm_root: string;
}

export interface AfterCommandHookContext extends BeforeCommandHookContext {
  ok: boolean;
  error?: string;
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

export interface CommandDefinition {
  name: string;
  run: CommandHandler;
}

export type FlagDefinition = Record<string, unknown>;
export type SchemaFieldDefinition = Record<string, unknown>;
export type SchemaMigrationDefinition = Record<string, unknown>;
export type SearchProviderDefinition = Record<string, unknown>;
export type VectorStoreAdapterDefinition = Record<string, unknown>;
export type Importer = (context: unknown) => unknown;
export type Exporter = (context: unknown) => unknown;

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

export interface ExtensionRendererRegistry {
  overrides: RegisteredExtensionRendererOverride[];
}

export interface RegisteredExtensionFlagDefinitions {
  layer: ExtensionLayer;
  name: string;
  target_command: string;
  flags: FlagDefinition[];
}

export interface RegisteredExtensionSchemaFieldDefinitions {
  layer: ExtensionLayer;
  name: string;
  fields: SchemaFieldDefinition[];
}

export interface RegisteredExtensionSchemaMigrationDefinition {
  layer: ExtensionLayer;
  name: string;
  definition: SchemaMigrationDefinition;
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
}

export interface RegisteredExtensionVectorStoreAdapter {
  layer: ExtensionLayer;
  name: string;
  definition: VectorStoreAdapterDefinition;
}

export interface ExtensionRegistrationRegistry {
  flags: RegisteredExtensionFlagDefinitions[];
  item_fields: RegisteredExtensionSchemaFieldDefinitions[];
  migrations: RegisteredExtensionSchemaMigrationDefinition[];
  importers: RegisteredExtensionImporter[];
  exporters: RegisteredExtensionExporter[];
  search_providers: RegisteredExtensionSearchProvider[];
  vector_store_adapters: RegisteredExtensionVectorStoreAdapter[];
}

export interface ExtensionRegistrationCounts {
  flags: number;
  item_fields: number;
  migrations: number;
  importers: number;
  exporters: number;
  search_providers: number;
  vector_store_adapters: number;
}

export interface ExtensionApi {
  registerCommand(command: string, override: CommandOverride): void;
  registerCommand(definition: CommandDefinition): void;
  registerFlags(targetCommand: string, flags: FlagDefinition[]): void;
  registerItemFields(fields: SchemaFieldDefinition[]): void;
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
}

export interface ExtensionActivationResult {
  hooks: ExtensionHookRegistry;
  commands: ExtensionCommandRegistry;
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
  if ("capabilities" in candidate && candidate.capabilities !== undefined && candidate.capabilities !== null) {
    if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((value) => typeof value !== "string")) {
      return null;
    }
    capabilities = normalizeNames((candidate.capabilities as string[]).map((value) => value.toLowerCase()));
  }

  return {
    name: candidate.name.trim(),
    version: candidate.version.trim(),
    entry: candidate.entry.trim(),
    priority,
    capabilities,
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

export function createEmptyExtensionRendererRegistry(): ExtensionRendererRegistry {
  return {
    overrides: [],
  };
}

export function createEmptyExtensionRegistrationRegistry(): ExtensionRegistrationRegistry {
  return {
    flags: [],
    item_fields: [],
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
  for (const capability of collectUnknownExtensionCapabilities(manifest.capabilities)) {
    extensionWarnings.push(`extension_capability_unknown:${layer}:${manifest.name}:${capability}`);
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

function normalizeRegistrationRecord(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} requires an object definition`);
  }
  return sanitizeRegistrationValue(value) as Record<string, unknown>;
}

function normalizeRegistrationRecordList(name: string, value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} requires an array of object definitions`);
  }
  return value.map((entry) => normalizeRegistrationRecord(name, entry));
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
  renderers: ExtensionRendererRegistry,
  registrations: ExtensionRegistrationRegistry,
): ExtensionApi {
  const registerCommand = (commandOrDefinition: string | CommandDefinition, override?: CommandOverride): void => {
    assertExtensionCapability(extension, "commands", "registerCommand");
    if (typeof commandOrDefinition === "string") {
      const normalizedCommand = normalizeCommandName(commandOrDefinition);
      if (normalizedCommand.length === 0) {
        throw new TypeError("registerCommand requires a non-empty command name");
      }
      if (typeof override !== "function") {
        throw new TypeError("registerCommand requires an override function when command name is provided");
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
      throw new TypeError("registerCommand requires a command definition object");
    }
    if (typeof commandOrDefinition.name !== "string") {
      throw new TypeError("registerCommand requires a command definition name");
    }

    const normalizedCommand = normalizeCommandName(commandOrDefinition.name);
    if (normalizedCommand.length === 0) {
      throw new TypeError("registerCommand requires a non-empty command definition name");
    }
    if (typeof commandOrDefinition.run !== "function") {
      throw new TypeError("registerCommand requires a command definition run handler");
    }
    commands.handlers.push({
      layer: extension.layer,
      name: extension.name,
      command: normalizedCommand,
      run: commandOrDefinition.run,
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
    const normalizedFields = normalizeRegistrationRecordList("registerItemFields fields", fields);
    if (normalizedFields.length === 0) {
      throw new TypeError("registerItemFields requires at least one field definition");
    }
    registrations.item_fields.push({
      layer: extension.layer,
      name: extension.name,
      fields: normalizedFields,
    });
  };
  const registerMigration = (definition: SchemaMigrationDefinition): void => {
    assertExtensionCapability(extension, "schema", "registerMigration");
    registrations.migrations.push({
      layer: extension.layer,
      name: extension.name,
      definition: normalizeRegistrationRecord("registerMigration definition", definition),
    });
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
    registrations.search_providers.push({
      layer: extension.layer,
      name: extension.name,
      definition: normalizeRegistrationRecord("registerSearchProvider provider", provider),
    });
  };
  const registerVectorStoreAdapter = (adapter: VectorStoreAdapterDefinition): void => {
    assertExtensionCapability(extension, "search", "registerVectorStoreAdapter");
    registrations.vector_store_adapters.push({
      layer: extension.layer,
      name: extension.name,
      definition: normalizeRegistrationRecord("registerVectorStoreAdapter adapter", adapter),
    });
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
    registerFlags,
    registerItemFields,
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
  const flagCount = registrations.flags.reduce((total, entry) => total + entry.flags.length, 0);
  const itemFieldCount = registrations.item_fields.reduce((total, entry) => total + entry.fields.length, 0);
  return {
    flags: flagCount,
    item_fields: itemFieldCount,
    migrations: registrations.migrations.length,
    importers: registrations.importers.length,
    exporters: registrations.exporters.length,
    search_providers: registrations.search_providers.length,
    vector_store_adapters: registrations.vector_store_adapters.length,
  };
}

export async function activateExtensions(loadResult: ExtensionLoadResult): Promise<ExtensionActivationResult> {
  const hooks = createEmptyExtensionHookRegistry();
  const commands = createEmptyExtensionCommandRegistry();
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
      await activatable.activate(createExtensionApi(extension, hooks, commands, renderers, registrations));
    } catch (error: unknown) {
      warnings.push(`extension_activate_failed:${extension.layer}:${extension.name}`);
      failed.push({
        layer: extension.layer,
        name: extension.name,
        entry_path: extension.entry_path,
        error: formatUnknownError(error),
      });
    }
  }

  return {
    hooks,
    commands,
    renderers,
    registrations,
    failed,
    warnings,
    hook_counts: {
      before_command: hooks.beforeCommand.length,
      after_command: hooks.afterCommand.length,
      on_write: hooks.onWrite.length,
      on_read: hooks.onRead.length,
      on_index: hooks.onIndex.length,
    },
    command_override_count: commands.overrides.length,
    command_handler_count: commands.handlers.length,
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
