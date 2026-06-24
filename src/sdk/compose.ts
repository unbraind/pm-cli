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
import type { PmMaxVersionExceededMode } from "../core/extensions/extension-types.js";
import {
  normalizeKnownExtensionCapability,
  resolveLegacyExtensionCapabilityAlias,
} from "../core/extensions/extension-capability-aliases.js";
import { normalizeCommandName } from "../core/extensions/extension-runtime-helpers.js";
import {
  evaluatePmMaxVersionBound,
  evaluatePmMinVersionBound,
  type PmVersionBoundEvaluation,
  type PmVersionBoundKind,
} from "../core/extensions/version-compat.js";

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
   * {@link defineExtensionManifest} for full contract checking at the definition
   * site.
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
 * Typed identity helper for a (partial) {@link ExtensionBlueprint} authored as its
 * own module — the typed entry point of the modular declarative-authoring loop.
 *
 * It is the natural companion to {@link mergeExtensionBlueprints}: when an
 * extension's surface is split across files — a commands module, a search module,
 * a hooks module — wrap each fragment so it is contract-checked *at its definition
 * site* (with editor completion), exactly as {@link defineExtension} types a whole
 * module and {@link defineExtensionManifest} types a manifest. It returns its
 * argument unchanged, preserving the literal type
 * so the fragment composes into {@link mergeExtensionBlueprints},
 * {@link composeExtension}, or {@link composeExtensionPackage} with no loss of
 * inference.
 *
 * Use as:
 * `export const commandsModule = defineExtensionBlueprint({ commands: [...] })`
 */
