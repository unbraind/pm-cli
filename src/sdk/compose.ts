/**
 * @module sdk/compose
 *
 * Declarative extension authoring — the capstone of the SDK authoring tripod
 * (`author → register → test`).
 *
 * The {@link ./define.js | `define*`} builders type each registration where it
 * is written, and the `assert*`/`run*` testing helpers verify and invoke it. But
 * the author still has to hand-wire every definition into an imperative
 * `activate(api)` body — calling the right `api.register*` method, in the right
 * order, without forgetting one — and then hand-sync `manifest.capabilities` to
 * match. Those are the two most common package-authoring footguns.
 *
 * {@link composeExtension} closes the loop: an author (or an agent) describes
 * *what* to register as a plain {@link ExtensionBlueprint} object, and the SDK
 * generates the `activate` that wires every surface for them.
 * {@link deriveExtensionCapabilities} computes the exact least-privilege
 * capability set that blueprint exercises, so `manifest.json` can be authored
 * with zero declared-but-unused / used-but-undeclared drift (the author-time
 * inverse of the runtime `reconcileExtensionCapabilityUsage` reconciliation).
 *
 * This module also owns {@link ExtensionModule} and {@link defineExtension} —
 * the in-module export shape every extension entry file produces and its
 * zero-cost identity helper — so both the imperative (`defineExtension`) and
 * declarative (`composeExtension`) authoring styles live together. Both are
 * re-exported from the SDK barrel, so the public API is unchanged.
 */
import type {
  AfterCommandHook,
  BeforeCommandHook,
  CommandDefinition,
  CommandOverride,
  ExtensionApi,
  ExtensionCapability,
  ExtensionManifest,
  ExtensionServiceName,
  Exporter,
  FlagDefinition,
  ImportExportRegistrationOptions,
  Importer,
  OnIndexHook,
  OnReadHook,
  OnWriteHook,
  OutputRendererFormat,
  ParserOverride,
  PreflightOverride,
  RendererOverride,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
  SchemaMigrationDefinition,
  SearchProviderDefinition,
  ServiceOverride,
  VectorStoreAdapterDefinition,
} from "../core/extensions/loader.js";
import type { ExtensionActivationSummary } from "../core/extensions/activation-summary.js";
import {
  normalizeKnownExtensionCapability,
  resolveLegacyExtensionCapabilityAlias,
} from "../core/extensions/extension-capability-aliases.js";
import { normalizeCommandName } from "../core/extensions/extension-runtime-helpers.js";

/**
 * Documents the extension module payload exchanged by command, SDK, and package integrations.
 *
 * This is the shape an extension entry file exports (as its default export and,
 * conventionally, as named `manifest`/`activate` exports). Produce it directly,
 * via {@link defineExtension} for the imperative style, or via
 * {@link composeExtension} for the declarative style.
 */
export interface ExtensionModule {
  /**
   * Optional in-module metadata mirror.
   *
   * The authoritative manifest remains on-disk `manifest.json`; this field is
   * useful when authors want colocated metadata for tooling/tests. Type it with
   * {@link defineExtensionManifest} for full contract checking in plain
   * JavaScript packages.
   */
  manifest?: ExtensionManifest;
  activate(api: ExtensionApi): void | Promise<void>;
  /**
   * Optional teardown lifecycle hook (VS Code-style `deactivate`). Invoked by
   * the host on shutdown/reload to release resources opened during `activate`.
   */
  deactivate?(): void | Promise<void>;
}

/**
 * Typed identity helper for extension module exports.
 *
 * Use as:
 * `export default defineExtension({ activate(api) { ... } })`
 *
 * Reach for {@link composeExtension} instead when you would rather declare the
 * registrations as data than wire them imperatively in `activate`.
 */
export function defineExtension<TModule extends ExtensionModule>(module: TModule): TModule {
  return module;
}

/**
 * A single importer registration entry for an {@link ExtensionBlueprint}, mirroring
 * the positional arguments of `api.registerImporter(name, importer, options?)`.
 */
