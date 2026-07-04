/**
 * @module sdk/testing
 *
 * Defines public SDK APIs and package-author helpers for Testing.
 */
import type {
  AfterCommandHookContext,
  BeforeCommandHookContext,
  CommandHandlerResult,
  CommandOverrideContext,
  CommandOverrideResult,
  ExtensionActivationResult,
  ExtensionCapability,
  ExtensionCommandRegistry,
  ExtensionDeactivationResult,
  ExtensionGovernancePolicy,
  ExtensionHookRegistry,
  ExtensionLayer,
  ExtensionLoadResult,
  ExtensionManifest,
  ExtensionParserRegistry,
  ExtensionPreflightRegistry,
  ExtensionRegistrationRegistry,
  ExtensionRendererRegistry,
  ExtensionServiceName,
  ExtensionServiceRegistry,
  FlagDefinition,
  OnIndexHookContext,
  OnReadHookContext,
  OnWriteHookContext,
  OutputRendererFormat,
  ParserOverrideContext,
  ParserOverrideResult,
  PreflightOverrideContext,
  PreflightOverrideResult,
  RegisteredExtensionCommandDefinition,
  RegisteredExtensionCommandOverride,
  RegisteredExtensionExporter,
  RegisteredExtensionFlagDefinitions,
  RegisteredExtensionHook,
  RegisteredExtensionImporter,
  RegisteredExtensionParserOverride,
  RegisteredExtensionPreflightOverride,
  RegisteredExtensionProjectProfile,
  RegisteredExtensionRendererOverride,
  RegisteredExtensionSchemaFieldDefinitions,
  RegisteredExtensionSchemaItemTypeDefinitions,
  RegisteredExtensionSchemaMigrationDefinition,
  RegisteredExtensionSearchProvider,
  RegisteredExtensionServiceOverride,
  RegisteredExtensionVectorStoreAdapter,
  RendererOverrideContext,
  RendererOverrideResult,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
  SchemaMigrationRunContext,
  SearchProviderEmbedBatchContext,
  SearchProviderEmbedContext,
  SearchProviderQueryContext,
  SearchProviderQueryExpansionContext,
  SearchProviderQueryExpansionResult,
  SearchProviderQueryResult,
  SearchProviderRerankContext,
  SearchProviderRerankResult,
  ServiceOverrideContext,
  ServiceOverrideResult,
  VectorStoreDeleteContext,
  VectorStoreQueryContext,
  VectorStoreQueryHit,
  VectorStoreUpsertContext,
} from "../core/extensions/loader.js";
import {
  activateExtensions,
  deactivateExtensions,
  runAfterCommandHooks,
  runBeforeCommandHooks,
  runCommandHandler,
  runCommandOverride,
  runOnIndexHooks,
  runOnReadHooks,
  runOnWriteHooks,
  runParserOverride,
  runPreflightOverride,
  runRendererOverride,
  runServiceOverride,
} from "../core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../core/extensions/extension-types.js";
import {
  getMigrationRuntimeDefinition,
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../core/extensions/runtime-registrations.js";
import { collectUsedExtensionCapabilities } from "../core/extensions/capability-usage.js";
import { normalizeKnownExtensionCapability } from "../core/extensions/extension-capability-aliases.js";
import {
  checkExtensionManifestCompatibility,
  describeExtensionBlueprint,
  lintExtensionBlueprint,
  preflightExtension,
} from "./compose.js";
import { describeExtensionActivation } from "../core/extensions/activation-summary.js";
import type {
  DescribeExtensionActivationOptions,
  ExtensionActivationSummary,
} from "../core/extensions/activation-summary.js";
import type { ProjectProfileDefinition } from "../core/profile/profile-presets.js";
import { lintProjectProfile, type ProjectProfileLintReport } from "../core/profile/profile-lint.js";
import { renderExtensionSurfaceMarkdown } from "../core/extensions/activation-summary-markdown.js";
import type { ExtensionSurfaceMarkdownOptions } from "../core/extensions/activation-summary-markdown.js";
import type {
  ExtensionBlueprint,
  ExtensionBlueprintLintCode,
  ExtensionBlueprintLintFinding,
  ExtensionBlueprintLintResult,
  ExtensionBlueprintLintSeverity,
  ExtensionManifestCompatibilityManifest,
  ExtensionManifestCompatibilityResult,
  ExtensionManifestCompatibilityTarget,
  ExtensionPreflightReport,
  LintExtensionBlueprintOptions,
  PreflightExtensionOptions,
} from "./compose.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import type { PmPackageManifest, PmPackageResourceKind } from "../core/packages/manifest.js";
import { asPropertyRecord } from "../core/shared/primitives.js";

// `describeExtensionActivation` is the `describe` (enumerate-all) verb that
// pairs with the `assert*` (verify-one) and `run*` (invoke-one) helpers below.
// It lives in core (it walks the same registries the loader populates) and is
// surfaced here so package authors get the whole testing surface from the
// `@unbrained/pm-cli/sdk/testing` subpath.
export {
  describeExtensionActivation,
  renderExtensionSurfaceMarkdown,
};
export type {
  DescribeExtensionActivationOptions,
  ExtensionActivationSummary,
} from "../core/extensions/activation-summary.js";
export type { ExtensionSurfaceMarkdownOptions } from "../core/extensions/activation-summary-markdown.js";

// `composeExtension`'s author-time companions: describe a blueprint's surface map
// and preflight it for capability drift / duplicate / empty-surface footguns
// without activating. Surfaced through the `@unbrained/pm-cli/sdk/testing` subpath
// so a package author gets the full author → describe → preflight → test loop here,
// alongside the assert*/run* helpers; `assertExtensionBlueprint` below is the
// throwing assertion that pairs with the non-throwing `lintExtensionBlueprint`.
export { describeExtensionBlueprint, lintExtensionBlueprint };
export type {
  ExtensionBlueprint,
  ExtensionBlueprintLintCode,
  ExtensionBlueprintLintFinding,
  ExtensionBlueprintLintResult,
  ExtensionBlueprintLintSeverity,
  LintExtensionBlueprintOptions,
};

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
 * Documents the deactivate extension for test options payload exchanged by command, SDK, and package integrations.
 */
export interface DeactivateExtensionForTestOptions {
  /** Overrides the in-memory extension name (defaults to `manifest.name` or `"test-extension"`). */
  name?: string;
  /** Overrides the layer recorded for the in-memory extension (defaults to `"project"`). */
  layer?: ExtensionLayer;
  /**
   * Activation result returned by `activateExtensionForTest`. When provided, an
   * extension whose `activate` failed is skipped — mirroring the host teardown
   * contract that never deactivates a never-initialized extension. Pass the same
   * `name`/`layer` to both helpers so the skip key matches.
   */
  activation?: Pick<ExtensionActivationResult, "failed">;
  /**
   * Per-hook teardown bound, forwarded as `deactivate_timeout_ms`. Use `0` (or
   * `Infinity`) to wait indefinitely; omit to keep the host default.
   */
  deactivateTimeoutMs?: number;
}

/**
 * Options for {@link runRegisteredCommandForTest} — the inputs forwarded to a
 * registered extension command handler when exercising its behavior in a test.
 */
export interface RunRegisteredCommandForTestOptions {
  /**
   * Full registered command path to invoke, e.g. `"hello"` or `"todos import"`.
   * Matched against `commands.handlers[].command` after normalization (trimmed,
   * lower-cased, internal whitespace collapsed), mirroring runtime dispatch.
   */
  command: string;
  /** Positional arguments forwarded as `context.args` (default: none). */
  args?: readonly string[];
  /** Parsed flags/options forwarded as `context.options` (default: none). */
  options?: Record<string, unknown>;
  /**
   * Global option overrides merged onto the agent-safe test defaults
   * (`{ json: true, quiet: true, noPager: true }`), forwarded as `context.global`.
   */
  global?: Partial<GlobalOptions>;
  /**
   * Resolved pm workspace root forwarded as `context.pm_root` (default: `""`).
   * Most pure handlers ignore it; set it when the handler reads workspace files.
   */
  pmRoot?: string;
}

/**
 * Options for {@link runRegisteredHookForTest} — the lifecycle `kind` to fire and
 * the synthetic context handed to every registered hook of that kind.
 *
 * The union keeps `context` type-safe per kind: `kind: "on_write"` requires an
 * {@link OnWriteHookContext}, `kind: "after_command"` an
 * {@link AfterCommandHookContext}, and so on — so authors cannot accidentally
 * pass an index context to a read hook.
 */
export type RunRegisteredHookForTestOptions =
  | { kind: "before_command"; context: BeforeCommandHookContext }
  | { kind: "after_command"; context: AfterCommandHookContext }
  | { kind: "on_read"; context: OnReadHookContext }
  | { kind: "on_write"; context: OnWriteHookContext }
  | { kind: "on_index"; context: OnIndexHookContext };

/**
 * Maps each invokable search-provider operation to the context type its function
 * receives, keeping {@link runRegisteredSearchProviderForTest} type-safe per
 * operation. Mirrors the operations the host dispatches to a registered provider:
 * semantic `query`, single/batch embedding (`embed`/`embedBatch`),
 * `queryExpansion`, and `rerank`.
 */
export interface SearchProviderOperationContexts {
  query: SearchProviderQueryContext;
  embed: SearchProviderEmbedContext;
  embedBatch: SearchProviderEmbedBatchContext;
  queryExpansion: SearchProviderQueryExpansionContext;
  rerank: SearchProviderRerankContext;
}

/**
 * Maps each invokable search-provider operation to the result type its function
 * returns, so {@link runRegisteredSearchProviderForTest} resolves a precise return
 * type from the chosen `operation` instead of a union the caller must narrow.
 */
export interface SearchProviderOperationResults {
  query: SearchProviderQueryResult;
  embed: number[];
  embedBatch: number[][];
  queryExpansion: SearchProviderQueryExpansionResult;
  rerank: SearchProviderRerankResult;
}

/**
 * Options for {@link runRegisteredSearchProviderForTest}: the registered
 * `provider` name to resolve, the `operation` to invoke, and the synthetic
 * `context` handed to that operation. The discriminated union keeps `context`
 * type-safe per operation — `operation: "embed"` requires a
 * {@link SearchProviderEmbedContext}, `operation: "rerank"` a
 * {@link SearchProviderRerankContext}, and so on.
 */
export type RunRegisteredSearchProviderForTestOptions = {
  [Operation in keyof SearchProviderOperationContexts]: {
    /** Registered provider name to resolve, matched case-insensitively as the host does. */
    provider: string;
    /** Provider operation to invoke. */
    operation: Operation;
    /** Synthetic context handed to the resolved operation function. */
    context: SearchProviderOperationContexts[Operation];
  };
}[keyof SearchProviderOperationContexts];

/**
 * Maps each invokable vector-store-adapter operation to the context type its
 * function receives, keeping {@link runRegisteredVectorStoreAdapterForTest}
 * type-safe per operation. Mirrors the operations the host dispatches to a
 * registered adapter: nearest-neighbour `query`, `upsert`, and `delete`.
 */
export interface VectorStoreAdapterOperationContexts {
  query: VectorStoreQueryContext;
  upsert: VectorStoreUpsertContext;
  delete: VectorStoreDeleteContext;
}

/**
 * Maps each invokable vector-store-adapter operation to the result type its
 * function returns. Only `query` has a structured result
 * ({@link VectorStoreQueryHit}[]); `upsert`/`delete` report success by not
 * throwing, so their result is `unknown` and typically ignored.
 */
export interface VectorStoreAdapterOperationResults {
  query: VectorStoreQueryHit[];
  upsert: unknown;
  delete: unknown;
}

/**
 * Options for {@link runRegisteredVectorStoreAdapterForTest}: the registered
 * `adapter` name to resolve, the `operation` to invoke, and the synthetic
 * `context` handed to that operation. The discriminated union keeps `context`
 * type-safe per operation — `operation: "upsert"` requires a
 * {@link VectorStoreUpsertContext}, `operation: "delete"` a
 * {@link VectorStoreDeleteContext}, and so on.
 */
export type RunRegisteredVectorStoreAdapterForTestOptions = {
  [Operation in keyof VectorStoreAdapterOperationContexts]: {
    /** Registered adapter name to resolve, matched case-insensitively as the host does. */
    adapter: string;
    /** Adapter operation to invoke. */
    operation: Operation;
    /** Synthetic context handed to the resolved operation function. */
    context: VectorStoreAdapterOperationContexts[Operation];
  };
}[keyof VectorStoreAdapterOperationContexts];

/**
 * Options for {@link runRegisteredMigrationForTest}: which registered migration
 * to invoke and the workspace root its run context reports.
 */
export interface RunRegisteredMigrationForTestOptions {
  /** Registered migration id to resolve, matched case-insensitively against `definition.id`. */
  migration: string;
  /** Optional extension name to disambiguate when several extensions register the same id. */
  extensionName?: string;
  /** Resolved pm workspace root forwarded as `context.pm_root` (default `""`). */
  pmRoot?: string;
}

/**
 * Options for {@link runRegisteredImporterForTest} — the registered importer name
 * to invoke plus the synthetic invocation context forwarded to its handler.
 *
 * The `importer` name is the value passed to `api.registerImporter(name, ...)`,
 * resolved case-insensitively (and whitespace-collapsed) against
 * `registrations.importers`; the helper derives the `"<name> import"` command
 * path internally, so authors never hand-build it.
 */
export interface RunRegisteredImporterForTestOptions {
  /** Registered importer name to resolve, e.g. `"csv"` for a `"csv import"` handler. */
  importer: string;
  /** Optional extension name to disambiguate when several extensions register the same importer. */
  extensionName?: string;
  /** Positional arguments forwarded as `context.args` (default: none). */
  args?: readonly string[];
  /** Parsed flags/options forwarded as `context.options` (default: none). */
  options?: Record<string, unknown>;
  /**
   * Global option overrides merged onto the agent-safe test defaults
   * (`{ json: true, quiet: true, noPager: true }`), forwarded as `context.global`.
   */
  global?: Partial<GlobalOptions>;
  /** Resolved pm workspace root forwarded as `context.pm_root` (default: `""`). */
  pmRoot?: string;
}

/**
 * Options for {@link runRegisteredExporterForTest} — the registered exporter name
 * to invoke plus the synthetic invocation context forwarded to its handler.
 *
 * The `exporter` name is the value passed to `api.registerExporter(name, ...)`,
 * resolved case-insensitively (and whitespace-collapsed) against
 * `registrations.exporters`; the helper derives the `"<name> export"` command
 * path internally, so authors never hand-build it.
 */
export interface RunRegisteredExporterForTestOptions {
  /** Registered exporter name to resolve, e.g. `"csv"` for a `"csv export"` handler. */
  exporter: string;
  /** Optional extension name to disambiguate when several extensions register the same exporter. */
  extensionName?: string;
  /** Positional arguments forwarded as `context.args` (default: none). */
  args?: readonly string[];
  /** Parsed flags/options forwarded as `context.options` (default: none). */
  options?: Record<string, unknown>;
  /**
   * Global option overrides merged onto the agent-safe test defaults
   * (`{ json: true, quiet: true, noPager: true }`), forwarded as `context.global`.
   */
  global?: Partial<GlobalOptions>;
  /** Resolved pm workspace root forwarded as `context.pm_root` (default: `""`). */
  pmRoot?: string;
}

/**
 * Documents the extension deactivation expectation payload exchanged by command, SDK, and package integrations.
 */
export interface ExtensionDeactivationExpectation {
  /** Expected count of extensions whose `deactivate` ran without throwing (default `1`). */
  deactivated?: number;
  /** Expected count of teardown failures (default `0`). */
  failed?: number;
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
 * Documents the registered project-profile expectation payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredProfileExpectation {
  /** Profile name to assert is registered (case-insensitive). */
  profile: string;
  /** Restrict the match to a single extension when several are active. */
  extensionName?: string;
}

/**
 * Documents the registered project-profile assertion payload exchanged by command, SDK, and package integrations.
 */
export interface RegisteredProfileAssertion {
  /** The matching registration entry. */
  registration: RegisteredExtensionProjectProfile;
  /** The registered profile definition. */
  profile: ProjectProfileDefinition;
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

/**
 * Options for {@link ExtensionTestHarness.renderMarkdown}.
 */
export interface RenderExtensionHarnessMarkdownOptions extends ExtensionSurfaceMarkdownOptions {
  /**
   * Restrict the rendered summary to one activated extension by name. Defaults
   * to the full activation union, matching {@link ExtensionTestHarness.activationSummary}.
   */
  extensionName?: string;
}

function normalizeSdkIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Match key for profile-name assertions. Extends {@link normalizeSdkIdentifier}
 * with hyphen→underscore folding so the assertion mirrors the runtime profile
 * resolution (`pm profile`), which treats `my-flow` and `my_flow` as the same
 * archetype. Profiles are the one registration surface that resolves
 * hyphen-insensitively (item types resolve by alias, migrations by exact id), so
 * — unlike the other `assertRegistered*` helpers — this one folds the separator
 * to stay in lockstep with how a profile is actually looked up by name.
 */
function normalizeSdkProfileMatchKey(value: string): string {
  return normalizeSdkIdentifier(value).replaceAll("-", "_");
}

function extensionNameSuffix(extensionName: string | undefined): string {
  return extensionName ? ` from extension "${extensionName}"` : "";
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeSdkCommandName(command: string): string {
  if (typeof command !== "string") {
    // Positional misuse like runRegisteredCommandForTest(activation, "name", opts)
    // reaches here with `undefined` at runtime; guide instead of crashing on .trim().
    throw new Error(
      'A command name string is required. Pass it via the options object, e.g. runRegisteredCommandForTest(activation, { command: "my command" }) — positional command arguments are not supported.',
    );
  }
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
  const moduleRecord = asPropertyRecord(module);
  if (!moduleRecord) {
    return {};
  }
  const manifest = asPropertyRecord(moduleRecord.manifest);
  if (manifest) {
    return manifest as Partial<ExtensionManifest>;
  }
  const defaultExport = asPropertyRecord(moduleRecord.default);
  const defaultManifest = asPropertyRecord(defaultExport?.manifest);
  if (defaultManifest) {
    return defaultManifest as Partial<ExtensionManifest>;
  }
  if (defaultExport && ("name" in defaultExport || "capabilities" in defaultExport)) {
    return defaultExport as Partial<ExtensionManifest>;
  }
  if ("name" in moduleRecord || "capabilities" in moduleRecord) {
    return moduleRecord as Partial<ExtensionManifest>;
  }
  return {};
}

function resolveTestExtensionName(manifest: Partial<ExtensionManifest>, explicitName: string | undefined): string {
  return (
    explicitName ??
    (typeof manifest.name === "string" && manifest.name.trim().length > 0 ? manifest.name.trim() : "test-extension")
  );
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
 * Build the synthetic single-extension {@link ExtensionLoadResult} shared by the
 * activate/deactivate test helpers, so both stay aligned with the loader's load
 * contract as it evolves. The `loaded` entry mirrors the real on-disk shape
 * (including `capabilities` and the compatibility fields) while leaving
 * filesystem paths empty, since the module is supplied in memory.
 */
function buildSingleExtensionLoadResult(
  module: unknown,
  manifest: Partial<ExtensionManifest>,
  identity: { name: string; layer: ExtensionLayer; capabilities: ExtensionCapability[]; policy: ExtensionGovernancePolicy },
): ExtensionLoadResult {
  return {
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: identity.policy,
    failed: [],
    loaded: [
      {
        layer: identity.layer,
        directory: "",
        manifest_path: "",
        name: identity.name,
        version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
        entry: typeof manifest.entry === "string" ? manifest.entry : "./index.js",
        priority: typeof manifest.priority === "number" ? manifest.priority : 0,
        entry_path: "",
        capabilities: identity.capabilities,
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
  };
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
  return activateExtensions(
    buildSingleExtensionLoadResult(module, manifest, {
      name: resolveTestExtensionName(manifest, options.name),
      layer: options.layer ?? "project",
      capabilities: readTestExtensionCapabilities(manifest, options),
      policy: options.policy ?? createDefaultExtensionGovernancePolicy(),
    }),
  );
}

/**
 * Deactivate one in-memory extension module for package tests — the teardown
 * counterpart to {@link activateExtensionForTest}.
 *
 * Runs pm's real `deactivateExtensions` engine (including its bounded per-hook
 * timeout and best-effort failure capture) over a single synthetic load entry,
 * so authors can prove an extension's `deactivate` releases the resources its
 * `activate` opened — without importing private loader internals or staging a
 * workspace. Resolve `name`/`layer` the same way {@link activateExtensionForTest}
 * does so a forwarded `activation` result skips a failed extension correctly.
 */
export async function deactivateExtensionForTest(
  module: unknown,
  options: DeactivateExtensionForTestOptions = {},
): Promise<ExtensionDeactivationResult> {
  const manifest = readTestExtensionManifest(module);
  return deactivateExtensions(
    buildSingleExtensionLoadResult(module, manifest, {
      name: resolveTestExtensionName(manifest, options.name),
      layer: options.layer ?? "project",
      capabilities: readTestExtensionCapabilities(manifest, {}),
      policy: createDefaultExtensionGovernancePolicy(),
    }),
    options.activation,
    options.deactivateTimeoutMs === undefined ? {} : { deactivate_timeout_ms: options.deactivateTimeoutMs },
  );
}

/**
 * Invoke a registered extension command handler and return its real
 * {@link CommandHandlerResult} so package tests can assert on behavior — not
 * just that the command was registered.
 *
 * This is the "invoke" verb that completes the package-author testing loop:
 * `activateExtensionForTest` → `assertRegisteredCommandContract` → **run** →
 * `deactivateExtensionForTest`. It runs pm's real handler-dispatch engine
 * (`runCommandHandler`) over `activation.commands`, building the
 * `CommandHandlerContext` with agent-safe global defaults
 * (`{ json: true, quiet: true, noPager: true }`) that callers may override.
 *
 * Because `registerImporter`/`registerExporter` register their handlers under
 * the `"<name> import"` / `"<name> export"` command paths, this same helper
 * exercises importer and exporter handlers too.
 *
 * Throws a descriptive error (listing the available handler command paths) when
 * no handler is registered for `command`, since that is a wiring/typo bug in the
 * test rather than a behavior under test. When a handler is found, the result is
 * returned verbatim: a clean run yields `{ handled: true, result, warnings: [] }`,
 * while a handler that throws a non-exit error yields
 * `{ handled: false, warnings: [code], errorMessage }` so the failure can be
 * asserted. A handler that throws an error carrying a numeric `exitCode`
 * propagates the throw, matching runtime semantics.
 */
export async function runRegisteredCommandForTest(
  commands: ExtensionCommandRegistry,
  options: RunRegisteredCommandForTestOptions,
): Promise<CommandHandlerResult> {
  const command = normalizeSdkCommandName(options.command);
  if (command.length === 0) {
    throw new Error("Expected command name must be a non-empty string");
  }
  const hasHandler = commands.handlers.some((entry) => entry.command === command);
  if (!hasHandler) {
    const available = sortedUnique(commands.handlers.map((entry) => entry.command));
    throw new Error(
      `Expected a registered command handler for "${command}" to invoke. Available command handlers: ${formatAvailable(
        available,
      )}`,
    );
  }
  return runCommandHandler(commands, {
    command,
    args: options.args ? [...options.args] : [],
    options: options.options ? { ...options.options } : {},
    global: { json: true, quiet: true, noPager: true, ...options.global },
    pm_root: options.pmRoot ?? "",
  });
}

/**
 * Fire every registered lifecycle hook of a given `kind` through pm's real hook
 * runner and return the warnings array so package tests can assert on behavior —
 * not just that a hook was registered.
 *
 * This is the hook counterpart to {@link runRegisteredCommandForTest}, extending
 * the package-author "invoke" verb to the `api.hooks.*` surface. Pass the
 * `ExtensionHookRegistry` from `activateExtensionForTest(...).hooks` together with
 * the lifecycle `kind` and a synthetic context. Hooks observe their inputs via a
 * cloned context snapshot (mutations never leak back to the caller), so the
 * observable signal is twofold: any side effects the hook performs, and the
 * returned warnings. A clean run returns `[]`; a hook that throws contributes one
 * `extension_hook_failed:<layer>:<name>:<hookName>` warning, mirroring runtime
 * dispatch which isolates a failing hook without aborting the others.
 *
 * Throws a descriptive error (listing the hook kinds that do have registrations)
 * when no hook of `kind` is registered, since firing a hook the extension never
 * registered is a wiring/typo bug in the test rather than a behavior under test.
 */
export async function runRegisteredHookForTest(
  hooks: ExtensionHookRegistry,
  options: RunRegisteredHookForTestOptions,
): Promise<string[]> {
  if (hooks[HOOK_KIND_TO_REGISTRY_FIELD[options.kind]].length === 0) {
    const populatedKinds = sortedUnique(
      (Object.keys(HOOK_KIND_TO_REGISTRY_FIELD) as RegisteredHookKind[]).filter(
        (kind) => hooks[HOOK_KIND_TO_REGISTRY_FIELD[kind]].length > 0,
      ),
    );
    throw new Error(
      `Expected a registered "${options.kind}" hook to invoke. Hook kinds with registrations: ${formatAvailable(
        populatedKinds,
      )}`,
    );
  }
  switch (options.kind) {
    case "before_command":
      return runBeforeCommandHooks(hooks, options.context);
    case "after_command":
      return runAfterCommandHooks(hooks, options.context);
    case "on_read":
      return runOnReadHooks(hooks, options.context);
    case "on_write":
      return runOnWriteHooks(hooks, options.context);
    case "on_index":
      return runOnIndexHooks(hooks, options.context);
  }
}

/**
 * Invoke a registered parser override through pm's real runner and return the
 * resolved {@link ParserOverrideResult}, so package tests can assert the rewritten
 * args/options/global an override produces for a command before dispatch.
 *
 * Guards that a parser override is registered for the (normalized) target command
 * before delegating: without a match `runParserOverride` would silently return
 * `overridden: false`, hiding a typo'd command name in the test. When a match
 * exists the result is returned verbatim — `overridden: true` with the rewritten
 * context on success, or `overridden: false` with an
 * `extension_parser_override_failed:*` warning when the override throws.
 */
export async function runRegisteredParserOverrideForTest(
  parsers: ExtensionParserRegistry,
  context: ParserOverrideContext,
): Promise<ParserOverrideResult> {
  const command = normalizeSdkCommandName(context.command);
  if (!parsers.overrides.some((entry) => entry.command === command)) {
    throw new Error(
      `Expected a registered parser override for command "${command}" to invoke. Available parser override commands: ${formatAvailable(
        sortedUnique(parsers.overrides.map((entry) => entry.command)),
      )}`,
    );
  }
  return runParserOverride(parsers, context);
}

/**
 * Invoke the active preflight override through pm's real runner and return the
 * resolved {@link PreflightOverrideResult}, so package tests can assert the
 * migration/format gate decision an override yields.
 *
 * Unlike command-scoped overrides, the runtime applies the **last** registered
 * preflight override regardless of command, so this helper guards only that at
 * least one preflight override is registered before delegating. The result is
 * returned verbatim — `overridden: true` with the adjusted decision on success,
 * or `overridden: false` with an `extension_preflight_override_failed:*` warning
 * when the override throws.
 */
export async function runRegisteredPreflightOverrideForTest(
  preflight: ExtensionPreflightRegistry,
  context: PreflightOverrideContext,
): Promise<PreflightOverrideResult> {
  if (preflight.overrides.length === 0) {
    throw new Error(
      "Expected a registered preflight override to invoke, but none are registered.",
    );
  }
  return runPreflightOverride(preflight, context);
}

/**
 * Invoke a registered command-result override through pm's real runner and return
 * the resolved {@link CommandOverrideResult}, so package tests can assert how an
 * override transforms a command's result payload.
 *
 * Accepts the same `ExtensionCommandRegistry` exposed as
 * `activateExtensionForTest(...).commands` (it carries both handlers and
 * overrides). Guards that an override is registered for the (normalized) target
 * command before delegating, so a typo'd command name surfaces as a clear error
 * rather than a silent `overridden: false`. The result is returned verbatim —
 * including the `extension_command_override_async_unsupported:*` warning the
 * runtime emits when an override returns a Promise (command overrides are
 * synchronous), or an `extension_command_override_failed:*` warning on throw.
 */
export async function runRegisteredCommandOverrideForTest(
  commands: ExtensionCommandRegistry,
  context: CommandOverrideContext,
): Promise<CommandOverrideResult> {
  const command = normalizeSdkCommandName(context.command);
  if (!commands.overrides.some((entry) => entry.command === command)) {
    throw new Error(
      `Expected a registered command override for command "${command}" to invoke. Available command override commands: ${formatAvailable(
        sortedUnique(commands.overrides.map((entry) => entry.command)),
      )}`,
    );
  }
  return runCommandOverride(commands, context);
}

/**
 * Invoke a registered renderer override through pm's real runner and return the
 * resolved {@link RendererOverrideResult}, so package tests can assert the custom
 * string an override renders for a given output `format`.
 *
 * Guards that a renderer override is registered for `context.format` before
 * delegating, so a wrong format surfaces as a clear error rather than a silent
 * `overridden: false`. The result is returned verbatim — `overridden: true` with
 * the rendered string on success, or `overridden: false` (with an
 * `extension_renderer_invalid_result:*` / `extension_renderer_failed:*` warning
 * where applicable) when the override returns a non-string or throws.
 */
export async function runRegisteredRendererOverrideForTest(
  renderers: ExtensionRendererRegistry,
  context: RendererOverrideContext,
): Promise<RendererOverrideResult> {
  if (!renderers.overrides.some((entry) => entry.format === context.format)) {
    throw new Error(
      `Expected a registered renderer override for format "${context.format}" to invoke. Available renderer override formats: ${formatAvailable(
        sortedUnique(renderers.overrides.map((entry) => entry.format)),
      )}`,
    );
  }
  return runRendererOverride(renderers, context);
}

/**
 * Invoke a registered service override through pm's real runner and return the
 * resolved {@link ServiceOverrideResult}, so package tests can assert how an
 * override handles an internal service payload (e.g. `output_format`).
 *
 * Guards that a service override is registered for `context.service` before
 * delegating, so a wrong service name surfaces as a clear error rather than a
 * silent `handled: false`. The result is returned verbatim — `handled: true` with
 * the override's result when it claims the payload, or `handled: false` with the
 * original payload (and any `extension_service_override_*` warnings) otherwise.
 */
export async function runRegisteredServiceOverrideForTest(
  services: ExtensionServiceRegistry,
  context: ServiceOverrideContext,
): Promise<ServiceOverrideResult> {
  if (!services.overrides.some((entry) => entry.service === context.service)) {
    throw new Error(
      `Expected a registered service override for service "${context.service}" to invoke. Available service override services: ${formatAvailable(
        sortedUnique(services.overrides.map((entry) => entry.service)),
      )}`,
    );
  }
  return runServiceOverride(services, context);
}

/**
 * Maps each search-provider operation to the runtime-definition keys that may
 * hold its function, in priority order. The host accepts both camelCase and
 * snake_case spellings for the multi-word operations, so this helper mirrors that
 * by trying `embedBatch` before `embed_batch` and `queryExpansion` before
 * `query_expansion`.
 */
const SEARCH_PROVIDER_OPERATION_DEFINITION_KEYS: Record<keyof SearchProviderOperationContexts, readonly string[]> = {
  query: ["query"],
  embed: ["embed"],
  embedBatch: ["embedBatch", "embed_batch"],
  queryExpansion: ["queryExpansion", "query_expansion"],
  rerank: ["rerank"],
};

/**
 * Invoke an operation of a registered search provider through the same name
 * resolution the host uses and return the operation's result, so package tests
 * can assert a custom provider's runtime behavior — not just that it registered.
 *
 * This is the search-provider counterpart to {@link runRegisteredCommandForTest},
 * extending the package-author "invoke" verb to the `api.registerSearchProvider`
 * surface. Pass the `ExtensionRegistrationRegistry` from
 * `activateExtensionForTest(...).registrations`, the registered provider name, the
 * `operation` to exercise (`query`, `embed`, `embedBatch`, `queryExpansion`, or
 * `rerank`), and a synthetic context. The provider is resolved via
 * {@link resolveRegisteredSearchProvider} (case-insensitive, last registration
 * wins) and the operation is invoked on its `runtime_definition` — the clone that
 * preserves live functions, matching what the runtime dispatches.
 *
 * Throws a descriptive error listing the available providers when the name is not
 * registered, and a separate error when the resolved provider does not implement
 * the requested operation, since invoking an absent provider/operation is a
 * wiring bug in the test rather than a behavior under test.
 */
export async function runRegisteredSearchProviderForTest<Operation extends keyof SearchProviderOperationContexts>(
  registrations: ExtensionRegistrationRegistry,
  options: {
    provider: string;
    operation: Operation;
    context: SearchProviderOperationContexts[Operation];
  },
): Promise<SearchProviderOperationResults[Operation]> {
  const registration = resolveRegisteredSearchProvider(registrations, options.provider);
  if (!registration) {
    const available = sortedUnique(registrations.search_providers.map((entry) => entry.definition.name));
    throw new Error(
      `Expected a registered search provider "${options.provider}" to invoke. Available search providers: ${formatAvailable(
        available,
      )}`,
    );
  }
  const runtimeDefinition = registration.runtime_definition;
  const operationFn = SEARCH_PROVIDER_OPERATION_DEFINITION_KEYS[options.operation]
    .map((key) => runtimeDefinition[key])
    .find((value) => typeof value === "function");
  if (typeof operationFn !== "function") {
    throw new Error(
      `Registered search provider "${options.provider}" does not implement the "${options.operation}" operation.`,
    );
  }
  return (await (operationFn as (context: SearchProviderOperationContexts[Operation]) => unknown)(
    options.context,
  )) as SearchProviderOperationResults[Operation];
}

/**
 * Invoke an operation of a registered vector store adapter through the same name
 * resolution the host uses and return the operation's result, so package tests
 * can assert a custom adapter's runtime behavior — not just that it registered.
 *
 * This is the vector-store counterpart to {@link runRegisteredSearchProviderForTest}.
 * Pass the `ExtensionRegistrationRegistry` from
 * `activateExtensionForTest(...).registrations`, the registered adapter name, the
 * `operation` to exercise (`query`, `upsert`, or `delete`), and a synthetic
 * context. The adapter is resolved via {@link resolveRegisteredVectorStoreAdapter}
 * (case-insensitive, last registration wins) and the operation is invoked on its
 * `runtime_definition` — the clone that preserves live functions, matching what
 * the runtime dispatches.
 *
 * Throws a descriptive error listing the available adapters when the name is not
 * registered, and a separate error when the resolved adapter does not implement
 * the requested operation.
 */
export async function runRegisteredVectorStoreAdapterForTest<
  Operation extends keyof VectorStoreAdapterOperationContexts,
>(
  registrations: ExtensionRegistrationRegistry,
  options: {
    adapter: string;
    operation: Operation;
    context: VectorStoreAdapterOperationContexts[Operation];
  },
): Promise<VectorStoreAdapterOperationResults[Operation]> {
  const registration = resolveRegisteredVectorStoreAdapter(registrations, options.adapter);
  if (!registration) {
    const available = sortedUnique(registrations.vector_store_adapters.map((entry) => entry.definition.name));
    throw new Error(
      `Expected a registered vector store adapter "${options.adapter}" to invoke. Available vector store adapters: ${formatAvailable(
        available,
      )}`,
    );
  }
  const operationFn = registration.runtime_definition[options.operation];
  if (typeof operationFn !== "function") {
    throw new Error(
      `Registered vector store adapter "${options.adapter}" does not implement the "${options.operation}" operation.`,
    );
  }
  return (await (operationFn as (context: VectorStoreAdapterOperationContexts[Operation]) => unknown)(
    options.context,
  )) as VectorStoreAdapterOperationResults[Operation];
}

/**
 * Invoke a registered schema migration's `run` function through the same runtime
 * definition the host executes and return its result, so package tests can assert
 * a migration's behavior — not just that it registered.
 *
 * This completes the package-author "invoke" verb across every executable
 * registration surface. The migration is resolved by id via
 * {@link assertRegisteredMigration} (which throws a descriptive "available
 * migrations" error when absent), then `run` is invoked on its
 * `runtime_definition` with a context mirroring the one
 * `executeRegisteredRuntimeMigrations` builds at runtime: the resolved id,
 * `command: "migration"`, the registering extension's layer/name, the supplied
 * `pmRoot`, and the migration's normalized status. Unlike the runtime — which
 * skips already-applied migrations and folds a throw into a warning — this helper
 * always invokes `run` and lets a throw propagate, so authors can assert both the
 * success result and failure via rejection.
 *
 * Throws when the resolved migration declares no `run` function, since invoking a
 * runless migration is a wiring bug in the test rather than a behavior under test.
 */
export async function runRegisteredMigrationForTest(
  registrations: ExtensionRegistrationRegistry,
  options: RunRegisteredMigrationForTestOptions,
): Promise<unknown> {
  const migration = assertRegisteredMigration(registrations, {
    migration: options.migration,
    extensionName: options.extensionName,
  });
  const run = getMigrationRuntimeDefinition(migration).run;
  if (typeof run !== "function") {
    throw new Error(`Registered migration "${options.migration}" does not implement a run function to invoke.`);
  }
  const declaredStatus = migration.definition.status;
  const context: SchemaMigrationRunContext = {
    id: migration.definition.id as string,
    command: "migration",
    layer: migration.layer,
    extension: migration.name,
    pm_root: options.pmRoot ?? "",
    status: (typeof declaredStatus === "string" ? declaredStatus.trim().toLowerCase() : "") || "pending",
  };
  return await (run as (context: SchemaMigrationRunContext) => unknown)(context);
}

/**
 * Invoke a registered extension importer through pm's real handler-dispatch
 * engine and return its {@link CommandHandlerResult}, so package tests can assert
 * an importer's behavior — not just that it registered.
 *
 * This is the importer counterpart to {@link runRegisteredCommandForTest},
 * extending the package-author "invoke" verb to the `api.registerImporter`
 * surface. Because `registerImporter(name, fn)` wraps `fn` into a command handler
 * at the `"<name> import"` path, invoking it through `runRegisteredCommandForTest`
 * requires the author to know that naming convention and to remember that an
 * importer is reachable as a command at all. This helper closes both gaps: it
 * accepts the registered importer name directly, validates via
 * {@link assertRegisteredImporter} that it is genuinely a registered importer
 * (not merely some command parked at that path), derives the command path, and
 * dispatches through the same engine.
 *
 * The full activation result is required because importer execution spans two
 * sub-registries: `registrations.importers` proves the importer exists, while
 * `commands` holds the wrapped handler. The result is returned verbatim from the
 * command engine: a clean run yields `{ handled: true, result, warnings: [] }`
 * (where `result` is the importer's return value), a non-exit throw yields
 * `{ handled: false, warnings: [code], errorMessage }`, and an error carrying a
 * numeric `exitCode` propagates — matching runtime import semantics.
 *
 * Throws a descriptive "available importers" error (via `assertRegisteredImporter`)
 * when no importer matches, since that is a wiring/typo bug in the test rather
 * than a behavior under test.
 */
export async function runRegisteredImporterForTest(
  activation: ExtensionActivationResult,
  options: RunRegisteredImporterForTestOptions,
): Promise<CommandHandlerResult> {
  const importer = assertRegisteredImporter(activation.registrations, {
    importer: options.importer,
    extensionName: options.extensionName,
  });
  return runRegisteredCommandForTest(activation.commands, {
    command: `${importer.importer} import`,
    args: options.args,
    options: options.options,
    global: options.global,
    pmRoot: options.pmRoot,
  });
}

/**
 * Invoke a registered extension exporter through pm's real handler-dispatch
 * engine and return its {@link CommandHandlerResult}, so package tests can assert
 * an exporter's behavior — not just that it registered.
 *
 * This is the exporter counterpart to {@link runRegisteredImporterForTest} and
 * the final surface in the package-author "invoke" verb. Because
 * `registerExporter(name, fn)` wraps `fn` into a command handler at the
 * `"<name> export"` path, this helper accepts the registered exporter name
 * directly, validates via {@link assertRegisteredExporter} that it is genuinely a
 * registered exporter, derives the command path, and dispatches through the same
 * engine. See {@link runRegisteredImporterForTest} for the full activation
 * rationale and return semantics (which apply identically here).
 *
 * Throws a descriptive "available exporters" error (via `assertRegisteredExporter`)
 * when no exporter matches, since that is a wiring/typo bug in the test rather
 * than a behavior under test.
 */
export async function runRegisteredExporterForTest(
  activation: ExtensionActivationResult,
  options: RunRegisteredExporterForTestOptions,
): Promise<CommandHandlerResult> {
  const exporter = assertRegisteredExporter(activation.registrations, {
    exporter: options.exporter,
    extensionName: options.extensionName,
  });
  return runRegisteredCommandForTest(activation.commands, {
    command: `${exporter.exporter} export`,
    args: options.args,
    options: options.options,
    global: options.global,
    pmRoot: options.pmRoot,
  });
}

/**
 * Assert that an {@link ExtensionDeactivationResult} reports the expected clean
 * teardown counts, throwing a descriptive error otherwise. Defaults assert the
 * single-extension happy path — exactly one extension deactivated and none
 * failed. Returns the result so assertions can chain.
 */
export function assertExtensionDeactivated(
  result: ExtensionDeactivationResult,
  expectation: ExtensionDeactivationExpectation = {},
): ExtensionDeactivationResult {
  const expectedDeactivated = expectation.deactivated ?? 1;
  if (result.deactivated !== expectedDeactivated) {
    throw new Error(
      `Expected ${expectedDeactivated} extension${expectedDeactivated === 1 ? "" : "s"} to deactivate cleanly, ` +
        `but ${result.deactivated} did.`,
    );
  }
  const expectedFailed = expectation.failed ?? 0;
  if (result.failed.length !== expectedFailed) {
    const detail = result.failed.map((failure) => `${failure.layer}:${failure.name} (${failure.error})`).join(", ");
    throw new Error(
      `Expected ${expectedFailed} teardown failure${expectedFailed === 1 ? "" : "s"}, ` +
        `but observed ${result.failed.length}${detail.length > 0 ? `: ${detail}` : ""}.`,
    );
  }
  return result;
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
 * Assert that an activated extension registration registry contains a project
 * profile registered via `api.registerProfile(profile)` (optionally scoped to a
 * specific extension).
 *
 * This is the test-time counterpart to the declarative `defineProjectProfile`
 * authoring helper and the `pm profile list/show/apply` runtime surface: it
 * proves a package's archetype reached the registry so a downstream consumer can
 * resolve and apply it by name. Like the other declarative-surface assertions
 * (item types, item fields), a profile is verified by presence — it is staged,
 * not executed — so there is no `runRegisteredProfileForTest` counterpart.
 */
export function assertRegisteredProfile(
  registrations: ExtensionRegistrationRegistry,
  expectation: RegisteredProfileExpectation,
): RegisteredProfileAssertion {
  const expectedProfile = normalizeSdkProfileMatchKey(expectation.profile);
  if (expectedProfile.length === 0) {
    throw new Error("Expected profile name must be a non-empty string");
  }

  const match = registrations.profiles
    .filter((entry) => expectation.extensionName === undefined || entry.name === expectation.extensionName)
    .find((entry) => normalizeSdkProfileMatchKey(entry.profile.name) === expectedProfile);
  if (!match) {
    const available = sortedUnique(registrations.profiles.map((entry) => entry.profile.name));
    throw new Error(
      `Expected profile "${expectedProfile}"${extensionNameSuffix(
        expectation.extensionName,
      )} to be registered. Available profiles: ${formatAvailable(available)}`,
    );
  }

  return { registration: match, profile: match.profile };
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

/**
 * Preflight a declarative {@link ExtensionBlueprint} in a test, throwing if it has
 * any `error`-severity issue (today: capability the blueprint exercises but the
 * declared set omits, which would fail activation with `extension_capability_missing`).
 *
 * The throwing counterpart to {@link lintExtensionBlueprint} and the `assert*`
 * family member for declarative authoring: drop `assertExtensionBlueprint(blueprint)`
 * into a package's `node:test`/Vitest suite to fail CI before the blueprint is
 * ever activated. The full {@link ExtensionBlueprintLintResult} is returned on
 * success so a test can still inspect advisory warnings (unused capability,
 * duplicate command, empty surface) without failing on them.
 */
export function assertExtensionBlueprint(
  blueprint: ExtensionBlueprint,
  options: LintExtensionBlueprintOptions = {},
): ExtensionBlueprintLintResult {
  const result = lintExtensionBlueprint(blueprint, options);
  if (!result.ok) {
    const errors = result.findings.filter((finding) => finding.severity === "error");
    throw new Error(
      `Extension blueprint failed preflight with ${errors.length} ${errors.length === 1 ? "error" : "errors"}:\n` +
        errors.map((finding) => `  - [${finding.code}] ${finding.message}`).join("\n"),
    );
  }
  return result;
}

/** Options for {@link assertProjectProfile}. */
export interface AssertProjectProfileOptions {
  /**
   * Also throw when the profile produces `warning`-severity findings (e.g. a
   * workflow transition referencing a status no profile or built-in defines).
   * Off by default so warnings stay advisory; turn on for strict CI gates.
   */
  strict?: boolean;
}

/**
 * Assert a {@link ProjectProfileDefinition} is internally consistent in a test,
 * throwing on any `error`-severity finding (and on `warning`-severity findings
 * too when `strict` is set). The author-time counterpart to `defineProjectProfile`
 * and the project-profile analogue of {@link assertExtensionBlueprint}: drop
 * `assertProjectProfile(myProfile)` into a package's `node:test`/Vitest suite to
 * fail CI before the profile is ever registered via `api.registerProfile` or
 * applied via `pm profile apply`. The full {@link ProjectProfileLintReport} is
 * returned on success so a test can still inspect advisory warnings without
 * failing on them.
 */
export function assertProjectProfile(
  profile: ProjectProfileDefinition,
  options: AssertProjectProfileOptions = {},
): ProjectProfileLintReport {
  const report = lintProjectProfile(profile);
  const blocking = report.findings.filter(
    (finding) => finding.severity === "error" || (options.strict === true && finding.severity === "warning"),
  );
  if (blocking.length > 0) {
    throw new Error(
      `Project profile "${report.profile}" failed lint with ${blocking.length} ${blocking.length === 1 ? "issue" : "issues"}:\n` +
        blocking.map((finding) => `  - ${finding.severity} [${finding.code}] ${finding.message}`).join("\n"),
    );
  }
  return report;
}

/**
 * The structured result of {@link assertExtensionManifestMatchesBlueprint}: the
 * reconciliation between a manifest's declared capabilities and the set the
 * blueprint actually exercises. Returned only when they match exactly (the
 * assertion throws otherwise).
 */
export interface ExtensionManifestBlueprintMatch {
  /** The least-privilege capability set the blueprint exercises (from `deriveExtensionCapabilities`). */
  used: ExtensionCapability[];
  /** The manifest's declared capabilities, legacy-alias resolved and normalized. */
  declared: ExtensionCapability[];
  /** Capabilities the blueprint uses but the manifest omits — would crash activation. Empty on success. */
  missing: ExtensionCapability[];
  /** Capabilities the manifest declares but no surface exercises — violates least privilege. Empty on success. */
  unused: ExtensionCapability[];
  /** Every lint finding for the blueprint, so callers can inspect advisory warnings. */
  findings: ExtensionBlueprintLintFinding[];
}

/**
 * Strictly assert a manifest's `capabilities` equal the least-privilege set a
 * declarative {@link ExtensionBlueprint} exercises, throwing on any drift in
 * either direction.
 *
 * This is the strict bookend to the lenient {@link assertExtensionBlueprint}:
 * where that helper fails only on an *undeclared* capability (the `error`-severity
 * `extension_capability_missing` activation crash) and merely *warns* on an unused
 * one, this assertion fails on **both** — an undeclared capability (`missing`) and
 * a declared-but-unused one (`unused`) — so a hand-maintained `manifest.json` stays
 * exactly the set the blueprint requires. Drop it into a package's
 * `node:test`/Vitest suite to guard against capability drift in CI, the natural
 * companion to {@link ../sdk/compose.js#synthesizeExtensionManifest} (assert what
 * you would otherwise generate). Only `capabilities` are reconciled because that is
 * the one manifest field a blueprint determines.
 *
 * The reconciliation is returned on success so a test can still inspect advisory
 * warnings (duplicate command, empty surface) without failing on them.
 */
export function assertExtensionManifestMatchesBlueprint(
  manifest: Pick<ExtensionManifest, "capabilities">,
  blueprint: ExtensionBlueprint,
): ExtensionManifestBlueprintMatch {
  // Coerce a malformed/absent capabilities field to an explicit empty declared set
  // so an untyped `.js` caller gets a deterministic `missing` list rather than the
  // lint silently falling back to the blueprint's in-module manifest mirror.
  const declaredCapabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const result = lintExtensionBlueprint(blueprint, { declaredCapabilities });
  // `declared` is guaranteed non-null here: we always hand lint an array, so it
  // never takes its "no declared set" branch. The cast drops the unreachable null.
  const declared = result.declared as ExtensionCapability[];
  const declaredSet = new Set(declared);
  const usedSet = new Set(result.used);
  const missing = result.used.filter((capability) => !declaredSet.has(capability));
  const unused = declared.filter((capability) => !usedSet.has(capability));
  if (missing.length > 0 || unused.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`missing [${missing.join(", ")}] (the blueprint registers ${missing.length === 1 ? "a surface" : "surfaces"} requiring ${missing.length === 1 ? "it" : "them"}; activation throws extension_capability_missing)`);
    }
    if (unused.length > 0) {
      parts.push(`unused [${unused.join(", ")}] (declared but no surface exercises ${unused.length === 1 ? "it" : "them"}; drop for least privilege)`);
    }
    throw new Error(
      `Manifest capabilities do not match the blueprint: ${parts.join("; ")}. ` +
        "Set capabilities to synthesizeExtensionManifest(blueprint, identity).capabilities to stay in sync.",
    );
  }
  return { used: result.used, declared, missing, unused, findings: result.findings };
}

/**
 * Assert an extension manifest's declared version bounds permit it to load on a
 * target pm CLI version, throwing when a bound blocks the load.
 *
 * This is the throwing CI/test counterpart to
 * {@link ../sdk/compose.js#checkExtensionManifestCompatibility}: it runs the same
 * author-time version-bound analysis and fails on any blocking incompatibility — a
 * malformed bound (`*_invalid`), a `pm_min_version` the target is below
 * (`pm_min_version_unmet`), or a `block`-mode `pm_max_version` the target exceeds
 * (`pm_max_version_exceeded`). Advisory `warning` findings (`*_unchecked`, or a
 * `warn`-mode `pm_max_version_exceeded_warn`) never throw, because the loader
 * would still load the extension. Pin it to the pm version a package commits to
 * supporting so a too-tight or malformed bound fails the package's own suite, not
 * a user's install. The full compatibility result is returned on success so a test
 * can still inspect advisory warnings.
 */
export function assertExtensionManifestCompatible(
  manifest: ExtensionManifestCompatibilityManifest,
  target: ExtensionManifestCompatibilityTarget,
): ExtensionManifestCompatibilityResult {
  const result = checkExtensionManifestCompatibility(manifest, target);
  const blocking = result.findings.filter((finding) => finding.severity === "error");
  if (blocking.length > 0) {
    throw new Error(
      `Extension manifest is not compatible with pm ${result.pmVersion}: ${blocking
        .map((finding) => finding.message)
        .join("; ")}`,
    );
  }
  return result;
}

/**
 * Preflight a declarative {@link ExtensionBlueprint} through every author-time
 * check in one test, throwing if any stage produced an `error`-severity finding.
 *
 * This is the throwing CI/test bookend over
 * {@link ../sdk/compose.js#preflightExtension} — the single guard that replaces
 * chaining {@link assertExtensionBlueprint}, {@link assertExtensionManifestMatchesBlueprint},
 * and {@link assertExtensionManifestCompatible} in a package's
 * `node:test`/Vitest suite. It runs the same consolidated analysis (always lints
 * the blueprint; synthesizes the manifest when `options.identity` is given; checks
 * version bounds when `options.target` is given) and throws one error listing every
 * blocking finding tagged by its `source:code`. Advisory `warning` findings (an
 * unused capability, a duplicate command, an `*_unchecked` bound) never throw,
 * matching the underlying stages. The full {@link ExtensionPreflightReport} is
 * returned on success so a test can still inspect those warnings, the synthesized
 * manifest, and the derived capability set without failing on them.
 */
export function assertExtensionPreflight(
  blueprint: ExtensionBlueprint,
  options: PreflightExtensionOptions = {},
): ExtensionPreflightReport {
  const report = preflightExtension(blueprint, options);
  if (!report.ok) {
    const errors = report.findings.filter((finding) => finding.severity === "error");
    throw new Error(
      `Extension failed preflight with ${errors.length} ${errors.length === 1 ? "error" : "errors"}:\n` +
        errors.map((finding) => `  - [${finding.source}:${finding.code}] ${finding.message}`).join("\n"),
    );
  }
  return report;
}

/**
 * A fluent, single-extension test fixture returned by
 * {@link createExtensionTestHarness}.
 *
 * Every method binds one of the standalone SDK testing helpers to the correct
 * sub-registry of a single {@link ExtensionActivationResult}, so a package author
 * never threads `activation.registrations` vs `activation.commands` vs
 * `activation.hooks` (etc.) by hand — picking the wrong sub-registry is a common
 * footgun that surfaces as a confusing `available: (none)` error. Methods do not
 * use `this`; they close over the activation, so they remain safe to destructure
 * (`const { runCommand, assertCommandContract } = harness;`).
 *
 * The `assert*` methods verify registration wiring (returning the matched
 * registration); the `run*` methods invoke a registered surface through pm's real
 * dispatch engine (returning its runtime result); {@link deactivate} runs the real
 * teardown engine. The raw {@link activation} stays public as an escape hatch to
 * the standalone helpers for any surface not covered by a convenience method.
 */
export interface ExtensionTestHarness {
  /** The in-memory extension module supplied to {@link createExtensionTestHarness}. */
  readonly module: unknown;
  /** Resolved extension name (manifest name, explicit override, or `"test-extension"`). */
  readonly name: string;
  /** Layer recorded for the in-memory extension (defaults to `"project"`). */
  readonly layer: ExtensionLayer;
  /** The underlying activation result; use it to reach standalone helpers directly. */
  readonly activation: ExtensionActivationResult;

  /** Bound {@link describeExtensionActivation} over the whole `activation`. */
  activationSummary(options?: DescribeExtensionActivationOptions): ExtensionActivationSummary;
  /**
   * Bound {@link renderExtensionSurfaceMarkdown} over {@link activationSummary},
   * so tests and README generators can produce deterministic surface docs from
   * the same harness they use for assert/run coverage.
   */
  renderMarkdown(options?: RenderExtensionHarnessMarkdownOptions): string;

  /** Bound {@link assertRegisteredCommandContract} over `activation.registrations`. */
  assertCommandContract(expectation: RegisteredCommandContractExpectation): RegisteredCommandContractAssertion;
  /** Bound {@link assertRegisteredFlags} over `activation.registrations`. */
  assertFlags(expectation: RegisteredFlagsExpectation): RegisteredExtensionFlagDefinitions;
  /** Bound {@link assertRegisteredItemField} over `activation.registrations`. */
  assertItemField(expectation: RegisteredItemFieldExpectation): RegisteredItemFieldAssertion;
  /** Bound {@link assertRegisteredItemType} over `activation.registrations`. */
  assertItemType(expectation: RegisteredItemTypeExpectation): RegisteredItemTypeAssertion;
  /** Bound {@link assertRegisteredProfile} over `activation.registrations`. */
  assertProfile(expectation: RegisteredProfileExpectation): RegisteredProfileAssertion;
  /** Bound {@link assertRegisteredHook} over `activation.hooks`. */
  assertHook<TKind extends RegisteredHookKind>(
    expectation: RegisteredHookExpectation & { kind: TKind },
  ): ExtensionHookRegistry[(typeof HOOK_KIND_TO_REGISTRY_FIELD)[TKind]][number];
  /** Bound {@link assertRegisteredCommandOverride} over `activation.commands`. */
  assertCommandOverride(expectation: RegisteredCommandOverrideExpectation): RegisteredExtensionCommandOverride;
  /** Bound {@link assertRegisteredParserOverride} over `activation.parsers`. */
  assertParserOverride(expectation: RegisteredParserOverrideExpectation): RegisteredExtensionParserOverride;
  /** Bound {@link assertRegisteredPreflightOverride} over `activation.preflight`. */
  assertPreflightOverride(expectation?: RegisteredPreflightOverrideExpectation): RegisteredExtensionPreflightOverride;
  /** Bound {@link assertRegisteredRendererOverride} over `activation.renderers`. */
  assertRendererOverride(expectation: RegisteredRendererOverrideExpectation): RegisteredExtensionRendererOverride;
  /** Bound {@link assertRegisteredServiceOverride} over `activation.services`. */
  assertServiceOverride(expectation: RegisteredServiceOverrideExpectation): RegisteredExtensionServiceOverride;
  /** Bound {@link assertRegisteredSearchProvider} over `activation.registrations`. */
  assertSearchProvider(expectation: RegisteredSearchProviderExpectation): RegisteredExtensionSearchProvider;
  /** Bound {@link assertRegisteredVectorStoreAdapter} over `activation.registrations`. */
  assertVectorStoreAdapter(expectation: RegisteredVectorStoreAdapterExpectation): RegisteredExtensionVectorStoreAdapter;
  /** Bound {@link assertRegisteredImporter} over `activation.registrations`. */
  assertImporter(expectation: RegisteredImporterExpectation): RegisteredExtensionImporter;
  /** Bound {@link assertRegisteredExporter} over `activation.registrations`. */
  assertExporter(expectation: RegisteredExporterExpectation): RegisteredExtensionExporter;
  /** Bound {@link assertRegisteredMigration} over `activation.registrations`. */
  assertMigration(expectation: RegisteredMigrationExpectation): RegisteredExtensionSchemaMigrationDefinition;
  /** Bound {@link assertExtensionCapabilityUsage} over the whole `activation`. */
  assertCapabilityUsage(expectation: ExtensionCapabilityUsageExpectation): ExtensionCapabilityUsageAssertion;

  /** Bound {@link runRegisteredCommandForTest} over `activation.commands`. */
  runCommand(options: RunRegisteredCommandForTestOptions): Promise<CommandHandlerResult>;
  /** Bound {@link runRegisteredHookForTest} over `activation.hooks`. */
  runHook(options: RunRegisteredHookForTestOptions): Promise<string[]>;
  /** Bound {@link runRegisteredCommandOverrideForTest} over `activation.commands`. */
  runCommandOverride(context: CommandOverrideContext): Promise<CommandOverrideResult>;
  /** Bound {@link runRegisteredParserOverrideForTest} over `activation.parsers`. */
  runParserOverride(context: ParserOverrideContext): Promise<ParserOverrideResult>;
  /** Bound {@link runRegisteredPreflightOverrideForTest} over `activation.preflight`. */
  runPreflightOverride(context: PreflightOverrideContext): Promise<PreflightOverrideResult>;
  /** Bound {@link runRegisteredRendererOverrideForTest} over `activation.renderers`. */
  runRendererOverride(context: RendererOverrideContext): Promise<RendererOverrideResult>;
  /** Bound {@link runRegisteredServiceOverrideForTest} over `activation.services`. */
  runServiceOverride(context: ServiceOverrideContext): Promise<ServiceOverrideResult>;
  /** Bound {@link runRegisteredSearchProviderForTest} over `activation.registrations`. */
  runSearchProvider<Operation extends keyof SearchProviderOperationContexts>(options: {
    provider: string;
    operation: Operation;
    context: SearchProviderOperationContexts[Operation];
  }): Promise<SearchProviderOperationResults[Operation]>;
  /** Bound {@link runRegisteredVectorStoreAdapterForTest} over `activation.registrations`. */
  runVectorStoreAdapter<Operation extends keyof VectorStoreAdapterOperationContexts>(options: {
    adapter: string;
    operation: Operation;
    context: VectorStoreAdapterOperationContexts[Operation];
  }): Promise<VectorStoreAdapterOperationResults[Operation]>;
  /** Bound {@link runRegisteredMigrationForTest} over `activation.registrations`. */
  runMigration(options: RunRegisteredMigrationForTestOptions): Promise<unknown>;
  /** Bound {@link runRegisteredImporterForTest} over the whole `activation`. */
  runImporter(options: RunRegisteredImporterForTestOptions): Promise<CommandHandlerResult>;
  /** Bound {@link runRegisteredExporterForTest} over the whole `activation`. */
  runExporter(options: RunRegisteredExporterForTestOptions): Promise<CommandHandlerResult>;

  /**
   * Bound {@link deactivateExtensionForTest} — runs the real teardown engine for
   * this harness's module, forwarding its resolved `name`/`layer`/`activation` so
   * the skip-key matches and a never-initialized extension is not deactivated.
   */
  deactivate(options?: { deactivateTimeoutMs?: number }): Promise<ExtensionDeactivationResult>;
}

/**
 * Reject obviously wrong harness input (e.g. an options object passed as the
 * module) instead of silently producing an empty activation. Mirrors the
 * loader's activatable-extension shapes: an `activate` function on the module
 * or on its default export.
 */
function assertTestModuleHasActivateExport(module: unknown): void {
  const moduleRecord = asPropertyRecord(module);
  const defaultExport = asPropertyRecord(moduleRecord?.default);
  if (typeof moduleRecord?.activate === "function" || typeof defaultExport?.activate === "function") {
    return;
  }
  throw new Error(
    "createExtensionTestHarness received a module with no activate export. Pass the extension module (with an activate(api) function on the module or its default export) as the first argument, and options second.",
  );
}

/**
 * Activate one in-memory extension module and return a fluent
 * {@link ExtensionTestHarness} that binds every SDK testing helper to the right
 * sub-registry of the resulting activation.
 *
 * This is the ergonomic capstone over the standalone helpers: instead of
 * `activateExtensionForTest(module)` followed by repeatedly threading
 * `activation.registrations` / `activation.commands` / `activation.hooks` into
 * each `assertRegistered*` / `runRegistered*` call, an author writes
 * `const ext = await createExtensionTestHarness(module, { capabilities });` and
 * then `ext.assertCommandContract(...)`, `await ext.runCommand(...)`,
 * `await ext.deactivate()` — never needing to know pm's internal registry layout.
 *
 * `name` and `layer` are resolved exactly as {@link activateExtensionForTest}
 * resolves them, and captured so {@link ExtensionTestHarness.deactivate} forwards
 * a matching skip-key. Activation runs pm's real validation/activation engine, so
 * every bound helper exercises real wiring and dispatch — not mocks.
 *
 * Fails fast: if the module does not activate cleanly (e.g. a registration is
 * dropped because the manifest omits the required capability), this throws a
 * descriptive error listing each failure instead of returning a harness whose
 * registries are empty — which would otherwise surface later as the confusing
 * `available: (none)` assertion error this helper exists to prevent. Tests that
 * deliberately exercise a *failed* activation should call
 * {@link activateExtensionForTest} directly and inspect `activation.failed`.
 */
export async function createExtensionTestHarness(
  module: unknown,
  options: ActivateExtensionForTestOptions = {},
): Promise<ExtensionTestHarness> {
  assertTestModuleHasActivateExport(module);
  const manifest = readTestExtensionManifest(module);
  const name = resolveTestExtensionName(manifest, options.name);
  const layer: ExtensionLayer = options.layer ?? "project";
  const activation = await activateExtensionForTest(module, options);
  if (activation.failed.length > 0) {
    const detail = activation.failed
      .map((failure) => {
        const missingCapability = failure.trace?.missing_capability;
        const reason = missingCapability ? `${failure.error}; missing capability "${missingCapability}"` : failure.error;
        return `${failure.layer}:${failure.name} (${reason})`;
      })
      .join(", ");
    throw new Error(
      `createExtensionTestHarness could not activate the extension cleanly: ${detail}. ` +
        "Declare the required capability in the manifest (or pass it via options.capabilities), " +
        "or use activateExtensionForTest directly to inspect a failed activation.",
    );
  }
  return {
    module,
    name,
    layer,
    activation,
    activationSummary(describeOptions) {
      return describeExtensionActivation(activation, describeOptions);
    },
    renderMarkdown(markdownOptions = {}) {
      const { extensionName, ...renderOptions } = markdownOptions ?? {};
      return renderExtensionSurfaceMarkdown(describeExtensionActivation(activation, { extensionName }), renderOptions);
    },
    assertCommandContract(expectation) {
      return assertRegisteredCommandContract(activation.registrations, expectation);
    },
    assertFlags(expectation) {
      return assertRegisteredFlags(activation.registrations, expectation);
    },
    assertItemField(expectation) {
      return assertRegisteredItemField(activation.registrations, expectation);
    },
    assertItemType(expectation) {
      return assertRegisteredItemType(activation.registrations, expectation);
    },
    assertProfile(expectation) {
      return assertRegisteredProfile(activation.registrations, expectation);
    },
    assertHook(expectation) {
      return assertRegisteredHook(activation.hooks, expectation);
    },
    assertCommandOverride(expectation) {
      return assertRegisteredCommandOverride(activation.commands, expectation);
    },
    assertParserOverride(expectation) {
      return assertRegisteredParserOverride(activation.parsers, expectation);
    },
    assertPreflightOverride(expectation) {
      return assertRegisteredPreflightOverride(activation.preflight, expectation);
    },
    assertRendererOverride(expectation) {
      return assertRegisteredRendererOverride(activation.renderers, expectation);
    },
    assertServiceOverride(expectation) {
      return assertRegisteredServiceOverride(activation.services, expectation);
    },
    assertSearchProvider(expectation) {
      return assertRegisteredSearchProvider(activation.registrations, expectation);
    },
    assertVectorStoreAdapter(expectation) {
      return assertRegisteredVectorStoreAdapter(activation.registrations, expectation);
    },
    assertImporter(expectation) {
      return assertRegisteredImporter(activation.registrations, expectation);
    },
    assertExporter(expectation) {
      return assertRegisteredExporter(activation.registrations, expectation);
    },
    assertMigration(expectation) {
      return assertRegisteredMigration(activation.registrations, expectation);
    },
    assertCapabilityUsage(expectation) {
      return assertExtensionCapabilityUsage(activation, expectation);
    },
    runCommand(runOptions) {
      return runRegisteredCommandForTest(activation.commands, runOptions);
    },
    runHook(runOptions) {
      return runRegisteredHookForTest(activation.hooks, runOptions);
    },
    runCommandOverride(context) {
      return runRegisteredCommandOverrideForTest(activation.commands, context);
    },
    runParserOverride(context) {
      return runRegisteredParserOverrideForTest(activation.parsers, context);
    },
    runPreflightOverride(context) {
      return runRegisteredPreflightOverrideForTest(activation.preflight, context);
    },
    runRendererOverride(context) {
      return runRegisteredRendererOverrideForTest(activation.renderers, context);
    },
    runServiceOverride(context) {
      return runRegisteredServiceOverrideForTest(activation.services, context);
    },
    runSearchProvider(runOptions) {
      return runRegisteredSearchProviderForTest(activation.registrations, runOptions);
    },
    runVectorStoreAdapter(runOptions) {
      return runRegisteredVectorStoreAdapterForTest(activation.registrations, runOptions);
    },
    runMigration(runOptions) {
      return runRegisteredMigrationForTest(activation.registrations, runOptions);
    },
    runImporter(runOptions) {
      return runRegisteredImporterForTest(activation, runOptions);
    },
    runExporter(runOptions) {
      return runRegisteredExporterForTest(activation, runOptions);
    },
    deactivate(deactivateOptions = {}) {
      return deactivateExtensionForTest(module, {
        name,
        layer,
        activation,
        deactivateTimeoutMs: deactivateOptions.deactivateTimeoutMs,
      });
    },
  };
}
