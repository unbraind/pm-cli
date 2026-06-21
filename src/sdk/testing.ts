/**
 * @module sdk/testing
 *
 * Defines public SDK APIs and package-author helpers for Testing.
 */
import type {
  ExtensionActivationResult,
  ExtensionCapability,
  ExtensionCommandRegistry,
  ExtensionGovernancePolicy,
  ExtensionHookRegistry,
  ExtensionLayer,
  ExtensionManifest,
  ExtensionParserRegistry,
  ExtensionPreflightRegistry,
  ExtensionRegistrationRegistry,
  ExtensionRendererRegistry,
  ExtensionServiceName,
  ExtensionServiceRegistry,
  FlagDefinition,
  OutputRendererFormat,
  RegisteredExtensionCommandDefinition,
  RegisteredExtensionCommandOverride,
  RegisteredExtensionExporter,
  RegisteredExtensionFlagDefinitions,
  RegisteredExtensionHook,
  RegisteredExtensionImporter,
  RegisteredExtensionParserOverride,
  RegisteredExtensionPreflightOverride,
  RegisteredExtensionRendererOverride,
  RegisteredExtensionSchemaFieldDefinitions,
  RegisteredExtensionSchemaItemTypeDefinitions,
  RegisteredExtensionSchemaMigrationDefinition,
  RegisteredExtensionSearchProvider,
  RegisteredExtensionServiceOverride,
  RegisteredExtensionVectorStoreAdapter,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
} from "../core/extensions/loader.js";
import { activateExtensions } from "../core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../core/extensions/extension-types.js";
import { collectUsedExtensionCapabilities } from "../core/extensions/capability-usage.js";
import { normalizeKnownExtensionCapability } from "../core/extensions/extension-capability-aliases.js";
import type { PmPackageManifest, PmPackageResourceKind } from "../core/packages/manifest.js";

interface TestExtensionModule {
  manifest?: Partial<ExtensionManifest>;
  activate?: unknown;
  default?: TestExtensionModule;
}

/**
 * Documents the activate extension for test options payload exchanged by command, SDK, and package integrations.
 */
export interface ActivateExtensionForTestOptions {
  name?: string;
  layer?: ExtensionLayer;
  capabilities?: readonly ExtensionCapability[];
  policy?: ExtensionGovernancePolicy;
}

/**
 * Documents the registered command contract expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredCommandContractExpectation {
  command: string;
  action?: string;
  extensionName?: string;
  arguments?: string[];
  flags?: string[];
}

/**
 * Documents the registered command contract assertion payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredCommandContractAssertion {
  command: RegisteredExtensionCommandDefinition;
  flags: FlagDefinition[];
}

/**
 * Documents the registered flags expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredFlagsExpectation {
  targetCommand: string;
  extensionName?: string;
  flags?: string[];
}

/**
 * Public hook lifecycle kinds an extension can register through `api.hooks.*`.
 */
export type RegisteredHookKind = "before_command" | "after_command" | "on_read" | "on_write" | "on_index";

const HOOK_KIND_TO_REGISTRY_FIELD: Record<RegisteredHookKind, keyof ExtensionHookRegistry> = {
  before_command: "beforeCommand",
  after_command: "afterCommand",
  on_read: "onRead",
  on_write: "onWrite",
  on_index: "onIndex",
};

