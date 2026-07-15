/**
 * @module sdk/extension/scaffold
 *
 * Implements extension package-management support for Scaffold.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EXECUTABLE_COMMAND_ALIASES } from "../../cli/bootstrap-args.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { PM_CORE_COMMAND_NAMES } from "../cli-contracts.js";
import { normalizeManagedDirectoryName } from "./shared.js";

// Safe compatibility floor emitted into scaffolded manifests. The current
// starters are loaded as TypeScript and use the SDK define*/testing helpers; the
// first released host that supports that full generated contract is v2026.6.24.
// manifest_version tracks the manifest schema generation (currently 1).
const SCAFFOLD_MANIFEST_VERSION = 1;
/** Public contract for scaffold pm min version, shared by SDK and presentation-layer consumers. */
export const SCAFFOLD_PM_MIN_VERSION = "2026.6.24";
const SCAFFOLD_NODE_ENGINE = ">=22.18.0";
const SCAFFOLD_DECLARED_PERMISSIONS = {
  fs_read: false,
  fs_write: false,
  network: false,
  env_read: false,
  env_write: false,
  process_spawn: false,
};

const RESERVED_SCAFFOLD_COMMAND_ROOTS = new Set([
  ...PM_CORE_COMMAND_NAMES.map((commandName) =>
    commandName.split("-")[0]!.toLowerCase(),
  ),
  ...Object.keys(EXECUTABLE_COMMAND_ALIASES).map((alias) =>
    alias.toLowerCase(),
  ),
  // "scaffold" is a Commander command that currently lives outside both
  // PM_CORE_COMMAND_NAMES and EXECUTABLE_COMMAND_ALIASES.
  "scaffold",
]);

// TypeScript dev-dependency floor for scaffolded packages, matching the CLI's own
// toolchain so generated packages compile against the same compiler generation.
const SCAFFOLD_TYPESCRIPT_VERSION = "^6.0.0";

// `@types/node` floor for scaffolded packages: the colocated `index.test.ts`
// imports `node:test`/`node:assert`, which need Node's ambient type definitions
// to type-check. Pinned to the engines floor (Node >=22.18), matching the CLI
// itself — the version where Node strips TypeScript types on load by default.
const SCAFFOLD_TYPES_NODE_VERSION = "^22.0.0";

const SAMPLE_HARNESS_CLEANUP_LINES = [
  "type StarterHarness = Awaited<ReturnType<typeof createExtensionTestHarness>>;",
  "",
  "async function deactivateIfNeeded(ext: StarterHarness, deactivated: boolean): Promise<void> {",
  "  if (!deactivated) {",
  "    try {",
  "      await ext.deactivate();",
  "    } catch {",
  "      // Preserve the original assertion error; cleanup is best effort.",
  "    }",
  "  }",
  "}",
  "",
] as const;

const SAMPLE_HARNESS_FINALLY_LINES = [
  "  } finally {",
  "    await deactivateIfNeeded(ext, deactivated);",
  "  }",
] as const;

function indentGeneratedLines(
  lines: readonly string[],
  prefix: string,
): string[] {
  return lines.map((line) => (line === "" ? line : `${prefix}${line}`));
}

function buildSchemaCapabilityAssertionLines(options: {
  readonly extensionName: string;
  readonly itemTypeName: string;
  readonly itemTypeFolder: string;
  readonly fieldName: string;
  readonly migrationId: string;
  readonly includeMigrationReplacementHint?: boolean;
}): string[] {
  const migrationHint =
    options.includeMigrationReplacementHint === true
      ? ["  // as your migration grows."]
      : [];
  return [
    "  // assertItemType/Field/Migration throw unless the registration is present, so",
    "  // reaching each next line already proves the wiring; assert on the returned",
    "  // definitions to demonstrate inspecting registered metadata.",
    `  const itemType = ext.assertItemType({ itemType: ${JSON.stringify(options.itemTypeName)}, extensionName: ${JSON.stringify(options.extensionName)} });`,
    `  assert.equal(itemType.itemType.folder, ${JSON.stringify(options.itemTypeFolder)});`,
    `  const itemField = ext.assertItemField({ field: ${JSON.stringify(options.fieldName)}, extensionName: ${JSON.stringify(options.extensionName)} });`,
    '  assert.equal(itemField.field.type, "string");',
    `  ext.assertMigration({ migration: ${JSON.stringify(options.migrationId)}, extensionName: ${JSON.stringify(options.extensionName)}, mandatory: false });`,
    "",
    "  // runMigration invokes the migration through pm's real runner with a synthetic",
    "  // context and returns its result.",
    ...migrationHint,
    `  const migrated = await ext.runMigration({ migration: ${JSON.stringify(options.migrationId)} });`,
    `  assert.deepEqual(migrated, { migrated: true, id: ${JSON.stringify(options.migrationId)} });`,
  ];
}

function buildProfileCapabilityAssertionLines(extensionName: string): string[] {
  return [
    "  // assertProfile throws unless the profile is registered, so reaching the next",
    "  // line already proves the wiring; assert on the returned definition to inspect",
    "  // the bundled archetype dimensions.",
    `  const { profile } = ext.assertProfile({ profile: ${JSON.stringify(extensionName)}, extensionName: ${JSON.stringify(extensionName)} });`,
    `  assert.equal(profile.title, ${JSON.stringify(`${extensionName} archetype`)});`,
    "  assert.equal(profile.types.length, 1);",
    "  assert.equal(profile.workflows.length, 1);",
  ];
}

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

/** Capability shapes the package/extension scaffolder can target via the `--capability` selector — one per SDK extension capability, so every registration surface has a runnable starter. `commands` emits the default command-only starter; `hooks` additionally wires an `after_command` lifecycle reactor; `search` wires an in-memory provider/adapter pair; `importers` wires importer and exporter command primitives so authors can customize project context movement; `schema` registers a custom item type, item field, and migration so authors can model their own project domain; `profile` registers a complete project-profile archetype (item types, statuses, fields, a workflow, config, a template, and package recommendations) via `api.registerProfile` so `pm profile apply` can tailor a tracker in one shot; `renderers` overrides how a command's output is serialized for a format; `parser` rewrites a command's parsed options before its handler runs; `preflight` adjusts pm's pre-run migration/format gate decision; and `services` overrides a built-in pm service (e.g. output formatting) — without starting from a blank extension. */
export const SCAFFOLD_CAPABILITIES = [
  "commands",
  "hooks",
  "search",
  "importers",
  "schema",
  "profile",
  "renderers",
  "parser",
  "preflight",
  "services",
] as const;

/**
 * Restricts the `--capability` selector to a {@link SCAFFOLD_CAPABILITIES} value.
 */
export type ExtensionScaffoldCapability =
  (typeof SCAFFOLD_CAPABILITIES)[number];

const SCAFFOLD_MANIFEST_CAPABILITIES: Record<
  ExtensionScaffoldCapability,
  readonly string[]
> = {
  commands: ["commands"],
  hooks: ["commands", "hooks"],
  search: ["commands", "search"],
  importers: ["commands", "schema", "importers"],
  schema: ["commands", "schema"],
  // A profile registration IS a schema+config bundle, so the loader gate requires
  // the `schema` capability (no separate `profile` capability) — same grant as the
  // schema starter, mirroring the bundled pm-kanban exemplar.
  profile: ["commands", "schema"],
  renderers: ["commands", "renderers"],
  // The parser starter declares `--shout`/`--upper` command flags so the
  // override is runnable through `pm <command> --shout`; flag metadata is
  // schema-governed, so the manifest also declares `schema`.
  parser: ["commands", "parser", "schema"],
  preflight: ["commands", "preflight"],
  services: ["commands", "services"],
};

const SAMPLE_TEST_CAPABILITIES_LITERAL: Record<
  ExtensionScaffoldCapability,
  string
> = {
  commands: '["commands"]',
  hooks: '["commands", "hooks"]',
  search: '["commands", "search"]',
  importers: '["commands", "schema", "importers"]',
  schema: '["commands", "schema"]',
  profile: '["commands", "schema"]',
  renderers: '["commands", "renderers"]',
  parser: '["commands", "parser", "schema"]',
  preflight: '["commands", "preflight"]',
  services: '["commands", "services"]',
};

const ENTRYPOINT_BULLETS: Record<ExtensionScaffoldCapability, string> = {
  commands:
    "- `index.ts`: the TypeScript manifest entry — starter command registration plus a `deactivate` teardown stub.",
  hooks:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, an `after_command` lifecycle hook, and a `deactivate` teardown stub.",
  search:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a search provider, a vector-store adapter, and a `deactivate` teardown stub.",
  importers:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, importer/exporter command registrations, and a `deactivate` teardown stub.",
  schema:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a custom item type, a custom item field, a schema migration, and a `deactivate` teardown stub.",
  profile:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a project profile (item types, statuses, fields, a workflow, config, a template, and package recommendations) registered via `api.registerProfile`, and a `deactivate` teardown stub.",
  renderers:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a `toon` output renderer override, and a `deactivate` teardown stub.",
  parser:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a parser override that rewrites the command's parsed options, and a `deactivate` teardown stub.",
  preflight:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, a preflight override over pm's pre-run gate decision, and a `deactivate` teardown stub.",
  services:
    "- `index.ts`: the TypeScript manifest entry — starter command registration, an `output_format` service override, and a `deactivate` teardown stub.",
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
  profile:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, project-profile registration (asserting the bundled archetype dimensions), and teardown via the SDK testing helpers.",
  renderers:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, renderer override registration and invocation (including format pass-through), and teardown via the SDK testing helpers.",
  parser:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, parser override registration and the option rewrite it produces, and teardown via the SDK testing helpers.",
  preflight:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, preflight override registration and the gate decision it returns, and teardown via the SDK testing helpers.",
  services:
    "- `index.test.ts`: sample `node:test` suite covering activation, command invocation, service override registration and invocation (including command pass-through), and teardown via the SDK testing helpers.",
};

const TSCONFIG_BULLET =
  "- `tsconfig.json`: strict type-check-only TypeScript config (`noEmit`) for the `.ts` source the loader runs directly.";

const PACKAGE_CAPABILITY_README_SECTIONS: Record<
  ExtensionScaffoldCapability,
  readonly string[]
> = {
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
    '`pm create <type> "<title>"` and `pm list --type <type>`.',
  ],
  profile: [
    "",
    "## Project Profile",
    "`index.ts` registers a complete project-profile archetype through",
    "`api.registerProfile`. A profile is the broadest customization primitive pm",
    "has — one declarative bundle of item types, custom statuses, fields, a per-type",
    "workflow, config knobs, create templates, and package recommendations. Once the",
    "package is installed the profile resolves by name through `pm profile list`,",
    "`pm profile show <name>`, and `pm profile apply <name>`, which stages every",
    "dimension idempotently — exactly like a core archetype (agile/ops/research),",
    "with no consumer code required. Replace the sample archetype with your own",
    "domain; the `schema` capability in `manifest.json` grants the registration (a",
    "profile is a schema+config bundle, so it needs no separate capability).",
  ],
  renderers: [
    "",
    "## Output Renderer",
    "`index.ts` registers a `toon` output renderer override through",
    "`api.registerRenderer`. Renderer overrides run for every command's output in",
    "that format, so this starter scopes itself to THIS package's own command and",
    "returns `null` (pass-through to pm's default renderer) for everything else.",
    "Return a string to take over rendering. Replace the sample serialization with",
    "your own; the `renderers` capability in `manifest.json` grants the",
    "registration.",
  ],
  parser: [
    "",
    "## Parser Override",
    "`index.ts` registers a parser override for the starter command through",
    "`api.registerParser`. pm runs it on the command's parsed options BEFORE the",
    "handler, merging the delta you return. This starter rewrites a deprecated",
    "`--shout` alias to the canonical `--upper` flag; replace it with your",
    "command's real normalization. The `parser` capability in `manifest.json`",
    "grants the registration.",
  ],
  preflight: [
    "",
    "## Preflight Override",
    "`index.ts` registers a preflight override through `api.registerPreflight`. pm",
    "calls it before every command to compute the migration/format gate decision —",
    "the last registered override wins. Return only the decision keys you want to",
    "change; this starter echoes the current decision unchanged (a safe no-op) so",
    "installing the package does not alter gate behavior. The `preflight`",
    "capability in `manifest.json` grants the registration.",
  ],
  services: [
    "",
    "## Service Override",
    "`index.ts` overrides the built-in `output_format` service through",
    "`api.registerService`. The service renders a command's structured result;",
    "returning the payload unchanged passes through to pm's default formatting.",
    "This starter scopes itself to THIS package's own command and passes every",
    "other command through, so it never disrupts unrelated output. The `services`",
    "capability in `manifest.json` grants the registration.",
  ],
};

const EXTENSION_CAPABILITY_README_SECTIONS: Record<
  ExtensionScaffoldCapability,
  readonly string[]