export interface ExtensionBlueprintImporter {
  /** Registered importer name; the `<name> import` command path is derived from it. */
  name: string;
  /** The importer handler that bridges an external system into the pm context graph. */
  importer: Importer;
  /** Optional command metadata (description/flags/intent/examples) for the derived command. */
  options?: ImportExportRegistrationOptions;
}

/**
 * A single exporter registration entry for an {@link ExtensionBlueprint}, mirroring
 * the positional arguments of `api.registerExporter(name, exporter, options?)`.
 */
export interface ExtensionBlueprintExporter {
  /** Registered exporter name; the `<name> export` command path is derived from it. */
  name: string;
  /** The exporter handler that bridges the pm context graph out to an external system. */
  exporter: Exporter;
  /** Optional command metadata (description/flags/intent/examples) for the derived command. */
  options?: ImportExportRegistrationOptions;
}

/**
 * The lifecycle hooks an {@link ExtensionBlueprint} can register, one array per
 * kind. Each entry is registered through the matching `api.hooks.*` method in
 * the canonical order `before_command → after_command → on_write → on_read →
 * on_index`.
 */
export interface ExtensionBlueprintHooks {
  /** Hooks fired before a command runs (`api.hooks.beforeCommand`). */
  beforeCommand?: BeforeCommandHook[];
  /** Hooks fired after a command runs (`api.hooks.afterCommand`). */
  afterCommand?: AfterCommandHook[];
  /** Hooks fired when an item is persisted (`api.hooks.onWrite`). */
  onWrite?: OnWriteHook[];
  /** Hooks fired when an item is read (`api.hooks.onRead`). */
  onRead?: OnReadHook[];
  /** Hooks fired during index/search refresh (`api.hooks.onIndex`). */
  onIndex?: OnIndexHook[];
}

/**
 * A declarative description of everything an extension registers at activation.
 *
 * Every field is optional: populate the surfaces your extension uses (ideally
 * with {@link ./define.js | `define*`}-authored definitions) and leave the rest
 * out. {@link composeExtension} turns the blueprint into an
 * {@link ExtensionModule} whose generated `activate` calls the matching
 * `api.register*` method for each surface, and {@link deriveExtensionCapabilities}
 * computes the capability set the blueprint requires.
 *
 * Record-keyed fields map a routing key (command name, output format, or service
 * name) to its handler, mirroring the two-argument `api.register*` overloads.
 */
export interface ExtensionBlueprint {
  /** Optional in-module manifest mirror, copied onto the produced module verbatim. */
  manifest?: ExtensionManifest;
  /** Full command definitions registered via `api.registerCommand(definition)`. */
  commands?: CommandDefinition[];
  /** Command overrides keyed by command name, registered via `api.registerCommand(command, override)`. */
  commandOverrides?: Record<string, CommandOverride>;
  /** Additional flags keyed by target command name, registered via `api.registerFlags(command, flags)`. */
  flags?: Record<string, FlagDefinition[]>;
  /** Parser overrides keyed by command name, registered via `api.registerParser(command, override)`. */
  parsers?: Record<string, ParserOverride>;
  /** Output renderer overrides keyed by format, registered via `api.registerRenderer(format, renderer)`. */
  renderers?: Partial<Record<OutputRendererFormat, RendererOverride>>;
  /** Service overrides keyed by service name, registered via `api.registerService(service, override)`. */
  services?: Partial<Record<ExtensionServiceName, ServiceOverride>>;
  /** Preflight overrides registered via `api.registerPreflight(override)`. */
  preflights?: PreflightOverride[];
  /** Custom item types registered in a single `api.registerItemTypes(types)` call. */
  itemTypes?: SchemaItemTypeDefinition[];
  /** Custom front-matter fields registered in a single `api.registerItemFields(fields)` call. */
  itemFields?: SchemaFieldDefinition[];
  /** Schema migrations registered one at a time via `api.registerMigration(definition)`. */
  migrations?: SchemaMigrationDefinition[];
  /** Search providers registered via `api.registerSearchProvider(provider)`. */
  searchProviders?: SearchProviderDefinition[];
  /** Vector store adapters registered via `api.registerVectorStoreAdapter(adapter)`. */
  vectorStoreAdapters?: VectorStoreAdapterDefinition[];
  /** Importers registered via `api.registerImporter(name, importer, options?)`. */
  importers?: ExtensionBlueprintImporter[];
  /** Exporters registered via `api.registerExporter(name, exporter, options?)`. */
  exporters?: ExtensionBlueprintExporter[];
  /** Lifecycle hooks registered through `api.hooks.*`. */
  hooks?: ExtensionBlueprintHooks;
  /**
   * Optional imperative escape hatch run *after* every declarative registration,
   * for the rare wiring the blueprint cannot express. Receives the same `api`.
   */
  activate?: (api: ExtensionApi) => void | Promise<void>;
  /** Optional teardown hook copied onto the produced module verbatim. */
  deactivate?: () => void | Promise<void>;
}