/**
 * Documents the registered hook expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredHookExpectation {
  kind: RegisteredHookKind;
  extensionName?: string;
}

/**
 * Documents the registered search provider expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredSearchProviderExpectation {
  provider: string;
  extensionName?: string;
}

/**
 * Documents the registered vector store adapter expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredVectorStoreAdapterExpectation {
  adapter: string;
  extensionName?: string;
}

/**
 * Documents the registered importer expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredImporterExpectation {
  importer: string;
  extensionName?: string;
}

/**
 * Documents the registered exporter expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredExporterExpectation {
  exporter: string;
  extensionName?: string;
}

/**
 * Documents the registered item field expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredItemFieldExpectation {
  field: string;
  extensionName?: string;
  type?: SchemaFieldDefinition["type"];
}

/**
 * Documents the registered item field assertion payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredItemFieldAssertion {
  registration: RegisteredExtensionSchemaFieldDefinitions;
  field: SchemaFieldDefinition;
}

/**
 * Documents the registered item type expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredItemTypeExpectation {
  itemType: string;
  extensionName?: string;
  folder?: string;
}

/**
 * Documents the registered item type assertion payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredItemTypeAssertion {
  registration: RegisteredExtensionSchemaItemTypeDefinitions;
  itemType: SchemaItemTypeDefinition;
}

/**
 * Documents the registered command override expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredCommandOverrideExpectation {
  command: string;
  extensionName?: string;
}

/**
 * Documents the registered parser override expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredParserOverrideExpectation {
  command: string;
  extensionName?: string;
}

/**
 * Documents the registered preflight override expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredPreflightOverrideExpectation {
  extensionName?: string;
}

/**
 * Documents the registered renderer override expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredRendererOverrideExpectation {
  format: OutputRendererFormat;
  extensionName?: string;
}

/**
 * Documents the registered service override expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredServiceOverrideExpectation {
  service: ExtensionServiceName;
  extensionName?: string;
}

/**
 * Documents the registered migration expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredMigrationExpectation {
  migration: string;
  extensionName?: string;
  mandatory?: boolean;
}

/**
 * Documents the extension capability usage expectation payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionCapabilityUsageExpectation {
  /**
   * Capabilities the manifest declares. Mirror `manifest.capabilities` here so
   * the assertion fails when the manifest grants more than the code uses.
   */
  declared: readonly ExtensionCapability[];
  /** Restrict reconciliation to a single extension when the activation has several. */
  extensionName?: string;
  /**
   * Capabilities allowed to be declared without being exercised (e.g. ones a
   * runtime registers only behind a config flag). These are excluded from the
   * least-privilege failure.
   */
  allowUnused?: readonly ExtensionCapability[];
}

/**
 * Documents the extension capability usage assertion payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionCapabilityUsageAssertion {
  /** Declared capabilities considered, sorted and de-duplicated. */
  declared: ExtensionCapability[];
  /** Capabilities the extension actually registered against, sorted. */
  used: ExtensionCapability[];
  /** Declared capabilities with no matching registration after the allowlist. */
  unused: ExtensionCapability[];
}

/**
 * Restricts package manifest resource expectation values accepted by command, SDK, and storage contracts.
 */
export type PackageManifestResourceExpectation = Partial<Record<PmPackageResourceKind, readonly string[]>>;

/**
 * Documents the package manifest expectation payload exchanged by command, SDK, and package integrations.
 */
export interface PackageManifestExpectation {
  packageName?: string;
  aliases?: readonly string[];
  resources?: PackageManifestResourceExpectation;
}

function normalizeSdkIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function extensionNameSuffix(extensionName: string | undefined): string {
  return extensionName ? ` from extension "${extensionName}"` : "";
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeSdkCommandName(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(" ");
}

function formatAvailable(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function assertStringSetIncludes(
  actual: readonly string[] | undefined,
  expected: readonly string[],
  label: string,
): void {
  const actualValues = new Set(actual ?? []);
  const missing = sortedUnique(expected.filter((value) => !actualValues.has(value)));
  if (missing.length > 0) {
    throw new Error(
      `Expected package manifest ${label} to include ${missing.join(", ")}; available: ${formatAvailable(
        sortedUnique(actual ?? []),
      )}`,
    );
  }
}

function collectFlagLabels(flags: readonly FlagDefinition[]): Set<string> {
  const labels = new Set<string>();
  for (const flag of flags) {
    if (typeof flag.long === "string" && flag.long.trim().length > 0) {
      labels.add(flag.long.trim());
    }
    if (typeof flag.short === "string" && flag.short.trim().length > 0) {
      labels.add(flag.short.trim());
    }
  }
  return labels;
}

function readTestExtensionManifest(module: unknown): Partial<ExtensionManifest> {
  if (module && typeof module === "object") {
    const testModule = module as TestExtensionModule;
    const manifest = testModule.manifest;
    if (manifest && typeof manifest === "object") {
      return manifest;
    }
    const defaultExport = testModule.default;
    const defaultManifest = defaultExport?.manifest;
    if (defaultManifest && typeof defaultManifest === "object") {
      return defaultManifest;
    }
    if (defaultExport && typeof defaultExport === "object" && ("name" in defaultExport || "capabilities" in defaultExport)) {
      return defaultExport as Partial<ExtensionManifest>;
    }
    if ("name" in testModule || "capabilities" in testModule) {
      return testModule as Partial<ExtensionManifest>;
    }
  }
  return {};
}

function readTestExtensionCapabilities(
  manifest: Partial<ExtensionManifest>,
  options: ActivateExtensionForTestOptions,
): ExtensionCapability[] {
  if (Array.isArray(options.capabilities)) {
    return [...options.capabilities];
  }
  if (Array.isArray(manifest.capabilities)) {
    return manifest.capabilities.filter((capability): capability is ExtensionCapability => typeof capability === "string");
  }
  return [];
}

/**
 * Activate one in-memory extension module for package tests.
 *
 * This uses pm's real registration validation and activation engine while
 * avoiding private loader imports, filesystem manifests, or workspace setup.
 */
export async function activateExtensionForTest(
  module: unknown,
  options: ActivateExtensionForTestOptions = {},
): Promise<ExtensionActivationResult> {
  const manifest = readTestExtensionManifest(module);
  const name =
    options.name ??
    (typeof manifest.name === "string" && manifest.name.trim().length > 0 ? manifest.name.trim() : "test-extension");
  const layer = options.layer ?? "project";
  const capabilities = readTestExtensionCapabilities(manifest, options);

  return activateExtensions({
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: options.policy ?? createDefaultExtensionGovernancePolicy(),
    failed: [],
    loaded: [
      {
        layer,
        directory: "",
        manifest_path: "",
        name,
        version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
        entry: typeof manifest.entry === "string" ? manifest.entry : "./index.js",
        priority: typeof manifest.priority === "number" ? manifest.priority : 0,
        entry_path: "",
        capabilities,
        manifest_version: typeof manifest.manifest_version === "number" ? manifest.manifest_version : undefined,
        pm_min_version: typeof manifest.pm_min_version === "string" ? manifest.pm_min_version : undefined,
        pm_max_version: typeof manifest.pm_max_version === "string" ? manifest.pm_max_version : undefined,
        engines: manifest.engines,
        trusted: manifest.trusted,
        provenance: manifest.provenance,
        sandbox_profile: manifest.sandbox_profile,
        permissions: manifest.permissions,
        activation: manifest.activation,
        module,
      },
    ],
  });
}

/**
 * Assert that a normalized package manifest advertises expected package
 * resources. Pair with `readPmPackageManifest(packageRoot)` in package tests.
 */
export function assertPackageManifest(
  manifest: PmPackageManifest,
  expectation: PackageManifestExpectation,
): PmPackageManifest {
  if (expectation.packageName !== undefined && manifest.package_name !== expectation.packageName) {
    throw new Error(
      `Expected package manifest package_name to be "${expectation.packageName}"; received "${
        manifest.package_name ?? "(none)"
      }"`,
    );
  }
  if (expectation.aliases !== undefined) {
    assertStringSetIncludes(manifest.aliases, expectation.aliases, "aliases");
  }
  if (expectation.resources !== undefined) {
    for (const [kind, expectedPaths] of Object.entries(expectation.resources) as Array<
      [PmPackageResourceKind, readonly string[]]
    >) {
      assertStringSetIncludes(manifest.resources[kind], expectedPaths, `pm.${kind}`);
    }
  }
  return manifest;
}

/**
 * Assert that an activated extension registration registry contains a command
 * contract with the expected public metadata.
 */
export function assertRegisteredCommandContract(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredCommandContractExpectation,
): RegisteredCommandContractAssertion {
  const expectedCommand = normalizeSdkCommandName(expectation.command);
  if (expectedCommand.length === 0) {
    throw new Error("Expected command name must be a non-empty string");
  }

  const commandCandidates = registrations.commands.filter((entry) => entry.command === expectedCommand);
  const command = expectation.extensionName
    ? commandCandidates.find((entry) => entry.name === expectation.extensionName)
    : commandCandidates[0];
  if (!command) {
    const available = registrations.commands.map((entry) => entry.command).sort((left, right) => left.localeCompare(right));
    const extensionSuffix = expectation.extensionName ? ` from extension "${expectation.extensionName}"` : "";
    throw new Error(
      `Expected extension command "${expectedCommand}"${extensionSuffix} to be registered. Available commands: ${formatAvailable(
        available,
      )}`,
    );
  }

  if (expectation.action !== undefined && command.action !== expectation.action) {
    throw new Error(
      `Expected extension command "${expectedCommand}" action "${expectation.action}", received "${command.action}"`,
    );
  }

  if (expectation.arguments !== undefined) {
    const actualArguments = (command.arguments ?? []).map((argument) => argument.name);
    const missingArguments = expectation.arguments.filter((argument) => !actualArguments.includes(argument));
    if (missingArguments.length > 0) {
      throw new Error(
        `Expected extension command "${expectedCommand}" arguments ${formatAvailable(
          expectation.arguments,
        )}; missing ${formatAvailable(missingArguments)}; available ${formatAvailable(actualArguments)}`,
      );
    }
  }

  const flags = registrations.flags
    .filter(
      (entry) =>
        entry.target_command === expectedCommand &&
        (expectation.extensionName === undefined || entry.name === expectation.extensionName),
    )
    .flatMap((entry) => entry.flags);

  if (expectation.flags !== undefined) {
    const actualFlagLabels = collectFlagLabels(flags);
    const missingFlags = expectation.flags.filter((flag) => !actualFlagLabels.has(flag));
    if (missingFlags.length > 0) {
      throw new Error(
        `Expected extension command "${expectedCommand}" flags ${formatAvailable(expectation.flags)}; missing ${formatAvailable(
          missingFlags,
        )}; available ${formatAvailable([...actualFlagLabels].sort((left, right) => left.localeCompare(right)))}`,
      );
    }
  }

  return { command, flags };
}

/**
 * Assert that an activated extension registration registry contains flags
 * injected into an existing command through `api.registerFlags(...)`.
 */
export function assertRegisteredFlags(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredFlagsExpectation,
): RegisteredExtensionFlagDefinitions {
  const expectedCommand = normalizeSdkCommandName(expectation.targetCommand);
  if (expectedCommand.length === 0) {
    throw new Error("Expected target command name must be a non-empty string");
  }

  const candidates = registrations.flags.filter((entry) => entry.target_command === expectedCommand);
  let registration: RegisteredExtensionFlagDefinitions | undefined;
  if (expectation.extensionName) {
    registration = candidates.find((entry) => entry.name === expectation.extensionName);
  } else if (candidates.length === 1) {
    registration = candidates[0];
  } else if (candidates.length > 1) {
    const availableExtensions = sortedUnique(candidates.map((entry) => entry.name));
    throw new Error(
      `Expected flags for target command "${expectedCommand}" matched multiple extensions: ${formatAvailable(
        availableExtensions,
      )}. Specify extensionName to choose one registration.`,
    );
  }
  if (!registration) {
    const available = sortedUnique(registrations.flags.map((entry) => entry.target_command));
    const availableExtensions = sortedUnique(candidates.map((entry) => entry.name));
    throw new Error(
      `Expected flags for target command "${expectedCommand}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available flag target commands: ${formatAvailable(available)}; matching extensions: ${formatAvailable(
        availableExtensions,
      )}`,
    );
  }

  if (expectation.flags !== undefined) {
    const actualFlagLabels = collectFlagLabels(registration.flags);
    const missingFlags = expectation.flags.filter((flag) => !actualFlagLabels.has(flag));
    if (missingFlags.length > 0) {
      throw new Error(
        `Expected flags for target command "${expectedCommand}" to include ${formatAvailable(
          expectation.flags,
        )}; missing ${formatAvailable(missingFlags)}; available ${formatAvailable(
          [...actualFlagLabels].sort((left, right) => left.localeCompare(right)),
        )}`,
      );
    }
  }

  return registration;
}

/**
 * Assert that an activated extension hook registry contains a hook of the
 * expected lifecycle kind (optionally scoped to a specific extension).
 *
 * Hooks are surfaced via `ExtensionActivationResult.hooks`, not the command
 * registration registry, so this helper accepts an `ExtensionHookRegistry`.
 */
export function assertRegisteredHook<TKind extends RegisteredHookKind>(
  hooks: ExtensionHookRegistry,
  expectation: RegisteredHookExpectation & { kind: TKind },
): ExtensionHookRegistry[(typeof HOOK_KIND_TO_REGISTRY_FIELD)[TKind]][number] {
  const field = HOOK_KIND_TO_REGISTRY_FIELD[expectation.kind];
  const candidates = hooks[field] as ReadonlyArray<RegisteredExtensionHook<unknown>>;
  const hook = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!hook) {
    const available = sortedUnique(candidates.map((entry) => entry.name));
    throw new Error(
      `Expected a "${expectation.kind}" hook${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available "${expectation.kind}" hooks: ${formatAvailable(available)}`,
    );
  }

  return hook as ExtensionHookRegistry[(typeof HOOK_KIND_TO_REGISTRY_FIELD)[TKind]][number];
}

/**
 * Assert that an activated extension registration registry contains a search
 * provider with the expected name (optionally scoped to a specific extension).
 */
export function assertRegisteredSearchProvider(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredSearchProviderExpectation,
): RegisteredExtensionSearchProvider {
  const expectedProvider = normalizeSdkIdentifier(expectation.provider);
  if (expectedProvider.length === 0) {
    throw new Error("Expected search provider name must be a non-empty string");
  }

  const candidates = registrations.search_providers.filter(
    (entry) => normalizeSdkIdentifier(entry.definition.name) === expectedProvider,
  );
  const provider = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!provider) {
    const available = sortedUnique(registrations.search_providers.map((entry) => entry.definition.name));
    throw new Error(
      `Expected search provider "${expectedProvider}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available search providers: ${formatAvailable(available)}`,
    );
  }

  return provider;
}

