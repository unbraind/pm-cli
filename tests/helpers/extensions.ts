import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { activateExtensions } from "../../src/core/extensions/loader.js";
import { createDefaultExtensionGovernancePolicy } from "../../src/core/extensions/extension-types.js";
import type {
  ExtensionActivationResult,
  ExtensionApi,
  ExtensionLayer,
} from "../../src/core/extensions/loader.js";

type ManifestRecord = Record<string, unknown>;

export type TestExtensionPlacement = "extensionRoot" | "projectRoot";

export interface WriteTestExtensionOptions {
  root: string;
  directory?: string;
  name?: string;
  placement?: TestExtensionPlacement;
  manifest?: ManifestRecord | null;
  manifestOverrides?: ManifestRecord;
  entryFilename?: string;
  entrySource?: string | null;
}

export interface WriteTestExtensionResult {
  extensionRoot: string;
  manifestPath: string;
  entryPath: string;
  manifest: ManifestRecord | null;
}

const DEFAULT_ENTRY_SOURCE = "export default { activate() {} };\n";

function resolveExtensionRoot(options: WriteTestExtensionOptions): string {
  const baseRoot =
    options.placement === "projectRoot" ? path.join(options.root, "extensions") : options.root;
  return options.directory ? path.join(baseRoot, options.directory) : baseRoot;
}

function buildFixture(options: WriteTestExtensionOptions): WriteTestExtensionResult {
  const extensionRoot = resolveExtensionRoot(options);
  const entryFilename = options.entryFilename ?? "index.js";
  const manifestPath = path.join(extensionRoot, "manifest.json");
  const entryPath = path.join(extensionRoot, entryFilename);
  const manifest =
    options.manifest === null
      ? null
      : {
          name: options.name ?? options.directory ?? path.basename(extensionRoot),
          version: "1.0.0",
          entry: entryFilename,
          capabilities: ["commands"],
          ...options.manifest,
          ...options.manifestOverrides,
        };

  return {
    extensionRoot,
    manifestPath,
    entryPath,
    manifest,
  };
}

export async function writeTestExtension(options: WriteTestExtensionOptions): Promise<WriteTestExtensionResult> {
  const fixture = buildFixture(options);
  await mkdir(fixture.extensionRoot, { recursive: true });

  if (fixture.manifest !== null) {
    await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
  }

  const entrySource = options.entrySource === undefined ? DEFAULT_ENTRY_SOURCE : options.entrySource;
  if (entrySource !== null) {
    await mkdir(path.dirname(fixture.entryPath), { recursive: true });
    await writeFile(fixture.entryPath, entrySource, "utf8");
  }

  return fixture;
}

export function writeTestExtensionSync(options: WriteTestExtensionOptions): WriteTestExtensionResult {
  const fixture = buildFixture(options);
  mkdirSync(fixture.extensionRoot, { recursive: true });

  if (fixture.manifest !== null) {
    writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
  }

  const entrySource = options.entrySource === undefined ? DEFAULT_ENTRY_SOURCE : options.entrySource;
  if (entrySource !== null) {
    mkdirSync(path.dirname(fixture.entryPath), { recursive: true });
    writeFileSync(fixture.entryPath, entrySource, "utf8");
  }

  return fixture;
}

export function defaultTestExtensionEntrySource(): string {
  return DEFAULT_ENTRY_SOURCE;
}

/** In-memory extension module descriptor for {@link activateSyntheticExtensions}. */
export interface SyntheticExtension {
  name: string;
  layer?: ExtensionLayer;
  capabilities: string[];
  activate?: (api: ExtensionApi) => void;
}

/** Activate one or more in-memory extension modules through the real engine. */
export async function activateSyntheticExtensions(
  extensions: SyntheticExtension[],
): Promise<ExtensionActivationResult> {
  return activateExtensions({
    disabled_by_flag: false,
    roots: { global: "", project: "" },
    configured_enabled: [],
    configured_disabled: [],
    discovered: [],
    effective: [],
    warnings: [],
    policy: createDefaultExtensionGovernancePolicy(),
    failed: [],
    loaded: extensions.map((extension) => ({
      layer: extension.layer ?? "project",
      directory: "",
      manifest_path: "",
      name: extension.name,
      version: "0.0.0",
      entry: "./index.js",
      priority: 0,
      entry_path: "",
      capabilities: extension.capabilities,
      module: { activate: extension.activate ?? (() => undefined) },
    })),
  });
}

/** Options for {@link registerEverySurfaceForTest}. */
export interface RegisterEverySurfaceOptions {
  /** When true, additionally registers the `ext-a-profile` archetype profile. */
  includeProfile?: boolean;
}

/** Register at least one surface for every known capability under one extension. */
export function registerEverySurfaceForTest(api: ExtensionApi, options: RegisterEverySurfaceOptions = {}): void {
  api.registerCommand({ name: "ext-a cmd", run: () => ({ ok: true }) });
  api.registerCommand("list", (context) => context.result);
  api.registerItemFields([{ name: "team", type: "string" }]);
  api.registerItemTypes([{ name: "Ticket" }]);
  api.registerMigration({ id: "ext-a-migration", run: () => ({}) });
  if (options.includeProfile === true) {
    api.registerProfile({
      name: "ext-a-profile",
      title: "Ext A archetype",
      summary: "Synthetic archetype for the every-surface fixture.",
      types: [],
      statuses: [],
      fields: [],
      workflows: [],
      config: [],
      templates: [],
      packages: [],
    });
  }
  api.registerImporter("ext-a-import", async () => ({ items: [] }));
  api.registerExporter("ext-a-export", async () => ({}));
  api.registerSearchProvider({ name: "ext-a-search", query: () => [] });
  api.registerVectorStoreAdapter({ name: "ext-a-vector", query: () => [] });
  api.registerParser("ext-a cmd", () => ({}));
  api.registerPreflight(() => ({}));
  api.registerService("output_format", () => null);
  api.registerRenderer("toon", () => null);
  api.hooks.beforeCommand(() => undefined);
  api.hooks.afterCommand(() => undefined);
  api.hooks.onWrite(() => undefined);
  api.hooks.onRead(() => undefined);
  api.hooks.onIndex(() => undefined);
}