/**
 * Assemble an {@link ExtensionModule} from a declarative {@link ExtensionBlueprint}.
 *
 * The returned module's `activate` registers every populated surface through the
 * matching `api.register*` method in a deterministic order (commands → overrides
 * → flags → parsers → renderers → services → preflights → item types → item
 * fields → migrations → search providers → vector store adapters → importers →
 * exporters → hooks), then awaits the blueprint's optional imperative `activate`
 * so it can layer on anything the declarative form cannot express. `manifest`
 * and `deactivate` are copied onto the module verbatim.
 *
 * This is a pure assembler: it does not validate the definitions. Per-surface
 * contract enforcement stays in `api.register*` (and the loader), exactly as it
 * does for hand-written `activate` bodies, so a malformed definition surfaces
 * the same activation diagnostic either way.
 */
export function composeExtension(blueprint: ExtensionBlueprint): ExtensionModule {
  const activate = async (api: ExtensionApi): Promise<void> => {
    for (const command of blueprint.commands ?? []) {
      api.registerCommand(command);
    }
    for (const [command, override] of Object.entries(blueprint.commandOverrides ?? {})) {
      api.registerCommand(command, override);
    }
    for (const [targetCommand, flags] of Object.entries(blueprint.flags ?? {})) {
      api.registerFlags(targetCommand, flags);
    }
    for (const [command, override] of Object.entries(blueprint.parsers ?? {})) {
      api.registerParser(command, override);
    }
    for (const [format, renderer] of Object.entries(blueprint.renderers ?? {}) as Array<
      [OutputRendererFormat, RendererOverride]
    >) {
      api.registerRenderer(format, renderer);
    }
    for (const [service, override] of Object.entries(blueprint.services ?? {}) as Array<
      [ExtensionServiceName, ServiceOverride]
    >) {
      api.registerService(service, override);
    }
    for (const override of blueprint.preflights ?? []) {
      api.registerPreflight(override);
    }
    const itemTypes = blueprint.itemTypes ?? [];
    if (itemTypes.length > 0) {
      api.registerItemTypes(itemTypes);
    }
    const itemFields = blueprint.itemFields ?? [];
    if (itemFields.length > 0) {
      api.registerItemFields(itemFields);
    }
    for (const migration of blueprint.migrations ?? []) {
      api.registerMigration(migration);
    }
    for (const provider of blueprint.searchProviders ?? []) {
      api.registerSearchProvider(provider);
    }
    for (const adapter of blueprint.vectorStoreAdapters ?? []) {
      api.registerVectorStoreAdapter(adapter);
    }
    for (const entry of blueprint.importers ?? []) {
      api.registerImporter(entry.name, entry.importer, entry.options);
    }
    for (const entry of blueprint.exporters ?? []) {
      api.registerExporter(entry.name, entry.exporter, entry.options);
    }
    // `?? {}` (rather than a `!== undefined` guard) so an untyped JavaScript
    // author who passes `hooks: null` is treated the same as omitting it,
    // instead of throwing on the first `hooks.beforeCommand` access.
    const hooks: ExtensionBlueprintHooks = blueprint.hooks ?? {};
    for (const hook of hooks.beforeCommand ?? []) {
      api.hooks.beforeCommand(hook);
    }
    for (const hook of hooks.afterCommand ?? []) {
      api.hooks.afterCommand(hook);
    }
    for (const hook of hooks.onWrite ?? []) {
      api.hooks.onWrite(hook);
    }
    for (const hook of hooks.onRead ?? []) {
      api.hooks.onRead(hook);
    }
    for (const hook of hooks.onIndex ?? []) {
      api.hooks.onIndex(hook);
    }
    await blueprint.activate?.(api);
  };

  // Truthy checks (rather than `!== undefined`) so an explicit `null` mirror or
  // teardown is treated as absent instead of copied onto the module.
  const module: ExtensionModule = { activate };
  if (blueprint.manifest) {
    module.manifest = blueprint.manifest;
  }
  if (blueprint.deactivate) {
    module.deactivate = blueprint.deactivate;
  }
  return module;
}