> = {
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
  profile: [
    "",
    "## Project Profile",
    "`index.ts` registers a complete project-profile archetype through",
    "`api.registerProfile` — one declarative bundle of item types, custom statuses,",
    "fields, a per-type workflow, config knobs, create templates, and package",
    "recommendations. Once installed the profile resolves by name through",
    "`pm profile list`, `pm profile show <name>`, and `pm profile apply <name>`,",
    "which stages every dimension idempotently like a core archetype. Replace the",
    "sample archetype with your own domain; the `schema` capability in",
    "`manifest.json` grants the registration.",
  ],
  renderers: [
    "",
    "## Output Renderer",
    "`index.ts` registers a `toon` output renderer override through",
    "`api.registerRenderer`. Renderer overrides run for every command's output in",
    "that format, so this starter scopes itself to its own command and returns",
    "`null` (pass-through to pm's default renderer) for everything else. Replace",
    "the sample serialization with your own; the `renderers` capability in",
    "`manifest.json` grants the registration.",
  ],
  parser: [
    "",
    "## Parser Override",
    "`index.ts` registers a parser override for the starter command through",
    "`api.registerParser`. pm runs it on the command's parsed options BEFORE the",
    "handler, merging the delta you return. This starter rewrites a deprecated",
    "`--shout` alias to the canonical `--upper` flag; replace it with your own",
    "normalization. The `parser` capability in `manifest.json` grants the",
    "registration.",
  ],
  preflight: [
    "",
    "## Preflight Override",
    "`index.ts` registers a preflight override through `api.registerPreflight`. pm",
    "calls it before every command to compute the migration/format gate decision —",
    "the last registered override wins. This starter echoes the current decision",
    "unchanged (a safe no-op); return only the decision keys you want to change.",
    "The `preflight` capability in `manifest.json` grants the registration.",
  ],
  services: [
    "",
    "## Service Override",
    "`index.ts` overrides the built-in `output_format` service through",
    "`api.registerService`. Returning the payload unchanged passes through to pm's",
    "default formatting, so this starter scopes itself to its own command and",
    "passes every other command through. The `services` capability in",
    "`manifest.json` grants the registration.",
  ],
};

// README activation explainer for command-bearing starters (commands/hooks/
// search/importers): they declare `activation.commands` so pm loads them lazily.
const LAZY_ACTIVATION_README_SECTION: Record<
  "package" | "extension",
  readonly string[]
