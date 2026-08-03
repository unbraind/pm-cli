/**
 * @module sdk/extension/shared
 *
 * Implements extension package-management support for Shared.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  DEFAULT_EXTENSION_PRIORITY,
  isCanonicalPathWithinDirectory,
  parseExtensionManifestDocument,
  type ExtensionManifest,
} from "../../core/extensions/loader.js";

export { DEFAULT_EXTENSION_PRIORITY, isCanonicalPathWithinDirectory };

/** Documents the validated extension directory payload exchanged by command, SDK, and package integrations. */
export interface ValidatedExtensionDirectory {
  /** Value that configures or reports directory for this contract. */
  directory: string;
  /** Filesystem path used for manifest resolution. */
  manifest_path: string;
  /** Filesystem path used for entry resolution. */
  entry_path: string;
  /** Declarative package manifest consumed by the extension loader. */
  manifest: ExtensionManifest;
}

/** Optional install-source evidence used to make validation failures actionable. */
export interface ExtensionDirectoryValidationContext {
  /** Source kind whose behavior explains a missing built artifact. */
  source_kind?: "github" | "local" | "npm";
  /** Original source spelling shown in recovery guidance. */
  source_input?: string;
  /** Package root containing package.json for source-aware diagnostics. */
  source_root?: string;
}

/** Implements normalize string list for the public runtime surface of this module. */
export function normalizeStringList(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/** Implements normalize extension name for match for the public runtime surface of this module. */
export function normalizeExtensionNameForMatch(value: string): string {
  return value.trim().toLowerCase();
}

/** Implements normalize managed directory name for the public runtime surface of this module. */
export function normalizeManagedDirectoryName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  let start = 0;
  while (normalized[start] === "-") {
    start += 1;
  }
  let end = normalized.length;
  while (end > start && normalized[end - 1] === "-") {
    end -= 1;
  }
  const directoryName = normalized.slice(start, end);
  if (directoryName.length === 0) {
    throw new PmCliError(
      "Extension manifest name must resolve to a non-empty directory name.",
      EXIT_CODE.USAGE,
    );
  }
  if (directoryName === "." || directoryName === "..") {
    // Manifest-controlled input must resolve to a dedicated child directory, never
    // the extensions root itself or its parent (path-traversal guard).
    throw new PmCliError(
      'Extension manifest name must not resolve to "." or "..".',
      EXIT_CODE.USAGE,
    );
  }
  return directoryName;
}

/** Implements parse extension manifest for the public runtime surface of this module. */
export function parseExtensionManifest(raw: unknown): ExtensionManifest | null {
  return parseExtensionManifestDocument(raw);
}

/** Bounded package metadata used only to improve GitHub-source recovery. */
interface GithubSourcePackageMetadata {
  /** Valid npm package name suitable for an explicit npm install command. */
  package_name?: string;
  /** Whether package scripts indicate that runtime output must be built. */
  has_build_script: boolean;
}

/** Read advisory package metadata without replacing the primary validation error. */
async function readGithubSourcePackageMetadata(
  sourceRoot: string,
): Promise<GithubSourcePackageMetadata> {
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(sourceRoot, "package.json"), "utf8"),
    ) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };
    const packageName =
      typeof packageJson.name === "string" &&
      /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/iu.test(packageJson.name)
        ? packageJson.name
        : undefined;
    return {
      ...(packageName ? { package_name: packageName } : {}),
      has_build_script: ["build", "prepare", "prepack"].some(
        (key) => typeof packageJson.scripts?.[key] === "string",
      ),
    };
  } catch {
    return { has_build_script: false };
  }
}

/** Build the source-aware error returned for a missing extension entry. */
async function missingExtensionEntryError(
  manifest: ExtensionManifest,
  entryPath: string,
  context: ExtensionDirectoryValidationContext,
): Promise<PmCliError> {
  if (
    context.source_kind !== "github" ||
    typeof context.source_root !== "string"
  ) {
    return new PmCliError(
      `Extension entry file is missing at "${entryPath}".`,
      EXIT_CODE.USAGE,
    );
  }
  const packageMetadata = await readGithubSourcePackageMetadata(
    context.source_root,
  );
  const npmCommand = packageMetadata.package_name
    ? `pm install npm:${packageMetadata.package_name}`
    : undefined;
  const source = context.source_input ?? context.source_root;
  return new PmCliError(
    `Extension entry "${manifest.entry}" is absent from GitHub source "${source}". pm install copies GitHub repositories without running package scripts${packageMetadata.has_build_script ? ", and this package declares a build or publish script" : ""}. ${npmCommand ? `Try "${npmCommand}" if the package is published, or install a locally built directory.` : "Build the source locally and install that directory, or use its published npm: package."}`,
    EXIT_CODE.USAGE,
    {
      code: "github_source_entry_unbuilt",
      required:
        "Use a GitHub tree with committed runtime output, a published npm artifact, or a locally built source directory.",
      why: "GitHub installation is a source copy and never executes untrusted package build scripts.",
      examples: npmCommand
        ? [npmCommand, `pm install ${context.source_root}`]
        : [`pm install ${context.source_root}`],
      nextSteps: npmCommand
        ? [
            `Retry with ${npmCommand}.`,
            "Or build the repository locally, then install its directory.",
          ]
        : [
            "Build the repository locally, then install its directory.",
            "If it is published, retry with pm install npm:<package-name>.",
          ],
      recovery: {
        attempted_command: `pm install ${source}`,
        normalized_args: ["install", source],
        ...(npmCommand ? { next_best_command: npmCommand } : {}),
      },
    },
  );
}

/** Implements validate extension directory for the public runtime surface of this module. */
export async function validateExtensionDirectory(
  directory: string,
  context: ExtensionDirectoryValidationContext = {},
): Promise<ValidatedExtensionDirectory> {
  const manifestPath = path.join(directory, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new PmCliError(
      `Extension manifest is missing at "${manifestPath}".`,
      EXIT_CODE.USAGE,
    );
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as unknown;
  } catch (error: unknown) {
    throw new PmCliError(
      `Failed to parse extension manifest at "${manifestPath}": ${formatManifestReadError(error)}`,
      EXIT_CODE.USAGE,
    );
  }

  const manifest = parseExtensionManifest(parsedManifest);
  if (!manifest) {
    throw new PmCliError(
      `Extension manifest at "${manifestPath}" is invalid.`,
      EXIT_CODE.USAGE,
    );
  }

  const entryPath = path.resolve(directory, manifest.entry);
  if (!isPathWithinDirectory(directory, entryPath)) {
    throw new PmCliError(
      `Extension entry "${manifest.entry}" resolves outside extension directory "${directory}".`,
      EXIT_CODE.USAGE,
    );
  }
  if (!(await pathExists(entryPath))) {
    throw await missingExtensionEntryError(manifest, entryPath, context);
  }
  if (!(await isCanonicalPathWithinDirectory(directory, entryPath))) {
    throw new PmCliError(
      `Extension entry "${manifest.entry}" resolves outside extension directory after symlink resolution.`,
      EXIT_CODE.USAGE,
    );
  }

  return {
    directory,
    manifest_path: manifestPath,
    entry_path: entryPath,
    manifest,
  };
}

function formatManifestReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Public contract for test only extension shared, shared by SDK and presentation-layer consumers. */
export const _testOnlyExtensionShared = {
  formatManifestReadError,
};