/**
 * Assert that an activated extension registration registry contains a vector
 * store adapter with the expected name (optionally scoped to a specific
 * extension).
 */
export function assertRegisteredVectorStoreAdapter(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredVectorStoreAdapterExpectation,
): RegisteredExtensionVectorStoreAdapter {
  const expectedAdapter = normalizeSdkIdentifier(expectation.adapter);
  if (expectedAdapter.length === 0) {
    throw new Error("Expected vector store adapter name must be a non-empty string");
  }

  const candidates = registrations.vector_store_adapters.filter(
    (entry) => normalizeSdkIdentifier(entry.definition.name) === expectedAdapter,
  );
  const adapter = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!adapter) {
    const available = sortedUnique(registrations.vector_store_adapters.map((entry) => entry.definition.name));
    throw new Error(
      `Expected vector store adapter "${expectedAdapter}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available vector store adapters: ${formatAvailable(available)}`,
    );
  }

  return adapter;
}

/**
 * Assert that an activated extension registration registry contains an importer
 * for the expected format/name (optionally scoped to a specific extension).
 */
export function assertRegisteredImporter(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredImporterExpectation,
): RegisteredExtensionImporter {
  const expectedImporter = normalizeSdkIdentifier(expectation.importer);
  if (expectedImporter.length === 0) {
    throw new Error("Expected importer name must be a non-empty string");
  }

  const candidates = registrations.importers.filter(
    (entry) => normalizeSdkIdentifier(entry.importer) === expectedImporter,
  );
  const importer = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!importer) {
    const available = sortedUnique(registrations.importers.map((entry) => entry.importer));
    throw new Error(
      `Expected importer "${expectedImporter}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available importers: ${formatAvailable(available)}`,
    );
  }

  return importer;
}

