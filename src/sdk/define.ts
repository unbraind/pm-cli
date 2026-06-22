/**
 * @module sdk/define
 *
 * Authoring-time typed builders for every extension registration surface.
 *
 * These `define*` helpers are the third leg of the SDK ergonomics tripod:
 * {@link ../core/extensions/loader.js#ExtensionApi | `api.register*`} registers
 * a definition at activation, the `assert*`/`run*` testing helpers verify and
 * invoke it, and these builders let authors *write* the definition with full
 * type-checking and editor inference before it ever reaches `activate`.
 *
 * Every builder is a zero-cost identity function that returns its argument
 * unchanged — exactly like the SDK's {@link ./index.js#defineExtension} and the
 * wider `defineConfig`/`defineComponent` ecosystem convention. Their value is
 * entirely at the type level:
 *
 * - In plain-JavaScript packages (the documented norm — `pm package init`
 *   scaffolds `.js`) authors cannot write TypeScript annotations, so a bare
 *   `const cmd = { ... }` is unchecked. `const cmd = defineCommand({ ... })`
 *   restores full contract checking and contextual parameter inference for the
 *   nested handler through the editor's TypeScript language service.
 * - Definitions can be colocated, exported, reused, and unit-tested apart from
 *   the `activate` call instead of being trapped as inline literals.
 *
 * Object-definition builders use a generic constraint (`<T extends Def>`) so the
 * narrow literal type survives the round-trip, mirroring `defineExtension`.
 * Function-definition builders are intentionally non-generic: a generic
 * constrained to a whole function type suppresses contextual typing of a bare
 * arrow's parameter (it would fall back to implicit `any` in `.js`), whereas the
 * non-generic signature lets TypeScript type the handler parameter from the
 * declared function type.
 */