/**
 * Blueprint registration fields whose presence implies a capability, paired with
 * the capability each grants. Mirrors `EXTENSION_CAPABILITY_REGISTRATION_SURFACES`
 * so a blueprint's derived capabilities exactly match what the loader enforces
 * when {@link composeExtension}'s generated `activate` calls `api.register*`.
 *
 * `hooks` is handled separately (it is a nested object, not an array/record of
 * registrations) and so is intentionally absent from this table.
 */
const BLUEPRINT_FIELD_CAPABILITIES: ReadonlyArray<readonly [BlueprintRegistrationField, ExtensionCapability]> = [
  ["commands", "commands"],
  ["commandOverrides", "commands"],
  ["flags", "schema"],
  ["itemTypes", "schema"],
  ["itemFields", "schema"],
  ["migrations", "schema"],
  ["parsers", "parser"],
  ["renderers", "renderers"],
  ["services", "services"],
  ["preflights", "preflight"],
  ["searchProviders", "search"],
  ["vectorStoreAdapters", "search"],
  ["importers", "importers"],
  ["exporters", "importers"],
];

type BlueprintRegistrationField =
  | "commands"
  | "commandOverrides"
  | "flags"
  | "parsers"
  | "renderers"
  | "services"
  | "preflights"
  | "itemTypes"
  | "itemFields"
  | "migrations"
  | "searchProviders"
  | "vectorStoreAdapters"
  | "importers"
  | "exporters";

function hasEntries(value: readonly unknown[] | Record<string, unknown> | null | undefined): boolean {
  // `!value` treats both `null` and `undefined` as "no entries", so an untyped
  // JavaScript author cannot crash capability derivation with an explicit null
  // field — `Object.keys(null)` would otherwise throw.
  if (!value) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Object.keys(value).length > 0;
}

/**
 * Compute the minimal least-privilege capability set a {@link ExtensionBlueprint}
 * exercises, sorted and de-duplicated.
 *
 * Use it to author `manifest.json` `capabilities` exactly — declaring nothing the
 * extension does not use and nothing it does. It is the author-time inverse of
 * the runtime `reconcileExtensionCapabilityUsage` reconciliation: derive the set
 * here before activation rather than detecting drift after it. A blueprint with
 * no registration surfaces returns an empty array.
 */