/**
 * Assert that an activated extension registration registry contains an exporter
 * for the expected format/name (optionally scoped to a specific extension).
 */
export function assertRegisteredExporter(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredExporterExpectation,
): RegisteredExtensionExporter {
  const expectedExporter = normalizeSdkIdentifier(expectation.exporter);
  if (expectedExporter.length === 0) {
    throw new Error("Expected exporter name must be a non-empty string");
  }

  const candidates = registrations.exporters.filter(
    (entry) => normalizeSdkIdentifier(entry.exporter) === expectedExporter,
  );
  const exporter = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!exporter) {
    const available = sortedUnique(registrations.exporters.map((entry) => entry.exporter));
    throw new Error(
      `Expected exporter "${expectedExporter}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available exporters: ${formatAvailable(available)}`,
    );
  }

  return exporter;
}

/**
 * Assert that an activated extension registration registry contains a custom
 * item field definition (optionally scoped to a specific extension).
 */
export function assertRegisteredItemField(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredItemFieldExpectation,
): RegisteredItemFieldAssertion {
  const expectedField = normalizeSdkIdentifier(expectation.field);
  if (expectedField.length === 0) {
    throw new Error("Expected item field name must be a non-empty string");
  }

  const candidates = registrations.item_fields
    .filter((entry) => expectation.extensionName === undefined || entry.name === expectation.extensionName)
    .map((registration) => ({
      registration,
      field: registration.fields.find((field) => normalizeSdkIdentifier(field.name) === expectedField),
    }))
    .filter((entry): entry is RegisteredItemFieldAssertion => entry.field !== undefined);

  const match = candidates.find((entry) => expectation.type === undefined || entry.field.type === expectation.type);
  if (!match) {
    const available = sortedUnique(
      registrations.item_fields.flatMap((entry) => entry.fields.map((field) => `${field.name}:${field.type}`)),
    );
    throw new Error(
      `Expected item field "${expectedField}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available item fields: ${formatAvailable(available)}`,
    );
  }

  return match;
}

