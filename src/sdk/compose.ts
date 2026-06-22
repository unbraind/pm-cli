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
    const hooks = blueprint.hooks;
    if (hooks !== undefined) {
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
    }
    await blueprint.activate?.(api);
  };

  const module: ExtensionModule = { activate };
  if (blueprint.manifest !== undefined) {
    module.manifest = blueprint.manifest;
  }
  if (blueprint.deactivate !== undefined) {
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

function hasEntries(value: readonly unknown[] | Record<string, unknown> | undefined): boolean {
  if (value === undefined) {
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
  const hooks = blueprint.hooks;
  if (hooks !== undefined && [hooks.beforeCommand, hooks.afterCommand, hooks.onWrite, hooks.onRead, hooks.onIndex].some(hasEntries)) {
    capabilities.add("hooks");
  }
  return [...capabilities].sort((left, right) => left.localeCompare(right));
}