export function deriveExtensionCapabilities(blueprint: ExtensionBlueprint): ExtensionCapability[] {
  const capabilities = new Set<ExtensionCapability>();
  for (const [field, capability] of BLUEPRINT_FIELD_CAPABILITIES) {
    if (hasEntries(blueprint[field])) {
      capabilities.add(capability);
    }
  }
  // A command definition carrying its own inline `flags` registers them through
  // `registerCommand`, which asserts the `schema` capability independently of the
  // top-level `flags` record. Mirror that here so the derived set still matches
  // what activation enforces when a command declares flags inline and the
  // blueprint has no separate `flags` field. `!== undefined` (not a truthiness or
  // length check) matches the loader's exact guard, including an empty inline array.
  if ((blueprint.commands ?? []).some((command) => command.flags !== undefined)) {
    capabilities.add("schema");
  }
  // `?? {}` keeps an explicit `hooks: null` from throwing, mirroring composeExtension.
  const hooks: ExtensionBlueprintHooks = blueprint.hooks ?? {};
  if ([hooks.beforeCommand, hooks.afterCommand, hooks.onWrite, hooks.onRead, hooks.onIndex].some(hasEntries)) {
    capabilities.add("hooks");
  }
  return [...capabilities].sort((left, right) => left.localeCompare(right));
}

/**
 * Blueprint hook fields paired with the lifecycle kind each registers, ordered to
 * match `ExtensionActivationResult.hook_counts` (and the runtime
 * {@link ../core/extensions/activation-summary.js#describeExtensionActivation}'s
 * `hooks` ordering) so a blueprint summary's `hooks` list reads in the same
 * canonical order, not alphabetically.
 */
const BLUEPRINT_HOOK_FIELD_TO_KIND = [
  ["beforeCommand", "before_command"],
  ["afterCommand", "after_command"],
  ["onWrite", "on_write"],
  ["onRead", "on_read"],
  ["onIndex", "on_index"],
] as const satisfies ReadonlyArray<readonly [keyof ExtensionBlueprintHooks, string]>;

