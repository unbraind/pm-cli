/**
 * @module core/extensions/activation-summary
 *
 * Enumerates *what* an extension activation registered, by name, in one pass.
 *
 * {@link ./extension-types.js#ExtensionActivationResult | `ExtensionActivationResult`}
 * already carries per-surface *counts* (`hook_counts`, `registration_counts`,
 * the various `*_count` fields), but answering "what does this extension
 * register?" otherwise means walking fifteen-plus sub-registries by hand
 * (`registrations.commands`/`flags`/`item_types`/`item_fields`/`migrations`/
 * `importers`/`exporters`/`search_providers`/`vector_store_adapters`,
 * `commands.overrides`/`handlers`, the `parsers`/`preflight`/`services`/
 * `renderers` override registries, and the five `hooks.*` arrays).
 *
 * {@link describeExtensionActivation} flattens all of them into one sorted,
 * deterministic {@link ExtensionActivationSummary} of identifiers — the
 * `describe` (enumerate-all) verb that complements the SDK's `assert*`
 * (verify-one) and `run*` (invoke-one) testing helpers. It serves two callers:
 *
 * - **Agents** get a single token-efficient view of an activation instead of
 *   traversing every registry ("project management = context management").
 * - **Package authors** can assert their *entire* registration surface in one
 *   `deepEqual` — a least-privilege "I register exactly these surfaces and
 *   nothing more" check, the positive counterpart to
 *   {@link ./capability-usage.js#reconcileExtensionCapabilityUsage}.
 */
import type {
  ExtensionActivationResult,
  ExtensionCapability,
  ExtensionHookRegistry,
  ExtensionServiceName,
  OutputRendererFormat,
} from "./extension-types.js";
import {
  collectUsedExtensionCapabilities,
  normalizeExtensionName,
} from "./capability-usage.js";

/**
 * Canonical lifecycle hook kinds paired with their {@link ExtensionHookRegistry}
 * field, ordered to match `ExtensionActivationResult.hook_counts` so a summary's
 * `hooks` list reads in the same stable order the runtime reports counts in.
 */
const HOOK_REGISTRY_FIELD_TO_KIND = [
  ["beforeCommand", "before_command"],
  ["afterCommand", "after_command"],
  ["onWrite", "on_write"],
  ["onRead", "on_read"],
  ["onIndex", "on_index"],
] as const satisfies ReadonlyArray<
  readonly [keyof ExtensionHookRegistry, string]
>;

/**
 * Flat, name-level enumeration of every surface an activation registered.
 *
 * Arrays are de-duplicated for deterministic equality. Most are locale-sorted;
 * {@link ExtensionActivationSummary.hooks} is the exception — it is emitted in
 * canonical lifecycle order to mirror `ExtensionActivationResult.hook_counts`,
 * not alphabetically. The three command fields capture distinct dimensions and
 * can overlap: a command
 * registered via `api.registerCommand(definition)` appears in both
 * {@link ExtensionActivationSummary.commands} (its declared definition) and
 * {@link ExtensionActivationSummary.command_handlers} (its executable handler),
 * whereas a built-in command replaced via `api.registerCommand(name, override)`
 * appears only in {@link ExtensionActivationSummary.command_overrides}.
 */
export interface ExtensionActivationSummary {
  /** Known capabilities the registered surfaces exercise (sorted, de-duplicated). */
  capabilities: ExtensionCapability[];
  /** Full command paths declared via `registerCommand`'s definition form. */
  commands: string[];
  /** Built-in command paths replaced by an `registerCommand(name, override)` handler. */
  command_overrides: string[];
  /**
   * Full command paths backed by an extension-provided handler. A superset of
   * {@link ExtensionActivationSummary.commands} that also includes the
   * `<name> import`/`<name> export` paths synthesized for importers/exporters.
   */
  command_handlers: string[];
  /** Lifecycle hook kinds with at least one registered hook (canonical order). */
  hooks: string[];
  /** Command paths that received extension-registered flags. */
  flag_commands: string[];
  /** Custom item-type names registered via `registerItemTypes`. */
  item_types: string[];
  /** Custom front-matter field names registered via `registerItemFields`. */
  item_fields: string[];
  /** Schema migration ids registered via `registerMigration` (id-less migrations are omitted — they carry no identifier). */
  migrations: string[];
  /** Project profile names registered via `registerProfile`. */
  profiles: string[];
  /** Importer names registered via `registerImporter`. */
  importers: string[];
  /** Exporter names registered via `registerExporter`. */
  exporters: string[];
  /** Search-provider names registered via `registerSearchProvider`. */
  search_providers: string[];
  /** Vector-store adapter names registered via `registerVectorStoreAdapter`. */
  vector_store_adapters: string[];
  /** Command paths with a parser override registered via `registerParser`. */
  parser_overrides: string[];
  /** Built-in service names overridden via `registerService`. */
  service_overrides: ExtensionServiceName[];
  /** Output formats with a renderer override registered via `registerRenderer`. */
  renderer_overrides: OutputRendererFormat[];
  /** Count of registered preflight overrides. The surface carries no per-entry identifier, so this is a `number` rather than `string[]` — the only numeric field in the summary. */
  preflight_overrides: number;
}