/**
 * Assert that an activated extension registration registry contains a custom
 * item type definition (optionally scoped to a specific extension).
 */
export function assertRegisteredItemType(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredItemTypeExpectation,
): RegisteredItemTypeAssertion {
  const expectedType = normalizeSdkIdentifier(expectation.itemType);
  if (expectedType.length === 0) {
    throw new Error("Expected item type name must be a non-empty string");
  }

  const candidates = registrations.item_types
    .filter((entry) => expectation.extensionName === undefined || entry.name === expectation.extensionName)
    .map((registration) => ({
      registration,
      itemType: registration.types.find((itemType) => normalizeSdkIdentifier(itemType.name) === expectedType),
    }))
    .filter((entry): entry is RegisteredItemTypeAssertion => entry.itemType !== undefined);

  const match = candidates.find((entry) => expectation.folder === undefined || entry.itemType.folder === expectation.folder);
  if (!match) {
    const available = sortedUnique(
      registrations.item_types.flatMap((entry) => entry.types.map((itemType) => `${itemType.name}:${itemType.folder}`)),
    );
    throw new Error(
      `Expected item type "${expectedType}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available item types: ${formatAvailable(available)}`,
    );
  }

  return match;
}

/**
 * Assert that an activated extension command registry contains a command
 * override registered via `api.registerCommand(command, override)` (optionally
 * scoped to a specific extension).
 *
 * Command overrides are surfaced via `ExtensionActivationResult.commands`, not
 * the command registration registry, so this helper accepts an
 * `ExtensionCommandRegistry`.
 */
export function assertRegisteredCommandOverride(
  commands: ExtensionCommandRegistry,
  expectation: RegisteredCommandOverrideExpectation,
): RegisteredExtensionCommandOverride {
  const expectedCommand = normalizeSdkCommandName(expectation.command);
  if (expectedCommand.length === 0) {
    throw new Error("Expected command name must be a non-empty string");
  }

  const candidates = commands.overrides.filter((entry) => entry.command === expectedCommand);
  const override = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!override) {
    const available = sortedUnique(commands.overrides.map((entry) => entry.command));
    throw new Error(
      `Expected command override "${expectedCommand}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available command overrides: ${formatAvailable(available)}`,
    );
  }

  return override;
}

/**
 * Assert that an activated extension parser registry contains a parser override
 * registered via `api.registerParser(command, override)` (optionally scoped to
 * a specific extension).
 *
 * Parser overrides are surfaced via `ExtensionActivationResult.parsers`, not the
 * command registration registry, so this helper accepts an
 * `ExtensionParserRegistry`.
 */
