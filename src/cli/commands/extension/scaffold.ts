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
const SCAFFOLD_DECLARED_PERMISSIONS = {
  fs_read: false,
  fs_write: false,
  network: false,
  env_read: false,
  env_write: false,
  process_spawn: false,
};

/**
 * Capability shapes the package/extension scaffolder can target via the
 * `--capability` selector. `commands` emits the default command-only starter;
 * `hooks` additionally wires an `after_command` lifecycle reactor, `search`
 * wires an in-memory provider/adapter pair, and `importers` wires importer and
 * exporter command primitives so authors can customize project context movement
 * without starting from a blank extension.
 */
export const SCAFFOLD_CAPABILITIES = ["commands", "hooks", "search", "importers"] as const;

/**
 * Restricts the `--capability` selector to a {@link SCAFFOLD_CAPABILITIES} value.
 */
export type ExtensionScaffoldCapability = (typeof SCAFFOLD_CAPABILITIES)[number];

const SCAFFOLD_MANIFEST_CAPABILITIES: Record<ExtensionScaffoldCapability, readonly string[]> = {
  commands: ["commands"],
  hooks: ["commands", "hooks"],
  search: ["commands", "search"],
  importers: ["commands", "schema", "importers"],
};

const SAMPLE_TEST_CAPABILITIES_LITERAL: Record<ExtensionScaffoldCapability, string> = {
  commands: '["commands"]',
  hooks: '["commands", "hooks"]',
  search: '["commands", "search"]',
  importers: '["commands", "schema", "importers"]',
};

const ENTRYPOINT_BULLETS: Record<ExtensionScaffoldCapability, string> = {
  commands: "- `index.js`: starter command registration plus a `deactivate` teardown stub.",
  hooks:
    "- `index.js`: starter command registration, an `after_command` lifecycle hook, and a `deactivate` teardown stub.",
  search:
    "- `index.js`: starter command registration, a search provider, a vector-store adapter, and a `deactivate` teardown stub.",
  importers:
    "- `index.js`: starter command registration, importer/exporter command registrations, and a `deactivate` teardown stub.",
};

const SAMPLE_TEST_BULLETS: Record<ExtensionScaffoldCapability, string> = {
  commands:
    "- `index.test.js`: sample `node:test` suite covering activation, command invocation, and teardown via the SDK testing helpers.",
  hooks:
    "- `index.test.js`: sample `node:test` suite covering activation, command invocation, the after_command hook, and teardown via the SDK testing helpers.",
  search:
    "- `index.test.js`: sample `node:test` suite covering activation, command invocation, search provider/vector adapter invocation, and teardown via the SDK testing helpers.",
  importers:
    "- `index.test.js`: sample `node:test` suite covering activation, command invocation, importer/exporter invocation, and teardown via the SDK testing helpers.",
};

const PACKAGE_CAPABILITY_README_SECTIONS: Record<ExtensionScaffoldCapability, readonly string[]> = {
  commands: [],
  hooks: [
    "",
    "## Lifecycle Hook",
    "`index.js` registers an `after_command` hook via `api.hooks.afterCommand`.",
    "pm fires it once a command finishes, passing the command outcome and the",
    "items it mutated (`context.affected`). React there to keep external context",
    "in sync - sync records, emit telemetry, or refresh derived state. The",
    "`hooks` capability in `manifest.json` is what grants the hook registration;",
    "remove it (and the hook) if your package only needs commands.",
  ],
  search: [
    "",
    "## Search Provider",
    "`index.js` registers a deterministic in-memory search provider and",
    "vector-store adapter through `api.registerSearchProvider` and",
    "`api.registerVectorStoreAdapter`. Replace the sample scoring,",
    "embedding, and storage behavior with your project-specific retrieval",
    "logic. The `search` capability in `manifest.json` grants both",
    "registrations.",
  ],
  importers: [
    "",
    "## Importer and Exporter",
    "`index.js` registers paired project-context import/export commands through",
    "`api.registerImporter` and `api.registerExporter`. Replace the starter",
    "payloads with your domain adapter: GitHub issues, CSV rows, documents,",
    "tickets, or another project-management source of truth. The `importers`",
    "capability grants both registrations, and `schema` grants the example",
    "command flag metadata.",
  ],
};

