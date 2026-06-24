/**
 * @module cli/commands/extension/scaffold
 *
 * Implements extension package-management support for Scaffold.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";
import { normalizeManagedDirectoryName } from "./shared.js";

// Safe compatibility floor emitted into scaffolded manifests. Mirrors the
// first-party package manifests (pm-nf2q): every current 2026.5.x CLI
// satisfies it, and it models the field for external authors. manifest_version
// tracks the manifest schema generation (currently 1).
const SCAFFOLD_MANIFEST_VERSION = 1;
const SCAFFOLD_PM_MIN_VERSION = "2026.5.0";
const SCAFFOLD_NODE_ENGINE = ">=22.18.0";
const SCAFFOLD_DECLARED_PERMISSIONS = {
  fs_read: false,
  fs_write: false,
  network: false,
  env_read: false,
  env_write: false,
  process_spawn: false,
};

// TypeScript dev-dependency floor for scaffolded packages, matching the CLI's own
// toolchain so generated packages compile against the same compiler generation.
const SCAFFOLD_TYPESCRIPT_VERSION = "^6.0.0";

// `@types/node` floor for scaffolded packages: the colocated `index.test.ts`
// imports `node:test`/`node:assert`, which need Node's ambient type definitions
// to type-check. Pinned to the engines floor (Node >=22.18), matching the CLI
// itself — the version where Node strips TypeScript types on load by default.
const SCAFFOLD_TYPES_NODE_VERSION = "^22.0.0";

// Strict NodeNext tsconfig emitted into every scaffold (ADR pm-2c28 / pm-m1uz:
// extensions are authored AND loaded as TypeScript). It is a type-check-only
// config (`noEmit`): there is no compile step — pm loads the `./index.ts`
// manifest entry directly via Node's native type stripping (Node >=22.18), so
// no `.js` is emitted or committed. `allowImportingTsExtensions` lets the
// colocated `index.test.ts` import the sibling `./index.ts` entry with its real
// extension, exactly as Node resolves it at load time. NodeNext resolution keeps
// the module graph identical to the runtime loader.
const SCAFFOLD_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    // `node:test`/`node:assert` in the colocated test (and Node globals) resolve
    // from `@types/node`; name it explicitly so it is loaded regardless of how the
    // package manager lays out `node_modules/@types`.
    types: ["node"],
  },
  // Recursive so a package that grows into subdirectory `*.ts` modules still
  // type-checks; tsc excludes `node_modules` by default.
  include: ["**/*.ts"],
};

/**
 * Capability shapes the package/extension scaffolder can target via the
 * `--capability` selector. `commands` emits the default command-only starter;
 * `hooks` additionally wires an `after_command` lifecycle reactor, `search`
 * wires an in-memory provider/adapter pair, `importers` wires importer and
 * exporter command primitives so authors can customize project context movement,
 * and `schema` registers a custom item type, item field, and migration so
 * authors can model their own project domain — without starting from a blank
 * extension.
 */
export const SCAFFOLD_CAPABILITIES = ["commands", "hooks", "search", "importers", "schema"] as const;

/**
 * Restricts the `--capability` selector to a {@link SCAFFOLD_CAPABILITIES} value.
 */
export type ExtensionScaffoldCapability = (typeof SCAFFOLD_CAPABILITIES)[number];

const SCAFFOLD_MANIFEST_CAPABILITIES: Record<ExtensionScaffoldCapability, readonly string[]> = {
  commands: ["commands"],
  hooks: ["commands", "hooks"],
  search: ["commands", "search"],
  importers: ["commands", "schema", "importers"],
  schema: ["commands", "schema"],
};

const SAMPLE_TEST_CAPABILITIES_LITERAL: Record<ExtensionScaffoldCapability, string> = {
  commands: '["commands"]',
  hooks: '["commands", "hooks"]',
  search: '["commands", "search"]',
  importers: '["commands", "schema", "importers"]',
  schema: '["commands", "schema"]',
};

const ENTRYPOINT_BULLETS: Record<ExtensionScaffoldCapability, string> = {
  commands: "- `index.ts`: the TypeScript manifest entry — starter command registration plus a `deactivate` teardown stub.",
  hooks:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, an `after_command` lifecycle hook, and a `deactivate` teardown stub.",
  search:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a search provider, a vector-store adapter, and a `deactivate` teardown stub.",
  importers:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, importer/exporter command registrations, and a `deactivate` teardown stub.",
  schema:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a custom item type, a custom item field, a schema migration, and a `deactivate` teardown stub.",
};

const SAMPLE_TEST_BULLETS: Record<ExtensionScaffoldCapability, string> = {
  commands:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, and teardown via the SDK testing helpers.",
  hooks:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, the after_command hook, and teardown via the SDK testing helpers.",
  search:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, search provider/vector adapter invocation, and teardown via the SDK testing helpers.",
  importers:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, importer/exporter invocation, and teardown via the SDK testing helpers.",
  schema:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, item type/field/migration registration, migration invocation, and teardown via the SDK testing helpers.",
};

const TSCONFIG_BULLET = "- `tsconfig.json`: strict type-check-only TypeScript config (`noEmit`) for the `.ts` source the loader runs directly.";

const PACKAGE_CAPABILITY_README_SECTIONS: Record<ExtensionScaffoldCapability, readonly string[]> = {
  commands: [],
  hooks: [
    "",
    "## Lifecycle Hook",
    "`index.ts` registers an `after_command` hook via `api.hooks.afterCommand`.",
    "pm fires it once a command finishes, passing the command outcome and the",
    "items it mutated (`context.affected`). React there to keep external context",
    "in sync - sync records, emit telemetry, or refresh derived state. The",
    "`hooks` capability in `manifest.json` is what grants the hook registration;",
    "remove it (and the hook) if your package only needs commands.",
  ],
  search: [
    "",
    "## Search Provider",
    "`index.ts` registers a deterministic in-memory search provider and",
    "vector-store adapter through `api.registerSearchProvider` and",
    "`api.registerVectorStoreAdapter`. Replace the sample scoring,",
    "embedding, and storage behavior with your project-specific retrieval",
    "logic. The `search` capability in `manifest.json` grants both",
    "registrations.",
  ],
  importers: [
    "",
    "## Importer and Exporter",
    "`index.ts` registers paired project-context import/export commands through",
    "`api.registerImporter` and `api.registerExporter`. Replace the starter",
    "payloads with your domain adapter: GitHub issues, CSV rows, documents,",
    "tickets, or another project-management source of truth. The `importers`",
    "capability grants both registrations, and `schema` grants the example",
    "command flag metadata.",
  ],
  schema: [
    "",
    "## Custom Schema",
    "`index.ts` models a project domain by registering a custom item type, a",
    "custom item field, and a schema migration through `api.registerItemTypes`,",
    "`api.registerItemFields`, and `api.registerMigration`. This is how a package",
    "turns pm into a domain-specific tracker — `project management = context",
    "management`. Replace the sample type/field/migration with your own domain",
    "model; the `schema` capability in `manifest.json` grants all three",
    "registrations. Once installed, the custom type is usable everywhere, e.g.",
    "`pm create <type> \"<title>\"` and `pm list --type <type>`.",
  ],
};