export function assertRegisteredParserOverride(
  parsers: ExtensionParserRegistry,
  expectation: RegisteredParserOverrideExpectation,
): RegisteredExtensionParserOverride {
  const expectedCommand = normalizeSdkCommandName(expectation.command);
  if (expectedCommand.length === 0) {
    throw new Error("Expected command name must be a non-empty string");
  }

  const candidates = parsers.overrides.filter((entry) => entry.command === expectedCommand);
  const override = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!override) {
    const available = sortedUnique(parsers.overrides.map((entry) => entry.command));
    throw new Error(
      `Expected parser override "${expectedCommand}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available parser overrides: ${formatAvailable(available)}`,
    );
  }

  return override;
}

/**
 * Assert that an activated extension preflight registry contains a preflight
 * override registered via `api.registerPreflight(override)` (optionally scoped
 * to a specific extension).
 *
 * Preflight overrides are global (they run for every command and carry no
 * `command` field), so the expectation only accepts an optional
 * `extensionName`. Preflight overrides are surfaced via
 * `ExtensionActivationResult.preflight`.
 */
export function assertRegisteredPreflightOverride(
  preflight: ExtensionPreflightRegistry,
  expectation: RegisteredPreflightOverrideExpectation = {},
): RegisteredExtensionPreflightOverride {
  const override = expectation.extensionName
    ? preflight.overrides.find((entry) => entry.name === expectation.extensionName)
    : preflight.overrides[0];
  if (!override) {
    const available = sortedUnique(preflight.overrides.map((entry) => entry.name));
    throw new Error(
      `Expected a preflight override${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available preflight overrides: ${formatAvailable(available)}`,
    );
  }

  return override;
}

/**
 * Assert that an activated extension renderer registry contains a renderer
 * override registered via `api.registerRenderer(format, renderer)` for the
 * expected output format (optionally scoped to a specific extension).
 *
 * Renderer overrides are surfaced via `ExtensionActivationResult.renderers`.
 */
export function assertRegisteredRendererOverride(
  renderers: ExtensionRendererRegistry,
  expectation: RegisteredRendererOverrideExpectation,
): RegisteredExtensionRendererOverride {
  const expectedFormat = normalizeSdkIdentifier(expectation.format);
  if (expectedFormat.length === 0) {
    throw new Error("Expected renderer format must be a non-empty string");
  }

  const candidates = renderers.overrides.filter((entry) => entry.format === expectedFormat);
  const override = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!override) {
    const available = sortedUnique(renderers.overrides.map((entry) => entry.format));
    throw new Error(
      `Expected renderer override "${expectedFormat}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available renderer overrides: ${formatAvailable(available)}`,
    );
  }

  return override;
}

/**
 * Assert that an activated extension service registry contains a service override
 * registered via `api.registerService(service, override)` for the expected
 * service name (optionally scoped to a specific extension).
 *
 * Service overrides are surfaced via `ExtensionActivationResult.services`, not the
 * command registration registry, so this helper accepts an
 * `ExtensionServiceRegistry`.
 */
export function assertRegisteredServiceOverride(
  services: ExtensionServiceRegistry,
  expectation: RegisteredServiceOverrideExpectation,
): RegisteredExtensionServiceOverride {
  const expectedService = normalizeSdkIdentifier(expectation.service);
  if (expectedService.length === 0) {
    throw new Error("Expected service name must be a non-empty string");
  }

  const candidates = services.overrides.filter((entry) => normalizeSdkIdentifier(entry.service) === expectedService);
  const override = expectation.extensionName
    ? candidates.find((entry) => entry.name === expectation.extensionName)
    : candidates[0];
  if (!override) {
    const available = sortedUnique(services.overrides.map((entry) => entry.service));
    throw new Error(
      `Expected service override "${expectedService}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available service overrides: ${formatAvailable(available)}`,
    );
  }

  return override;
}

/**
 * Assert that an activated extension registration registry contains a schema
 * migration registered via `api.registerMigration(definition)` with the expected
 * id (optionally scoped to a specific extension and asserting the `mandatory`
 * governance flag, where an unset flag is treated as non-mandatory).
 *
 * Migrations are surfaced via `ExtensionActivationResult.registrations.migrations`.
 */