const EXTENSION_CAPABILITY_README_SECTIONS: Record<ExtensionScaffoldCapability, readonly string[]> = {
  commands: [],
  hooks: [
    "",
    "## Lifecycle Hook",
    "`index.js` registers an `after_command` hook via `api.hooks.afterCommand`.",
    "pm fires it once a command finishes, passing the command outcome and the",
    "items it mutated (`context.affected`). React there to keep external context",
    "in sync. The `hooks` capability in `manifest.json` grants the registration;",
    "remove it (and the hook) if your extension only needs commands.",
  ],
  search: [
    "",
    "## Search Provider",
    "`index.js` registers a deterministic in-memory search provider and",
    "vector-store adapter through `api.registerSearchProvider` and",
    "`api.registerVectorStoreAdapter`. Replace the sample scoring, embedding,",
    "and storage behavior with your project-specific retrieval logic. The",
    "`search` capability in `manifest.json` grants both registrations.",
  ],
  importers: [
    "",
    "## Importer and Exporter",
    "`index.js` registers paired project-context import/export commands through",
    "`api.registerImporter` and `api.registerExporter`. Replace the starter",
    "payloads with your domain adapter. The `importers` capability grants both",
    "registrations, and `schema` grants the example command flag metadata.",
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
 * Build the colocated `node:test` sample suite for the chosen capability. Every
 * variant covers activation, command invocation, and teardown via the SDK
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
  const capabilitiesLiteral = SAMPLE_TEST_CAPABILITIES_LITERAL[capability];
  const searchProviderName = `${extensionName}-search`;
  const vectorAdapterName = `${extensionName}-vector`;
  const adapterName = `${extensionName.replace(/-/g, " ")} items`;
  const importNames = [
    "  activateExtensionForTest,",
    "  assertExtensionDeactivated,",
    "  assertRegisteredCommandContract,",
    ...(hooksEnabled ? ["  assertRegisteredHook,"] : []),
    ...(searchEnabled ? ["  assertRegisteredSearchProvider,", "  assertRegisteredVectorStoreAdapter,"] : []),
    ...(importersEnabled ? ["  assertRegisteredImporter,", "  assertRegisteredExporter,"] : []),
    "  deactivateExtensionForTest,",
    "  runRegisteredCommandForTest,",
    ...(hooksEnabled ? ["  runRegisteredHookForTest,"] : []),
    ...(searchEnabled ? ["  runRegisteredSearchProviderForTest,", "  runRegisteredVectorStoreAdapterForTest,"] : []),
    ...(importersEnabled ? ["  runRegisteredImporterForTest,", "  runRegisteredExporterForTest,"] : []),
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
        "  const query = await runRegisteredSearchProviderForTest(activation.registrations, {",
        `    provider: ${JSON.stringify(searchProviderName)},`,
        '    operation: "query",',
        "    context: {",
        '      query: "sync",',
        '      mode: "semantic",',
        '      tokens: ["sync"],',
        "      options: {},",
        "      settings: {},",
        "      documents: [",
        '        { metadata: { id: "pm-1", title: "Sync external context" }, body: "" },',
        '        { metadata: { id: "pm-2", title: "Unrelated task" }, body: "" },',
        "      ],",
        "    },",
        "  });",
        '  assert.deepEqual(query, { hits: [{ id: "pm-1", score: 1, matched_fields: ["title"] }] });',
        "",
        "  const embedding = await runRegisteredSearchProviderForTest(activation.registrations, {",
        `    provider: ${JSON.stringify(searchProviderName)},`,
        '    operation: "embed",',
        '    context: { input: "abc", settings: {}, model: "starter-model" },',
        "  });",
        "  assert.deepEqual(embedding, [3]);",
        "",
        "  const vectorHits = await runRegisteredVectorStoreAdapterForTest(activation.registrations, {",
        `    adapter: ${JSON.stringify(vectorAdapterName)},`,
        '    operation: "query",',
        "    context: { vector: [0.1, 0.2], limit: 2, settings: {} },",
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
  return [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    "import {",
    ...importNames,
    '} from "@unbrained/pm-cli/sdk/testing";',
    'import extension from "./index.js";',
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
    "  assert.equal(invocation.result.ok, true);",
    `  assert.equal(invocation.result.command, ${JSON.stringify(commandName)});`,
    "});",
    "",
    ...hookTestLines,
    ...searchTestLines,
    ...importerTestLines,
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
  const manifest = `${JSON.stringify(
    {
      name: extensionName,
      version: "0.1.0",
      entry: "./index.js",
      manifest_version: SCAFFOLD_MANIFEST_VERSION,
      pm_min_version: SCAFFOLD_PM_MIN_VERSION,
      trusted: true,
      sandbox_profile: "strict",
      permissions: { ...SCAFFOLD_DECLARED_PERMISSIONS },
      capabilities,
    },
    null,
    2,
  )}\n`;
  // Keep scaffolds dependency-light by default: even package mode can be
  // installed before peer dependencies are materialized in the generated root.
  // The JSDoc import preserves editor narrowing without forcing the runtime
  // loader to resolve @unbrained/pm-cli/sdk from a freshly generated scaffold.
  const entrypoint = [
    '/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */',
    "export function activate(api) {",
    ...buildActivateBodyLines(extensionName, commandName, capability),
    "}",
    "",
    "// `deactivate` is the teardown counterpart to `activate`: pm runs it on host",
    "// shutdown/reload (e.g. the MCP server between requests) to release anything",
    "// `activate` opened - timers, connections, caches. This starter holds no such",
    "// resources, so it stays a documented no-op; add cleanup here as you grow.",
    "export function deactivate() {}",
    "",
    "export default {",
    "  activate,",
    "  deactivate,",
    "};",
    "",
  ].join("\n");
  // README bullet describing what index.js wires, kept in sync with the chosen
  // capability so the generated docs match the generated code.
  const entrypointBullet = ENTRYPOINT_BULLETS[capability];
  if (vocabulary === "package") {
    const packageJson = `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        keywords: ["pm-package"],
        // `node --test` runs the colocated *.test.js sample against the peer SDK
        // testing helpers; no extra dev-dependency or test runner is required.
        scripts: {
          test: "node --test",
        },
        peerDependencies: {
          "@unbrained/pm-cli": "*",
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
    const gitignore = ["node_modules/", "*.log", ""].join("\n");
    const packageReadme = [
      `# ${packageName}`,
      "",
      "Generated by `pm package init`.",
      "",
      "## Included Files",
      "- `package.json`: package metadata, `test` script, and `pm` resource manifest.",
      "- `manifest.json`: extension metadata and capabilities.",
      entrypointBullet,
      sampleTestBullet,
      "- `.gitignore`: ignores `node_modules/` and log files.",
      "",
      "## Quick Start",
      "```bash",
      "pm install --project <package-path>",
      `pm ${commandName}`,
      "pm package doctor --project --detail summary",
      "```",
      "",
      "## Validate the Package",
      "Install the peer SDK once, then run the colocated sample test:",
      "```bash",
      "npm install",
      "npm test",
      "```",
      "`npm test` runs `node --test`, which executes `index.test.js` against the",
      "`@unbrained/pm-cli/sdk/testing` helpers - no extra test runner required.",
      ...PACKAGE_CAPABILITY_README_SECTIONS[capability],
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
      "- Keep simple starter runtime behavior at the package root so local installs work without dependency bootstrapping.",
      "- Move larger runtimes into subdirectories only after adding package dependencies and validating `pm package doctor`.",
      "- Add capabilities to the extension manifest only when the entrypoint uses the matching SDK API.",
      "- Use `@unbrained/pm-cli/sdk` as the public SDK import for richer package runtimes.",
      "",
    ].join("\n");
    return {
      "package.json": packageJson,
      "manifest.json": manifest,
      "index.js": entrypoint,
      "index.test.js": sampleTest,
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
    "- `manifest.json`: extension metadata and capabilities.",
    entrypointBullet,
    "",
    "## Quick Start",
    "```bash",
    "pm extension --install --project <scaffold-path>",
    `pm ${commandName}`,
    "pm extension --doctor --project --detail summary",
    "```",
    ...EXTENSION_CAPABILITY_README_SECTIONS[capability],
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
    "## Notes",
    "- This scaffold uses ESM exports so it works in package scopes with `type: module`.",
    "- Update `manifest.json` capabilities and `index.js` command behavior as your extension evolves.",
    "- Release any resources `activate` opens (timers, connections, caches) in the `deactivate` teardown hook.",
    "",
  ].join("\n");
  return {
    "manifest.json": manifest,
    "index.js": entrypoint,
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