import type {
  AfterCommandHook,
  BeforeCommandHook,
  CommandDefinition,
  CommandOverride,
  Exporter,
  FlagDefinition,
  Importer,
  OnIndexHook,
  OnReadHook,
  OnWriteHook,
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
 * Type a command definition for `api.registerCommand(definition)`.
 *
 * Checks the object against {@link CommandDefinition} and infers the `run`
 * handler's `context` parameter while preserving the literal `name`/`action`
 * types. Pass the result straight to `registerCommand`, or export it so the
 * command can be invoked in tests via `runRegisteredCommandForTest`.
 */
export function defineCommand<TDefinition extends CommandDefinition>(definition: TDefinition): TDefinition {
  return definition;
}

/**
 * Type a single flag definition for a `api.registerFlags(command, flags)` array.
 *
 * Authors compose builders into the array
 * (`registerFlags("list", [defineFlag({ long: "--mine" })])`) to get
 * per-flag contract checking — `value_type`, `list`, and `default` included —
 * instead of validating a loosely-typed literal array all at once.
 */
export function defineFlag<TFlag extends FlagDefinition>(flag: TFlag): TFlag {
  return flag;
}

/**
 * Type a custom item-type definition for `api.registerItemTypes([...])`.
 *
 * Preserves the literal `name`/`folder`/`aliases` so a project archetype's
 * domain types stay strongly typed where the definition is declared and reused.
 */
export function defineItemType<TType extends SchemaItemTypeDefinition>(type: TType): TType {
  return type;
}

/**
 * Type a custom front-matter field definition for `api.registerItemFields([...])`.
 *
 * Checks `name`/`type`/`optional` against {@link SchemaFieldDefinition} while
 * keeping the field's extra metadata (the contract carries an index signature)
 * intact.
 */
export function defineItemField<TField extends SchemaFieldDefinition>(field: TField): TField {
  return field;
}

/**
 * Type a schema migration definition for `api.registerMigration(definition)`.
 *
 * Infers the `run` migration runner's context and preserves the literal `id`,
 * so the same definition can be registered and later exercised through
 * `runRegisteredMigrationForTest`.
 */
export function defineMigration<TMigration extends SchemaMigrationDefinition>(migration: TMigration): TMigration {
  return migration;
}

/**
 * Type a search-provider definition for `api.registerSearchProvider(provider)`.
 *
 * Infers the `query`/`embed`/`embedBatch` operation contexts and result shapes
 * so a custom retrieval backend is type-checked at the definition site and
 * reusable in `runRegisteredSearchProviderForTest`.
 */
export function defineSearchProvider<TProvider extends SearchProviderDefinition>(provider: TProvider): TProvider {
  return provider;
}

/**
 * Type a vector-store adapter definition for `api.registerVectorStoreAdapter(adapter)`.
 *
 * Infers the `query`/`upsert`/`delete` operation contexts so a package that owns
 * its own semantic index storage gets contract checking before activation and a
 * definition it can drive through `runRegisteredVectorStoreAdapterForTest`.
 */
export function defineVectorStoreAdapter<TAdapter extends VectorStoreAdapterDefinition>(adapter: TAdapter): TAdapter {
  return adapter;
}

/**
 * Type a command-override handler for `api.registerCommand(command, override)`.
 *
 * The non-generic signature lets TypeScript contextually type the override's
 * `context` parameter from {@link CommandOverride}, so a bare arrow authored in
 * a `.js` package still gets a fully-typed argument.
 */
export function defineCommandOverride(override: CommandOverride): CommandOverride {
  return override;
}

/**
 * Type a parser-override handler for `api.registerParser(command, override)`.
 *
 * Contextually types the `context` parameter and the returned
 * {@link ParserOverride} delta so an argument-rewriting override is checked
 * where it is written.
 */
export function defineParserOverride(override: ParserOverride): ParserOverride {
  return override;
}

/**
 * Type a preflight-override handler for `api.registerPreflight(override)`.
 *
 * Contextually types the `context` parameter and the returned gate decision so a
 * package's pre-run validation override is checked at the definition site.
 */
export function definePreflightOverride(override: PreflightOverride): PreflightOverride {
  return override;
}

/**
 * Type a service-override handler for `api.registerService(service, override)`.
 *
 * Contextually types the `context` parameter from {@link ServiceOverride} so a
 * package overriding a built-in service (output formatting, embeddings, and the
 * like) keeps its handler argument typed even in plain JavaScript.
 */
export function defineServiceOverride(override: ServiceOverride): ServiceOverride {
  return override;
}

/**
 * Type a renderer-override handler for `api.registerRenderer(format, renderer)`.
 *
 * Contextually types the `context` parameter and the `string | null | undefined`
 * return contract so a custom output renderer is checked where it is authored.
 */
export function defineRendererOverride(renderer: RendererOverride): RendererOverride {
  return renderer;
}

/**
 * Type an importer handler for `api.registerImporter(name, importer, options)`.
 *
 * Contextually types the {@link Importer} `context` (registration, args,
 * options, pm root) so the bridge from an external system into the pm context
 * graph is type-checked and reusable in `runRegisteredImporterForTest`.
 */
export function defineImporter(importer: Importer): Importer {
  return importer;
}

/**
 * Type an exporter handler for `api.registerExporter(name, exporter, options)`.
 *
 * Contextually types the {@link Exporter} `context` so the bridge from the pm
 * context graph out to an external system is checked at the definition site and
 * reusable in `runRegisteredExporterForTest`.
 */
export function defineExporter(exporter: Exporter): Exporter {
  return exporter;
}

/**
 * Type a `before_command` hook for `api.hooks.beforeCommand(hook)`.
 *
 * Contextually types the {@link BeforeCommandHook} `context` so a hook that
 * inspects or annotates a command before it runs keeps its argument typed when
 * authored as a standalone, exportable, testable value.
 */
export function defineBeforeCommandHook(hook: BeforeCommandHook): BeforeCommandHook {
  return hook;
}

/**
 * Type an `after_command` hook for `api.hooks.afterCommand(hook)`.
 *
 * Contextually types the {@link AfterCommandHook} `context` — including the
 * `affected` items pm mutated — so the natural place to react to every change
 * ("project management = context management") is checked where it is written.
 */
export function defineAfterCommandHook(hook: AfterCommandHook): AfterCommandHook {
  return hook;
}

/**
 * Type an `on_write` hook for `api.hooks.onWrite(hook)`.
 *
 * Contextually types the {@link OnWriteHook} `context` so a hook reacting to
 * item persistence keeps its argument typed in plain-JavaScript packages.
 */
export function defineOnWriteHook(hook: OnWriteHook): OnWriteHook {
  return hook;
}

/**
 * Type an `on_read` hook for `api.hooks.onRead(hook)`.
 *
 * Contextually types the {@link OnReadHook} `context` so a hook augmenting items
 * as they are read is type-checked at the definition site.
 */
export function defineOnReadHook(hook: OnReadHook): OnReadHook {
  return hook;
}

/**
 * Type an `on_index` hook for `api.hooks.onIndex(hook)`.
 *
 * Contextually types the {@link OnIndexHook} `context` so a hook participating
 * in index/search refresh keeps its argument typed even without TypeScript
 * annotations.
 */
export function defineOnIndexHook(hook: OnIndexHook): OnIndexHook {
  return hook;
}