> = {
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
const SCHEMA_ACTIVATION_README_SECTION: Record<
  "package" | "extension",
  readonly string[]
> = {
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

// README activation explainer for the `profile` starter: the contributed profile
// is resolved by the built-in `pm profile list/show/apply` commands (which the
// package does not own), so it intentionally omits `activation.commands` and relies
// on pm's conservative activation tier (granted by the `schema` capability).
const PROFILE_ACTIVATION_README_SECTION: Record<
  "package" | "extension",
  readonly string[]
> = {
  package: [
    "",
    "## Activation",
    "This package contributes a project profile resolved by the built-in",
    "`pm profile list`, `pm profile show <name>`, and `pm profile apply <name>`",
    "commands — commands the package does not own — so `manifest.json` intentionally",
    "declares no `activation.commands`. pm activates the package conservatively (for",
    "every command, granted by the `schema` capability) so the profile is present",
    "whenever `pm profile` runs. Declaring narrow `activation.commands` here would",
    "gate activation to only the listed commands and silently leave the profile",
    "unregistered for `pm profile`.",
  ],
  extension: [
    "",
    "## Activation",
    "This extension contributes a project profile resolved by the built-in",
    "`pm profile list`, `pm profile show <name>`, and `pm profile apply <name>`",
    "commands, so `manifest.json` intentionally declares no `activation.commands`. pm",
    "activates the extension conservatively (for every command, granted by the",
    "`schema` capability) so the profile is present whenever `pm profile` runs.",
    "Declaring narrow `activation.commands` here would silently leave the profile",
    "unregistered for `pm profile`.",
  ],
};

/**
 * Build the README "Included Files" bullet describing `manifest.json` for the
 * chosen capability and vocabulary. The `schema` and `profile` starters omit
 * `activation.commands` (see {@link buildScaffoldActivationCommands}), so their
 * bullet explains the global-contribution tradeoff instead of referencing a field
 * they deliberately lack.
 */
function buildScaffoldManifestBullet(
  capability: ExtensionScaffoldCapability,
  vocabulary: "extension" | "package",
): string {
  if (capability === "schema") {
    return `- \`manifest.json\`: ${vocabulary} metadata and capabilities (no \`activation.commands\` — the custom item type activates for every command).`;
  }
  if (capability === "profile") {
    return `- \`manifest.json\`: ${vocabulary} metadata and capabilities (no \`activation.commands\` — the contributed profile resolves through \`pm profile\` for every command).`;
  }
  return `- \`manifest.json\`: ${vocabulary} metadata, capabilities, and \`activation.commands\` (the command paths that lazily activate this ${vocabulary}).`;
}

/** Select the README activation section for the chosen capability and vocabulary: the `schema` and `profile` starters explain conservative activation (they omit `activation.commands`); every other capability documents lazy activation. */
function buildScaffoldActivationReadmeSection(
  capability: ExtensionScaffoldCapability,
  vocabulary: "extension" | "package",
): readonly string[] {
  if (capability === "schema") {
    return SCHEMA_ACTIVATION_README_SECTION[vocabulary];
  }
  if (capability === "profile") {
    return PROFILE_ACTIVATION_README_SECTION[vocabulary];
  }
  return LAZY_ACTIVATION_README_SECTION[vocabulary];
}

interface ExtensionScaffoldFileResult {
  path: string;
  status: "created" | "unchanged";
}

interface ExtensionScaffoldResult {
  extension_name: string;
  command_name: string;
  capability: ExtensionScaffoldCapability;
  /** Authoring style of the generated entrypoint: `"imperative"` (a hand-written `activate` body, the default) or `"declarative"` (a `composeExtension` blueprint). The declarative style is package-mode only (any capability). */
  style: ExtensionScaffoldStyle;
  target_path: string;
  created_directory: boolean;
  files: ExtensionScaffoldFileResult[];
}

/**
 * Authoring style the scaffolder targets for the generated entrypoint. The
 * default `"imperative"` emits a hand-written `activate` body; `"declarative"`
 * emits the SDK's `composeExtension` blueprint loop (package-mode only, for any
 * capability — see {@link buildDeclarativeEntrypoint}).
 */
export type ExtensionScaffoldStyle = "imperative" | "declarative";

/** Builds the starter command path from the normalized package/extension name. Names that start with a built-in pm command or executable alias are prefixed with `starter` so the generated command dispatches to the package instead of being consumed by core command parsing. */
export function buildScaffoldCommandName(extensionName: string): string {
  const commandWords = extensionName
    .replace(/-/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (commandWords.length === 0) {
    return "starter ping";
  }
  const firstWordLower = commandWords[0]!.toLowerCase();
  let leadingStarterWords = 0;
  while (commandWords[leadingStarterWords]?.toLowerCase() === "starter") {
    leadingStarterWords += 1;
  }
  const nextStarterWord = commandWords[leadingStarterWords]?.toLowerCase();
  const starterRootCollision =
    leadingStarterWords > 0 &&
    (leadingStarterWords === commandWords.length ||
      (nextStarterWord !== undefined &&
        RESERVED_SCAFFOLD_COMMAND_ROOTS.has(nextStarterWord)));
  const reservedRoot =
    RESERVED_SCAFFOLD_COMMAND_ROOTS.has(firstWordLower) || starterRootCollision;
  const resolvedWords = reservedRoot
    ? ["starter", ...commandWords]
    : commandWords;
  return `${resolvedWords.join(" ")} ping`;
}

/**
 * Build the project-profile archetype object literal the `profile` starter
 * registers — a complete {@link ProjectProfileDefinition} derived from the package
 * name: one custom item type, a custom status, a custom field, a per-type workflow,
 * offline search config, a create template, and an advisory package recommendation.
 *
 * Returned as the lines BETWEEN the object braces at a two-space base indent. Both
 * authoring styles read from this single source so they never drift: the imperative
 * {@link buildActivateBodyLines} wraps them in `api.registerProfile({ ... })`
 * (re-indenting by the `activate` body offset) and the declarative
 * {@link buildDeclarativeBlueprintSurface} wraps them in
 * `defineProjectProfile({ ... })`.
 */
function buildProfileArchetypeFieldLines(extensionName: string): string[] {
  const typeName = extensionName;
  const typeFolder = `${extensionName}s`;
  // De-hyphenate for a short alias; omit a redundant self-alias for single-word names.
  const typeAlias = extensionName.replace(/-/g, "");
  const typeAliases = typeAlias === typeName ? [] : [typeAlias];
  const fieldKey = `${extensionName.replace(/-/g, "_")}_owner`;
  const statusId = "reviewing";
  return [
    `  name: ${JSON.stringify(extensionName)},`,
    `  title: ${JSON.stringify(`${extensionName} archetype`)},`,
    '  summary: "Starter project profile. Replace these dimensions with your own archetype.",',
    "  // Item types the profile upserts into the project schema when applied.",
    "  types: [",
    "    {",
    `      name: ${JSON.stringify(typeName)},`,
    `      folder: ${JSON.stringify(typeFolder)},`,
    `      aliases: ${JSON.stringify(typeAliases)},`,
    `      description: ${JSON.stringify(`A ${extensionName} work item that flows to done.`)},`,
    "    },",
    "  ],",
    "  // Custom statuses upserted into the project status set.",
    "  statuses: [",
    "    {",
    `      id: ${JSON.stringify(statusId)},`,
    '      roles: ["active"],',
    '      aliases: ["in-review"],',
    '      description: "Work is implementation-complete and awaiting review.",',
    "    },",
    "  ],",
    "  // Custom item-metadata fields the archetype tracks.",
    "  fields: [",
    "    {",
    `      key: ${JSON.stringify(fieldKey)},`,
    '      type: "string",',
    '      commands: ["create", "update", "list"],',
    '      description: "Stakeholder accountable for the item.",',
    "    },",
    "  ],",
    "  // Per-type workflow transition allow-list staged into settings.",
    "  workflows: [",
    "    {",
    `      type: ${JSON.stringify(typeName)},`,
    "      allowed_transitions: [",
    '        ["open", "in_progress"],',
    `        ["in_progress", ${JSON.stringify(statusId)}],`,
    `        [${JSON.stringify(statusId)}, "in_progress"],`,
    `        [${JSON.stringify(statusId)}, "closed"],`,
    '        ["in_progress", "blocked"],',
    '        ["blocked", "in_progress"],',
    "      ],",
    "    },",
    "  ],",
    "  // Nested-settings knobs staged when the profile is applied.",
    "  config: [",
    '    { key: "search_provider", value: "bm25", summary: "Offline BM25 lexical search needs no embedding service." },',
    '    { key: "search_max_results", value: "20", summary: "Result cap tuned for quick triage." },',
    "  ],",
    "  // Create templates staged into <pmRoot>/templates.",
    "  templates: [",
    "    {",
    `      name: ${JSON.stringify(extensionName)},`,
    "      options: {",
    `        type: ${JSON.stringify(typeName)},`,
    '        priority: "2",',
    `        tags: ${JSON.stringify(extensionName)},`,
    '        acceptanceCriteria: "Item delivers the stated outcome with tests and docs updated.",',
    '        body: "## Context\\n\\n## Acceptance\\n- [ ] \\n",',
    "      },",
    "    },",
    "  ],",
    "  // Advisory package recommendations (never auto-installed).",
    "  packages: [",
    '    { spec: "templates", reason: "Reusable create templates for recurring item shapes." },',
    "  ],",
  ];
}

/** Build the `activate` body lines for the starter entrypoint. The base body always registers the starter command; capability-specific variants append the matching SDK surface so generated packages demonstrate one runnable customization primitive end to end. */
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
      '          const title = String(document.metadata.title ?? "").toLowerCase();',
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
      '    query: async (context) => [{ id: "starter-vector-hit", score: context.limit }],',
      "    upsert: async (context) => ({ upserted: context.points.length }),",
      "    delete: async (context) => ({ deleted: context.ids.length }),",
      "  });",
    ];
  }
  if (capability === "schema") {
    const itemTypeName = extensionName;
    const itemTypeFolder = `${extensionName}s`;
    // De-hyphenate for a short alias (e.g. "my-tracker" -> "mytracker"). For a
    // single-word name the de-hyphenated form equals the type name, so omit the
    // alias rather than register a redundant self-alias in the starter.
    const itemTypeAlias = extensionName.replace(/-/g, "");
    const itemTypeAliases =
      itemTypeAlias === itemTypeName ? [] : [itemTypeAlias];
    const fieldName = `${extensionName.replace(/-/g, "_")}_note`;
    const migrationId = `${extensionName}-0001-init`;
    return [
      ...commandLines,
      "",
      "  // Schema registrations let a package model its own project domain — the",
      '  // heart of "project management = context management". Item types and fields',
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
      `      aliases: ${JSON.stringify(itemTypeAliases)},`,
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
  if (capability === "profile") {
    return [
      ...commandLines,
      "",
      "  // A project profile is the broadest customization primitive pm has: one",
      "  // declarative bundle of item types, custom statuses, fields, a per-type",
      "  // workflow, config knobs, create templates, and package recommendations. Once",
      "  // this package is installed the profile resolves by name through `pm profile",
      "  // list`, `pm profile show`, and `pm profile apply`, which stages every dimension",
      "  // idempotently like a core archetype. A profile registration is a schema+config",
      "  // bundle, so the `schema` capability in manifest.json grants it.",
      "  api.registerProfile({",
      // The archetype field lines are all non-empty, so re-indent each by the
      // `activate` body offset (object braces sit at two spaces, fields at four).
      ...buildProfileArchetypeFieldLines(extensionName).map(
        (line) => `  ${line}`,
      ),
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
      '      source: context.options.source ?? "starter",',
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
      '      destination: context.options.destination ?? "stdout",',
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
  if (capability === "renderers") {
    return [
      ...commandLines,
      "",
      "  // Renderer overrides customize how pm serializes a command's structured",
      '  // result for an output format ("toon" or "json"). pm runs this override for',
      "  // EVERY command's output in that format, so it scopes itself to THIS",
      "  // package's own command and returns null — pass-through to pm's default",
      "  // renderer — for everything else. Return a string to take over rendering.",
      "  // The `renderers` capability in manifest.json grants the registration.",
      '  api.registerRenderer("toon", (context) => {',
      `    if (context.command !== ${JSON.stringify(commandName)}) {`,
      "      return null;",
      "    }",
      `    return ${JSON.stringify(`${extensionName}: `)} + JSON.stringify(context.result);`,
      "  });",
    ];
  }
  if (capability === "parser") {
    return [
      // The parser starter declares its own flags so the override is runnable end
      // to end through `pm <command> --shout`: the command defines the deprecated
      // `--shout` alias and canonical `--upper` flag, the parser rewrites one to
      // the other, and the handler surfaces the normalized value. Flag metadata
      // needs the `schema` capability (declared in manifest.json).
      "  api.registerCommand({",
      `    name: ${JSON.stringify(commandName)},`,
      '    description: "Starter scaffold command. Replace with your own behavior.",',
      "    flags: [",
      "      {",
      '        long: "--shout",',
      '        value_type: "boolean",',
      '        description: "Deprecated alias for --upper; the parser override rewrites it.",',
      "      },",
      "      {",
      '        long: "--upper",',
      '        value_type: "boolean",',
      '        description: "Echo the canonical flag the parser override produces.",',
      "      },",
      "    ],",
      "    run: async (context) => ({",
      "      ok: true,",
      `      source: ${JSON.stringify(extensionName)},`,
      "      command: context.command,",
      "      // Surfaces the normalized option so `--shout`/`--upper` is observable.",
      "      upper: context.options.upper === true,",
      '      message: "Starter extension scaffold is active.",',
      "    }),",
      "  });",
      "",
      "  // Parser overrides preprocess a command's parsed options BEFORE its handler",
      "  // runs, returning a delta — only the keys you set are merged over the parsed",
      "  // input. This override is scoped to THIS package's own command. Here it",
      "  // rewrites the deprecated `--shout` boolean alias to the canonical `--upper`",
      "  // flag; replace it with your command's real normalization. The `parser`",
      "  // capability in manifest.json grants the registration.",
      `  api.registerParser(${JSON.stringify(commandName)}, (context) => {`,
      "    const options = { ...context.options };",
      "    if (options.shout === true) {",
      "      options.upper = true;",
      "    }",
      "    delete options.shout;",
      "    return { options };",
      "  });",
    ];
  }
  if (capability === "preflight") {
    return [
      ...commandLines,
      "",
      "  // Preflight overrides adjust pm's pre-run gate decision (extension",
      "  // migrations + item-format checks) before EVERY command — the last",
      "  // registered override wins. Return a delta of the keys you want to change",
      "  // (enforce_item_format_gate, run_preflight_item_format_sync,",
      "  // run_extension_migrations, enforce_mandatory_migration_gate); returning",
      "  // context.decision unchanged is a safe no-op so installing the package does",
      "  // not alter gate behavior — replace it with your policy, e.g.",
      "  // `{ run_extension_migrations: false }`. The `preflight` capability in",
      "  // manifest.json grants the registration.",
      "  api.registerPreflight((context) => context.decision);",
    ];
  }
  if (capability === "services") {
    return [
      ...commandLines,
      "",
      "  // Service overrides replace a built-in pm service. The `output_format`",
      "  // service renders a command's structured result; returning the payload",
      "  // unchanged passes through to pm's default formatting. This override scopes",
      "  // itself to THIS package's own command and passes every other command",
      "  // through, so it never disrupts unrelated output. The `services` capability",
      "  // in manifest.json grants the registration.",
      '  api.registerService("output_format", (context) => {',
      `    if (context.command !== ${JSON.stringify(commandName)}) {`,
      "      return context.payload;",
      "    }",
      `    return { rendered_by: ${JSON.stringify(extensionName)}, payload: context.payload };`,
      "  });",
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

/** Build the colocated `node:test` sample suite (`index.test.ts`) for the chosen capability. Authored in TypeScript and run through the generated package's `npm test` script (typecheck first, then `node --test`, which strips types on Node >=22.18), it imports the `./index.ts` manifest entry directly under NodeNext resolution. Every variant covers activation, command invocation, and teardown via `createExtensionTestHarness`; capability variants add tests that use the harness-bound `assert*`/`run*` helpers and deactivate in `finally`. */
function buildSampleTestSource(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string {
  const hooksEnabled = capability === "hooks";
  const searchEnabled = capability === "search";
  const importersEnabled = capability === "importers";
  const schemaEnabled = capability === "schema";
  const profileEnabled = capability === "profile";
  const renderersEnabled = capability === "renderers";
  const parserEnabled = capability === "parser";
  const preflightEnabled = capability === "preflight";
  const servicesEnabled = capability === "services";
  const capabilitiesLiteral = SAMPLE_TEST_CAPABILITIES_LITERAL[capability];
  const itemTypeName = extensionName;
  const itemTypeFolder = `${extensionName}s`;
  const fieldName = `${extensionName.replace(/-/g, "_")}_note`;
  const migrationId = `${extensionName}-0001-init`;
  const importNames = [
    "  assertExtensionDeactivated,",
    "  createExtensionTestHarness,",
  ];
  const hookTestLines = hooksEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} reacts to commands via its after_command hook`)}, async () => {`,
        "  const ext = await createExtensionTestHarness(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  let deactivated = false;",
        "  try {",
        "    // assertHook throws unless an after_command hook is registered, so",
        "    // reaching the next line already proves the hook is wired.",
        "    ext.assertHook({",
        '      kind: "after_command",',
        `      extensionName: ${JSON.stringify(extensionName)},`,
        "    });",
        "    // runHook fires the hook through pm's real runner with a synthetic",
        "    // context and returns the warnings it produced; a clean hook returns none.",
        "    // Replace the context/assertions as your hook grows.",
        "    const warnings = await ext.runHook({",
        '      kind: "after_command",',
        "      context: {",
        `        command: ${JSON.stringify(commandName)},`,
        "        args: [],",
        '        pm_root: "",',
        "        ok: true,",
        "        affected: [],",
        "      },",
        "    });",
        "    assert.deepEqual(warnings, []);",
        "    const teardown = await ext.deactivate();",
        "    assertExtensionDeactivated(teardown);",
        "    deactivated = true;",
        ...SAMPLE_HARNESS_FINALLY_LINES,
        "});",
        "",
      ]
    : [];
  const searchTestLines = searchEnabled
    ? buildDeclarativeCapabilityTestBlock(
        extensionName,
        commandName,
        "search",
        capabilitiesLiteral,
      )
    : [];
  const importerTestLines = importersEnabled
    ? buildDeclarativeCapabilityTestBlock(
        extensionName,
        commandName,
        "importers",
        capabilitiesLiteral,
      )
    : [];
  const schemaTestLines = schemaEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} registers and runs its custom schema`)}, async () => {`,
        "  const ext = await createExtensionTestHarness(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  let deactivated = false;",
        "  try {",
        ...indentGeneratedLines(
          buildSchemaCapabilityAssertionLines({
            extensionName,
            itemTypeName,
            itemTypeFolder,
            fieldName,
            migrationId,
            includeMigrationReplacementHint: true,
          }),
          "  ",
        ),
        "    const teardown = await ext.deactivate();",
        "    assertExtensionDeactivated(teardown);",
        "    deactivated = true;",
        ...SAMPLE_HARNESS_FINALLY_LINES,
        "});",
        "",
      ]
    : [];
  const profileTestLines = profileEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} registers its project profile`)}, async () => {`,
        "  const ext = await createExtensionTestHarness(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  let deactivated = false;",
        "  try {",
        ...indentGeneratedLines(
          buildProfileCapabilityAssertionLines(extensionName),
          "  ",
        ),
        "    const teardown = await ext.deactivate();",
        "    assertExtensionDeactivated(teardown);",
        "    deactivated = true;",
        ...SAMPLE_HARNESS_FINALLY_LINES,
        "});",
        "",
      ]
    : [];
  const rendererTestLines = renderersEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} registers and invokes its renderer override`)}, async () => {`,
        "  const ext = await createExtensionTestHarness(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  let deactivated = false;",
        "  try {",
        "    // assertRendererOverride throws unless a renderer is registered for the",
        "    // format, so reaching the next line already proves the wiring.",
        `    const override = ext.assertRendererOverride({ format: "toon", extensionName: ${JSON.stringify(extensionName)} });`,
        '    assert.equal(override.format, "toon");',
        "",
        "    // runRendererOverride renders through pm's real runner. The override",
        "    // customizes only THIS package's command output and returns a string the",
        "    // host uses verbatim. Replace the assertions as it grows.",
        "    const rendered = await ext.runRendererOverride({",
        '      format: "toon",',
        `      command: ${JSON.stringify(commandName)},`,
        "      result: { ok: true },",
        "    });",
        "    assert.equal(rendered.overridden, true);",
        `    assert.equal(rendered.rendered, ${JSON.stringify(`${extensionName}: `)} + JSON.stringify({ ok: true }));`,
        "",
        "    // Output for any other command passes through to pm's default renderer.",
        "    const passthrough = await ext.runRendererOverride({",
        '      format: "toon",',
        '      command: "list",',
        "      result: { ok: true },",
        "    });",
        "    assert.equal(passthrough.overridden, false);",
        "    const teardown = await ext.deactivate();",
        "    assertExtensionDeactivated(teardown);",
        "    deactivated = true;",
        ...SAMPLE_HARNESS_FINALLY_LINES,
        "});",
        "",
      ]
    : [];
  const parserTestLines = parserEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} rewrites command options via its parser override`)}, async () => {`,
        "  const ext = await createExtensionTestHarness(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  let deactivated = false;",
        "  try {",
        "    // assertParserOverride throws unless a parser is registered for the",
        "    // command, so reaching the next line already proves the wiring.",
        `    ext.assertParserOverride({ command: ${JSON.stringify(commandName)}, extensionName: ${JSON.stringify(extensionName)} });`,
        "",
        "    // runParserOverride runs the override through pm's real parser runner and",
        "    // returns the rewritten context. The starter rewrites the deprecated",
        "    // `shout` alias to the canonical `upper` flag.",
        "    const result = await ext.runParserOverride({",
        `      command: ${JSON.stringify(commandName)},`,
        "      args: [],",
        "      options: { shout: true },",
        "      global: {},",
        '      pm_root: "",',
        "    });",
        "    assert.equal(result.overridden, true);",
        "    assert.deepEqual(result.context.options, { upper: true });",
        "",
        "    // End to end: feed the rewritten options into the command handler to",
        "    // prove `pm <command> --shout` surfaces the normalized `upper` flag in",
        "    // the result.",
        `    const invocation = await ext.runCommand({ command: ${JSON.stringify(commandName)}, options: result.context.options });`,
        "    assert.equal(invocation.handled, true);",
        "    assert.deepEqual(invocation.result, {",
        "      ok: true,",
        `      source: ${JSON.stringify(extensionName)},`,
        `      command: ${JSON.stringify(commandName)},`,
        "      upper: true,",
        '      message: "Starter extension scaffold is active.",',
        "    });",
        "    const teardown = await ext.deactivate();",
        "    assertExtensionDeactivated(teardown);",
        "    deactivated = true;",
        ...SAMPLE_HARNESS_FINALLY_LINES,
        "});",
        "",
      ]
    : [];
  const preflightTestLines = preflightEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} returns a preflight gate decision via its override`)}, async () => {`,
        "  const ext = await createExtensionTestHarness(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  let deactivated = false;",
        "  try {",
        "    // assertPreflightOverride throws unless a preflight override is",
        "    // registered, so reaching the next line already proves the wiring.",
        `    ext.assertPreflightOverride({ extensionName: ${JSON.stringify(extensionName)} });`,
        "",
        "    // runPreflightOverride runs the override through pm's real runner with a",
        "    // synthetic gate decision. The starter echoes the decision unchanged;",
        "    // replace the values/assertions with your real policy.",
        "    const decision = {",
        "      enforce_item_format_gate: true,",
        "      run_preflight_item_format_sync: false,",
        "      run_extension_migrations: true,",
        "      enforce_mandatory_migration_gate: false,",
        "    };",
        "    const result = await ext.runPreflightOverride({",
        `      command: ${JSON.stringify(commandName)},`,
        "      args: [],",
        "      options: {},",
        "      global: {},",
        '      pm_root: "",',
        "      decision,",
        "    });",
        "    assert.equal(result.overridden, true);",
        "    assert.deepEqual(result.decision, decision);",
        "    const teardown = await ext.deactivate();",
        "    assertExtensionDeactivated(teardown);",
        "    deactivated = true;",
        ...SAMPLE_HARNESS_FINALLY_LINES,
        "});",
        "",
      ]
    : [];
  const serviceTestLines = servicesEnabled
    ? [
        `test(${JSON.stringify(`${extensionName} customizes command output via its service override`)}, async () => {`,
        "  const ext = await createExtensionTestHarness(extension, {",
        `    name: ${JSON.stringify(extensionName)},`,
        `    capabilities: ${capabilitiesLiteral},`,
        "  });",
        "  let deactivated = false;",
        "  try {",
        "    // assertServiceOverride throws unless a service override is registered",
        "    // for the service, so reaching the next line proves the wiring.",
        `    ext.assertServiceOverride({ service: "output_format", extensionName: ${JSON.stringify(extensionName)} });`,
        "",
        "    // runServiceOverride runs the override through pm's real service runner.",
        "    // The override customizes only THIS package's command output (handled),",
        "    // passing every other command through (not handled).",
        "    const handled = await ext.runServiceOverride({",
        '      service: "output_format",',
        `      command: ${JSON.stringify(commandName)},`,
        "      payload: { ok: true },",
        "    });",
        "    assert.equal(handled.handled, true);",
        `    assert.deepEqual(handled.result, { rendered_by: ${JSON.stringify(extensionName)}, payload: { ok: true } });`,
        "",
        "    // Output for any other command passes through to pm's default formatter.",
        "    const passthrough = await ext.runServiceOverride({",
        '      service: "output_format",',
        '      command: "list",',
        "      payload: { ok: true },",
        "    });",
        "    assert.equal(passthrough.handled, false);",
        "    const teardown = await ext.deactivate();",
        "    assertExtensionDeactivated(teardown);",
        "    deactivated = true;",
        ...SAMPLE_HARNESS_FINALLY_LINES,
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
    ...(searchEnabled
      ? [
          'import type { ItemDocument, PmSettings } from "@unbrained/pm-cli/sdk";',
        ]
      : []),
    'import extension from "./index.ts";',
    "",
    ...SAMPLE_HARNESS_CLEANUP_LINES,
    `test(${JSON.stringify(`${extensionName} registers its starter command`)}, async () => {`,
    "  // `capabilities` mirrors manifest.json so the in-memory activation grants",
    "  // the capabilities the entrypoint relies on.",
    "  const ext = await createExtensionTestHarness(extension, {",
    `    name: ${JSON.stringify(extensionName)},`,
    `    capabilities: ${capabilitiesLiteral},`,
    "  });",
    "  let deactivated = false;",
    "  try {",
    "    // assertCommandContract is bound to the right activation registry and throws",
    "    // if the command is not registered, so reaching here already proves the",
    "    // wiring; assert on the returned definition to inspect metadata.",
    "    const registered = ext.assertCommandContract({",
    `      command: ${JSON.stringify(commandName)},`,
    `      extensionName: ${JSON.stringify(extensionName)},`,
    "    });",
    '    assert.equal(typeof registered.command.description, "string");',
    "",
    "    // runCommand invokes the handler through pm's real dispatch engine, so this",
    "    // asserts behavior - not just that the command is wired. Replace these",
    "    // assertions as you flesh out your command.",
    "    const invocation = await ext.runCommand({",
    `      command: ${JSON.stringify(commandName)},`,
    "    });",
    "    assert.equal(invocation.handled, true);",
    "    // The handler result is typed `unknown`, so deep-equality on the whole",
    "    // structured payload keeps the assertion type-safe without a cast.",
    "    assert.deepEqual(invocation.result, {",
    "      ok: true,",
    `      source: ${JSON.stringify(extensionName)},`,
    `      command: ${JSON.stringify(commandName)},`,
    // The parser starter's command surfaces the normalized `upper` flag, which
    // defaults to false when the command is invoked without `--shout`/`--upper`.
    ...(parserEnabled ? ["      upper: false,"] : []),
    '      message: "Starter extension scaffold is active.",',
    "    });",
    "    const teardown = await ext.deactivate();",
    "    assertExtensionDeactivated(teardown);",
    "    deactivated = true;",
    ...SAMPLE_HARNESS_FINALLY_LINES,
    "});",
    "",
    ...hookTestLines,
    ...searchTestLines,
    ...importerTestLines,
    ...schemaTestLines,
    ...profileTestLines,
    ...rendererTestLines,
    ...parserTestLines,
    ...preflightTestLines,
    ...serviceTestLines,
    `test(${JSON.stringify(`${extensionName} tears down cleanly via deactivate`)}, async () => {`,
    "  // createExtensionTestHarness binds teardown to the same name/layer used for",
    "  // activation, so this proves your `deactivate` hook runs without throwing.",
    "  const ext = await createExtensionTestHarness(extension, {",
    `    name: ${JSON.stringify(extensionName)},`,
    `    capabilities: ${capabilitiesLiteral},`,
    "  });",
    "  const teardown = await ext.deactivate();",
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
 * The `schema` and `profile` variants are the deliberate exceptions: each returns
 * an empty list so the manifest omits `activation.commands`. Custom item types and
 * fields are GLOBAL schema contributions that built-in commands (`pm create
 * <type>`, `pm list --type <type>`, `pm validate`) must see, and a contributed
 * project profile is resolved by the built-in `pm profile list/show/apply` commands
 * — commands the package does not own and cannot enumerate. Declaring narrow
 * `activation.commands` there would gate activation to only the listed commands and
 * silently leave the custom type or profile unregistered for those built-ins;
 * omitting it lets pm's conservative activation tier (which covers `schema`) load
 * the package for every command.
 */
function buildScaffoldActivationCommands(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string[] {
  if (capability === "schema" || capability === "profile") {
    return [];
  }
  if (capability === "importers") {
    const adapterName = `${extensionName.replace(/-/g, " ")} items`;
    return [commandName, `${adapterName} import`, `${adapterName} export`];
  }
  return [commandName];
}

// One-line surface phrase per capability, listing the registration surfaces the
// declarative blueprint populates beyond the always-present starter command. Used
// to keep the generated README's entrypoint bullet accurate per capability.
const DECLARATIVE_ENTRYPOINT_SURFACE_PHRASE: Record<
  ExtensionScaffoldCapability,
  string
> = {
  commands: "starter command",
  hooks: "starter command and after_command hook",
  search: "starter command, search provider, and vector-store adapter",
  importers: "starter command, importer, and exporter",
  schema: "starter command, custom item type, item field, and migration",
  profile: "starter command and project profile",
  renderers: "starter command and toon renderer override",
  parser: "starter command and parser override",
  preflight: "starter command and preflight override",
  services: "starter command and output_format service override",
};

// The `ExtensionBlueprint` fields each capability populates, rendered as inline
// code in the README's Declarative Authoring section so authors can see which
// blueprint surface maps to the capability they scaffolded.
const DECLARATIVE_CAPABILITY_BLUEPRINT_FIELDS: Record<
  ExtensionScaffoldCapability,
  string
> = {
  commands: "`commands`",
  hooks: "`commands` and `hooks.afterCommand`",
  search: "`commands`, `searchProviders`, and `vectorStoreAdapters`",
  importers: "`commands`, `importers`, and `exporters`",
  schema: "`commands`, `itemTypes`, `itemFields`, and `migrations`",
  profile: "`commands` and `profiles`",
  renderers: "`commands` and `renderers`",
  parser: "`commands` and `parsers`",
  preflight: "`commands` and `preflights`",
  services: "`commands` and `services`",
};

/**
 * The shared per-capability registration-definition builder for the declarative
 * starter: the `define*`-authored definitions, the `ExtensionBlueprint` fields that
 * collect them, and the extra `define*` builder names to import. It is the single
 * source the declarative {@link buildDeclarativeEntrypoint} and its colocated test
 * ({@link buildDeclarativeCapabilityTestBlock}) both read from, so the two never
 * drift on what the capability registers.
 */
interface DeclarativeBlueprintSurface {
  /** Extra `define*` builder names to import beyond the always-present trio. */
  builderImports: string[];
  /** The `export const <name> = define*({...})` definition blocks (blank-separated). */
  definitions: string[];
  /** The `ExtensionBlueprint` object field lines, e.g. `  searchProviders: [searchProvider],`. */
  blueprintFields: string[];
}

/**
 * Build the `defineCommand` starter-command definition for the declarative
 * entrypoint. Mirrors the imperative {@link buildActivateBodyLines} command body
 * (same name/description/run result), and for the `parser` capability declares the
 * `--shout`/`--upper` flags and surfaces the normalized `upper` option so the
 * override is runnable end to end through `pm <command> --shout`.
 */
function buildDeclarativePingCommandLines(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string[] {
  const parserEnabled = capability === "parser";
  return [
    "// The starter command, authored with the `defineCommand` builder so its literal",
    "// name is preserved and the handler `context` is inferred. Exporting it lets you",
    "// unit-test the definition in isolation, apart from the blueprint.",
    "export const pingCommand = defineCommand({",
    `  name: ${JSON.stringify(commandName)},`,
    '  description: "Starter scaffold command. Replace with your own behavior.",',
    ...(parserEnabled
      ? [
          "  flags: [",
          "    {",
          '      long: "--shout",',
          '      value_type: "boolean",',
          '      description: "Deprecated alias for --upper; the parser override rewrites it.",',
          "    },",
          "    {",
          '      long: "--upper",',
          '      value_type: "boolean",',
          '      description: "Echo the canonical flag the parser override produces.",',
          "    },",
          "  ],",
        ]
      : []),
    "  run: async (context) => ({",
    "    ok: true,",
    `    source: ${JSON.stringify(extensionName)},`,
    "    command: context.command,",
    ...(parserEnabled ? ["    upper: context.options.upper === true,"] : []),
    '    message: "Starter extension scaffold is active.",',
    "  }),",
    "});",
  ];
}

/**
 * Build the {@link DeclarativeBlueprintSurface} for a capability: the starter
 * command plus the capability's `define*`-authored registration definitions and
 * the `ExtensionBlueprint` fields that collect them.
 *
 * Blueprint fields are emitted in {@link composeExtension}'s registration order so
 * the generated `activate` wires them deterministically. Each surface mirrors the
 * imperative {@link buildActivateBodyLines} registration (same names, same handler
 * behavior) so a package scaffolded in either style installs and dispatches
 * identically — the manifest, derived capabilities, and registered surfaces match.
 */
function buildDeclarativeBlueprintSurface(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): DeclarativeBlueprintSurface {
  const builderImports: string[] = [];
  const definitions: string[] = [
    ...buildDeclarativePingCommandLines(extensionName, commandName, capability),
  ];
  const blueprintFields: string[] = ["  commands: [pingCommand],"];

  const searchProviderName = `${extensionName}-search`;
  const vectorAdapterName = `${extensionName}-vector`;
  const adapterName = `${extensionName.replace(/-/g, " ")} items`;
  const itemTypeName = extensionName;
  const itemTypeFolder = `${extensionName}s`;
  // De-hyphenate for a short alias; omit a redundant self-alias for single-word names.
  const itemTypeAlias = extensionName.replace(/-/g, "");
  const itemTypeAliases = itemTypeAlias === itemTypeName ? [] : [itemTypeAlias];
  const fieldName = `${extensionName.replace(/-/g, "_")}_note`;
  const migrationId = `${extensionName}-0001-init`;

  switch (capability) {
    case "commands":
      break;
    case "hooks":
      builderImports.push("defineAfterCommandHook");
      definitions.push(
        "",
        "// after_command hooks fire once pm finishes a command, receiving the items it",
        "// mutated. React here - sync to an external system, emit telemetry, or refresh",
        '// derived context ("project management = context management"). This starter is a',
        "// documented no-op on the success path; replace the body with your own reaction.",
        "export const afterCommandHook = defineAfterCommandHook((context) => {",
        "  if (!context.ok) {",
        "    return;",
        "  }",
        "  // `context.affected` lists the items pm mutated (id, status, changed_fields):",
        "  //   for (const item of context.affected ?? []) { /* ...item.id... */ }",
        "});",
      );
      blueprintFields.push("  hooks: { afterCommand: [afterCommandHook] },");
      break;
    case "search":
      builderImports.push("defineSearchProvider", "defineVectorStoreAdapter");
      definitions.push(
        "",
        "// Search providers let packages customize how pm ranks and retrieves project",
        "// context. This starter is deterministic and dependency-free: replace the scoring",
        "// with your domain retrieval, embedding, or rerank logic as the package grows.",
        "export const searchProvider = defineSearchProvider({",
        `  name: ${JSON.stringify(searchProviderName)},`,
        "  query: async (context) => {",
        "    const needle = context.query.toLowerCase();",
        "    const hits = context.documents",
        "      .filter((document) => {",
        '        const title = String(document.metadata.title ?? "").toLowerCase();',
        "        return title.includes(needle);",
        "      })",
        "      .map((document) => ({",
        "        id: document.metadata.id,",
        "        score: 1,",
        '        matched_fields: ["title"],',
        "      }));",
        "    return { hits };",
        "  },",
        "  embed: async (context) => [context.input.length],",
        "});",
        "",
        "// Vector-store adapters let packages own semantic index storage. This starter",
        "// returns a stable in-memory hit so generated tests can exercise the adapter",
        "// without external services.",
        "export const vectorStoreAdapter = defineVectorStoreAdapter({",
        `  name: ${JSON.stringify(vectorAdapterName)},`,
        '  query: async (context) => [{ id: "starter-vector-hit", score: context.limit }],',
        "  upsert: async (context) => ({ upserted: context.points.length }),",
        "  delete: async (context) => ({ deleted: context.ids.length }),",
        "});",
      );
      blueprintFields.push(
        "  searchProviders: [searchProvider],",
        "  vectorStoreAdapters: [vectorStoreAdapter],",
      );
      break;
    case "importers":
      builderImports.push("defineExporter", "defineImporter");
      definitions.push(
        "",
        "// Importers/exporters are the bridge between pm's context graph and another",
        "// project-management system. Keep the starter deterministic so package tests can",
        "// run without touching the network or filesystem; replace these payloads with",
        "// your adapter's real mapping as the package grows.",
        "export const importer = defineImporter(async (context) => ({",
        "  imported: 1,",
        '  source: context.options.source ?? "starter",',
        "  args: context.args,",
        "}));",
        "",
        "export const exporter = defineExporter(async (context) => ({",
        "  exported: true,",
        '  destination: context.options.destination ?? "stdout",',
        "  args: context.args,",
        "}));",
      );
      blueprintFields.push(
        "  importers: [",
        "    {",
        `      name: ${JSON.stringify(adapterName)},`,
        "      importer,",
        "      options: {",
        `        action: ${JSON.stringify(`${adapterName} import`)},`,
        '        description: "Import starter records into pm context.",',
        "        flags: [",
        "          {",
        '            long: "--source",',
        '            value_name: "name",',
        '            value_type: "string",',
        '            description: "Source name or path to import from.",',
        "          },",
        "        ],",
        "      },",
        "    },",
        "  ],",
        "  exporters: [",
        "    {",
        `      name: ${JSON.stringify(adapterName)},`,
        "      exporter,",
        "      options: {",
        `        action: ${JSON.stringify(`${adapterName} export`)},`,
        '        description: "Export pm context into starter records.",',
        "        flags: [",
        "          {",
        '            long: "--destination",',
        '            value_name: "name",',
        '            value_type: "string",',
        '            description: "Destination name or path to export to.",',
        "          },",
        "        ],",
        "      },",
        "    },",
        "  ],",
      );
      break;
    case "schema":
      builderImports.push(
        "defineItemField",
        "defineItemType",
        "defineMigration",
      );
      definitions.push(
        "",
        "// Schema registrations let a package model its own project domain - the heart of",
        '// "project management = context management". Item types and fields are GLOBAL',
        "// contributions, so this package declares no `activation.commands` and pm",
        "// activates it conservatively for every command.",
        "export const noteField = defineItemField({",
        `  name: ${JSON.stringify(fieldName)},`,
        '  type: "string",',
        "  optional: true,",
        "});",
        "",
        "export const itemType = defineItemType({",
        `  name: ${JSON.stringify(itemTypeName)},`,
        "  // Replace with your domain's canonical plural folder name.",
        `  folder: ${JSON.stringify(itemTypeFolder)},`,
        `  aliases: ${JSON.stringify(itemTypeAliases)},`,
        "  // Add field names here to force them at `pm create` time.",
        "  required_create_fields: [],",
        "});",
        "",
        "// Migrations let a package evolve stored items as its schema changes. pm runs each",
        "// migration ONCE through the preflight gate (not once per item), passing a context",
        "// that identifies the migration itself: `context.id` is the migration id (not an",
        "// item id), alongside `context.pm_root`. This starter is a deterministic no-op so",
        "// package tests can invoke it without touching the corpus; replace the body with",
        "// your real rewrite.",
        "export const initMigration = defineMigration({",
        `  id: ${JSON.stringify(migrationId)},`,
        `  description: ${JSON.stringify(`Initialize ${extensionName} schema state.`)},`,
        "  mandatory: false,",
        "  run: async (context) => ({ migrated: true, id: context.id }),",
        "});",
      );
      blueprintFields.push(
        "  itemTypes: [itemType],",
        "  itemFields: [noteField],",
        "  migrations: [initMigration],",
      );
      break;
    case "profile":
      builderImports.push("defineProjectProfile");
      definitions.push(
        "",
        "// A project profile is the broadest customization primitive pm has: one",
        "// declarative bundle of item types, custom statuses, fields, a per-type workflow,",
        "// config knobs, create templates, and package recommendations. Once installed it",
        "// resolves by name through `pm profile list/show/apply`, which stages every",
        "// dimension idempotently like a core archetype. A profile registration is a",
        "// schema+config bundle, so the `schema` capability grants it.",
        "export const starterProfile = defineProjectProfile({",
        ...buildProfileArchetypeFieldLines(extensionName),
        "});",
      );
      blueprintFields.push("  profiles: [starterProfile],");
      break;
    case "renderers":
      builderImports.push("defineRendererOverride");
      definitions.push(
        "",
        "// Renderer overrides customize how pm serializes a command's structured result",
        '// for an output format ("toon" or "json"). pm runs this override for EVERY',
        "// command's output in that format, so it scopes itself to THIS package's own",
        "// command and returns null - pass-through to pm's default renderer - for",
        "// everything else. Return a string to take over rendering.",
        "export const toonRenderer = defineRendererOverride((context) => {",
        `  if (context.command !== ${JSON.stringify(commandName)}) {`,
        "    return null;",
        "  }",
        `  return ${JSON.stringify(`${extensionName}: `)} + JSON.stringify(context.result);`,
        "});",
      );
      blueprintFields.push("  renderers: { toon: toonRenderer },");
      break;
    case "parser":
      builderImports.push("defineParserOverride");
      definitions.push(
        "",
        "// Parser overrides preprocess a command's parsed options BEFORE its handler runs,",
        "// returning a delta - only the keys you set are merged over the parsed input. This",
        "// override is scoped to THIS package's own command; here it rewrites the deprecated",
        "// `--shout` boolean alias to the canonical `--upper` flag.",
        "export const pingParser = defineParserOverride((context) => {",
        "  const options = { ...context.options };",
        "  if (options.shout === true) {",
        "    options.upper = true;",
        "  }",
        "  delete options.shout;",
        "  return { options };",
        "});",
      );
      blueprintFields.push(
        `  parsers: { ${JSON.stringify(commandName)}: pingParser },`,
      );
      break;
    case "preflight":
      builderImports.push("definePreflightOverride");
      definitions.push(
        "",
        "// Preflight overrides adjust pm's pre-run gate decision (extension migrations +",
        "// item-format checks) before EVERY command - the last registered override wins.",
        "// Return a delta of the keys you want to change (enforce_item_format_gate,",
        "// run_preflight_item_format_sync, run_extension_migrations,",
        "// enforce_mandatory_migration_gate); returning context.decision unchanged is a",
        "// safe no-op - replace it with your policy, e.g. { run_extension_migrations: false }.",
        "export const preflightOverride = definePreflightOverride((context) => context.decision);",
      );
      blueprintFields.push("  preflights: [preflightOverride],");
      break;
    case "services":
      builderImports.push("defineServiceOverride");
      definitions.push(
        "",
        "// Service overrides replace a built-in pm service. The `output_format` service",
        "// renders a command's structured result; returning the payload unchanged passes",
        "// through to pm's default formatting. This override scopes itself to THIS",
        "// package's own command and passes every other command through.",
        "export const outputService = defineServiceOverride((context) => {",
        `  if (context.command !== ${JSON.stringify(commandName)}) {`,
        "    return context.payload;",
        "  }",
        `  return { rendered_by: ${JSON.stringify(extensionName)}, payload: context.payload };`,
        "});",
      );
      blueprintFields.push("  services: { output_format: outputService },");
      break;
  }

  return { builderImports, definitions, blueprintFields };
}

/**
 * Build the declarative (`composeExtension`) variant of the starter `index.ts` for
 * the chosen capability.
 *
 * Where {@link buildActivateBodyLines} emits an imperative `activate` that calls
 * `api.register*` directly, this emits the SDK's flagship declarative loop: the
 * capability's surfaces are authored with the `define*` builders (via the shared
 * {@link buildDeclarativeBlueprintSurface}), collected into an `ExtensionBlueprint`
 * by `defineExtensionBlueprint`, and turned into the runtime module by
 * `composeExtension` (which generates the `activate` that registers every blueprint
 * surface in order). Every definition, the blueprint, and the module are exported
 * so the colocated test can preflight the blueprint and exercise the module — see
 * {@link buildDeclarativeSampleTestSource}.
 *
 * It is package-mode by construction: `composeExtension` is a runtime SDK *value*
 * import, so it belongs in package-mode authoring where the SDK is a linked
 * dependency, not in the import-free extension-only starters.
 * {@link scaffoldExtensionProject} enforces that constraint before this is reached.
 */
function buildDeclarativeEntrypoint(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string {
  const surface = buildDeclarativeBlueprintSurface(
    extensionName,
    commandName,
    capability,
  );
  // `composeExtension`/`defineCommand`/`defineExtensionBlueprint` are always needed;
  // sort the full set so the import line is stable and idiomatic per capability.
  const builderImports = [
    "composeExtension",
    "defineCommand",
    "defineExtensionBlueprint",
    ...surface.builderImports,
  ].sort((left, right) => left.localeCompare(right));
  return [
    `import { ${builderImports.join(", ")} } from "@unbrained/pm-cli/sdk";`,
    "",
    ...surface.definitions,
    "",
    "// Declarative authoring: describe WHAT the package registers as a blueprint and",
    "// let `composeExtension` generate the `activate` that wires every surface in order,",
    "// instead of hand-writing each `api.register*` call. `defineExtensionBlueprint`",
    "// contract-checks the blueprint where it is authored. Keep `manifest.json`'s",
    "// `capabilities` equal to the set this blueprint derives.",
    "export const blueprint = defineExtensionBlueprint({",
    ...surface.blueprintFields,
    "  // `deactivate` is the teardown counterpart to the generated `activate`: pm runs",
    "  // it on host shutdown/reload to release anything the package opened (timers,",
    "  // connections, caches). This starter holds none, so it stays a no-op.",
    "  deactivate: () => {},",
    "});",
    "",
    "// `composeExtension(blueprint)` is the package's default export — the runtime",
    "// `ExtensionModule` pm loads. Guard the blueprint with `assertExtensionPreflight`",
    "// in index.test.ts before publishing.",
    "export default composeExtension(blueprint);",
    "",
  ].join("\n");
}

/**
 * Build the capability-specific `node:test` block for the declarative starter:
 * a dedicated test that activates the composed module through
 * {@link ExtensionTestHarness} and asserts + invokes the capability's surface
 * (hook, search provider/adapter, importer/exporter, schema, renderer, parser,
 * preflight, or service override). Returns `[]` for the `commands` capability,
 * whose only surface — the starter command — is already covered by the base test.
 *
 * Each block mirrors the imperative {@link buildSampleTestSource} capability test
 * but reaches it through the harness's bound `assert*`/`run*` helpers instead of
 * the standalone helpers, so the declarative starter never threads
 * `activation.registrations` / `activation.parsers` / ... by hand.
 */
function buildDeclarativeCapabilityTestBlock(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
  capabilitiesLiteral: string,
): string[] {
  if (capability === "commands") {
    return [];
  }
  const searchProviderName = `${extensionName}-search`;
  const vectorAdapterName = `${extensionName}-vector`;
  const adapterName = `${extensionName.replace(/-/g, " ")} items`;
  const itemTypeName = extensionName;
  const itemTypeFolder = `${extensionName}s`;
  const fieldName = `${extensionName.replace(/-/g, "_")}_note`;
  const migrationId = `${extensionName}-0001-init`;
  const harness = [
    "  const ext = await createExtensionTestHarness(extension, {",
    `    name: ${JSON.stringify(extensionName)},`,
    `    capabilities: ${capabilitiesLiteral},`,
    "  });",
  ];
  const withHarnessCleanup = (body: string[]): string[] => [
    ...harness,
    "  let deactivated = false;",
    "  try {",
    ...body.map((line) => (line === "" ? line : `  ${line}`)),
    "    const teardown = await ext.deactivate();",
    "    assertExtensionDeactivated(teardown);",
    "    deactivated = true;",
    ...SAMPLE_HARNESS_FINALLY_LINES,
  ];
  switch (capability) {
    case "hooks":
      return [
        `test(${JSON.stringify(`${extensionName} reacts to commands via its after_command hook`)}, async () => {`,
        ...withHarnessCleanup([
          "  // assertHook throws unless an after_command hook is registered, so reaching the",
          "  // next line already proves the hook is wired.",
          `  ext.assertHook({ kind: "after_command", extensionName: ${JSON.stringify(extensionName)} });`,
          "  // runHook fires the hook through pm's real runner with a synthetic context and",
          "  // returns the warnings it produced; a clean hook returns none.",
          "  const warnings = await ext.runHook({",
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
        ]),
        "});",
        "",
      ];
    case "search":
      return [
        `test(${JSON.stringify(`${extensionName} registers and invokes search primitives`)}, async () => {`,
        ...withHarnessCleanup([
          `  ext.assertSearchProvider({ provider: ${JSON.stringify(searchProviderName)}, extensionName: ${JSON.stringify(extensionName)} });`,
          `  ext.assertVectorStoreAdapter({ adapter: ${JSON.stringify(vectorAdapterName)}, extensionName: ${JSON.stringify(extensionName)} });`,
          "",
          "  // The starter provider reads only document title/id, so `settings` is a minimal",
          "  // typed stub and `documents` carry just the fields it inspects.",
          "  const query = await ext.runSearchProvider({",
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
          "  const embedding = await ext.runSearchProvider({",
          `    provider: ${JSON.stringify(searchProviderName)},`,
          '    operation: "embed",',
          '    context: { input: "abc", settings: {} as PmSettings, model: "starter-model" },',
          "  });",
          "  assert.deepEqual(embedding, [3]);",
          "",
          "  const vectorHits = await ext.runVectorStoreAdapter({",
          `    adapter: ${JSON.stringify(vectorAdapterName)},`,
          '    operation: "query",',
          "    context: { vector: [0.1, 0.2], limit: 2, settings: {} as PmSettings },",
          "  });",
          '  assert.deepEqual(vectorHits, [{ id: "starter-vector-hit", score: 2 }]);',
        ]),
        "});",
        "",
      ];
    case "importers":
      return [
        `test(${JSON.stringify(`${extensionName} registers and invokes import/export primitives`)}, async () => {`,
        ...withHarnessCleanup([
          `  ext.assertImporter({ importer: ${JSON.stringify(adapterName)}, extensionName: ${JSON.stringify(extensionName)} });`,
          `  ext.assertExporter({ exporter: ${JSON.stringify(adapterName)}, extensionName: ${JSON.stringify(extensionName)} });`,
          "",
          "  const imported = await ext.runImporter({",
          `    importer: ${JSON.stringify(adapterName)},`,
          '    options: { source: "tickets" },',
          '    args: ["batch-1"],',
          "  });",
          "  assert.equal(imported.handled, true);",
          '  assert.deepEqual(imported.result, { imported: 1, source: "tickets", args: ["batch-1"] });',
          "",
          "  const exported = await ext.runExporter({",
          `    exporter: ${JSON.stringify(adapterName)},`,
          '    options: { destination: "archive" },',
          '    args: ["done"],',
          "  });",
          "  assert.equal(exported.handled, true);",
          '  assert.deepEqual(exported.result, { exported: true, destination: "archive", args: ["done"] });',
        ]),
        "});",
        "",
      ];
    case "schema":
      return [
        `test(${JSON.stringify(`${extensionName} registers and runs its custom schema`)}, async () => {`,
        ...withHarnessCleanup(
          buildSchemaCapabilityAssertionLines({
            extensionName,
            itemTypeName,
            itemTypeFolder,
            fieldName,
            migrationId,
          }),
        ),
        "});",
        "",
      ];
    case "profile":
      return [
        `test(${JSON.stringify(`${extensionName} registers its project profile`)}, async () => {`,
        ...withHarnessCleanup(
          buildProfileCapabilityAssertionLines(extensionName),
        ),
        "});",
        "",
      ];
    case "renderers":
      return [
        `test(${JSON.stringify(`${extensionName} registers and invokes its renderer override`)}, async () => {`,
        ...withHarnessCleanup([
          "  // assertRendererOverride throws unless a renderer is registered for the format,",
          "  // so reaching the next line already proves the wiring.",
          `  const override = ext.assertRendererOverride({ format: "toon", extensionName: ${JSON.stringify(extensionName)} });`,
          '  assert.equal(override.format, "toon");',
          "",
          "  // runRendererOverride renders through pm's real runner. The override customizes",
          "  // only THIS package's command output and returns a string the host uses verbatim.",
          "  const rendered = await ext.runRendererOverride({",
          '    format: "toon",',
          `    command: ${JSON.stringify(commandName)},`,
          "    result: { ok: true },",
          "  });",
          "  assert.equal(rendered.overridden, true);",
          `  assert.equal(rendered.rendered, ${JSON.stringify(`${extensionName}: `)} + JSON.stringify({ ok: true }));`,
          "",
          "  // Output for any other command passes through to pm's default renderer.",
          "  const passthrough = await ext.runRendererOverride({",
          '    format: "toon",',
          '    command: "list",',
          "    result: { ok: true },",
          "  });",
          "  assert.equal(passthrough.overridden, false);",
        ]),
        "});",
        "",
      ];
    case "parser":
      return [
        `test(${JSON.stringify(`${extensionName} rewrites command options via its parser override`)}, async () => {`,
        ...withHarnessCleanup([
          "  // assertParserOverride throws unless a parser is registered for the command, so",
          "  // reaching the next line already proves the wiring.",
          `  ext.assertParserOverride({ command: ${JSON.stringify(commandName)}, extensionName: ${JSON.stringify(extensionName)} });`,
          "",
          "  // runParserOverride runs the override through pm's real parser runner and returns",
          "  // the rewritten context. The starter rewrites the deprecated `shout` alias to the",
          "  // canonical `upper` flag.",
          "  const result = await ext.runParserOverride({",
          `    command: ${JSON.stringify(commandName)},`,
          "    args: [],",
          "    options: { shout: true },",
          "    global: {},",
          '    pm_root: "",',
          "  });",
          "  assert.equal(result.overridden, true);",
          "  assert.deepEqual(result.context.options, { upper: true });",
          "",
          "  // End to end: feed the rewritten options into the command handler to prove",
          "  // `pm <command> --shout` surfaces the normalized `upper` flag in the result.",
          `  const invocation = await ext.runCommand({ command: ${JSON.stringify(commandName)}, options: result.context.options });`,
          "  assert.equal(invocation.handled, true);",
          "  assert.deepEqual(invocation.result, {",
          "    ok: true,",
          `    source: ${JSON.stringify(extensionName)},`,
          `    command: ${JSON.stringify(commandName)},`,
          "    upper: true,",
          '    message: "Starter extension scaffold is active.",',
          "  });",
        ]),
        "});",
        "",
      ];
    case "preflight":
      return [
        `test(${JSON.stringify(`${extensionName} returns a preflight gate decision via its override`)}, async () => {`,
        ...withHarnessCleanup([
          "  // assertPreflightOverride throws unless a preflight override is registered, so",
          "  // reaching the next line already proves the wiring.",
          `  ext.assertPreflightOverride({ extensionName: ${JSON.stringify(extensionName)} });`,
          "",
          "  // runPreflightOverride runs the override through pm's real runner with a synthetic",
          "  // gate decision. The starter echoes the decision unchanged; replace the",
          "  // values/assertions with your real policy.",
          "  const decision = {",
          "    enforce_item_format_gate: true,",
          "    run_preflight_item_format_sync: false,",
          "    run_extension_migrations: true,",
          "    enforce_mandatory_migration_gate: false,",
          "  };",
          "  const result = await ext.runPreflightOverride({",
          `    command: ${JSON.stringify(commandName)},`,
          "    args: [],",
          "    options: {},",
          "    global: {},",
          '    pm_root: "",',
          "    decision,",
          "  });",
          "  assert.equal(result.overridden, true);",
          "  assert.deepEqual(result.decision, decision);",
        ]),
        "});",
        "",
      ];
    case "services":
      return [
        `test(${JSON.stringify(`${extensionName} customizes command output via its service override`)}, async () => {`,
        ...withHarnessCleanup([
          "  // assertServiceOverride throws unless a service override is registered for the",
          "  // service, so reaching the next line proves the wiring.",
          `  ext.assertServiceOverride({ service: "output_format", extensionName: ${JSON.stringify(extensionName)} });`,
          "",
          "  // runServiceOverride runs the override through pm's real service runner. The",
          "  // override customizes only THIS package's command output (handled), passing every",
          "  // other command through (not handled).",
          "  const handled = await ext.runServiceOverride({",
          '    service: "output_format",',
          `    command: ${JSON.stringify(commandName)},`,
          "    payload: { ok: true },",
          "  });",
          "  assert.equal(handled.handled, true);",
          `  assert.deepEqual(handled.result, { rendered_by: ${JSON.stringify(extensionName)}, payload: { ok: true } });`,
          "",
          "  // Output for any other command passes through to pm's default formatter.",
          "  const passthrough = await ext.runServiceOverride({",
          '    service: "output_format",',
          '    command: "list",',
          "    payload: { ok: true },",
          "  });",
          "  assert.equal(passthrough.handled, false);",
        ]),
        "});",
        "",
      ];
  }
}

/**
 * Build the declarative variant of the colocated `node:test` suite
 * (`index.test.ts`) for the chosen capability's `composeExtension` starter.
 *
 * Like {@link buildSampleTestSource}, this uses the harness-bound runtime
 * helpers; it also exercises the author-time capstone the declarative loop
 * unlocks:
 * `assertExtensionPreflight(blueprint, { identity, target })` (lint + manifest
 * synthesis + version-compat in one call) over the exported `blueprint`, and the
 * ergonomic runtime `createExtensionTestHarness(module)` whose `assert*`/`run*`/
 * `deactivate` methods are pre-bound to the right activation sub-registry. The base
 * suite covers preflight, the starter command, and teardown; for non-`commands`
 * capabilities {@link buildDeclarativeCapabilityTestBlock} adds a dedicated test for
 * the capability's surface. The `identity`/`target` versions are pinned to the
 * scaffolded `pm_min_version` so the synthesized manifest is trivially compatible
 * and the suite stays deterministic; an author edits them as the package matures.
 */
function buildDeclarativeSampleTestSource(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string {
  const parserEnabled = capability === "parser";
  // The preflight report's capability set is DERIVED from the blueprint and SORTED,
  // so assert against the sorted manifest capabilities (a set match in canonical
  // order); the harness `capabilities` grant uses the same literal.
  const capabilitiesLiteral = JSON.stringify(
    [...SCAFFOLD_MANIFEST_CAPABILITIES[capability]].sort(),
  );
  return [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { assertExtensionDeactivated, assertExtensionPreflight, createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";',
    // The search sample's synthetic query/vector contexts reference these SDK types
    // for their typed-stub fixtures; other capabilities need no extra type imports.
    ...(capability === "search"
      ? [
          'import type { ItemDocument, PmSettings } from "@unbrained/pm-cli/sdk";',
        ]
      : []),
    'import extension, { blueprint } from "./index.ts";',
    "",
    ...SAMPLE_HARNESS_CLEANUP_LINES,
    `test(${JSON.stringify(`${extensionName} passes author-time preflight`)}, () => {`,
    "  // assertExtensionPreflight is the author-time capstone: it lints the blueprint,",
    "  // synthesizes the least-privilege manifest from `identity`, and checks the version",
    "  // bounds against `target` in one call, throwing on any blocking finding. It returns",
    "  // the full report so you can inspect the derived data.",
    "  const report = assertExtensionPreflight(blueprint, {",
    "    identity: {",
    `      name: ${JSON.stringify(extensionName)},`,
    '      version: "0.1.0",',
    '      entry: "./index.ts",',
    "      priority: 0,",
    `      pm_min_version: ${JSON.stringify(SCAFFOLD_PM_MIN_VERSION)},`,
    "    },",
    `    target: { pmVersion: ${JSON.stringify(SCAFFOLD_PM_MIN_VERSION)} },`,
    "  });",
    "  // The capability set is DERIVED from the blueprint, never hand-synced. Keep",
    "  // manifest.json's `capabilities` equal to this list (set match, sorted).",
    `  assert.deepEqual(report.capabilities, ${capabilitiesLiteral});`,
    `  assert.deepEqual(report.manifest?.capabilities, ${capabilitiesLiteral});`,
    "});",
    "",
    `test(${JSON.stringify(`${extensionName} registers and runs its starter command`)}, async () => {`,
    "  // createExtensionTestHarness activates the composed module once and binds the",
    "  // assert*/run*/deactivate helpers to the right activation sub-registry, so you",
    "  // never thread activation.registrations vs activation.commands by hand.",
    "  // `capabilities` mirrors manifest.json so the in-memory activation grants what the",
    "  // blueprint needs.",
    "  const ext = await createExtensionTestHarness(extension, {",
    `    name: ${JSON.stringify(extensionName)},`,
    `    capabilities: ${capabilitiesLiteral},`,
    "  });",
    "  let deactivated = false;",
    "  try {",
    "    // assertCommandContract throws unless the command is registered, so reaching",
    "    // the next line already proves the wiring; assert on the returned definition",
    "    // to demonstrate inspecting registered metadata.",
    `    const registered = ext.assertCommandContract({ command: ${JSON.stringify(commandName)} });`,
    '    assert.equal(typeof registered.command.description, "string");',
    "",
    "    // runCommand invokes the handler through pm's real dispatch engine, so this",
    "    // asserts behavior - not just that the command is wired. Replace these",
    "    // assertions as you flesh out your command.",
    `    const invocation = await ext.runCommand({ command: ${JSON.stringify(commandName)} });`,
    "    assert.equal(invocation.handled, true);",
    "    assert.deepEqual(invocation.result, {",
    "      ok: true,",
    `      source: ${JSON.stringify(extensionName)},`,
    `      command: ${JSON.stringify(commandName)},`,
    // The parser starter's command surfaces the normalized `upper` flag, false when
    // the command is invoked without `--shout`/`--upper`.
    ...(parserEnabled ? ["      upper: false,"] : []),
    '      message: "Starter extension scaffold is active.",',
    "    });",
    "    // deactivate runs pm's real teardown engine over the module; exactly one",
    "    // extension tears down with no failures.",
    "    const teardown = await ext.deactivate();",
    "    assertExtensionDeactivated(teardown);",
    "    deactivated = true;",
    ...SAMPLE_HARNESS_FINALLY_LINES,
    "});",
    "",
    ...buildDeclarativeCapabilityTestBlock(
      extensionName,
      commandName,
      capability,
      capabilitiesLiteral,
    ),
  ].join("\n");
}

/**
 * Build the README for the declarative (`composeExtension`) package starter for
 * the chosen capability.
 *
 * It documents the same metadata/validation sections as the imperative package
 * README but frames the entrypoint around the declarative loop and the author-time
 * preflight test, so the generated docs match the generated `index.ts`/
 * `index.test.ts`. The included-files bullets, the Declarative Authoring blueprint
 * fields, and the activation section are capability-aware: the `schema` starter
 * contributes a global item type (so it omits `activation.commands`), while every
 * other capability declares the command paths that lazily activate the package.
 */
function buildDeclarativePackageReadme(
  packageName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
): string {
  // The schema/profile starters omit `activation.commands` (their surface is a
  // global contribution), so describe the manifest accurately and use the
  // conservative-activation section.
  const manifestBullet = buildScaffoldManifestBullet(capability, "package");
  const activationSection = buildScaffoldActivationReadmeSection(
    capability,
    "package",
  );
  return [
    `# ${packageName}`,
    "",
    "Generated by `pm package init --declarative`.",
    "",
    "## Included Files",
    "- `package.json`: package metadata, `typecheck`/`test` scripts, and `pm` resource manifest.",
    manifestBullet,
    `- \`index.ts\`: the TypeScript manifest entry — a \`defineExtensionBlueprint\` blueprint (${DECLARATIVE_ENTRYPOINT_SURFACE_PHRASE[capability]}) composed into the runtime module by \`composeExtension\`, plus a \`deactivate\` teardown stub.`,
    "- `index.test.ts`: sample `node:test` suite covering author-time preflight (`assertExtensionPreflight`) and runtime surface invocation/teardown via `createExtensionTestHarness`.",
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
    "## Declarative Authoring",
    "`index.ts` uses the SDK's declarative authoring loop instead of an imperative",
    "`activate` body. You describe WHAT the package registers as an",
    "`ExtensionBlueprint` and `composeExtension` generates the `activate` that wires",
    "every surface in order:",
    "- The `define*` builders author each surface with literal-type preservation and",
    "  contextual handler inference (`defineCommand`, `defineSearchProvider`,",
    "  `defineItemType`, `defineParserOverride`, ...).",
    `- \`defineExtensionBlueprint({ ... })\` collects the definitions into the blueprint;`,
    `  this starter populates ${DECLARATIVE_CAPABILITY_BLUEPRINT_FIELDS[capability]}. Add more`,
    "  fields as the package grows.",
    "- `composeExtension(blueprint)` is the default export — the runtime module pm",
    "  loads. Its generated `activate` requires exactly the capabilities the blueprint",
    "  derives, so `manifest.json`'s `capabilities` never drift.",
    "",
    "## Validate the Package",
    "`npm install` pulls the peer SDK and TypeScript. `npm test` is the default",
    "validation gate: it type-checks the package, then runs the colocated sample:",
    "```bash",
    "npm install",
    "npm test",
    "```",
    "`index.test.ts` exercises both authoring capstones: `assertExtensionPreflight`",
    "(the author-time lint + manifest synthesis + version-compatibility check over the",
    "exported `blueprint`) and `createExtensionTestHarness` (the runtime fixture whose",
    "`assert*`/`run*`/`deactivate` methods bind to the right activation sub-registry).",
    "`npm run typecheck` is available when you only want the SDK contract check.",
    "`npm run test:runtime` runs just `node --test`, which strips types on load and",
    "executes `index.test.ts` directly against the `@unbrained/pm-cli/sdk/testing`",
    "helpers - no compile step and no extra test runner required.",
    ...activationSection,
    "",
    "## Compatibility Bounds",
    "`manifest.json` cannot hold comments, so the version-compatibility fields are documented here:",
    `- \`manifest_version\` (integer): manifest schema generation. Leave at \`${SCAFFOLD_MANIFEST_VERSION}\` unless you adopt a newer manifest schema.`,
    `- \`pm_min_version\` (string): lowest pm CLI version that may load this package. Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\`. The loader blocks the package on older CLIs.`,
    "- `pm_max_version` (string, optional): highest pm CLI version that may load this package. Add it to block CLIs that are newer than the version you have validated against. The loader blocks the package when the CLI exceeds this bound.",
    "",
    "## Policy Metadata",
    'The starter command is pure compute, so `manifest.json` declares `trusted: true`, `sandbox_profile: "strict"`, and all six permission keys as `false`. Keep that least-privilege shape for pure packages; relax only the specific permission your package actually needs and verify with `pm package doctor --project --detail deep --trace`.',
    "",
    "## Notes",
    "- Author in `index.ts`; pm loads it directly (no build), so edits take effect on the next install/reload — there is no `.js` to regenerate.",
    "- Move larger runtimes into sibling or subdirectory `*.ts` modules and import them with their real `.ts` extension; `tsconfig.json` type-checks every `*.ts` in the package (recursively).",
    "- Use `@unbrained/pm-cli/sdk` as the public SDK import for richer package runtimes.",
    "",
  ].join("\n");
}

/** Derived, deterministic identifier set the package `define*` README snippets reference: the search/vector adapter names, the importer/exporter adapter label, the custom item type/folder/aliases, the note field, and the seed migration id. All are projected from `extensionName` so the generated snippet matches the generated `index.ts`. */
interface ScaffoldSnippetNames {
  searchProviderName: string;
  vectorAdapterName: string;
  adapterName: string;
  itemTypeName: string;
  itemTypeFolder: string;
  itemTypeAliases: string[];
  fieldName: string;
  migrationId: string;
}

/**
 * Project the {@link ScaffoldSnippetNames} for `extensionName`, omitting a
 * redundant self-alias when the de-hyphenated form already equals the type name.
 */
function buildScaffoldSnippetNames(
  extensionName: string,
): ScaffoldSnippetNames {
  const itemTypeName = extensionName;
  const itemTypeAlias = extensionName.replace(/-/g, "");
  return {
    searchProviderName: `${extensionName}-search`,
    vectorAdapterName: `${extensionName}-vector`,
    adapterName: `${extensionName.replace(/-/g, " ")} items`,
    itemTypeName,
    itemTypeFolder: `${extensionName}s`,
    itemTypeAliases: itemTypeAlias === itemTypeName ? [] : [itemTypeAlias],
    fieldName: `${extensionName.replace(/-/g, "_")}_note`,
    migrationId: `${extensionName}-0001-init`,
  };
}

/** Build the comma-separated `define*` builder import list for the README snippet, including only the builders the chosen capability demonstrates. */
function buildDefineBuilderImports(
  capability: ExtensionScaffoldCapability,
): string {
  return [
    "defineCommand",
    ...(capability === "hooks" ? ["defineAfterCommandHook"] : []),
    ...(capability === "search"
      ? ["defineSearchProvider", "defineVectorStoreAdapter"]
      : []),
    ...(capability === "importers" ? ["defineImporter", "defineExporter"] : []),
    ...(capability === "schema"
      ? ["defineItemType", "defineItemField", "defineMigration"]
      : []),
    ...(capability === "profile" ? ["defineProjectProfile"] : []),
    ...(capability === "renderers" ? ["defineRendererOverride"] : []),
    ...(capability === "parser" ? ["defineParserOverride"] : []),
    ...(capability === "preflight" ? ["definePreflightOverride"] : []),
    ...(capability === "services" ? ["defineServiceOverride"] : []),
  ].join(", ");
}

/** Build the exported `define*` declarations for the README snippet: the base `pingCommand` (with parser flags for the parser capability) plus the one capability-specific export the chosen capability demonstrates. */
function buildDefineBuilderExports(
  extensionName: string,
  commandName: string,
  capability: ExtensionScaffoldCapability,
  names: ScaffoldSnippetNames,
): string[] {
  const lines = [
    "export const pingCommand = defineCommand({",
    `  name: ${JSON.stringify(commandName)},`,
    '  description: "Starter scaffold command. Replace with your own behavior.",',
    // The parser starter's command declares the flags its override normalizes so
    // the demo is runnable through `pm <command> --shout`, and surfaces the
    // canonical `upper` flag in the result.
    ...(capability === "parser"
      ? [
          "  flags: [",
          '    { long: "--shout", value_type: "boolean", description: "Deprecated alias for --upper." },',
          '    { long: "--upper", value_type: "boolean", description: "Canonical flag the parser produces." },',
          "  ],",
          "  run: (context) => ({ ok: true, command: context.command, upper: context.options.upper === true }),",
        ]
      : ["  run: (context) => ({ ok: true, command: context.command }),"]),
    "});",
  ];
  if (capability === "hooks") {
    lines.push(
      "",
      "export const afterCommandHook = defineAfterCommandHook((context) => {",
      "  if (!context.ok) return;",
      "  // React to context.affected here as your package grows.",
      "});",
    );
  }
  if (capability === "search") {
    lines.push(
      "",
      "export const searchProvider = defineSearchProvider({",
      `  name: ${JSON.stringify(names.searchProviderName)},`,
      "  query: async (context) => ({",
      "    hits: context.documents",
      '      .filter((document) => String(document.metadata.title ?? "").toLowerCase().includes(context.query.toLowerCase()))',
      '      .map((document) => ({ id: document.metadata.id, score: 1, matched_fields: ["title"] })),',
      "  }),",
      "  embed: async (context) => [context.input.length],",
      "});",
      "",
      "export const vectorStoreAdapter = defineVectorStoreAdapter({",
      `  name: ${JSON.stringify(names.vectorAdapterName)},`,
      '  query: async (context) => [{ id: "starter-vector-hit", score: context.limit }],',
      "  upsert: async (context) => ({ upserted: context.points.length }),",
      "  delete: async (context) => ({ deleted: context.ids.length }),",
      "});",
    );
  }
  if (capability === "importers") {
    lines.push(
      "",
      "export const importer = defineImporter(async (context) => ({",
      "  imported: 1,",
      '  source: context.options.source ?? "starter",',
      "  args: context.args,",
      "}));",
      "",
      "export const exporter = defineExporter(async (context) => ({",
      "  exported: true,",
      '  destination: context.options.destination ?? "stdout",',
      "  args: context.args,",
      "}));",
    );
  }
  if (capability === "schema") {
    lines.push(
      "",
      `export const noteField = defineItemField({ name: ${JSON.stringify(names.fieldName)}, type: "string", optional: true });`,
      "",
      "export const itemType = defineItemType({",
      `  name: ${JSON.stringify(names.itemTypeName)},`,
      `  folder: ${JSON.stringify(names.itemTypeFolder)},`,
      `  aliases: ${JSON.stringify(names.itemTypeAliases)},`,
      "  required_create_fields: [],",
      "});",
      "",
      "export const initMigration = defineMigration({",
      `  id: ${JSON.stringify(names.migrationId)},`,
      `  description: ${JSON.stringify(`Initialize ${extensionName} schema state.`)},`,
      "  mandatory: false,",
      "  run: async (context) => ({ migrated: true, id: context.id }),",
      "});",
    );
  }
  if (capability === "profile") {
    // Abbreviated illustration; the generated index.ts populates every archetype
    // dimension (types, statuses, fields, workflow, config, template, packages).
    lines.push(
      "",
      "export const starterProfile = defineProjectProfile({",
      `  name: ${JSON.stringify(extensionName)},`,
      `  title: ${JSON.stringify(`${extensionName} archetype`)},`,
      '  summary: "Starter project profile. Replace these dimensions with your own archetype.",',
      "  types: [",
      `    { name: ${JSON.stringify(names.itemTypeName)}, folder: ${JSON.stringify(names.itemTypeFolder)} },`,
      "  ],",
      "  // ...plus statuses, fields, workflows, config, templates, and packages.",
      "});",
    );
  }
  if (capability === "renderers") {
    lines.push(
      "",
      "export const toonRenderer = defineRendererOverride((context) => {",
      `  if (context.command !== ${JSON.stringify(commandName)}) return null;`,
      `  return ${JSON.stringify(`${extensionName}: `)} + JSON.stringify(context.result);`,
      "});",
    );
  }
  if (capability === "parser") {
    lines.push(
      "",
      "export const pingParser = defineParserOverride((context) => {",
      "  const options = { ...context.options };",
      "  if (options.shout === true) options.upper = true;",
      "  delete options.shout;",
      "  return { options };",
      "});",
    );
  }
  if (capability === "preflight") {
    lines.push(
      "",
      "// Return a delta of the gate-decision keys you want to change; returning",
      "// context.decision unchanged is a safe no-op (e.g. { run_extension_migrations: false }).",
      "export const preflightOverride = definePreflightOverride((context) => context.decision);",
    );
  }
  if (capability === "services") {
    lines.push(
      "",
      "export const outputService = defineServiceOverride((context) => {",
      `  if (context.command !== ${JSON.stringify(commandName)}) return context.payload;`,
      `  return { rendered_by: ${JSON.stringify(extensionName)}, payload: context.payload };`,
      "});",
    );
  }
  return lines;
}

/**
 * Build the `activate` body registrations for the README snippet: one
 * `api.register*`/`api.hooks.*` call wiring the capability-specific exports
 * produced by {@link buildDefineBuilderExports}.
 */
function buildDefineBuilderActivate(
  commandName: string,
  capability: ExtensionScaffoldCapability,
  names: ScaffoldSnippetNames,
): string[] {
  const lines: string[] = [];
  if (capability === "renderers") {
    lines.push('  api.registerRenderer("toon", toonRenderer);');
  }
  if (capability === "parser") {
    lines.push(
      `  api.registerParser(${JSON.stringify(commandName)}, pingParser);`,
    );
  }
  if (capability === "preflight") {
    lines.push("  api.registerPreflight(preflightOverride);");
  }
  if (capability === "services") {
    lines.push('  api.registerService("output_format", outputService);');
  }
  if (capability === "hooks") {
    lines.push("  api.hooks.afterCommand(afterCommandHook);");
  }
  if (capability === "search") {
    lines.push(
      "  api.registerSearchProvider(searchProvider);",
      "  api.registerVectorStoreAdapter(vectorStoreAdapter);",
    );
  }
  if (capability === "schema") {
    lines.push(
      "  api.registerItemFields([noteField]);",
      "  api.registerItemTypes([itemType]);",
      "  api.registerMigration(initMigration);",
    );
  }
  if (capability === "profile") {
    lines.push("  api.registerProfile(starterProfile);");
  }
  if (capability === "importers") {
    lines.push(
      `  api.registerImporter(${JSON.stringify(names.adapterName)}, importer, {`,
      `    action: ${JSON.stringify(`${names.adapterName} import`)},`,
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
      `  api.registerExporter(${JSON.stringify(names.adapterName)}, exporter, {`,
      `    action: ${JSON.stringify(`${names.adapterName} export`)},`,
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
  return lines;
}

/** Implements build starter extension scaffold files for the public runtime surface of this module. */
export function buildStarterExtensionScaffoldFiles(
  extensionName: string,
  commandName: string,
  vocabulary: "extension" | "package",
  capability: ExtensionScaffoldCapability = "commands",
  declarative: boolean = false,
): Record<string, string> {
  const packageName = `pm-${extensionName}`;
  const capabilities = SCAFFOLD_MANIFEST_CAPABILITIES[capability];
  const activationCommands = buildScaffoldActivationCommands(
    extensionName,
    commandName,
    capability,
  );
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
      // The schema and profile starters omit this field (empty list) so their
      // global contribution — a custom item type/field, or a project profile
      // resolved by `pm profile` — stays available to built-in commands (see
      // buildScaffoldActivationCommands).
      ...(activationCommands.length > 0
        ? { activation: { commands: activationCommands } }
        : {}),
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
  // The schema/profile starters omit `activation.commands` (their surface is a
  // global contribution), so describe the manifest accurately instead of
  // referencing a field they deliberately lack.
  const manifestBullet = buildScaffoldManifestBullet(capability, vocabulary);
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
        // `test` is the self-validating author gate: typecheck first, then run
        // the colocated sample with Node's built-in runner (which strips types
        // on load) against the peer SDK testing helpers — no third-party test
        // runner or compile output required. `test:runtime` remains available
        // for tight loops after a separate `npm run typecheck`.
        scripts: {
          typecheck: "tsc --noEmit",
          "test:runtime": "node --test",
          test: "npm run typecheck && npm run test:runtime",
        },
        peerDependencies: {
          "@unbrained/pm-cli": `>=${SCAFFOLD_PM_MIN_VERSION}`,
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
    const sampleTest = buildSampleTestSource(
      extensionName,
      commandName,
      capability,
    );
    const sampleTestBullet = SAMPLE_TEST_BULLETS[capability];
    // The package commits only TypeScript source — pm loads the `.ts` entry
    // directly, so there is no compiled output to ignore. Keep dependencies and
    // the tsc incremental cache out of version control.
    const gitignore = ["node_modules/", "*.log", "*.tsbuildinfo", ""].join(
      "\n",
    );
    const names = buildScaffoldSnippetNames(extensionName);
    const defineBuilderImports = buildDefineBuilderImports(capability);
    const defineBuilderSnippet = [
      "```ts",
      `import { ${defineBuilderImports} } from "@unbrained/pm-cli/sdk";`,
      'import type { ExtensionApi } from "@unbrained/pm-cli/sdk";',
      "",
      ...buildDefineBuilderExports(
        extensionName,
        commandName,
        capability,
        names,
      ),
      "",
      "export function activate(api: ExtensionApi): void {",
      "  api.registerCommand(pingCommand);",
      ...buildDefineBuilderActivate(commandName, capability, names),
      "}",
      "",
      "export function deactivate(): void {}",
      "",
      "export default { activate, deactivate };",
      "```",
    ];
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
      "`npm install` pulls the peer SDK and TypeScript. `npm test` is the default",
      "validation gate: it type-checks the package, then runs the colocated sample:",
      "```bash",
      "npm install",
      "npm test",
      "```",
      "`npm run typecheck` is available when you only want the SDK contract check.",
      "`npm run test:runtime` runs just `node --test`, which strips types on load and",
      "executes `index.test.ts` directly against the `@unbrained/pm-cli/sdk/testing`",
      "helpers - no compile step and no extra test runner required.",
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
      ...buildScaffoldActivationReadmeSection(capability, "package"),
      "",
      "## Compatibility Bounds",
      "`manifest.json` cannot hold comments, so the version-compatibility fields are documented here:",
      `- \`manifest_version\` (integer): manifest schema generation. Leave at \`${SCAFFOLD_MANIFEST_VERSION}\` unless you adopt a newer manifest schema.`,
      `- \`pm_min_version\` (string): lowest pm CLI version that may load this package. Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\`. The loader blocks the package on older CLIs.`,
      "- `pm_max_version` (string, optional): highest pm CLI version that may load this package. Add it to block CLIs that are newer than the version you have validated against. The loader blocks the package when the CLI exceeds this bound.",
      "",
      "## Policy Metadata",
      'The starter command is pure compute, so `manifest.json` declares `trusted: true`, `sandbox_profile: "strict"`, and all six permission keys as `false`. Keep that least-privilege shape for pure packages; relax only the specific permission your package actually needs and verify with `pm package doctor --project --detail deep --trace`.',
      "",
      "## Notes",
      "- Author in `index.ts`; pm loads it directly (no build), so edits take effect on the next install/reload — there is no `.js` to regenerate.",
      "- Move larger runtimes into sibling or subdirectory `*.ts` modules and import them with their real `.ts` extension; `tsconfig.json` type-checks every `*.ts` in the package (recursively).",
      "- Add capabilities to the extension manifest only when the entrypoint uses the matching SDK API.",
      "- Use `@unbrained/pm-cli/sdk` as the public SDK import for richer package runtimes.",
      "",
    ].join("\n");
    // The declarative starter swaps the imperative entrypoint/test/README for the
    // `composeExtension` blueprint form (package-mode, any capability, enforced by
    // scaffoldExtensionProject). package.json, manifest.json, tsconfig.json, and
    // .gitignore are identical to the imperative starter for the same capability.
    return {
      "package.json": packageJson,
      "manifest.json": manifest,
      "index.ts": declarative
        ? buildDeclarativeEntrypoint(extensionName, commandName, capability)
        : entrypoint,
      "index.test.ts": declarative
        ? buildDeclarativeSampleTestSource(
            extensionName,
            commandName,
            capability,
          )
        : sampleTest,
      "tsconfig.json": tsconfig,
      ".gitignore": gitignore,
      "README.md": declarative
        ? buildDeclarativePackageReadme(packageName, commandName, capability)
        : packageReadme,
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
    '- `package.json`: `{ "type": "module" }` marker so the ESM entrypoint loads even when the host project is CommonJS.',
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
    ...buildScaffoldActivationReadmeSection(capability, "extension"),
    "",
    "## Compatibility Bounds",
    "`manifest.json` cannot hold comments, so the version-compatibility fields are documented here:",
    `- \`manifest_version\` (integer): manifest schema generation. Leave at \`${SCAFFOLD_MANIFEST_VERSION}\` unless you adopt a newer manifest schema.`,
    `- \`pm_min_version\` (string): lowest pm CLI version that may load this extension. Scaffolded as \`${SCAFFOLD_PM_MIN_VERSION}\`. The loader blocks the extension on older CLIs.`,
    "- `pm_max_version` (string, optional): highest pm CLI version that may load this extension. Add it to block CLIs that are newer than the version you have validated against. The loader blocks the extension when the CLI exceeds this bound.",
    "",
    "## Policy Metadata",
    'The starter command is pure compute, so `manifest.json` declares `trusted: true`, `sandbox_profile: "strict"`, and all six permission keys as `false`. Keep that least-privilege shape for pure extensions; relax only the specific permission your extension actually needs and verify with `pm extension --doctor --project --detail deep --trace`.',
    "",
    "- This scaffold is TypeScript ESM source loaded directly by pm (no compile), so it works in package scopes with `type: module`.",
    "- Author in `index.ts` (the manifest entry); edits take effect on the next install/reload — there is no `.js` to regenerate.",
    "- Release any resources `activate` opens (timers, connections, caches) in the `deactivate` teardown hook.",
    "",
  ].join("\n");
  return {
    "manifest.json": manifest,
    "index.ts": entrypoint,
    // Module-type marker: pm loads index.ts as ESM, and without a nearby
    // package.json Node inherits the host project's module type, breaking
    // installs into "type": "commonjs" projects (pm-r0m4).
    "package.json": `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    "tsconfig.json": tsconfig,
    "README.md": readme,
  };
}

/** Implements scaffold extension project for the public runtime surface of this module. */
export async function scaffoldExtensionProject(
  target: string,
  vocabulary: "extension" | "package" = "extension",
  capability: string = "commands",
  declarative: boolean = false,
): Promise<ExtensionScaffoldResult> {
  const normalizedCapability = capability.trim().toLowerCase();
  if (
    !(SCAFFOLD_CAPABILITIES as readonly string[]).includes(normalizedCapability)
  ) {
    throw new PmCliError(
      `Unknown scaffold capability "${capability}". Supported capabilities: ${SCAFFOLD_CAPABILITIES.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  const resolvedCapability =
    normalizedCapability as ExtensionScaffoldCapability;
  // The declarative (`composeExtension` blueprint) starter is package-mode only.
  // `composeExtension` is a runtime SDK *value* import, so it belongs in
  // package-mode authoring where the SDK is a linked dependency — not in the
  // import-free extension-only starters that must load without it. Every capability
  // emits its blueprint form (see buildDeclarativeBlueprintSurface).
  if (declarative && vocabulary !== "package") {
    throw new PmCliError(
      "--declarative scaffolds a package-mode blueprint starter (composeExtension is a runtime SDK import). Use `pm package init`, not `pm extension init`.",
      EXIT_CODE.USAGE,
    );
  }
  const style: ExtensionScaffoldStyle = declarative
    ? "declarative"
    : "imperative";
  const normalizedTarget = target.trim();
  const targetPath = path.resolve(process.cwd(), normalizedTarget);
  const extensionName = normalizeManagedDirectoryName(
    path.basename(targetPath),
  );
  // Hyphenated names become space-separated command words; reserved roots get a
  // `starter` prefix so core commands and aliases cannot intercept dispatch.
  const commandName = buildScaffoldCommandName(extensionName);
  const scaffoldFiles = buildStarterExtensionScaffoldFiles(
    extensionName,
    commandName,
    vocabulary,
    resolvedCapability,
    declarative,
  );

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
    style,
    target_path: targetPath,
    created_directory: createdDirectory,
    files,
  };
}