/**
 * Options for {@link describeExtensionActivation}.
 */
export interface DescribeExtensionActivationOptions {
  /**
   * Restrict the summary to a single extension by name. Names are matched
   * case-insensitively after trimming, mirroring
   * {@link ./capability-usage.js#collectUsedExtensionCapabilities}. Omit to
   * union across every extension in the activation result.
   */
  extensionName?: string;
  /** Restrict the summary to a set of extension names. This supports package aliases that resolve to multiple extensions while keeping the historical single-name option intact. */
  extensionNames?: readonly string[];
}

/**
 * Summarize, by name, every registration surface an activation exercised.
 *
 * Walks the same sub-registries the loader populates and the capability
 * reconciler attributes, returning a flat {@link ExtensionActivationSummary}
 * whose arrays are sorted and de-duplicated. With
 * {@link DescribeExtensionActivationOptions.extensionName} only the matching
 * extension's registrations contribute (across both layers); without it the
 * summary unions every extension in the activation. Failed activations register
 * nothing, so they contribute only an empty summary.
 */
export function describeExtensionActivation(
  activation: ExtensionActivationResult,
  options: DescribeExtensionActivationOptions = {},
): ExtensionActivationSummary {
  // Match both sides with the same normalizer collectUsedExtensionCapabilities
  // uses for the `capabilities` field below, so a filtered summary's named
  // surfaces and capabilities never disagree for a stored name with whitespace.
  const filters = new Set<string>();
  if (options.extensionName !== undefined) {
    filters.add(normalizeExtensionName(options.extensionName));
  }
  for (const name of options.extensionNames ?? []) {
    filters.add(normalizeExtensionName(name));
  }
  const matches = (name: string): boolean =>
    filters.size === 0 || filters.has(normalizeExtensionName(name));
  const collect = <TEntry extends { name: string }, TValue extends string>(
    entries: readonly TEntry[],
    identify: (entry: TEntry) => TValue,
  ): TValue[] =>
    sortUnique(entries.filter((entry) => matches(entry.name)).map(identify));
  const collectFlat = <TEntry extends { name: string }>(
    entries: readonly TEntry[],
    expand: (entry: TEntry) => readonly string[],
  ): string[] =>
    sortUnique(entries.filter((entry) => matches(entry.name)).flatMap(expand));
  const {
    registrations,
    commands,
    parsers,
    preflight,
    services,
    renderers,
    hooks,
  } = activation;
  return {
    capabilities: collectUsedExtensionCapabilities(activation, options),
    commands: collect(registrations.commands, (entry) => entry.command),
    command_overrides: collect(commands.overrides, (entry) => entry.command),
    command_handlers: collect(commands.handlers, (entry) => entry.command),
    hooks: HOOK_REGISTRY_FIELD_TO_KIND.filter(([field]) =>
      hooks[field].some((entry) => matches(entry.name)),
    ).map(([, kind]) => kind),
    flag_commands: collect(
      registrations.flags,
      (entry) => entry.target_command,
    ),
    item_types: collectFlat(registrations.item_types, (entry) =>
      entry.types.map((type) => type.name),
    ),
    item_fields: collectFlat(registrations.item_fields, (entry) =>
      entry.fields.map((field) => field.name),
    ),
    migrations: collectFlat(registrations.migrations, (entry) =>
      typeof entry.definition.id === "string" ? [entry.definition.id] : [],
    ),
    profiles: collect(registrations.profiles, (entry) => entry.profile.name),
    importers: collect(registrations.importers, (entry) => entry.importer),
    exporters: collect(registrations.exporters, (entry) => entry.exporter),
    search_providers: collect(
      registrations.search_providers,
      (entry) => entry.definition.name,
    ),
    vector_store_adapters: collect(
      registrations.vector_store_adapters,
      (entry) => entry.definition.name,
    ),
    parser_overrides: collect(parsers.overrides, (entry) => entry.command),
    service_overrides: collect(services.overrides, (entry) => entry.service),
    renderer_overrides: collect(renderers.overrides, (entry) => entry.format),
    preflight_overrides: preflight.overrides.filter((entry) =>
      matches(entry.name),
    ).length,
  };
}

function sortUnique<TValue extends string>(
  values: readonly TValue[],
): TValue[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
