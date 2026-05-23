import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
          ...(options.manifest ?? {}),
          ...(options.manifestOverrides ?? {}),
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