const EXTENSION_CAPABILITY_README_SECTIONS: Record<ExtensionScaffoldCapability, readonly string[]> = {
  commands: [],
  hooks: [
    "",
    "## Lifecycle Hook",
    "`index.ts` registers an `after_command` hook via `api.hooks.afterCommand`.",
    "pm fires it once a command finishes, passing the command outcome and the",
    "items it mutated (`context.affected`). React there to keep external context",
    "in sync. The `hooks` capability in `manifest.json` grants the registration;",
    "remove it (and the hook) if your extension only needs commands.",
  ],
  search: [
    "",
    "## Search Provider",
    "`index.ts` registers a deterministic in-memory search provider and",
    "vector-store adapter through `api.registerSearchProvider` and",
    "`api.registerVectorStoreAdapter`. Replace the sample scoring, embedding,",
    "and storage behavior with your project-specific retrieval logic. The",
    "`search` capability in `manifest.json` grants both registrations.",
  ],
  importers: [
    "",
    "## Importer and Exporter",
    "`index.ts` registers paired project-context import/export commands through",
    "`api.registerImporter` and `api.registerExporter`. Replace the starter",
    "payloads with your domain adapter. The `importers` capability grants both",
    "registrations, and `schema` grants the example command flag metadata.",
  ],
  schema: [
    "",
    "## Custom Schema",
    "`index.ts` models a project domain by registering a custom item type, a",
    "custom item field, and a schema migration through `api.registerItemTypes`,",
    "`api.registerItemFields`, and `api.registerMigration`. Replace the sample",
    "type/field/migration with your own domain model; the `schema` capability in",
    "`manifest.json` grants all three registrations. Once installed, the custom",
    'type is usable everywhere, e.g. `pm create <type> "<title>"`.',
  ],
};

// README activation explainer for command-bearing starters (commands/hooks/
// search/importers): they declare `activation.commands` so pm loads them lazily.
const LAZY_ACTIVATION_README_SECTION: Record<"package" | "extension", readonly string[]> = {
  package: [
    "",
    "## Lazy Activation",
    "`manifest.json` declares `activation.commands`: the exact command paths this",
    "package's `activate` registers. pm imports and activates the package lazily —",
    "only when an invoked command path matches one of these entries — so unrelated",
    "commands (`pm list`, `pm search`, ...) never pay to load it. Keep this list in",
    "sync with the registrations in `index.ts`: add an entry when you register a new",
    "command, importer, or exporter, and remove one you drop. An omitted or stale",
    "entry means the matching command will not dispatch from the CLI. Globally-scoped",
    "surfaces (hooks, parser/preflight/renderer overrides, and search providers for",
    "built-in search commands) still activate regardless of this list.",
  ],
  extension: [
    "",
    "## Lazy Activation",
    "`manifest.json` declares `activation.commands`: the exact command paths this",
    "extension's `activate` registers. pm imports and activates the extension lazily —",
    "only when an invoked command path matches one of these entries — so unrelated",
    "commands never pay to load it. Keep this list in sync with the registrations in",
    "`index.ts`: an omitted or stale entry means the matching command will not dispatch",
    "from the CLI. Globally-scoped surfaces (hooks, parser/preflight/renderer overrides,",
    "and search providers for built-in search commands) still activate regardless.",
  ],
};

// README activation explainer for the `schema` starter: it contributes a GLOBAL
// custom item type/field, so it intentionally omits `activation.commands` and
// relies on pm's conservative activation tier (see buildScaffoldActivationCommands).
const SCHEMA_ACTIVATION_README_SECTION: Record<"package" | "extension", readonly string[]> = {
  package: [
    "",
    "## Activation",
    "This package contributes a GLOBAL custom item type and field, so `manifest.json`",
    "intentionally declares no `activation.commands`. pm activates the package",
    "conservatively — for every command — so the custom type is present wherever it is",
    "used: `pm create <type>`, `pm list --type <type>`, `pm validate`, and so on.",
    "Declaring narrow `activation.commands` here would gate activation to only those",
    "commands and silently leave the custom type unregistered for `pm create`. If you",
    "drop the schema registrations and keep only command/hook/search/importer surfaces,",
    "add `activation.commands` back so pm can load the package lazily.",
  ],
  extension: [
    "",
    "## Activation",
    "This extension contributes a GLOBAL custom item type and field, so `manifest.json`",
    "intentionally declares no `activation.commands`. pm activates the extension",
    "conservatively — for every command — so the custom type is present wherever it is",
    "used: `pm create <type>`, `pm list --type <type>`, `pm validate`, and so on.",
    "Declaring narrow `activation.commands` here would gate activation to only those",
    "commands and silently leave the custom type unregistered for `pm create`.",
  ],
};

interface ExtensionScaffoldFileResult {
  path: string;
  status: "created" | "unchanged";
}

interface ExtensionScaffoldResult {
  extension_name: string;
  command_name: string;
  capability: ExtensionScaffoldCapability;
  target_path: string;
  created_directory: boolean;
  files: ExtensionScaffoldFileResult[];
}

/**
 * Build the `activate` body lines for the starter entrypoint. The base body
 * always registers the starter command; capability-specific variants append
 * the matching SDK surface so generated packages demonstrate one runnable
 * customization primitive end to end.
 */
