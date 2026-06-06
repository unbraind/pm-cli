import type {
  ExtensionActivationResult,
  ExtensionCapability,
  ExtensionGovernancePolicy,
  ExtensionHookRegistry,
  ExtensionLayer,
  ExtensionManifest,
  ExtensionRegistrationRegistry,
  FlagDefinition,
  RegisteredExtensionCommandDefinition,
  RegisteredExtensionExporter,
  RegisteredExtensionHook,
  RegisteredExtensionImporter,
  RegisteredExtensionSchemaFieldDefinitions,
  RegisteredExtensionSchemaItemTypeDefinitions,
  RegisteredExtensionSearchProvider,
  RegisteredExtensionVectorStoreAdapter,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
} from "../core/extensions/loader.js";
import { activateExtensions } from "../core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../core/extensions/extension-types.js";
import type { PmPackageManifest, PmPackageResourceKind } from "../core/packages/manifest.js";

interface TestExtensionModule {
  manifest?: Partial<ExtensionManifest>;
  activate?: unknown;
  default?: TestExtensionModule;
}

export interface ActivateExtensionForTestOptions {
  name?: string;
  layer?: ExtensionLayer;
  capabilities?: readonly ExtensionCapability[];
  policy?: ExtensionGovernancePolicy;
}

export interface RegisteredCommandContractExpectation {
  command: string;
  action?: string;
  extensionName?: string;
  arguments?: string[];
  flags?: string[];
}

export interface RegisteredCommandContractAssertion {
  command: RegisteredExtensionCommandDefinition;
  flags: FlagDefinition[];
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

export interface RegisteredHookExpectation {
  kind: RegisteredHookKind;
  extensionName?: string;
}

export interface RegisteredSearchProviderExpectation {
  provider: string;
  extensionName?: string;
}

export interface RegisteredVectorStoreAdapterExpectation {
  adapter: string;
  extensionName?: string;
}

export interface RegisteredImporterExpectation {
  importer: string;
  extensionName?: string;
}

export interface RegisteredExporterExpectation {
  exporter: string;
  extensionName?: string;
}

export interface RegisteredItemFieldExpectation {
  field: string;
  extensionName?: string;
  type?: SchemaFieldDefinition["type"];
}

export interface RegisteredItemFieldAssertion {
  registration: RegisteredExtensionSchemaFieldDefinitions;
  field: SchemaFieldDefinition;
}

export interface RegisteredItemTypeExpectation {
  itemType: string;
  extensionName?: string;
  folder?: string;
}

export interface RegisteredItemTypeAssertion {
  registration: RegisteredExtensionSchemaItemTypeDefinitions;
  itemType: SchemaItemTypeDefinition;
}

export type PackageManifestResourceExpectation = Partial<Record<PmPackageResourceKind, readonly string[]>>;

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