/** De-duplicate and locale-sort a list of identifiers, mirroring the runtime summary. */
function sortUnique<TValue extends string>(values: readonly TValue[]): TValue[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Compute, without activating, the exact {@link ExtensionActivationSummary} that
 * {@link composeExtension}'s generated `activate` would produce for a blueprint.
 *
 * This is the author-time inverse of the runtime
 * {@link ../core/extensions/activation-summary.js#describeExtensionActivation}:
 * the runtime verb walks an *activated* registry, while this one reads the
 * declarative {@link ExtensionBlueprint} data directly, so an author or agent can
 * preview the full named surface map (commands, overrides, handlers, hooks, item
 * types/fields, importers/exporters, search/vector adapters, parser/service/
 * renderer overrides, flag-target commands, and the preflight count) with no
 * loading, activation, or side effects. It is to the named surfaces what
 * {@link deriveExtensionCapabilities} is to the capability set.
 *
 * Fidelity is by construction: command paths are normalized with the same
 * `normalizeCommandName` the loader applies, and importer/exporter handler paths
 * are synthesized as `normalizeCommandName("<name> import|export")`, exactly as
 * `registerImporter`/`registerExporter` do. A parity test pins this output equal
 * to `describeExtensionActivation` over the same composed-and-activated blueprint.
 *
 * The one surface it cannot reflect is the blueprint's optional imperative
 * `activate` escape hatch — arbitrary code a static reader cannot inspect. A
 * blueprint that registers everything through that hatch summarizes as empty.
 */
export function describeExtensionBlueprint(blueprint: ExtensionBlueprint): ExtensionActivationSummary {
  const commandPaths = (blueprint.commands ?? []).map((command) => normalizeCommandName(command.name));
  const importerPaths = (blueprint.importers ?? []).map((entry) => normalizeCommandName(`${entry.name} import`));
  const exporterPaths = (blueprint.exporters ?? []).map((entry) => normalizeCommandName(`${entry.name} export`));
  // A command definition with inline `flags` registers a flag target under its own
  // path in addition to any top-level `flags` record, so union both sources.
  const flagCommands = [
    ...Object.keys(blueprint.flags ?? {}).map((command) => normalizeCommandName(command)),
    ...(blueprint.commands ?? [])
      .filter((command) => command.flags !== undefined)
      .map((command) => normalizeCommandName(command.name)),
  ];
  const hooks: ExtensionBlueprintHooks = blueprint.hooks ?? {};

  return {
    capabilities: deriveExtensionCapabilities(blueprint),
    commands: sortUnique(commandPaths),
    command_overrides: sortUnique(Object.keys(blueprint.commandOverrides ?? {}).map((command) => normalizeCommandName(command))),
    // command_handlers is a superset of commands that also carries the synthesized
    // importer/exporter command paths, but never the override-only paths.
    command_handlers: sortUnique([...commandPaths, ...importerPaths, ...exporterPaths]),
    hooks: BLUEPRINT_HOOK_FIELD_TO_KIND.filter(([field]) => (hooks[field]?.length ?? 0) > 0).map(([, kind]) => kind),
    flag_commands: sortUnique(flagCommands),
    item_types: sortUnique((blueprint.itemTypes ?? []).map((type) => type.name)),
    item_fields: sortUnique((blueprint.itemFields ?? []).map((field) => field.name)),
    // id-less migrations register but carry no identifier, so they are omitted —
    // exactly as describeExtensionActivation drops them from its `migrations` list.
    migrations: sortUnique(
      (blueprint.migrations ?? []).flatMap((migration) => (typeof migration.id === "string" ? [migration.id] : [])),
    ),
    importers: sortUnique((blueprint.importers ?? []).map((entry) => normalizeCommandName(entry.name))),
    exporters: sortUnique((blueprint.exporters ?? []).map((entry) => normalizeCommandName(entry.name))),
    search_providers: sortUnique((blueprint.searchProviders ?? []).map((provider) => provider.name)),
    vector_store_adapters: sortUnique((blueprint.vectorStoreAdapters ?? []).map((adapter) => adapter.name)),
    parser_overrides: sortUnique(Object.keys(blueprint.parsers ?? {}).map((command) => normalizeCommandName(command))),
    service_overrides: sortUnique(
      Object.keys(blueprint.services ?? {}).map((service) => String(service).trim().toLowerCase() as ExtensionServiceName),
    ),
    renderer_overrides: sortUnique(
      Object.keys(blueprint.renderers ?? {}).map((format) => String(format).trim().toLowerCase() as OutputRendererFormat),
    ),
    preflight_overrides: (blueprint.preflights ?? []).length,
  };
}

/**
 * The blueprint registration fields a lint flags as a dead "empty surface" when
 * present but empty. Mirrors {@link BlueprintRegistrationField} so adding a new
 * registration surface forces a decision here too; `hooks` is handled separately
 * because it is a nested object rather than an array/record of registrations.
 */
const BLUEPRINT_LINTABLE_SURFACE_FIELDS = [
  "commands",
  "commandOverrides",
  "flags",
  "parsers",
  "renderers",
  "services",
  "preflights",
  "itemTypes",
  "itemFields",
  "migrations",
  "searchProviders",
  "vectorStoreAdapters",
  "importers",
  "exporters",
] as const satisfies ReadonlyArray<BlueprintRegistrationField>;

/** Severity of an {@link ExtensionBlueprintLintFinding}: a hard `error` (activation will fail) or an advisory `warning`. */
export type ExtensionBlueprintLintSeverity = "error" | "warning";

/**
 * Machine-readable kind of an {@link ExtensionBlueprintLintFinding}.
 *
 * - `capability_undeclared` (error): a surface exercises a capability the declared
 *   set omits; the loader throws `extension_capability_missing` at activation.
 * - `capability_unused` (warning): a declared capability no surface exercises; the
 *   runtime equivalent is the `pm package doctor` `extension_capability_unused` note.
 * - `duplicate_command` (warning): the same normalized command path is declared
 *   more than once in `commands`; the later registration shadows the earlier.
 * - `command_override_conflict` (warning): a path is declared as both a fresh
 *   command definition and a command override.
 * - `empty_surface` (warning): a registration field is present but contributes
 *   nothing — a dead declaration.
 * - `manifest_capabilities_absent` (warning): the blueprint exercises capabilities
 *   but offers no declared set to reconcile against.
 */
export type ExtensionBlueprintLintCode =
  | "capability_undeclared"
  | "capability_unused"
  | "duplicate_command"
  | "command_override_conflict"
  | "empty_surface"
  | "manifest_capabilities_absent";

/**
 * A single author-time issue {@link lintExtensionBlueprint} found in a blueprint.
 */
export interface ExtensionBlueprintLintFinding {
  /** The machine-readable {@link ExtensionBlueprintLintCode} for programmatic handling. */
  code: ExtensionBlueprintLintCode;
  /** Whether the finding blocks activation (`error`) or is advisory (`warning`). */
  severity: ExtensionBlueprintLintSeverity;
  /** Human-readable explanation, including the suggested fix. */
  message: string;
  /** The capability involved, for capability-drift findings. */
  capability?: ExtensionCapability;
  /** The normalized command path involved, for command findings. */
  command?: string;
  /** The blueprint field involved, for `empty_surface` findings. */
  field?: string;
}

/**
 * Options for {@link lintExtensionBlueprint} and {@link ../sdk/testing.js#assertExtensionBlueprint}.
 */
export interface LintExtensionBlueprintOptions {
  /**
   * The capabilities the package's `manifest.json` declares (or will), used to
   * reconcile against the surfaces the blueprint exercises. Overrides
   * `blueprint.manifest.capabilities` when both are present. Omit both to lint
   * without a capability reconciliation (only the structural checks run).
   */
  declaredCapabilities?: readonly string[];
}

/**
 * The structured result of {@link lintExtensionBlueprint}.
 */
export interface ExtensionBlueprintLintResult {
  /** `true` when no `error`-severity finding is present (warnings still allow activation). */
  ok: boolean;
  /** Every finding, in detection order (capability drift, duplicates, conflicts, empty surfaces). */
  findings: ExtensionBlueprintLintFinding[];
  /** The least-privilege capability set the blueprint exercises (from {@link deriveExtensionCapabilities}). */
  used: ExtensionCapability[];
  /** The normalized declared capability set reconciled against, or `null` when none was provided. */
  declared: ExtensionCapability[] | null;
}

/** Normalize a raw declared-capability list to known capabilities only (legacy-alias aware, sorted, de-duplicated). */
function normalizeDeclaredCapabilities(capabilities: readonly string[]): ExtensionCapability[] {
  const known = new Set<ExtensionCapability>();
  for (const capability of capabilities) {
    // Resolve a legacy alias (e.g. migration/validation → schema) exactly as the
    // loader does before reconciliation — the author's raw manifest input has not
    // been loader-normalized yet, so failing to resolve it here would misreport an
    // alias-satisfied capability as undeclared. Fall back to a canonical known
    // name; unknown capabilities are a separate diagnostic and are dropped so a
    // typo is not misreported as "unused".
    const normalized = resolveLegacyExtensionCapabilityAlias(capability) ?? normalizeKnownExtensionCapability(capability);
    if (normalized !== null) {
      known.add(normalized);
    }
  }
  return [...known].sort((left, right) => left.localeCompare(right));
}

/**
 * Preflight a declarative {@link ExtensionBlueprint} at author time, returning the
 * structured issues that would otherwise only surface at activation.
 *
 * It is the author-time inverse of the runtime extension guardrails — pure data
 * analysis with no loading, activation, or side effects:
 *
 * - capability drift in both directions: a capability a surface exercises but the
 *   declared set omits is an `error` (the loader throws `extension_capability_missing`
 *   at activation); a declared capability no surface exercises is a `warning` (the
 *   author-time form of the `pm package doctor` `extension_capability_unused` note,
 *   making this the static inverse of `reconcileExtensionCapabilityUsage`).
 * - structural footguns: a command path declared twice (`duplicate_command`), a
 *   path declared as both a command and an override (`command_override_conflict`),
 *   and a registration field present but empty (`empty_surface`).
 *
 * The declared set is taken from `options.declaredCapabilities` or, failing that,
 * `blueprint.manifest.capabilities`; with neither, capability reconciliation is
 * skipped and a single `manifest_capabilities_absent` warning suggests adopting
 * {@link deriveExtensionCapabilities}. Like {@link describeExtensionBlueprint},
 * the imperative `activate` escape hatch is invisible to this static check.
 */
export function lintExtensionBlueprint(
  blueprint: ExtensionBlueprint,
  options: LintExtensionBlueprintOptions = {},
): ExtensionBlueprintLintResult {
  const findings: ExtensionBlueprintLintFinding[] = [];
  const used = deriveExtensionCapabilities(blueprint);

  // A non-array declared source (an untyped `.js` author's malformed manifest, or
  // a missing field) is treated as "no declared set" rather than "declares nothing".
  const declaredSource = options.declaredCapabilities ?? blueprint.manifest?.capabilities;
  const declared = Array.isArray(declaredSource) ? normalizeDeclaredCapabilities(declaredSource) : null;

  if (declared === null) {
    if (used.length > 0) {
      findings.push({
        code: "manifest_capabilities_absent",
        severity: "warning",
        message: `Blueprint exercises ${used.length === 1 ? "capability" : "capabilities"} [${used.join(", ")}] but declares none; set capabilities to deriveExtensionCapabilities(blueprint) so the manifest grant matches.`,
      });
    }
  } else {
    const declaredSet = new Set(declared);
    const usedSet = new Set(used);
    for (const capability of used) {
      if (!declaredSet.has(capability)) {
        findings.push({
          code: "capability_undeclared",
          severity: "error",
          message: `Blueprint exercises capability "${capability}" but it is absent from the declared capabilities; activation throws extension_capability_missing — add "${capability}" to the manifest capabilities.`,
          capability,
        });
      }
    }
    for (const capability of declared) {
      if (!usedSet.has(capability)) {
        findings.push({
          code: "capability_unused",
          severity: "warning",
          message: `Capability "${capability}" is declared but no blueprint surface exercises it; drop it to keep the manifest least-privilege (pm package doctor reports this as extension_capability_unused).`,
          capability,
        });
      }
    }
  }

  // Duplicate command paths within the declared command definitions.
  const commandPathCounts = new Map<string, number>();
  for (const command of blueprint.commands ?? []) {
    const path = normalizeCommandName(command.name);
    commandPathCounts.set(path, (commandPathCounts.get(path) ?? 0) + 1);
  }
  for (const [path, count] of commandPathCounts) {
    if (count > 1) {
      findings.push({
        code: "duplicate_command",
        severity: "warning",
        message: `Command "${path}" is declared ${count} times in commands; the later registration shadows the earlier one at dispatch.`,
        command: path,
      });
    }
  }

  // A command path declared as both a fresh definition and an override.
  const overridePaths = new Set(
    Object.keys(blueprint.commandOverrides ?? {}).map((command) => normalizeCommandName(command)),
  );
  for (const path of commandPathCounts.keys()) {
    if (overridePaths.has(path)) {
      findings.push({
        code: "command_override_conflict",
        severity: "warning",
        message: `Command "${path}" is declared both as a new command definition and as a command override; register one or the other.`,
        command: path,
      });
    }
  }

  // Registration fields present on the blueprint but contributing nothing.
  for (const field of BLUEPRINT_LINTABLE_SURFACE_FIELDS) {
    if (field in blueprint && !hasEntries(blueprint[field])) {
      findings.push({
        code: "empty_surface",
        severity: "warning",
        message: `Blueprint field "${field}" is present but empty; remove it or populate it.`,
        field,
      });
    }
  }
  if ("hooks" in blueprint) {
    const hooks: ExtensionBlueprintHooks = blueprint.hooks ?? {};
    const registersHook = [hooks.beforeCommand, hooks.afterCommand, hooks.onWrite, hooks.onRead, hooks.onIndex].some(
      hasEntries,
    );
    if (!registersHook) {
      findings.push({
        code: "empty_surface",
        severity: "warning",
        message: `Blueprint field "hooks" is present but registers no lifecycle hooks; remove it or populate it.`,
        field: "hooks",
      });
    }
  }

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    findings,
    used,
    declared,
  };
}