function buildActivateBodyLines(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string[] {
  const searchProviderName = `${extensionName}-search`;
  const vectorAdapterName = `${extensionName}-vector`;
  const adapterName = `${extensionName.replace(/-/g, " ")} items`;
  const commandLines = [
    "  api.registerCommand({",
    `    name: ${JSON.stringify(commandName)},`,
    '    description: "Starter scaffold command. Replace with your own behavior.",',
    "    run: async (context) => ({",
    "      ok: true,",
    `      source: ${JSON.stringify(extensionName)},`,
    "      command: context.command,",
    '      message: "Starter extension scaffold is active.",',
    "    }),",
    "  });",
  ];
  if (capability === "commands") {
    return commandLines;
  }
  if (capability === "search") {
    return [
      ...commandLines,
      "",
      "  // Search providers let packages customize how pm ranks and retrieves",
      "  // project context. This starter is deterministic and dependency-free:",
      "  // replace the scoring with your domain retrieval, embedding, or rerank",
      "  // logic as the package grows.",
      "  api.registerSearchProvider({",
      `    name: ${JSON.stringify(searchProviderName)},`,
      "    query: async (context) => {",
      "      const needle = context.query.toLowerCase();",
      "      const hits = context.documents",
      "        .filter((document) => {",
      "          const title = String(document.metadata.title ?? \"\").toLowerCase();",
      "          return title.includes(needle);",
      "        })",
      "        .map((document) => ({",
      "          id: document.metadata.id,",
      "          score: 1,",
      '          matched_fields: ["title"],',
      "        }));",
      "      return { hits };",
      "    },",
      "    embed: async (context) => [context.input.length],",
      "  });",
      "",
      "  // Vector-store adapters let packages own semantic index storage. This",
      "  // starter returns a stable in-memory hit so generated tests can exercise",
      "  // the adapter without external services.",
      "  api.registerVectorStoreAdapter({",
      `    name: ${JSON.stringify(vectorAdapterName)},`,
      "    query: async (context) => [{ id: \"starter-vector-hit\", score: context.limit }],",
      "    upsert: async (context) => ({ upserted: context.points.length }),",
      "    delete: async (context) => ({ deleted: context.ids.length }),",
      "  });",
    ];
  }
  if (capability === "schema") {
    const itemTypeName = extensionName;
    const itemTypeFolder = `${extensionName}s`;
    const itemTypeAlias = extensionName.replace(/-/g, "");
    const fieldName = `${extensionName.replace(/-/g, "_")}_note`;
    const migrationId = `${extensionName}-0001-init`;
    return [
      ...commandLines,
      "",
      "  // Schema registrations let a package model its own project domain — the",
      "  // heart of \"project management = context management\". Item types and fields",
      "  // are GLOBAL contributions: built-in commands like `pm create <type>` and",
      "  // `pm list --type <type>` must see them, so this package declares no",
      "  // `activation.commands` and pm activates it conservatively for every command.",
      "  // The `schema` capability in manifest.json grants all three registrations.",
      "  api.registerItemFields([",
      "    {",
      `      name: ${JSON.stringify(fieldName)},`,
      '      type: "string",',
      "      optional: true,",
      "    },",
      "  ]);",
      "",
      "  api.registerItemTypes([",
      "    {",
      `      name: ${JSON.stringify(itemTypeName)},`,
      "      // Replace with your domain's canonical plural folder name.",
      `      folder: ${JSON.stringify(itemTypeFolder)},`,
      `      aliases: [${JSON.stringify(itemTypeAlias)}],`,
      "      // Add field names here to force them at `pm create` time.",
      "      required_create_fields: [],",
      "    },",
      "  ]);",
      "",
      "  // Migrations let a package evolve stored items as its schema changes. pm",
      "  // runs each migration ONCE through the preflight gate (not once per item),",
      "  // passing a context that identifies the migration itself: `context.id` is",
      "  // the migration id (not an item id), alongside `context.pm_root` — iterate",
      "  // the corpus yourself from there. This starter is a deterministic no-op so",
      "  // package tests can invoke it without touching the corpus; replace the body",
      "  // with your real rewrite.",
      "  api.registerMigration({",
      `    id: ${JSON.stringify(migrationId)},`,
      `    description: ${JSON.stringify(`Initialize ${extensionName} schema state.`)},`,
      "    mandatory: false,",
      "    run: async (context) => ({ migrated: true, id: context.id }),",
      "  });",
    ];
  }
  if (capability === "importers") {
    return [
      ...commandLines,
      "",
      "  // Importers/exporters are the bridge between pm's context graph and",
      "  // another project-management system. Keep the starter deterministic so",
      "  // package tests can run without touching the network or filesystem; replace",
      "  // these payloads with your adapter's real mapping as the package grows.",
      "  api.registerImporter(",
      `    ${JSON.stringify(adapterName)},`,
      "    async (context) => ({",
      "      imported: 1,",
      "      source: context.options.source ?? \"starter\",",
      "      args: context.args,",
      "    }),",
      "    {",
      `      action: ${JSON.stringify(`${adapterName} import`)},`,
      '      description: "Import starter records into pm context.",',
      "      flags: [",
      "        {",
      '          long: "--source",',
      '          value_name: "name",',
      '          value_type: "string",',
      '          description: "Source name or path to import from.",',
      "        },",
      "      ],",
      "    },",
      "  );",
      "",
      "  api.registerExporter(",
      `    ${JSON.stringify(adapterName)},`,
      "    async (context) => ({",
      "      exported: true,",
      "      destination: context.options.destination ?? \"stdout\",",
      "      args: context.args,",
      "    }),",
      "    {",
      `      action: ${JSON.stringify(`${adapterName} export`)},`,
      '      description: "Export pm context into starter records.",',
      "      flags: [",
      "        {",
      '          long: "--destination",',
      '          value_name: "name",',
      '          value_type: "string",',
      '          description: "Destination name or path to export to.",',
      "        },",
      "      ],",
      "    },",
      "  );",
    ];
  }
  return [
    ...commandLines,
    "",
    "  // after_command hooks fire once pm finishes a command, receiving the items",
    "  // it mutated. This is the natural place to react to every change - sync to",
    "  // an external system, emit telemetry, or refresh derived context",
    '  // ("project management = context management"). This starter is a documented',
    "  // no-op on the success path; replace the body with your own reaction.",
    "  api.hooks.afterCommand((context) => {",
    "    if (!context.ok) {",
    "      return;",
    "    }",
    "    // `context.affected` lists the items pm mutated (id, status,",
    "    // changed_fields). React here, e.g.:",
    "    //   for (const item of context.affected ?? []) { /* ...item.id... */ }",
    "  });",
  ];
}

/**
 * Build the colocated `node:test` sample suite (`index.test.ts`) for the chosen
 * capability. Authored in TypeScript and run through `npm test` (`node --test`,
 * which strips types on Node >=22.18), it imports the `./index.ts` manifest entry
 * directly under NodeNext resolution.
 * Every variant covers activation, command invocation, and teardown via the SDK
 * testing helpers; the `hooks` variant adds a test that asserts the
 * `after_command` hook is registered and fires cleanly through the public SDK
 * testing helper `runRegisteredHookForTest`.
 */
function buildSampleTestSource(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string {
  const hooksEnabled = capability === "hooks";
  const searchEnabled = capability === "search";
  const importersEnabled = capability === "importers";
  const schemaEnabled = capability === "schema";
  const capabilitiesLiteral = SAMPLE_TEST_CAPABILITIES_LITERAL[capability];
  const searchProviderName = `${extensionName}-search`;
  const vectorAdapterName = `${extensionName}-vector`;
  const adapterName = `${extensionName.replace(/-/g, " ")} items`;
  const itemTypeName = extensionName;
  const itemTypeFolder = `${extensionName}s`;
  const fieldName = `${extensionName.replace(/-/g, "_")}_note`;
  const migrationId = `${extensionName}-0001-init`;
  const importNames = [
    "  activateExtensionForTest,",
    "  assertExtensionDeactivated,",
    "  assertRegisteredCommandContract,",
    ...(hooksEnabled ? ["  assertRegisteredHook,"] : []),
    ...(searchEnabled ? ["  assertRegisteredSearchProvider,", "  assertRegisteredVectorStoreAdapter,"] : []),
    ...(importersEnabled ? ["  assertRegisteredImporter,", "  assertRegisteredExporter,"] : []),
    ...(schemaEnabled ? ["  assertRegisteredItemField,", "  assertRegisteredItemType,", "  assertRegisteredMigration,"] : []),
    "  deactivateExtensionForTest,",
    "  runRegisteredCommandForTest,",
    ...(hooksEnabled ? ["  runRegisteredHookForTest,"] : []),
    ...(searchEnabled ? ["  runRegisteredSearchProviderForTest,", "  runRegisteredVectorStoreAdapterForTest,"] : []),
    ...(importersEnabled ? ["  runRegisteredImporterForTest,", "  runRegisteredExporterForTest,"] : []),
    ...(schemaEnabled ? ["  runRegisteredMigrationForTest,"] : []),
  ];
  const hookTestLines = hooksEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} reacts to commands via its after_command hook`)}, async () => {`,
        "  const activation = await activateExtensionForTest(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  // assertRegisteredHook throws unless an after_command hook is registered,",
        "  // so reaching the next line already proves the hook is wired.",
        "  assertRegisteredHook(activation.hooks, {",
        '    kind: "after_command",',
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "  });",
        "  // runRegisteredHookForTest fires the hook through pm's real runner with a",
        "  // synthetic context and returns the warnings it produced; a clean hook",
        "  // returns none. Replace the context/assertions as your hook grows.",
        "  const warnings = await runRegisteredHookForTest(activation.hooks, {",
        '    kind: "after_command",',
        "    context: {",
        `      command: ${JSON.stringify(commandName)},`,
        "      args: [],",
        '      pm_root: "",',
        "      ok: true,",
        "      affected: [],",
        "    },",
        "  });",
        "  assert.deepEqual(warnings, []);",
        "});",
        "",
      ]
    : [];
  const searchTestLines = searchEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} registers and invokes search primitives`)}, async () => {`,
        "  const activation = await activateExtensionForTest(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  assertRegisteredSearchProvider(activation.registrations, {",
        `    provider: ${JSON.stringify(searchProviderName)},`,
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "  });",
        "  assertRegisteredVectorStoreAdapter(activation.registrations, {",
        `    adapter: ${JSON.stringify(vectorAdapterName)},`,
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "  });",
        "",
        "  // The starter provider reads only document title/id, so `settings` is a",
        "  // minimal typed stub and `documents` carry just the fields it inspects.",
        "  const query = await runRegisteredSearchProviderForTest(activation.registrations, {",
        `    provider: ${JSON.stringify(searchProviderName)},`,
        '    operation: "query",',
        "    context: {",
        '      query: "sync",',
        '      mode: "semantic",',
        '      tokens: ["sync"],',
        "      options: {},",
        "      settings: {} as PmSettings,",
        "      documents: [",
        '        { metadata: { id: "pm-1", title: "Sync external context" }, body: "" },',
        '        { metadata: { id: "pm-2", title: "Unrelated task" }, body: "" },',
        "      ] as ItemDocument[],",
        "    },",
        "  });",
        '  assert.deepEqual(query, { hits: [{ id: "pm-1", score: 1, matched_fields: ["title"] }] });',
        "",
        "  const embedding = await runRegisteredSearchProviderForTest(activation.registrations, {",
        `    provider: ${JSON.stringify(searchProviderName)},`,
        '    operation: "embed",',
        '    context: { input: "abc", settings: {} as PmSettings, model: "starter-model" },',
        "  });",
        "  assert.deepEqual(embedding, [3]);",
        "",
        "  const vectorHits = await runRegisteredVectorStoreAdapterForTest(activation.registrations, {",
        `    adapter: ${JSON.stringify(vectorAdapterName)},`,
        '    operation: "query",',
        "    context: { vector: [0.1, 0.2], limit: 2, settings: {} as PmSettings },",
        "  });",
        '  assert.deepEqual(vectorHits, [{ id: "starter-vector-hit", score: 2 }]);',
        "});",
        "",
      ]
    : [];
  const importerTestLines = importersEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} registers and invokes import/export primitives`)}, async () => {`,
        "  const activation = await activateExtensionForTest(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  assertRegisteredImporter(activation.registrations, {",
        `    importer: ${JSON.stringify(adapterName)},`,
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "  });",
        "  assertRegisteredExporter(activation.registrations, {",
        `    exporter: ${JSON.stringify(adapterName)},`,
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "  });",
        "",
        "  const imported = await runRegisteredImporterForTest(activation, {",
        `    importer: ${JSON.stringify(adapterName)},`,
        '    options: { source: "tickets" },',
        '    args: ["batch-1"],',
        "  });",
        "  assert.equal(imported.handled, true);",
        '  assert.deepEqual(imported.result, { imported: 1, source: "tickets", args: ["batch-1"] });',
        "",
        "  const exported = await runRegisteredExporterForTest(activation, {",
        `    exporter: ${JSON.stringify(adapterName)},`,
        '    options: { destination: "archive" },',
        '    args: ["done"],',
        "  });",
        "  assert.equal(exported.handled, true);",
        '  assert.deepEqual(exported.result, { exported: true, destination: "archive", args: ["done"] });',
        "});",
        "",
      ]
    : [];
  const schemaTestLines = schemaEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} registers and runs its custom schema`)}, async () => {`,
        "  const activation = await activateExtensionForTest(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  // assertRegisteredItemType/Field/Migration throw unless the registration is",
        "  // present, so reaching each next line already proves the wiring; assert on",
        "  // the returned definitions to demonstrate inspecting registered metadata.",
        "  const itemType = assertRegisteredItemType(activation.registrations, {",
        `    itemType: ${JSON.stringify(itemTypeName)},`,
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "  });",
        `  assert.equal(itemType.itemType.folder, ${JSON.stringify(itemTypeFolder)});`,
        "  const itemField = assertRegisteredItemField(activation.registrations, {",
        `    field: ${JSON.stringify(fieldName)},`,
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "  });",
        '  assert.equal(itemField.field.type, "string");',
        "  assertRegisteredMigration(activation.registrations, {",
        `    migration: ${JSON.stringify(migrationId)},`,
        `    extensionName: ${JSON.stringify(extensionName)},`,
        "    mandatory: false,",
        "  });",
        "",
        "  // runRegisteredMigrationForTest invokes the migration through pm's real",
        "  // runner with a synthetic context and returns its result. Replace the",
        "  // context/assertions as your migration grows.",
        "  const migrated = await runRegisteredMigrationForTest(activation.registrations, {",
        `    migration: ${JSON.stringify(migrationId)},`,
        "  });",
        `  assert.deepEqual(migrated, { migrated: true, id: ${JSON.stringify(migrationId)} });`,
        "});",
        "",
      ]
    : [];
  return [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    "import {",
    ...importNames,
    '} from "@unbrained/pm-cli/sdk/testing";',
    // The search sample's synthetic query/vector contexts reference these SDK types
    // for their typed-stub fixtures; other capabilities need no extra type imports.
    ...(searchEnabled ? ['import type { ItemDocument, PmSettings } from "@unbrained/pm-cli/sdk";'] : []),
    'import extension from "./index.ts";',
    "",
    `test(${JSON.stringify(`${extensionName} registers its starter command`)}, async () => {`,
    "  // `capabilities` mirrors manifest.json so the in-memory activation grants",
    "  // the capabilities the entrypoint relies on.",
    "  const activation = await activateExtensionForTest(extension, {",
    `    name: ${JSON.stringify(extensionName)},`,
    `    capabilities: ${capabilitiesLiteral},`,
    "  });",
    "  // assertRegisteredCommandContract throws if the command is not",
    "  // registered, so reaching here already proves the wiring; assert on the",
    "  // returned definition to demonstrate inspecting registered metadata.",
    "  const registered = assertRegisteredCommandContract(activation.registrations, {",
    `    command: ${JSON.stringify(commandName)},`,
    `    extensionName: ${JSON.stringify(extensionName)},`,
    "  });",
    '  assert.equal(typeof registered.command.description, "string");',
    "",
    "  // runRegisteredCommandForTest invokes the handler through pm's real",
    "  // dispatch engine, so this asserts behavior - not just that the command",
    "  // is wired. Replace these assertions as you flesh out your command.",
    "  const invocation = await runRegisteredCommandForTest(activation.commands, {",
    `    command: ${JSON.stringify(commandName)},`,
    "  });",
    "  assert.equal(invocation.handled, true);",
    "  // The handler result is typed `unknown`, so deep-equality on the whole",
    "  // structured payload keeps the assertion type-safe without a cast.",
    "  assert.deepEqual(invocation.result, {",
    "    ok: true,",
    `    source: ${JSON.stringify(extensionName)},`,
    `    command: ${JSON.stringify(commandName)},`,
    '    message: "Starter extension scaffold is active.",',
    "  });",
    "});",
    "",
    ...hookTestLines,
    ...searchTestLines,
    ...importerTestLines,
    ...schemaTestLines,
    `test(${JSON.stringify(`${extensionName} tears down cleanly via deactivate`)}, async () => {`,
    "  // deactivateExtensionForTest runs pm's real teardown engine over the",
    "  // module, so this proves your `deactivate` hook runs without throwing.",
    "  const teardown = await deactivateExtensionForTest(extension, {",
    `    name: ${JSON.stringify(extensionName)},`,
    "  });",
    "  // assertExtensionDeactivated throws unless exactly one extension tore down",
    "  // with no failures, so reaching the next line already proves teardown ran.",
    "  assertExtensionDeactivated(teardown);",
    "  assert.equal(teardown.deactivated, 1);",
    "});",
    "",
  ].join("\n");
}