export function assertRegisteredMigration(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredMigrationExpectation,
): RegisteredExtensionSchemaMigrationDefinition {
  const expectedMigration = normalizeSdkIdentifier(expectation.migration);
  if (expectedMigration.length === 0) {
    throw new Error("Expected migration id must be a non-empty string");
  }

  const candidates = registrations.migrations.filter(
    (entry) =>
      (expectation.extensionName === undefined || entry.name === expectation.extensionName) &&
      typeof entry.definition.id === "string" &&
      normalizeSdkIdentifier(entry.definition.id) === expectedMigration,
  );
  const match = candidates.find(
    (entry) => expectation.mandatory === undefined || (entry.definition.mandatory ?? false) === expectation.mandatory,
  );
  if (match) {
    return match;
  }

  // The id (and any extension scope) matched but the `mandatory` flag did not:
  // report the mismatch directly rather than the misleading "not registered"
  // listing. Reaching here with a candidate implies `expectation.mandatory` was
  // set, since an unset flag matches any candidate above.
  const idMatch = candidates[0];
  if (idMatch !== undefined) {
    throw new Error(
      `Expected migration "${expectedMigration}"${extensionNameSuffix(expectation.extensionName)} to have ` +
        `mandatory=${expectation.mandatory}, but it is mandatory=${idMatch.definition.mandatory ?? false}.`,
    );
  }

  const available = sortedUnique(
    registrations.migrations.map((entry) => {
      const id =
        typeof entry.definition.id === "string" && entry.definition.id.trim().length > 0
          ? entry.definition.id.trim()
          : "(unnamed)";
      return `${id}:${entry.definition.mandatory === true}`;
    }),
  );
  throw new Error(
    `Expected migration "${expectedMigration}"${extensionNameSuffix(
      expectation.extensionName,
    )} to be registered. Available migrations: ${formatAvailable(available)}`,
  );
}

/**
 * Assert that an activated extension declares no capability it never uses
 * (least privilege). Pass the same capabilities as `manifest.capabilities` via
 * `expectation.declared`; the helper computes what the extension actually
 * registered against and throws when any declared capability is unused.
 *
 * This is the package-test counterpart of the advisory
 * `extension_capability_unused` warning `pm package doctor` emits, letting an
 * author catch an over-broad manifest at `npm test` time. Returns the
 * declared/used/unused breakdown for further assertions.
 */
export function assertExtensionCapabilityUsage(
  activation: ExtensionActivationResult,
  expectation: ExtensionCapabilityUsageExpectation,
): ExtensionCapabilityUsageAssertion {
  const toKnownCapabilitySet = (capabilities: readonly string[], field: string): Set<ExtensionCapability> => {
    const known = new Set<ExtensionCapability>();
    for (const capability of capabilities) {
      const normalized = normalizeKnownExtensionCapability(capability);
      if (normalized === null) {
        throw new Error(
          `Expected ${field} capability "${capability}" to be a known extension capability. ` +
            "Use canonical capability names (see manifest.capabilities).",
        );
      }
      known.add(normalized);
    }
    return known;
  };
  const declared = [...toKnownCapabilitySet(expectation.declared, "declared")].sort((left, right) =>
    left.localeCompare(right),
  );
  const allowUnused = toKnownCapabilitySet(expectation.allowUnused ?? [], "allowUnused");
  const used = collectUsedExtensionCapabilities(activation, { extensionName: expectation.extensionName });
  const usedSet = new Set(used);
  const unused = declared.filter((capability) => !usedSet.has(capability) && !allowUnused.has(capability));
  if (unused.length > 0) {
    const scopeSuffix = extensionNameSuffix(expectation.extensionName);
    throw new Error(
      `Expected every declared capability${scopeSuffix} to be exercised, but [${unused.join(
        ", ",
      )}] ${unused.length === 1 ? "is" : "are"} declared yet never registered against. ` +
        `Remove ${unused.length === 1 ? "it" : "them"} from manifest.capabilities for least privilege, ` +
        "or pass allowUnused for capabilities registered only behind a runtime flag.",
    );
  }
  return { declared, used, unused };
}