export function defineExtensionBlueprint<TBlueprint extends ExtensionBlueprint>(blueprint: TBlueprint): TBlueprint {
  return blueprint;
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
    // `?? {}` (rather than a `!== undefined` guard) so an explicit `hooks: null`
    // crossing an untyped boundary (e.g. a blueprint hydrated from JSON) is
    // treated the same as omitting it, instead of throwing on the first
    // `hooks.beforeCommand` access.
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
 * Concatenate the populated entries of an array surface across blueprints,
 * preserving argument order. Returns `undefined` when no blueprint contributes
 * any entry, so {@link mergeExtensionBlueprints} omits the field instead of
 * emitting an empty array. `?? []` tolerates an explicit `null` field (e.g. from a
 * blueprint hydrated across an untyped boundary) exactly as {@link composeExtension} does.
 */
function mergeArraySurface<TValue>(
  surfaces: ReadonlyArray<readonly TValue[] | null | undefined>,
): TValue[] | undefined {
  const merged = surfaces.flatMap((surface) => surface ?? []);
  return merged.length > 0 ? merged : undefined;
}

/**
 * Shallow-merge single-handler record surfaces (`commandOverrides`, `parsers`,
 * `renderers`, `services`) with last-defined-wins precedence on a key collision,
 * exactly like spreading the records in argument order. Returns `undefined` when
 * no blueprint contributes any key.
 */
function mergeHandlerRecord<TRecord extends object>(
  surfaces: ReadonlyArray<TRecord | null | undefined>,
): TRecord | undefined {
  const merged = Object.assign({}, ...surfaces.map((surface) => surface ?? {})) as TRecord;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge `flags` records by concatenating every blueprint's flag array for a shared
 * target command, mirroring the additive `api.registerFlags` semantics so each
 * module's flags reach the command. Returns `undefined` when no blueprint declares
 * any flags.
 */
function mergeFlagRecord(
  surfaces: ReadonlyArray<Record<string, FlagDefinition[]> | null | undefined>,
): Record<string, FlagDefinition[]> | undefined {
  const merged: Record<string, FlagDefinition[]> = {};
  for (const surface of surfaces) {
    for (const [command, flags] of Object.entries(surface ?? {})) {
      // `flags` is the record's array value, never nullish in-type — `composeExtension`
      // likewise passes it to `registerFlags` unguarded — so it is spread directly.
      merged[command] = [...(merged[command] ?? []), ...flags];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

const EXTENSION_BLUEPRINT_HOOK_KEYS = [
  "beforeCommand",
  "afterCommand",
  "onWrite",
  "onRead",
  "onIndex",
] as const satisfies ReadonlyArray<keyof ExtensionBlueprintHooks>;

type ExtensionBlueprintHookKey = (typeof EXTENSION_BLUEPRINT_HOOK_KEYS)[number];
type MissingExtensionBlueprintHookKeys = Exclude<keyof ExtensionBlueprintHooks, ExtensionBlueprintHookKey>;
type ExtraExtensionBlueprintHookKeys = Exclude<ExtensionBlueprintHookKey, keyof ExtensionBlueprintHooks>;

// Compile-time exhaustiveness guard: adding a hook field must update the canonical
// merge order above, and stale keys cannot remain in that list.
const EXTENSION_BLUEPRINT_HOOK_KEY_COVERAGE: Record<
  MissingExtensionBlueprintHookKeys | ExtraExtensionBlueprintHookKeys,
  never
> = {};
void EXTENSION_BLUEPRINT_HOOK_KEY_COVERAGE;

type ExtensionBlueprintHookArray<TKey extends keyof ExtensionBlueprintHooks> = NonNullable<ExtensionBlueprintHooks[TKey]>;
type ExtensionBlueprintHookValue<TKey extends keyof ExtensionBlueprintHooks> = ExtensionBlueprintHookArray<TKey>[number];

function assignMergedHookSurface<TKey extends keyof ExtensionBlueprintHooks>(
  merged: ExtensionBlueprintHooks,
  surfaces: ReadonlyArray<ExtensionBlueprintHooks | null | undefined>,
  key: TKey,
): void {
  const hookArrays = surfaces.map((hooks) => hooks?.[key]) as ReadonlyArray<
    ExtensionBlueprintHookArray<TKey> | null | undefined
  >;
  const value = mergeArraySurface<ExtensionBlueprintHookValue<TKey>>(hookArrays);
  if (value !== undefined) {
    const typedMerged = merged as { [K in TKey]?: ExtensionBlueprintHookArray<K> };
    typedMerged[key] = value as ExtensionBlueprintHookArray<TKey>;
  }
}

/**
 * Merge the nested `hooks` surface by concatenating each lifecycle kind's array in
 * canonical order. Returns `undefined` when no blueprint registers any hook.
 */
function mergeHookSurfaces(
  surfaces: ReadonlyArray<ExtensionBlueprintHooks | null | undefined>,
): ExtensionBlueprintHooks | undefined {
  const merged: ExtensionBlueprintHooks = {};
  for (const key of EXTENSION_BLUEPRINT_HOOK_KEYS) {
    assignMergedHookSurface(merged, surfaces, key);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge several partial {@link ExtensionBlueprint}s into one, so an extension's
 * surface can be authored *modularly* — a commands module, a search module, a
 * hooks module — and combined into a single blueprint to feed
 * {@link composeExtension}, {@link composeExtensionPackage},
 * {@link synthesizeExtensionManifest}, {@link describeExtensionBlueprint}, or
 * {@link preflightExtension}.
 *
 * The merge is pure and deterministic and never mutates an input. Each surface
 * combines the way its underlying `api.register*` call composes:
 *
 * - **Array surfaces** — `commands`, `preflights`, `itemTypes`, `itemFields`,
 *   `migrations`, `searchProviders`, `vectorStoreAdapters`, `importers`,
 *   `exporters` — concatenate in argument order.
 * - **`flags`** concatenates the flag arrays of any shared target command,
 *   mirroring additive `api.registerFlags`: every module's flags reach the command.
 * - **Single-handler records** — `commandOverrides`, `parsers`, `renderers`,
 *   `services` — follow last-defined-wins precedence on a key collision, exactly
 *   like spreading the records in argument order; a later module deliberately
 *   overrides an earlier one's handler for that key.
 * - **`hooks`** concatenates each lifecycle kind's array in canonical order.
 * - The imperative **`activate`** escape hatches chain in argument order (each
 *   awaited), so every module's escape-hatch wiring still runs.
 * - The **`deactivate`** teardown hooks chain in *reverse* argument order (LIFO),
 *   releasing resources in the inverse of acquisition. Teardown is best-effort:
 *   a throwing hook does not strand later modules' cleanup — every hook runs and
 *   teardown failures are re-thrown afterwards (as the original error for one
 *   failure, or an `AggregateError` for several).
 * - The **`manifest`** mirror is last-defined-wins.
 *
 * Because `composeExtension` and the derive/lint/describe helpers are pure readers
 * of this data, a merged blueprint behaves exactly as a hand-written one: a command
 * two modules both define survives as a duplicate in the merged `commands` array
 * and {@link lintExtensionBlueprint} flags it, just as it would in one file. An
 * empty field is omitted rather than emitted empty, so merging zero blueprints
 * returns an empty blueprint (`{}`).
 */
export function mergeExtensionBlueprints(...blueprints: ExtensionBlueprint[]): ExtensionBlueprint {
  const merged: ExtensionBlueprint = {};
  const assign = <TKey extends keyof ExtensionBlueprint>(key: TKey, value: ExtensionBlueprint[TKey]): void => {
    if (value !== undefined) {
      merged[key] = value;
    }
  };
  assign("commands", mergeArraySurface(blueprints.map((blueprint) => blueprint.commands)));
  assign("commandOverrides", mergeHandlerRecord(blueprints.map((blueprint) => blueprint.commandOverrides)));
  assign("flags", mergeFlagRecord(blueprints.map((blueprint) => blueprint.flags)));
  assign("parsers", mergeHandlerRecord(blueprints.map((blueprint) => blueprint.parsers)));
  assign("renderers", mergeHandlerRecord(blueprints.map((blueprint) => blueprint.renderers)));
  assign("services", mergeHandlerRecord(blueprints.map((blueprint) => blueprint.services)));
  assign("preflights", mergeArraySurface(blueprints.map((blueprint) => blueprint.preflights)));
  assign("itemTypes", mergeArraySurface(blueprints.map((blueprint) => blueprint.itemTypes)));
  assign("itemFields", mergeArraySurface(blueprints.map((blueprint) => blueprint.itemFields)));
  assign("migrations", mergeArraySurface(blueprints.map((blueprint) => blueprint.migrations)));
  assign("searchProviders", mergeArraySurface(blueprints.map((blueprint) => blueprint.searchProviders)));
  assign("vectorStoreAdapters", mergeArraySurface(blueprints.map((blueprint) => blueprint.vectorStoreAdapters)));
  assign("importers", mergeArraySurface(blueprints.map((blueprint) => blueprint.importers)));
  assign("exporters", mergeArraySurface(blueprints.map((blueprint) => blueprint.exporters)));
  assign("hooks", mergeHookSurfaces(blueprints.map((blueprint) => blueprint.hooks)));
  // Last-defined-wins for the in-module manifest mirror: a later module's identity
  // supersedes an earlier one's, matching the single-handler record precedence.
  let manifest: ExtensionManifest | undefined;
  for (const blueprint of blueprints) {
    if (blueprint.manifest) {
      manifest = blueprint.manifest;
    }
  }
  assign("manifest", manifest);
  // Imperative escape hatches chain forward (acquisition order); teardown chains
  // in reverse (LIFO), so resources release in the inverse of acquisition.
  const hasActivates = blueprints.some((blueprint) => blueprint.activate);
  assign(
    "activate",
    hasActivates
      ? async (api: ExtensionApi): Promise<void> => {
          for (const blueprint of blueprints) {
            if (blueprint.activate) {
              await blueprint.activate(api);
            }
          }
        }
      : undefined,
  );
  const hasDeactivates = blueprints.some((blueprint) => blueprint.deactivate);
  assign(
    "deactivate",
    hasDeactivates
      ? async (): Promise<void> => {
          // Teardown is best-effort across modules: a throwing `deactivate` must
          // not strand a later module's cleanup, so every hook runs (in reverse,
          // LIFO) and failures are surfaced after cleanup completes.
          const errors: unknown[] = [];
          for (const blueprint of [...blueprints].reverse()) {
            if (!blueprint.deactivate) {
              continue;
            }
            try {
              await blueprint.deactivate();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            if (errors.length > 1) {
              throw new AggregateError(errors, "Multiple extension blueprint deactivate hooks failed.");
            }
            throw errors[0];
          }
        }
      : undefined,
  );
  return merged;
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

/**
 * The author-supplied identity fields {@link synthesizeExtensionManifest} cannot
 * derive from a blueprint: every {@link ExtensionManifest} field except the
 * generated `capabilities`.
 *
 * The blueprint determines `capabilities` (the surfaces it registers) and nothing
 * else, so `name`/`version`/`entry`/`priority` and any optional metadata
 * (engines, permissions, provenance, version floors/ceilings, sandbox profile,
 * manifest version, activation, legacy aliases) are the author's to supply here.
 */
export interface SynthesizeExtensionManifestIdentity extends Omit<ExtensionManifest, "capabilities"> {
  /**
   * Extra capabilities to grant beyond the blueprint's derived set, for surfaces
   * registered through the blueprint's imperative `activate` escape hatch that
   * static derivation cannot see (e.g. a renderer wired in `activate`). Each is
   * legacy-alias resolved and normalized like a declared manifest capability;
   * unknown names are dropped (the synthesized manifest is validated at load).
   */
  additionalCapabilities?: readonly string[];
}

/**
 * Generate a complete, least-privilege {@link ExtensionManifest} from a
 * declarative {@link ExtensionBlueprint} and the author's identity fields.
 *
 * This is the *generate* verb that completes the declarative authoring loop
 * (`compose → derive → describe/lint → synthesize`). Where
 * {@link defineExtensionManifest} only *types* a hand-written manifest and
 * {@link deriveExtensionCapabilities} computes only the capability set, this
 * function assembles the whole manifest: it copies every author-supplied identity
 * field verbatim and fills `capabilities` with `deriveExtensionCapabilities`
 * unioned with any {@link SynthesizeExtensionManifestIdentity.additionalCapabilities | additionalCapabilities},
 * sorted and de-duplicated. The author writes the blueprint once and never
 * hand-syncs `manifest.capabilities` — declaring nothing the extension does not
 * use and nothing it does.
 *
 * It is a pure assembler: it neither validates the blueprint definitions (that
 * stays in `api.register*` at activation) nor the identity fields (the loader
 * validates the on-disk manifest). Pair it with
 * {@link ../sdk/testing.js#assertExtensionManifestMatchesBlueprint} to guard a
 * hand-maintained `manifest.json` against drift in CI.
 */
export function synthesizeExtensionManifest(
  blueprint: ExtensionBlueprint,
  identity: SynthesizeExtensionManifestIdentity,
): ExtensionManifest {
  const { additionalCapabilities, ...manifestIdentity } = identity;
  // `Array.isArray` keeps a non-array value (or an omitted field) crossing an
  // untyped boundary from crashing the spread, mirroring the rest of the SDK.
  const extra = Array.isArray(additionalCapabilities) ? normalizeDeclaredCapabilities(additionalCapabilities) : [];
  const capabilities = [...new Set<ExtensionCapability>([...deriveExtensionCapabilities(blueprint), ...extra])].sort(
    (left, right) => left.localeCompare(right),
  );
  return { ...manifestIdentity, capabilities };
}

/**
 * The two generated halves of a shippable extension package, returned by
 * {@link composeExtensionPackage}.
 */
export interface ExtensionPackage {
  /**
   * The runtime {@link ExtensionModule} to export as the package entry's default
   * export. Its `manifest` mirror is set to the same {@link ExtensionPackage.manifest}
   * object, so the in-module metadata and the on-disk manifest never diverge.
   */
  module: ExtensionModule;
  /**
   * The complete least-privilege {@link ExtensionManifest} to write as the
   * package's `manifest.json`, with `capabilities` derived from the blueprint.
   */
  manifest: ExtensionManifest;
}

/**
 * Assemble both halves of a shippable extension package from one declarative
 * {@link ExtensionBlueprint} and the author's identity fields — the author-once
 * capstone of the declarative loop.
 *
 * Where {@link composeExtension} produces only the runtime module and
 * {@link synthesizeExtensionManifest} produces only the manifest, this unifies
 * them: it synthesizes the complete least-privilege manifest from the blueprint
 * and identity, then composes the module with that synthesized manifest set as its
 * authoritative in-module `manifest` mirror. Both halves are therefore generated
 * from a single source and cannot drift — the module's `manifest` is the very
 * object returned as `manifest`. Export `module` as the package entry's default
 * export and write `manifest` as `manifest.json`.
 *
 * It is a pure assembler with no validation, loading, or filesystem access,
 * exactly like the two functions it composes; pair it with
 * {@link preflightExtension} (or {@link ../sdk/testing.js#assertExtensionPreflight})
 * for the author-time verify step. Use {@link mergeExtensionBlueprints} first to
 * assemble the blueprint modularly, then this to ship it.
 */
export function composeExtensionPackage(
  blueprint: ExtensionBlueprint,
  identity: SynthesizeExtensionManifestIdentity,
): ExtensionPackage {
  const manifest = synthesizeExtensionManifest(blueprint, identity);
  const module = composeExtension({ ...blueprint, manifest });
  return { module, manifest };
}

/**
 * The target a {@link checkExtensionManifestCompatibility} call evaluates a
 * manifest's version bounds against.
 */
export interface ExtensionManifestCompatibilityTarget {
  /**
   * The pm CLI version to check the manifest against, e.g. the running CLI's
   * `version` or a version floor a package commits to supporting. Plain
   * dotted-numeric (`2026.6.23`) or `v`-prefixed values are compared; anything
   * uninterpretable yields an `unchecked` finding rather than a false verdict.
   */
  pmVersion: string;
  /**
   * How a `pm_max_version` overrun is treated, mirroring the runtime
   * `extensions.policy.pm_max_version_exceeded_mode`. `"block"` (the default)
   * reports an exceeded upper bound as a blocking incompatibility; `"warn"`
   * reports it as a non-blocking advisory, matching an operator who relaxed the
   * gate during a CLI upgrade window.
   */
  pmMaxVersionExceededMode?: PmMaxVersionExceededMode;
}

/**
 * The manifest fields {@link checkExtensionManifestCompatibility} evaluates.
 *
 * Values are intentionally `unknown` rather than `string` so an author can
 * preflight the same malformed blank/non-string bounds (e.g. read from a JSON
 * manifest) the loader's manifest parser rejects as `extension_manifest_invalid`.
 */
export interface ExtensionManifestCompatibilityManifest {
  /** Inclusive lower pm CLI version bound from `manifest.json`. */
  pm_min_version?: unknown;
  /** Inclusive upper pm CLI version bound from `manifest.json`. */
  pm_max_version?: unknown;
}

/**
 * The machine-readable kind of an {@link ExtensionManifestCompatibilityFinding},
 * one per `<bound>_<outcome>` the loader can reach. Each mirrors a loader
 * `extension_pm_*_version_*` warning: `*_invalid`/`*_unmet`/`*_exceeded` block the
 * load, while `*_unchecked`/`*_exceeded_warn` are advisory (the extension still
 * loads).
 */
export type ExtensionManifestCompatibilityCode =
  | "pm_min_version_invalid"
  | "pm_min_version_unchecked"
  | "pm_min_version_unmet"
  | "pm_max_version_invalid"
  | "pm_max_version_unchecked"
  | "pm_max_version_exceeded"
  | "pm_max_version_exceeded_warn";

/**
 * A single version-bound issue {@link checkExtensionManifestCompatibility} found
 * when evaluating a manifest against a target pm version.
 */
export interface ExtensionManifestCompatibilityFinding {
  /** The machine-readable {@link ExtensionManifestCompatibilityCode} for programmatic handling. */
  code: ExtensionManifestCompatibilityCode;
  /** `error` when the bound blocks the load against the target version, `warning` when it is advisory. */
  severity: "error" | "warning";
  /** Which manifest bound produced the finding. */
  constraint: PmVersionBoundKind;
  /** The declared bound value, verbatim. */
  required: string;
  /** The target pm version the bound was evaluated against. */
  current: string;
  /** Human-readable explanation of the outcome and its effect on loading. */
  message: string;
}

/**
 * The structured result of {@link checkExtensionManifestCompatibility}.
 */
export interface ExtensionManifestCompatibilityResult {
  /** `true` when no `error`-severity finding blocks the load against the target version. */
  compatible: boolean;
  /** Every bound finding, lower bound before upper bound; empty when both bounds are absent or satisfied. */
  findings: ExtensionManifestCompatibilityFinding[];
  /** The target pm version the manifest was checked against, echoed back for messaging. */
  pmVersion: string;
}

/** Map a non-trivial bound evaluation to a compatibility finding, or `null` when the bound is absent or satisfied. */
function toCompatibilityFinding(
  evaluation: PmVersionBoundEvaluation,
  pmVersion: string,
): ExtensionManifestCompatibilityFinding | null {
  if (evaluation.status === "absent" || evaluation.status === "ok") {
    return null;
  }
  const code = `${evaluation.kind}_${evaluation.status}` as ExtensionManifestCompatibilityCode;
  let message: string;
  switch (code) {
    case "pm_min_version_invalid":
      message = `pm_min_version "${evaluation.required}" is not a valid version; the extension is treated as incompatible and the loader skips it.`;
      break;
    case "pm_min_version_unchecked":
      message = `pm_min_version "${evaluation.required}" could not be compared against pm ${pmVersion}; compatibility is unverified.`;
      break;
    case "pm_min_version_unmet":
      message = `Requires pm >= ${evaluation.required} but the target is pm ${pmVersion}; the loader skips the extension.`;
      break;
    case "pm_max_version_invalid":
      message = `pm_max_version "${evaluation.required}" is not a valid inclusive upper bound (version ranges are not allowed); the extension is treated as incompatible and the loader skips it.`;
      break;
    case "pm_max_version_unchecked":
      message = `pm_max_version "${evaluation.required}" could not be compared against pm ${pmVersion}; compatibility is unverified.`;
      break;
    case "pm_max_version_exceeded":
      message = `Allows pm <= ${evaluation.required} but the target is pm ${pmVersion}; the loader skips the extension.`;
      break;
    case "pm_max_version_exceeded_warn":
      message = `Target pm ${pmVersion} is newer than pm_max_version ${evaluation.required}, but the "warn" exceeded mode lets it load with a warning.`;
      break;
  }
  return {
    code,
    severity: evaluation.allowed ? "warning" : "error",
    constraint: evaluation.kind,
    required: evaluation.required,
    current: pmVersion,
    message,
  };
}

/**
 * Check, without loading anything, whether an extension manifest's declared
 * version bounds permit it to load on a given pm CLI version.
 *
 * This is the author-time inverse of the loader's runtime version gate: where the
 * loader resolves the *installed* CLI version (asynchronously, from `package.json`)
 * and emits `extension_pm_*_version_*` warnings, this pure synchronous function
 * takes the {@link ExtensionManifestCompatibilityTarget.pmVersion | target version}
 * the author supplies and returns structured findings. Both share the
 * {@link ../core/extensions/version-compat.js | version-compat core}, so the
 * author-time verdict and the runtime decision agree by construction — a package
 * author can pin a CI test to the pm version they support and catch a too-tight
 * `pm_min_version`, a malformed `pm_max_version`, or an upper bound a newer CLI
 * would exceed, long before publishing.
 *
 * `compatible` is `true` only when no bound blocks the load (`*_invalid`,
 * `*_unmet`, and a `block`-mode `*_exceeded`); `*_unchecked` (an uninterpretable
 * bound or target) and a `warn`-mode `*_exceeded_warn` are advisory `warning`
 * findings that still load. Pair it with
 * {@link ../sdk/testing.js#assertExtensionManifestCompatible} to fail CI on a
 * blocking incompatibility.
 */
export function checkExtensionManifestCompatibility(
  manifest: ExtensionManifestCompatibilityManifest,
  target: ExtensionManifestCompatibilityTarget,
): ExtensionManifestCompatibilityResult {
  const minEvaluation = evaluatePmMinVersionBound(manifest.pm_min_version, target.pmVersion);
  const maxEvaluation = evaluatePmMaxVersionBound(
    manifest.pm_max_version,
    target.pmVersion,
    target.pmMaxVersionExceededMode ?? "block",
  );
  const findings: ExtensionManifestCompatibilityFinding[] = [];
  const minFinding = toCompatibilityFinding(minEvaluation, target.pmVersion);
  if (minFinding !== null) {
    findings.push(minFinding);
  }
  const maxFinding = toCompatibilityFinding(maxEvaluation, target.pmVersion);
  if (maxFinding !== null) {
    findings.push(maxFinding);
  }
  return {
    compatible: minEvaluation.allowed && maxEvaluation.allowed,
    findings,
    pmVersion: target.pmVersion,
  };
}

/**
 * The lint codes whose verdict depends on the *declared* capability set rather
 * than the blueprint's structure. {@link preflightExtension} drops these from its
 * consolidated view when it synthesizes the manifest from an `identity` without an
 * explicit declared set, because the synthesized manifest — not the blueprint's
 * stale in-module `manifest` mirror — is what the package ships, so a drift against
 * the mirror is a false positive. Structural codes (`duplicate_command`,
 * `command_override_conflict`, `empty_surface`) are never suppressed.
 */
const CAPABILITY_DRIFT_LINT_CODES = new Set<ExtensionBlueprintLintCode>([
  "capability_undeclared",
  "capability_unused",
  "manifest_capabilities_absent",
]);

/**
 * Options for {@link preflightExtension} and
 * {@link ../sdk/testing.js#assertExtensionPreflight}. Every field is optional:
 * each one a check enables, so an author opts into exactly the stages whose
 * inputs they can supply.
 */
export interface PreflightExtensionOptions {
  /**
   * The author-supplied identity fields the blueprint cannot determine
   * (`name`/`version`/`entry`/`priority`, version bounds, etc.). Provide them to
   * have preflight {@link synthesizeExtensionManifest | synthesize} the complete
   * least-privilege manifest and include it in the report; the synthesized
   * version bounds then feed the {@link PreflightExtensionOptions.target | target}
   * compatibility check. Omit to skip manifest synthesis.
   */
  identity?: SynthesizeExtensionManifestIdentity;
  /**
   * The pm CLI version (and optional max-version overrun mode) to evaluate the
   * manifest's `pm_min_version`/`pm_max_version` bounds against. Provide it to run
   * {@link checkExtensionManifestCompatibility} against the synthesized manifest
   * (or, absent an `identity`, the blueprint's in-module `manifest` mirror). Omit
   * to skip the version-compatibility check.
   */
  target?: ExtensionManifestCompatibilityTarget;
  /**
   * The capabilities the package's `manifest.json` declares, reconciled against
   * the surfaces the blueprint exercises. Passed straight to
   * {@link lintExtensionBlueprint}; when omitted it falls back to
   * `blueprint.manifest.capabilities`, so the blueprint's in-module mirror is
   * linted by default.
   */
  declaredCapabilities?: readonly string[];
}

/** Which preflight stage produced an {@link ExtensionPreflightFinding}. */
export type ExtensionPreflightFindingSource = "blueprint" | "compatibility";

/**
 * A single finding in an {@link ExtensionPreflightReport}, flattened from one of
 * the underlying stages and tagged with its {@link ExtensionPreflightFindingSource}
 * so a consolidated report stays traceable to the check that raised it.
 */
export interface ExtensionPreflightFinding {
  /** The stage that produced the finding: blueprint lint or version compatibility. */
  source: ExtensionPreflightFindingSource;
  /** Whether the finding blocks publish/activation (`error`) or is advisory (`warning`). */
  severity: ExtensionBlueprintLintSeverity;
  /** The underlying stage's machine-readable code, for programmatic handling. */
  code: ExtensionBlueprintLintCode | ExtensionManifestCompatibilityCode;
  /** The underlying stage's human-readable explanation, verbatim. */
  message: string;
}

/**
 * The consolidated result of {@link preflightExtension}: every author-time stage's
 * structured output plus a flattened, source-tagged finding list.
 */
export interface ExtensionPreflightReport {
  /** `true` when no `error`-severity finding appears across any stage (warnings still pass). */
  ok: boolean;
  /** The least-privilege capability set the blueprint exercises (from {@link deriveExtensionCapabilities}). */
  capabilities: ExtensionCapability[];
  /** The full {@link lintExtensionBlueprint} result (structural + capability-drift findings). */
  blueprint: ExtensionBlueprintLintResult;
  /** The manifest synthesized from `options.identity`, or `null` when no identity was supplied. */
  manifest: ExtensionManifest | null;
  /** The {@link checkExtensionManifestCompatibility} result, or `null` when no `options.target` was supplied. */
  compatibility: ExtensionManifestCompatibilityResult | null;
  /**
   * Every finding from all stages, blueprint-lint findings before compatibility
   * findings, each tagged by `source`. This is the consolidated, curated view: when
   * `options.identity` synthesizes the manifest without an explicit
   * `declaredCapabilities` set, capability-drift findings the lint raised against the
   * blueprint's now-superseded in-module `manifest` mirror are omitted here (the raw
   * `blueprint` result still carries them).
   */
  findings: ExtensionPreflightFinding[];
}

/**
 * Preflight a declarative {@link ExtensionBlueprint} through every author-time
 * check in one call, returning a single consolidated {@link ExtensionPreflightReport}.
 *
 * This is the author-time capstone — the static analog of
 * {@link ../sdk/testing.js#createExtensionTestHarness}, which unified the
 * runtime-test helpers. Instead of chaining {@link lintExtensionBlueprint},
 * {@link synthesizeExtensionManifest}, and {@link checkExtensionManifestCompatibility}
 * (and reconciling their separate results) before publishing a package, an author
 * runs `preflightExtension(blueprint, { identity, target })` and reads one report:
 *
 * - the blueprint is always linted (structural footguns + capability drift);
 * - when `options.identity` is given, the complete least-privilege manifest is
 *   synthesized and returned, so the author never hand-syncs `capabilities`;
 * - when `options.target` is given, the synthesized manifest's version bounds
 *   (or, absent an identity, the blueprint's in-module `manifest` mirror) are
 *   checked against that pm version.
 *
 * It is pure and side-effect-free — no loading, activation, or filesystem access,
 * exactly like the stages it composes — so it is safe in any author-time or CI
 * context. The per-stage structured results are exposed unmodified
 * (`report.blueprint`/`manifest`/`compatibility`) alongside the flattened,
 * source-tagged `report.findings`; `report.ok` is `false` if any stage produced an
 * `error`-severity finding. The flattened `findings` are curated for the author-once
 * flow: once an `identity` synthesizes the manifest (and no explicit
 * `declaredCapabilities` was pinned), the synthesized manifest — not the blueprint's
 * in-module `manifest` mirror — is what ships, so capability-drift findings the lint
 * raised against that mirror are false positives and are omitted from
 * `report.findings` (the raw `report.blueprint` result still reports them). Pair it
 * with {@link ../sdk/testing.js#assertExtensionPreflight} to fail CI in one line.
 */
export function preflightExtension(
  blueprint: ExtensionBlueprint,
  options: PreflightExtensionOptions = {},
): ExtensionPreflightReport {
  const blueprintResult = lintExtensionBlueprint(blueprint, { declaredCapabilities: options.declaredCapabilities });
  const manifest = options.identity ? synthesizeExtensionManifest(blueprint, options.identity) : null;
  // Compatibility evaluates the bounds the package will ship: the synthesized
  // manifest when an identity drives generation, else the blueprint's in-module
  // manifest mirror, else an empty manifest (no bounds → trivially compatible).
  const compatibility = options.target
    ? checkExtensionManifestCompatibility(manifest ?? blueprint.manifest ?? {}, options.target)
    : null;
  // When preflight synthesizes the manifest from an identity (and the caller did not
  // pin an explicit declaredCapabilities set), the blueprint lint reconciled against
  // the blueprint's in-module `manifest` mirror — which the synthesized manifest
  // supersedes. Capability-drift findings against that stale mirror are false
  // positives in the consolidated view (a missing capability would even flip `ok` to
  // false though the synthesized manifest declares it), so drop them; structural
  // findings are unaffected and the raw lint result on `report.blueprint` keeps all of
  // them. An explicit declaredCapabilities set is a deliberate "check exactly this"
  // request, so it is never suppressed.
  const suppressCapabilityDrift = manifest !== null && options.declaredCapabilities === undefined;
  const blueprintFindings = suppressCapabilityDrift
    ? blueprintResult.findings.filter((finding) => !CAPABILITY_DRIFT_LINT_CODES.has(finding.code))
    : blueprintResult.findings;
  const findings: ExtensionPreflightFinding[] = [
    ...blueprintFindings.map(
      (finding): ExtensionPreflightFinding => ({
        source: "blueprint",
        severity: finding.severity,
        code: finding.code,
        message: finding.message,
      }),
    ),
    ...(compatibility?.findings ?? []).map(
      (finding): ExtensionPreflightFinding => ({
        source: "compatibility",
        severity: finding.severity,
        code: finding.code,
        message: finding.message,
      }),
    ),
  ];
  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    capabilities: blueprintResult.used,
    blueprint: blueprintResult,
    manifest,
    compatibility,
    findings,
  };
}