/**
 * Build the manifest `activation.commands` list for the chosen capability: the
 * exact command paths the starter `activate` registers.
 *
 * pm uses this list for lazy activation — it imports and activates the package
 * only when an invoked command path matches one of these entries — so it must
 * stay in sync with the registrations in {@link buildActivateBodyLines}. Every
 * first-party bundled package declares the same field; emitting it keeps
 * generated packages on that convention so they get precise, lazy, correct
 * activation instead of falling back to capability heuristics (which cannot
 * enumerate the contributed commands). The `importers` variant additionally
 * registers paired import/export command handlers under the adapter name.
 *
 * The `schema` variant is the deliberate exception: it returns an empty list so
 * the manifest omits `activation.commands`. Custom item types and fields are
 * GLOBAL schema contributions that built-in commands (`pm create <type>`,
 * `pm list --type <type>`, `pm validate`) must see — commands the package does
 * not own and cannot enumerate. Declaring narrow `activation.commands` there
 * would gate activation to only the listed commands and silently leave the
 * custom type unregistered for `pm create`; omitting it lets pm's conservative
 * activation tier (which covers `schema`) load the package for every command.
 */
function buildScaffoldActivationCommands(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string[] {
  if (capability === "schema") {
    return [];
  }
  if (capability === "importers") {
    const adapterName = `${extensionName.replace(/-/g, " ")} items`;
    return [commandName, `${adapterName} import`, `${adapterName} export`];
  }
  return [commandName];
}

/**
 * Implements build starter extension scaffold files for the public runtime surface of this module.
 */
export function buildStarterExtensionScaffoldFiles(
  extensionName: string,
  commandName: string,
  vocabulary: "extension" | "package",
  capability: ExtensionScaffoldCapability = "commands",
): Record<string, string> {
  const packageName = `pm-${extensionName}`;
  const capabilities = SCAFFOLD_MANIFEST_CAPABILITIES[capability];
  const activationCommands = buildScaffoldActivationCommands(extensionName, commandName, capability);
  const manifest = `${JSON.stringify(
    {
      name: extensionName,
      version: "0.1.0",
      entry: "./index.ts",
      manifest_version: SCAFFOLD_MANIFEST_VERSION,
      pm_min_version: SCAFFOLD_PM_MIN_VERSION,
      trusted: true,
      sandbox_profile: "strict",
      permissions: { ...SCAFFOLD_DECLARED_PERMISSIONS },
      capabilities,
      // Declares the exact command paths `activate` registers so pm activates
      // this package lazily — only when an invoked command matches — mirroring
      // every first-party bundled package. Keep it in sync with the entrypoint.
      // The schema starter omits this field (empty list) so its global custom
      // item type/field stay available to built-in commands (see
      // buildScaffoldActivationCommands).
      ...(activationCommands.length > 0 ? { activation: { commands: activationCommands } } : {}),
    },
    null,
    2,
  )}\n`;
  // The entrypoint is authored AND loaded as TypeScript (ADR pm-2c28 / pm-m1uz):
  // the manifest `entry` points at `./index.ts` and pm imports it directly via
  // Node's native type stripping (Node >=22.18) — there is no compile step and no
  // `.js` artifact. The typed `ExtensionApi` parameter is checked against the SDK
  // contract at author time (`npm run typecheck`).
  const entrypoint = [
    'import type { ExtensionApi } from "@unbrained/pm-cli/sdk";',
    "",
    "export function activate(api: ExtensionApi): void {",
    ...buildActivateBodyLines(extensionName, commandName, capability),
    "}",
    "",
    "// `deactivate` is the teardown counterpart to `activate`: pm runs it on host",
    "// shutdown/reload (e.g. the MCP server between requests) to release anything",
    "// `activate` opened - timers, connections, caches. This starter holds no such",
    "// resources, so it stays a documented no-op; add cleanup here as you grow.",
    "export function deactivate(): void {}",
    "",
    "export default {",
    "  activate,",
    "  deactivate,",
    "};",
    "",
  ].join("\n");
  const tsconfig = `${JSON.stringify(SCAFFOLD_TSCONFIG, null, 2)}\n`;
  // README bullet describing what index.ts wires, kept in sync with the chosen
  // capability so the generated docs match the generated code.
  const entrypointBullet = ENTRYPOINT_BULLETS[capability];
  // The schema starter omits `activation.commands` (its custom type is global),
  // so describe the manifest accurately instead of referencing a field it lacks.
  const manifestBullet =
    capability === "schema"
      ? `- \`manifest.json\`: ${vocabulary} metadata and capabilities (no \`activation.commands\` — the custom item type activates for every command).`
      : `- \`manifest.json\`: ${vocabulary} metadata, capabilities, and \`activation.commands\` (the command paths that lazily activate this ${vocabulary}).`;
  if (vocabulary === "package") {
    const packageJson = `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        keywords: ["pm-package"],
        engines: {
          node: SCAFFOLD_NODE_ENGINE,
        },
        // There is no build step: pm loads the `./index.ts` manifest entry
        // directly via Node's native type stripping (Node >=22.18). `typecheck`
        // validates the source against the SDK contracts (`tsc --noEmit`), and
        // `test` runs the colocated sample with Node's built-in runner (which
        // strips types on load) against the peer SDK testing helpers — no
        // third-party test runner or compile required.
        scripts: {
          typecheck: "tsc --noEmit",
          test: "node --test",
        },
        peerDependencies: {
          "@unbrained/pm-cli": "*",
        },
        devDependencies: {
          "@types/node": SCAFFOLD_TYPES_NODE_VERSION,
          typescript: SCAFFOLD_TYPESCRIPT_VERSION,
        },
        pm: {
          aliases: [extensionName],
          extensions: ["."],
          docs: ["README.md"],
          examples: ["README.md"],
          catalog: {
            display_name: extensionName,
            category: "workflow",
            summary: "Starter pm package scaffold.",
            tags: ["starter"],
          },
        },
      },
      null,
      2,
    )}\n`;
    // node:test sample: demonstrates validating the package with the SDK testing
    // helpers without adding a third-party test runner. The suite covers the
    // capability the scaffold targets (command invocation, and for the hooks
    // capability, the after_command lifecycle hook).
    const sampleTest = buildSampleTestSource(extensionName, commandName, capability);
    const sampleTestBullet = SAMPLE_TEST_BULLETS[capability];
    // The package commits only TypeScript source — pm loads the `.ts` entry
    // directly, so there is no compiled output to ignore. Keep dependencies and
    // the tsc incremental cache out of version control.
    const gitignore = [
      "node_modules/",
      "*.log",
      "*.tsbuildinfo",
      "",
    ].join("\n");
    const searchProviderName = `${extensionName}-search`;
    const vectorAdapterName = `${extensionName}-vector`;
    const adapterName = `${extensionName.replace(/-/g, " ")} items`;
    const itemTypeName = extensionName;
    const itemTypeFolder = `${extensionName}s`;
    const itemTypeAlias = extensionName.replace(/-/g, "");
    const fieldName = `${extensionName.replace(/-/g, "_")}_note`;
    const migrationId = `${extensionName}-0001-init`;
    const defineBuilderImports = [
      "defineCommand",
      ...(capability === "hooks" ? ["defineAfterCommandHook"] : []),
      ...(capability === "search" ? ["defineSearchProvider", "defineVectorStoreAdapter"] : []),
      ...(capability === "importers" ? ["defineImporter", "defineExporter"] : []),
      ...(capability === "schema" ? ["defineItemType", "defineItemField", "defineMigration"] : []),
    ].join(", ");
    const defineBuilderSnippet = [
      "```ts",
      `import { ${defineBuilderImports} } from "@unbrained/pm-cli/sdk";`,
      'import type { ExtensionApi } from "@unbrained/pm-cli/sdk";',
      "",
      "export const pingCommand = defineCommand({",
      `  name: ${JSON.stringify(commandName)},`,
      '  description: "Starter scaffold command. Replace with your own behavior.",',
      "  run: (context) => ({ ok: true, command: context.command }),",
      "});",
    ];
    if (capability === "hooks") {
      defineBuilderSnippet.push(
        "",
        "export const afterCommandHook = defineAfterCommandHook((context) => {",
        "  if (!context.ok) return;",
        "  // React to context.affected here as your package grows.",
        "});",
      );
    }
    if (capability === "search") {
      defineBuilderSnippet.push(
        "",
        "export const searchProvider = defineSearchProvider({",
        `  name: ${JSON.stringify(searchProviderName)},`,
        "  query: async (context) => ({",
        "    hits: context.documents",
        "      .filter((document) => String(document.metadata.title ?? \"\").toLowerCase().includes(context.query.toLowerCase()))",
        "      .map((document) => ({ id: document.metadata.id, score: 1, matched_fields: [\"title\"] })),",
        "  }),",
        "  embed: async (context) => [context.input.length],",
        "});",
        "",
        "export const vectorStoreAdapter = defineVectorStoreAdapter({",
        `  name: ${JSON.stringify(vectorAdapterName)},`,
        "  query: async (context) => [{ id: \"starter-vector-hit\", score: context.limit }],",
        "  upsert: async (context) => ({ upserted: context.points.length }),",
        "  delete: async (context) => ({ deleted: context.ids.length }),",
        "});",
      );
    }
    if (capability === "importers") {
      defineBuilderSnippet.push(
        "",
        "export const importer = defineImporter(async (context) => ({",
        "  imported: 1,",
        "  source: context.options.source ?? \"starter\",",
        "  args: context.args,",
        "}));",
        "",
        "export const exporter = defineExporter(async (context) => ({",
        "  exported: true,",
        "  destination: context.options.destination ?? \"stdout\",",
        "  args: context.args,",
        "}));",
      );
    }
    if (capability === "schema") {
      defineBuilderSnippet.push(
        "",
        `export const noteField = defineItemField({ name: ${JSON.stringify(fieldName)}, type: "string", optional: true });`,
        "",
        "export const itemType = defineItemType({",
        `  name: ${JSON.stringify(itemTypeName)},`,
        `  folder: ${JSON.stringify(itemTypeFolder)},`,
        `  aliases: [${JSON.stringify(itemTypeAlias)}],`,
        "  required_create_fields: [],",
        "});",
        "",
        "export const initMigration = defineMigration({",
        `  id: ${JSON.stringify(migrationId)},`,
        `  description: ${JSON.stringify(`Initialize ${extensionName} schema state.`)},`,
        "  mandatory: false,",
        "  run: async (context) => ({ migrated: true, id: context.id }),",
        "});",
      );
    }
    defineBuilderSnippet.push(
      "",
      "export function activate(api: ExtensionApi): void {",
      "  api.registerCommand(pingCommand);",
    );
    if (capability === "hooks") {
      defineBuilderSnippet.push("  api.hooks.afterCommand(afterCommandHook);");
    }
    if (capability === "search") {
      defineBuilderSnippet.push("  api.registerSearchProvider(searchProvider);", "  api.registerVectorStoreAdapter(vectorStoreAdapter);");
    }
    if (capability === "schema") {
      defineBuilderSnippet.push(
        "  api.registerItemFields([noteField]);",
        "  api.registerItemTypes([itemType]);",
        "  api.registerMigration(initMigration);",
      );
    }
    if (capability === "importers") {
      defineBuilderSnippet.push(
        `  api.registerImporter(${JSON.stringify(adapterName)}, importer, {`,
        `    action: ${JSON.stringify(`${adapterName} import`)},`,
        '    description: "Import starter records into pm context.",',
        "    flags: [",
        "      {",
        '        long: "--source",',
        '        value_name: "name",',
        '        value_type: "string",',
        '        description: "Source name or path to import from.",',
        "      },",
        "    ],",
        "  });",
        `  api.registerExporter(${JSON.stringify(adapterName)}, exporter, {`,
        `    action: ${JSON.stringify(`${adapterName} export`)},`,
        '    description: "Export pm context into starter records.",',
        "    flags: [",
        "      {",
        '        long: "--destination",',
        '        value_name: "name",',
        '        value_type: "string",',
        '        description: "Destination name or path to export to.",',
        "      },",
        "    ],",
        "  });",
      );
    }
    defineBuilderSnippet.push(
      "}",
      "",
      "export function deactivate(): void {}",
      "",
      "export default { activate, deactivate };",
      "```",
    );
    const packageReadme = [
      `# ${packageName}`,
      "",
      "Generated by `pm package init`.",
      "",
      "## Included Files",
      "- `package.json`: package metadata, `typecheck`/`test` scripts, and `pm` resource manifest.",
      manifestBullet,
      entrypointBullet,
      sampleTestBullet,
      TSCONFIG_BULLET,
      "- `.gitignore`: ignores `node_modules/`, logs, and the TypeScript build cache.",
      "",
      "## Quick Start",
      "This package is authored AND loaded as TypeScript: the manifest `entry` is",
      "`./index.ts` and pm imports it directly via Node's native type stripping",
      "(Node >=22.18), so there is no build step — install and run:",
      "```bash",
      "npm install",
      "pm install --project <package-path>",
      `pm ${commandName}`,
      "pm package doctor --project --detail summary",
      "```",
      "",
      "## Validate the Package",
      "`npm install` pulls the peer SDK and TypeScript; `npm run typecheck` checks the",
      "source against the SDK contracts and `npm test` runs the colocated sample:",
      "```bash",
      "npm install",
      "npm run typecheck",
      "npm test",
      "```",
      "`npm test` runs `node --test`, which strips types on load and executes",
      "`index.test.ts` directly against the `@unbrained/pm-cli/sdk/testing` helpers -",
      "no compile step and no extra test runner required.",
      "",
      "## Authoring With define* Builders",
      "`index.ts` is authored fully in TypeScript so every registration is checked",
      "against the SDK contracts at author time. Use the public SDK authoring",
      "builders for exported definitions you want literal-type preservation,",
      "contextual handler inference, and direct unit tests for:",
      ...defineBuilderSnippet,
      "The builders return their argument unchanged; runtime validation still lives",
      "in `api.register*`, and behavior validation lives in `sdk/testing`.",
      ...PACKAGE_CAPABILITY_README_SECTIONS[capability],
      ...(capability === "schema" ? SCHEMA_ACTIVATION_README_SECTION.package : LAZY_ACTIVATION_README_SECTION.package),
      "",
      "## Compatibility Bounds",
      "`manifest.json` cannot hold comments, so the version-compatibility fields are documented here:",
      `- \`manifest_version\` (integer): manifest schema generation. Leave at \`${SCAFFOLD_MANIFEST_VERSION}\` unless you adopt a newer manifest schema.`,
      `- \`pm_min_version\` (string): lowest pm CLI version that may load this package. Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\`. The loader blocks the package on older CLIs.`,
      "- `pm_max_version` (string, optional): highest pm CLI version that may load this package. Add it to block CLIs that are newer than the version you have validated against. The loader blocks the package when the CLI exceeds this bound.",
      "",
      "## Policy Metadata",
      "The starter command is pure compute, so `manifest.json` declares `trusted: true`, `sandbox_profile: \"strict\"`, and all six permission keys as `false`. Keep that least-privilege shape for pure packages; relax only the specific permission your package actually needs and verify with `pm package doctor --project --detail deep --trace`.",
      "",
      "## Notes",
      "- Author in `index.ts`; pm loads it directly (no build), so edits take effect on the next install/reload — there is no `.js` to regenerate.",
      "- Move larger runtimes into sibling or subdirectory `*.ts` modules and import them with their real `.ts` extension; `tsconfig.json` type-checks every `*.ts` in the package (recursively).",
      "- Add capabilities to the extension manifest only when the entrypoint uses the matching SDK API.",
      "- Use `@unbrained/pm-cli/sdk` as the public SDK import for richer package runtimes.",
      "",
    ].join("\n");
    return {
      "package.json": packageJson,
      "manifest.json": manifest,
      "index.ts": entrypoint,
      "index.test.ts": sampleTest,
      "tsconfig.json": tsconfig,
      ".gitignore": gitignore,
      "README.md": packageReadme,
    };
  }
  const readme = [
    `# ${extensionName}`,
    "",
    "Generated by `pm extension init`.",
    "",
    "## Included Files",
    manifestBullet,
    entrypointBullet,
    TSCONFIG_BULLET,
    "",
    "## Quick Start",
    "This extension is authored AND loaded as TypeScript: the manifest `entry` is",
    "`./index.ts` and pm imports it directly via Node's native type stripping",
    "(Node >=22.18), so there is no compile step. Install the dev dependencies for",
    "type-checking, then install and run the extension:",
    "```bash",
    "npm install -D typescript @types/node @unbrained/pm-cli",
    "npx tsc --noEmit",
    "pm extension --install --project <scaffold-path>",
    `pm ${commandName}`,
    "pm extension --doctor --project --detail summary",
    "```",
    ...EXTENSION_CAPABILITY_README_SECTIONS[capability],
    ...(capability === "schema" ? SCHEMA_ACTIVATION_README_SECTION.extension : LAZY_ACTIVATION_README_SECTION.extension),
    "",
    "## Compatibility Bounds",
    "`manifest.json` cannot hold comments, so the version-compatibility fields are documented here:",
    `- \`manifest_version\` (integer): manifest schema generation. Leave at \`${SCAFFOLD_MANIFEST_VERSION}\` unless you adopt a newer manifest schema.`,
    `- \`pm_min_version\` (string): lowest pm CLI version that may load this extension. Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\`. The loader blocks the extension on older CLIs.`,
    "- `pm_max_version` (string, optional): highest pm CLI version that may load this extension. Add it to block CLIs that are newer than the version you have validated against. The loader blocks the extension when the CLI exceeds this bound.",
    "",
    "## Policy Metadata",
    "The starter command is pure compute, so `manifest.json` declares `trusted: true`, `sandbox_profile: \"strict\"`, and all six permission keys as `false`. Keep that least-privilege shape for pure extensions; relax only the specific permission your extension actually needs and verify with `pm extension --doctor --project --detail deep --trace`.",
    "",
    "- This scaffold is TypeScript ESM source loaded directly by pm (no compile), so it works in package scopes with `type: module`.",
    "- Author in `index.ts` (the manifest entry); edits take effect on the next install/reload — there is no `.js` to regenerate.",
    "- Release any resources `activate` opens (timers, connections, caches) in the `deactivate` teardown hook.",
    "",
  ].join("\n");
  return {
    "manifest.json": manifest,
    "index.ts": entrypoint,
    "tsconfig.json": tsconfig,
    "README.md": readme,
  };
}

/**
 * Implements scaffold extension project for the public runtime surface of this module.
 */
export async function scaffoldExtensionProject(
  target: string,
  vocabulary: "extension" | "package" = "extension",
  capability: string = "commands",
): Promise<ExtensionScaffoldResult> {
  const normalizedCapability = capability.trim().toLowerCase();
  if (!(SCAFFOLD_CAPABILITIES as readonly string[]).includes(normalizedCapability)) {
    throw new PmCliError(
      `Unknown scaffold capability "${capability}". Supported capabilities: ${SCAFFOLD_CAPABILITIES.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  const resolvedCapability = normalizedCapability as ExtensionScaffoldCapability;
  const normalizedTarget = target.trim();
  const targetPath = path.resolve(process.cwd(), normalizedTarget);
  const extensionName = normalizeManagedDirectoryName(path.basename(targetPath));
  // Hyphenated top-level command groups can surface in help but fail dispatch in
  // Commander, so generated starters use space-separated command words while the
  // manifest and package identity keep their normalized directory names.
  const commandName = `${extensionName.replace(/-/g, " ")} ping`;
  const scaffoldFiles = buildStarterExtensionScaffoldFiles(extensionName, commandName, vocabulary, resolvedCapability);

  let createdDirectory = false;
  if (await pathExists(targetPath)) {
    const existingTargetStats = await fs.stat(targetPath);
    if (!existingTargetStats.isDirectory()) {
      throw new PmCliError(
        `Scaffold target "${targetPath}" exists and is not a directory.`,
        EXIT_CODE.CONFLICT,
      );
    }
  } else {
    await fs.mkdir(targetPath, { recursive: true });
    createdDirectory = true;
  }

  for (const [relativePath, content] of Object.entries(scaffoldFiles)) {
    const absolutePath = path.join(targetPath, relativePath);
    if (!(await pathExists(absolutePath))) {
      continue;
    }
    const existingContent = await fs.readFile(absolutePath, "utf8");
    if (existingContent !== content) {
      throw new PmCliError(
        `Scaffold file "${relativePath}" already exists with different content in "${targetPath}". Choose a new target path or remove conflicting files.`,
        EXIT_CODE.CONFLICT,
      );
    }
  }

  const files: ExtensionScaffoldFileResult[] = [];
  for (const [relativePath, content] of Object.entries(scaffoldFiles)) {
    const absolutePath = path.join(targetPath, relativePath);
    if (await pathExists(absolutePath)) {
      files.push({
        path: relativePath,
        status: "unchanged",
      });
      continue;
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    files.push({
      path: relativePath,
      status: "created",
    });
  }

  return {
    extension_name: extensionName,
    command_name: commandName,
    capability: resolvedCapability,
    target_path: targetPath,
    created_directory: createdDirectory,
    files,
  };
}
