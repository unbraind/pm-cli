/**
 * @module sdk/extension/install-sources
 *
 * Implements extension package-management support for Install Sources.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import npa from "npm-package-arg";
import { extract as extractTar, list as listTar, type ReadEntry } from "tar";
import { collectPackageExtensionDirectories } from "../../core/packages/manifest.js";
import { resolvePmPackageRootFromModule } from "../../core/packages/root.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../../core/fs/path-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import {
  PmCliError,
  type PmCliErrorContext,
} from "../../core/shared/errors.js";
import { listBundledPackageAliases } from "./bundled-catalog.js";

const execFileAsync = promisify(execFile);
const PM_CLI_PACKAGE_NAME = "@unbrained/pm-cli";
const LOCAL_PACKAGE_ARCHIVE_LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 4096,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
} as const;
let bundledPackageAliasesCache: { key: string; aliases: string[] } | undefined;

interface LocalPackageArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
}

/** Parsed filesystem install source. */
export interface LocalInstallSource {
  /** Discriminator for a filesystem source. */
  kind: "local";
  /** Exact caller-provided source text. */
  input: string;
  /** Absolute normalized source path. */
  absolute_path: string;
}

/** Parsed GitHub repository install source. */
export interface GithubInstallSource {
  /** Discriminator for a GitHub repository source. */
  kind: "github";
  /** Exact caller-provided source text. */
  input: string;
  /** Repository owner. */
  owner: string;
  /** Repository name without a `.git` suffix. */
  repo: string;
  /** Cloneable HTTPS repository URL. */
  repository: string;
  /** Optional Git ref selected by the caller or URL. */
  ref?: string;
  /** Optional repository-relative package directory. */
  subpath?: string;
}

/** Parsed npm registry or package-spec install source. */
export interface NpmInstallSource {
  /** Discriminator for an npm package source. */
  kind: "npm";
  /** Exact caller-provided source text. */
  input: string;
  /** Validated npm package specification. */
  spec: string;
}

/** Parsed extension install source accepted by the resolver. */
export type InstallSource =
  | LocalInstallSource
  | GithubInstallSource
  | NpmInstallSource;

/** Materialized install source ready for extension validation. */
export interface ResolvedInstallSource {
  /** Parsed source that produced this directory. */
  source: InstallSource;
  /** Absolute extension or package directory ready for validation. */
  directory: string;
  /** Root unpacked or cloned source directory when different from `directory`. */
  source_root?: string;
  /** Repository subpath selected after clone. */
  resolved_subpath?: string;
  /** Resolved Git commit when the source is a repository. */
  commit?: string;
  /** Canonical npm package name when the source is a registry package. */
  npm_package?: string;
  /** Resolved npm package version. */
  npm_version?: string;
  /** Releases temporary source material created during resolution. */
  cleanup?: () => Promise<void>;
}

/** Installed npm package that competes with a bare bundled install target. */
export interface InstalledNpmPackageCandidate {
  /** Package identity read from its package.json. */
  package: string;
  /** Installed package version when declared. */
  version?: string;
  /** Absolute package root selected by Node-style ancestor lookup. */
  directory: string;
}

/** Resolve an already-installed npm package without executing package code. */
export async function findInstalledNpmPackageCandidate(
  packageName: string,
  cwd: string = process.cwd(),
): Promise<InstalledNpmPackageCandidate | null> {
  const normalized = packageName.trim();
  if (!/^(@[^/\\\s]+\/[^/\\\s]+|[^@/\\\s][^/\\\s]*)$/u.test(normalized)) {
    return null;
  }
  let current = path.resolve(cwd);
  while (true) {
    const directory = path.join(
      current,
      "node_modules",
      ...normalized.split("/"),
    );
    const manifestPath = path.join(directory, "package.json");
    if (await pathExists(manifestPath)) {
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === normalized) {
          return {
            package: normalized,
            ...(typeof manifest.version === "string"
              ? { version: manifest.version }
              : {}),
            directory,
          };
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseGithubPathSpec(
  pathSpec: string,
  input: string,
  refOverride?: string,
): GithubInstallSource | null {
  const segments = pathSpec
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (owner.length === 0 || repo.length === 0) {
    return null;
  }
  const tail = segments.slice(2);
  let ref: string | undefined;
  let subpath: string | undefined;
  if (tail[0] === "tree" && tail.length >= 2) {
    ref = tail[1];
    subpath = tail.slice(2).join("/");
  } else if (tail.length > 0) {
    subpath = tail.join("/");
  }
  if (typeof refOverride === "string" && refOverride.trim().length > 0) {
    ref = refOverride.trim();
  }
  return {
    kind: "github",
    input,
    owner,
    repo,
    repository: `https://github.com/${owner}/${repo}.git`,
    ref,
    subpath: subpath && subpath.length > 0 ? subpath : undefined,
  };
}

function parseNpmInstallSource(
  normalizedInput: string,
  forceGithub: boolean,
  refOverride: string | undefined,
): InstallSource {
  const spec = normalizedInput.slice("npm:".length).trim();
  if (spec.length === 0) {
    throw new PmCliError(
      'npm package source must include a package spec after "npm:".',
      EXIT_CODE.USAGE,
    );
  }
  if (forceGithub) {
    throw new PmCliError(
      'Options "--gh/--github" cannot be combined with npm: package sources.',
      EXIT_CODE.USAGE,
    );
  }
  if (refOverride) {
    throw new PmCliError(
      'Option "--ref" cannot be combined with npm: package sources.',
      EXIT_CODE.USAGE,
    );
  }
  return {
    kind: "npm",
    input: normalizedInput,
    spec,
  };
}

/** Implements parse extension install source for the public runtime surface of this module. */
export function parseExtensionInstallSource(
  input: string,
  options: { forceGithub?: boolean; ref?: string } = {},
): InstallSource {
  const normalizedInput = input.trim();
  if (normalizedInput.length === 0) {
    throw new PmCliError(
      "Extension source is required for --install.",
      EXIT_CODE.USAGE,
    );
  }
  const refOverride =
    typeof options.ref === "string" && options.ref.trim().length > 0
      ? options.ref.trim()
      : undefined;

  if (normalizedInput.startsWith("npm:")) {
    return parseNpmInstallSource(
      normalizedInput,
      options.forceGithub === true,
      refOverride,
    );
  }

  const maybeGithubByUrl = (() => {
    try {
      const parsed = new URL(normalizedInput);
      if (parsed.hostname !== "github.com") {
        return null;
      }
      const pathSpec = parsed.pathname.replace(/^\/+/, "");
      return parseGithubPathSpec(pathSpec, normalizedInput, refOverride);
    } catch {
      return null;
    }
  })();
  if (maybeGithubByUrl) {
    return maybeGithubByUrl;
  }

  const strippedDomainInput = normalizedInput.startsWith("github.com/")
    ? normalizedInput.slice("github.com/".length)
    : null;
  if (strippedDomainInput) {
    const parsed = parseGithubPathSpec(
      strippedDomainInput,
      normalizedInput,
      refOverride,
    );
    if (!parsed) {
      throw new PmCliError(
        `Invalid GitHub source "${normalizedInput}".`,
        EXIT_CODE.USAGE,
      );
    }
    return parsed;
  }

  if (options.forceGithub) {
    const parsed = parseGithubPathSpec(
      normalizedInput,
      normalizedInput,
      refOverride,
    );
    if (!parsed) {
      throw new PmCliError(
        `Invalid GitHub shorthand "${normalizedInput}".`,
        EXIT_CODE.USAGE,
      );
    }
    return parsed;
  }

  if (/^https?:\/\//i.test(normalizedInput)) {
    throw new PmCliError(
      `Unsupported extension source URL "${normalizedInput}". Supported remote source host: github.com.`,
      EXIT_CODE.USAGE,
    );
  }

  return {
    kind: "local",
    input: normalizedInput,
    absolute_path: path.resolve(process.cwd(), normalizedInput),
  };
}

/** Implements run git command for the public runtime surface of this module. */
export async function runGitCommand(
  args: string[],
  execRunner: typeof execFileAsync = execFileAsync,
  timeoutMs?: number,
): Promise<string> {
  try {
    const result = await execRunner("git", args, {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    return (result.stdout ?? "").trim();
  } catch (error: unknown) {
    /* c8 ignore start -- stderr-vs-error-message precedence is validated in integration command-runner paths */
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : "";
    const message =
      stderr.trim().length > 0
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    /* c8 ignore stop */
    throw new PmCliError(
      `Git command failed: git ${args.join(" ")}\n${message}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

/** Implements resolve npm command name for the public runtime surface of this module. */
export function resolveNpmCommandName(
  platform: NodeJS.Platform = process.platform,
): "npm" | "npm.cmd" {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/** Implements should run npm command in shell for the public runtime surface of this module. */
export function shouldRunNpmCommandInShell(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32";
}

async function runNpmCommand(
  args: string[],
  cwd?: string,
  execRunner: typeof execFileAsync = execFileAsync,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const npmCommand = resolveNpmCommandName(platform);
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => key.toLowerCase() !== "npm_config_allow_scripts",
    ),
  );
  env.NPM_CONFIG_ALLOW_SCRIPTS = "";
  try {
    const result = await execRunner(npmCommand, args, {
      cwd,
      encoding: "utf8",
      env,
      shell: shouldRunNpmCommandInShell(platform),
    });
    return (result.stdout ?? "").trim();
  } catch (error: unknown) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : "";
    const message =
      stderr.trim().length > 0
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new PmCliError(
      `npm command failed: ${npmCommand} ${args.join(" ")}\n${message}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

function npmPackageNameFromSpec(spec: string): string {
  const trimmed = spec.trim();
  const withoutAlias = trimmed.includes("@file:")
    ? trimmed.slice(0, trimmed.lastIndexOf("@file:"))
    : trimmed;
  if (withoutAlias.startsWith("@")) {
    const scoped = withoutAlias.match(/^(@[^/@\s]+\/[^/@\s]+)/);
    return scoped?.[1] ?? withoutAlias;
  }
  const unscoped = withoutAlias.match(/^([^/@\s]+)/);
  return unscoped?.[1] ?? withoutAlias;
}

/** Implements check whether npm not found error for the public runtime surface of this module. */
export function isNpmNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("npm err! code e404") ||
    normalized.includes("404 not found") ||
    normalized.includes("is not in this registry")
  );
}

/** Implements check whether npm pack not found error for the public runtime surface of this module. */
export function isNpmPackNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return isNpmNotFoundError(error) || normalized.includes("not found");
}

function isFirstPartyPmPackageName(packageName: string): boolean {
  const normalized = packageName.trim().toLowerCase();
  return (
    normalized.startsWith("@unbrained/pm-") || normalized.startsWith("pm-")
  );
}

/** Implements build npm not found recovery for the public runtime surface of this module. */
export function buildNpmNotFoundRecovery(spec: string): {
  message: string;
  context: PmCliErrorContext;
} {
  const packageName = npmPackageNameFromSpec(spec);
  const isFirstPartyPackage = isFirstPartyPmPackageName(packageName);
  const repoName = packageName.replace(/^.*\//, "");
  const githubSource = isFirstPartyPackage
    ? `github.com/unbraind/${repoName}`
    : undefined;
  const nextBestCommand = githubSource
    ? `pm install --project ${githubSource}`
    : undefined;
  return {
    message: isFirstPartyPackage
      ? `npm package "${spec}" was not found in the registry. If this is an unpublished first-party pm package, install its GitHub repository instead.`
      : `npm package "${spec}" was not found in the registry.`,
    context: {
      code: "npm_package_not_found",
      required:
        "Use an install source that exists, or publish the npm package before installing it with npm:<name>.",
      why: "Classifying npm 404s avoids repeated registry retries and gives agents a deterministic fallback path.",
      examples: nextBestCommand
        ? [nextBestCommand, `pm package catalog --project --json`]
        : [`npm view ${packageName}`, `pm package catalog --project --json`],
      nextSteps: nextBestCommand
        ? [
            `Try ${nextBestCommand} if the repository exists.`,
            "Use pm package catalog --project --json to inspect bundled package aliases before installing.",
          ]
        : [
            `Verify ${packageName} exists in the npm registry and that you have access to it.`,
            "Use pm package catalog --project --json to inspect bundled package aliases before installing.",
          ],
      recovery: {
        attempted_command: `pm install --project npm:${spec}`,
        normalized_args: ["install", "--project", `npm:${spec}`],
        ...(githubSource && nextBestCommand
          ? {
              fallback_candidates: [
                {
                  source: githubSource,
                  command: nextBestCommand,
                  reason:
                    "canonical first-party GitHub repository fallback for unpublished pm packages",
                },
              ],
              next_best_command: nextBestCommand,
            }
          : {}),
      },
    },
  };
}

/** Implements wrap npm pack resolution error for the public runtime surface of this module. */
export function wrapNpmPackResolutionError(
  spec: string,
  error: unknown,
): PmCliError | null {
  if (!isNpmPackNotFoundError(error)) {
    return null;
  }
  const recovery = buildNpmNotFoundRecovery(spec);
  return new PmCliError(
    recovery.message,
    EXIT_CODE.NOT_FOUND,
    recovery.context,
  );
}

async function resolveLocalNpmPackagePath(
  spec: string,
): Promise<string | null> {
  if (path.isAbsolute(spec) || spec.startsWith(".") || spec.startsWith("..")) {
    const absolutePath = path.resolve(process.cwd(), spec);
    return (await pathExists(absolutePath)) ? absolutePath : null;
  }

  try {
    const parsed = new URL(spec);
    if (parsed.protocol === "file:") {
      const absolutePath = fileURLToPath(parsed);
      return (await pathExists(absolutePath)) ? absolutePath : null;
    }
  } catch {
    // Registry package specs are not URLs.
  }

  if (!/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    const absolutePath = path.resolve(process.cwd(), spec);
    if (await pathExists(absolutePath)) {
      return absolutePath;
    }
  }

  return null;
}

async function resolveNpmPackSpec(spec: string): Promise<string> {
  const localPath = await resolveLocalNpmPackagePath(spec);
  if (localPath) {
    // Hand npm pack a NATIVE filesystem path, never a percent-encoded file URL:
    // npm opens the spec literally, so spaces (`%20`) or a Windows 8.3 `~` short
    // name (`%7E`) escaped by pathToFileURL make pack fail ENOENT on every
    // platform (GH-363). resolveLocalNpmPackagePath already decoded the path.
    return localPath;
  }

  const localFileAlias = normalizeNpmLocalFileAliasSpec(spec);
  if (localFileAlias !== spec) {
    return localFileAlias;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    return spec;
  }

  return spec;
}

/** Implements normalize npm local file alias spec for the public runtime surface of this module. */
export function normalizeNpmLocalFileAliasSpec(
  spec: string,
  cwd: string = process.cwd(),
): string {
  const marker = "@file:";
  const markerIndex = spec.lastIndexOf(marker);
  if (markerIndex <= 0) {
    return spec;
  }
  const packageName = spec.slice(0, markerIndex);
  const target = spec.slice(markerIndex + marker.length);
  if (packageName.trim().length === 0 || target.trim().length === 0) {
    return spec;
  }
  // `file://host/share` (exactly two leading slashes) is a UNC / network spec,
  // not a local path — leave it for npm to resolve.
  if (target.startsWith("//") && !target.startsWith("///")) {
    return spec;
  }
  // A bare relative target resolves against cwd.
  if (!target.startsWith("/")) {
    return `${packageName}@${path.resolve(cwd, target)}`;
  }
  // Resolve an absolute `file:` URL target to a NATIVE, percent-DECODED path
  // (never an encoded file URL): npm opens the alias target literally, so an
  // escaped path — spaces (`%20`) or a Windows 8.3 `~` short name escaped to
  // `%7E` — fails ENOENT on every platform (GH-363). Decode via URL +
  // decodeURIComponent rather than fileURLToPath, which throws
  // ERR_INVALID_FILE_URL_PATH for a driveless absolute path supplied on Windows;
  // strip the leading slash before a Windows drive letter (`/C:/x` -> `C:/x`).
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(new URL(`file:${target}`).pathname);
  } catch {
    // Malformed percent-encoding (e.g. `%ZZ`) makes decodeURIComponent throw a
    // URIError; leave the spec untouched so npm surfaces a clear error instead
    // of crashing the CLI on an uncaught exception.
    return spec;
  }
  const nativePath = /^\/[A-Za-z]:/.test(decodedPath)
    ? decodedPath.slice(1)
    : decodedPath;
  return `${packageName}@${nativePath}`;
}

/**
 * Parse npm pack output and bind the reported artifact to its isolated target.
 *
 * Supports current JSON metadata and the legacy filename-only form while
 * refusing absolute or traversing results before the filesystem is consulted.
 */
function parsePackedNpmPackage(
  stdout: string,
  packDirectory: string,
): { tarball: string; package?: string; version?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    // Fall back to the last stdout line for older npm output.
  }
  const first = Array.isArray(parsed)
    ? (parsed[0] as
        | { filename?: unknown; name?: unknown; version?: unknown }
        | undefined)
    : undefined;
  const filename =
    first &&
    typeof first.filename === "string" &&
    first.filename.trim().length > 0
      ? first.filename
      : stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .at(-1);
  if (!filename) {
    throw new PmCliError(
      "npm pack did not report a tarball filename.",
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const tarball = path.resolve(packDirectory, filename);
  const relativeTarball = path.relative(packDirectory, tarball);
  if (
    relativeTarball.length === 0 ||
    relativeTarball === ".." ||
    relativeTarball.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarball)
  ) {
    throw new PmCliError(
      "npm pack reported a package archive outside its isolated destination.",
      EXIT_CODE.GENERIC_FAILURE,
      {
        code: "npm_package_archive_unsafe",
        required:
          "Retry with a trusted npm client that writes its archive inside the requested pack destination.",
        why: "pm will not read a package-manager artifact outside the isolated directory created for this install.",
      },
    );
  }
  return {
    tarball,
    package: typeof first?.name === "string" ? first.name : undefined,
    version: typeof first?.version === "string" ? first.version : undefined,
  };
}

async function resolveNpmSourceDirectory(source: NpmInstallSource): Promise<{
  directory: string;
  package?: string;
  version?: string;
  cleanup: () => Promise<void>;
}> {
  return resolveNpmSourceDirectoryWithRunner(source, runNpmCommand);
}

/**
 * Resolve an npm source with an injectable, argv-safe package-manager runner.
 *
 * Local package directories remain in place, while local and registry archives
 * share the same bounded validation, dependency installation, and cleanup
 * contract. Registry artifacts must also exist inside the requested pack root.
 */
async function resolveNpmSourceDirectoryWithRunner(
  source: NpmInstallSource,
  npmRunner: typeof runNpmCommand,
): Promise<{
  directory: string;
  package?: string;
  version?: string;
  cleanup: () => Promise<void>;
}> {
  const localPackageRoot = await resolveLocalNpmPackagePath(source.spec);
  if (localPackageRoot) {
    const localStats = await fs.stat(localPackageRoot);
    if (localStats.isFile() && isLocalPackageArchive(localPackageRoot)) {
      return extractLocalPackageArchive(localPackageRoot);
    }
    const packageJsonPath = path.join(localPackageRoot, "package.json");
    const packageJson = (await pathExists(packageJsonPath))
      ? (JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        })
      : {};
    return {
      directory: await resolvePackageExtensionDirectory(
        localPackageRoot,
        source.input,
      ),
      package:
        typeof packageJson.name === "string" ? packageJson.name : undefined,
      version:
        typeof packageJson.version === "string"
          ? packageJson.version
          : undefined,
      cleanup: async () => {},
    };
  }

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pm-npm-package-source-"),
  );
  const packDirectory = path.join(tempRoot, "pack");
  await fs.mkdir(packDirectory, { recursive: true });

  try {
    const packSpec = await resolveNpmPackSpec(source.spec);
    const packStdout = await npmRunner([
      "pack",
      packSpec,
      "--json",
      "--pack-destination",
      packDirectory,
    ]);
    const packed = parsePackedNpmPackage(packStdout, packDirectory);
    if (!(await pathExists(packed.tarball))) {
      throw new PmCliError(
        "npm pack did not create its reported package archive.",
        EXIT_CODE.GENERIC_FAILURE,
        {
          code: "npm_package_archive_missing",
          required:
            "Retry the npm package install with a healthy registry and writable temporary directory.",
          why: "The package manager reported a tarball filename that was absent before validation, so pm cannot safely extract or install it.",
        },
      );
    }
    const extracted = await extractLocalPackageArchive(packed.tarball);
    return {
      directory: extracted.directory,
      package: packed.package ?? extracted.package,
      version: packed.version ?? extracted.version,
      cleanup: async () => {
        try {
          await extracted.cleanup();
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error: unknown) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    const wrappedError = wrapNpmPackResolutionError(source.spec, error);
    if (wrappedError) {
      throw wrappedError;
    }
    throw error;
  }
}

/** Return whether a filesystem path names one supported npm package archive. */
function isLocalPackageArchive(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  return normalized.endsWith(".tgz") || normalized.endsWith(".tar.gz");
}

function failLocalPackageArchive(message: string): never {
  throw new PmCliError(message, EXIT_CODE.USAGE, {
    code: "local_package_archive_unsafe",
    required:
      "Use a bounded npm .tgz or .tar.gz archive with one package/ root and no links or escaping paths.",
    why: "Package archives are untrusted input and must be validated before any entry reaches the filesystem.",
  });
}

function validateLocalPackageArchiveEntry(
  entry: ReadEntry,
  limits: LocalPackageArchiveLimits,
  state: { entries: number; expandedBytes: number; packageJsonEntries: number },
): void {
  if (entry.meta) return;
  state.entries += 1;
  if (state.entries > limits.maxEntries) {
    failLocalPackageArchive(
      `Local package archive exceeds the ${limits.maxEntries} entry limit.`,
    );
  }
  const archivePath = entry.path;
  const segments = archivePath.split("/");
  if (
    archivePath.includes("\\") ||
    archivePath.startsWith("/") ||
    /^[A-Za-z]:/u.test(archivePath) ||
    segments.some((segment) => segment === "..")
  ) {
    failLocalPackageArchive(
      `Local package archive contains an escaping path: "${archivePath}".`,
    );
  }
  if (segments[0] !== "package") {
    failLocalPackageArchive(
      `Local package archive entry "${archivePath}" is outside the required package/ root.`,
    );
  }
  if (entry.type === "SymbolicLink" || entry.type === "Link") {
    failLocalPackageArchive(
      `Local package archive link "${archivePath}" is not supported.`,
    );
  }
  if (
    entry.type !== "File" &&
    entry.type !== "OldFile" &&
    entry.type !== "Directory"
  ) {
    failLocalPackageArchive(
      `Local package archive entry "${archivePath}" uses unsupported type "${entry.type}".`,
    );
  }
  if (entry.size > limits.maxEntryBytes) {
    failLocalPackageArchive(
      `Local package archive entry "${archivePath}" exceeds the ${limits.maxEntryBytes} byte entry limit.`,
    );
  }
  state.expandedBytes += entry.size;
  if (state.expandedBytes > limits.maxExpandedBytes) {
    failLocalPackageArchive(
      `Local package archive exceeds the ${limits.maxExpandedBytes} expanded byte limit.`,
    );
  }
  if (archivePath === "package/package.json") {
    state.packageJsonEntries += 1;
  }
}

/** Validate and extract one local npm package archive into an isolated temporary root. */
async function extractLocalPackageArchive(
  archivePath: string,
  limits: LocalPackageArchiveLimits = LOCAL_PACKAGE_ARCHIVE_LIMITS,
): Promise<{
  directory: string;
  package?: string;
  version?: string;
  cleanup: () => Promise<void>;
}> {
  const archiveStats = await fs.stat(archivePath);
  if (archiveStats.size > limits.maxArchiveBytes) {
    failLocalPackageArchive(
      `Local package archive exceeds the ${limits.maxArchiveBytes} archive byte limit.`,
    );
  }
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pm-local-package-archive-"),
  );
  const extractDirectory = path.join(tempRoot, "extract");
  await fs.mkdir(extractDirectory, { recursive: true });
  const state = { entries: 0, expandedBytes: 0, packageJsonEntries: 0 };
  let validationError: unknown;
  try {
    await listTar({
      file: archivePath,
      strict: true,
      maxDecompressionRatio: 100,
      onReadEntry: (entry) => {
        if (validationError !== undefined) return;
        try {
          validateLocalPackageArchiveEntry(entry, limits, state);
        } catch (error: unknown) {
          validationError = error;
        }
      },
    });
    if (validationError !== undefined) throw validationError;
    if (state.packageJsonEntries !== 1) {
      failLocalPackageArchive(
        `Local package archive must contain exactly one package/package.json entry; found ${state.packageJsonEntries}.`,
      );
    }
    await extractTar({
      file: archivePath,
      cwd: extractDirectory,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      noMtime: true,
      unlink: true,
      maxDepth: 64,
      maxDecompressionRatio: 100,
    });
    const packageRoot = path.join(extractDirectory, "package");
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = JSON.parse(
      await fs.readFile(packageJsonPath, "utf8"),
    ) as {
      name?: unknown;
      version?: unknown;
    };
    await installNpmPackageRuntimeDependencies(packageRoot);
    return {
      directory: await resolvePackageExtensionDirectory(
        packageRoot,
        archivePath,
      ),
      package:
        typeof packageJson.name === "string" ? packageJson.name : undefined,
      version:
        typeof packageJson.version === "string"
          ? packageJson.version
          : undefined,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function installNpmPackageRuntimeDependencies(
  packageRoot: string,
  npmRunner: typeof runNpmCommand = runNpmCommand,
): Promise<void> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as unknown;
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const manifest = parsed as {
    dependencies?: unknown;
    optionalDependencies?: unknown;
    peerDependencies?: unknown;
  };
  const dependencySpecs = runtimeDependencyInstallSpecs(manifest);
  const shouldLinkHostedPmCli = hasHostedPmCliDependency(manifest);
  if (dependencySpecs.length === 0 && !shouldLinkHostedPmCli) {
    return;
  }

  const runtimeOnlyManifest = { ...(parsed as Record<string, unknown>) };
  delete runtimeOnlyManifest.devDependencies;
  const installManifest = { ...runtimeOnlyManifest };
  removeHostedPmCliDependency(installManifest);
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify(installManifest, null, 2)}\n`,
    "utf8",
  );
  try {
    await Promise.all([
      fs.rm(path.join(packageRoot, "package-lock.json"), { force: true }),
      fs.rm(path.join(packageRoot, "npm-shrinkwrap.json"), { force: true }),
    ]);

    if (dependencySpecs.length > 0) {
      await npmRunner(
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--fund=false",
          "--package-lock=false",
          "--no-save",
          "--omit=peer",
          "--",
        ],
        packageRoot,
      );
    }

    if (shouldLinkHostedPmCli) {
      await linkHostedPmCliDependency(packageRoot);
    }
  } finally {
    await fs.writeFile(
      packageJsonPath,
      `${JSON.stringify(runtimeOnlyManifest, null, 2)}\n`,
      "utf8",
    );
  }
}

function hasHostedPmCliDependency(manifest: {
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}): boolean {
  for (const dependencyMap of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (
      typeof dependencyMap === "object" &&
      dependencyMap !== null &&
      PM_CLI_PACKAGE_NAME in dependencyMap
    ) {
      return true;
    }
  }
  return false;
}

function removeHostedPmCliDependency(manifest: Record<string, unknown>): void {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencyMap = manifest[field];
    if (typeof dependencyMap !== "object" || dependencyMap === null) {
      continue;
    }
    const nextMap = { ...(dependencyMap as Record<string, unknown>) };
    delete nextMap[PM_CLI_PACKAGE_NAME];
    if (Object.keys(nextMap).length === 0) {
      delete manifest[field];
    } else {
      manifest[field] = nextMap;
    }
  }
}

async function linkHostedPmCliDependency(packageRoot: string): Promise<void> {
  const hostPackageRoot = resolvePmPackageRootFromModule(import.meta.url, [
    "../../..",
  ]);
  const [scope, packageName] = PM_CLI_PACKAGE_NAME.split("/");
  const scopedDirectory = path.join(packageRoot, "node_modules", scope);
  const linkPath = path.join(scopedDirectory, packageName);
  await fs.mkdir(scopedDirectory, { recursive: true });
  await fs.rm(linkPath, { recursive: true, force: true });
  await fs.symlink(
    hostPackageRoot,
    linkPath,
    resolveDirectorySymlinkType(process.platform),
  );
}

function resolveDirectorySymlinkType(
  platform: NodeJS.Platform,
): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

function validateRuntimeDependencySpec(name: string, version: string): string {
  if (name.startsWith("-")) {
    throw new PmCliError(
      `Extension runtime dependency name "${name}" is unsafe because npm could interpret it as a command-line option.`,
      EXIT_CODE.USAGE,
      {
        code: "extension_dependency_name_unsafe",
        required:
          "Use a valid npm package name that does not begin with a dash.",
        why: "Extension manifests are untrusted input and dependency names must never become npm options.",
      },
    );
  }
  const hasUnsafeControlOrShellCharacter = [...version].some((character) => {
    const codePoint = character.charCodeAt(0);
    return (
      codePoint <= 31 || codePoint === 127 || "&|;()`\"'".includes(character)
    );
  });
  if (hasUnsafeControlOrShellCharacter) {
    throw new PmCliError(
      `Extension runtime dependency "${name}" has an unsafe version specifier.`,
      EXIT_CODE.USAGE,
      {
        code: "extension_dependency_version_unsafe",
        required:
          "Use an npm version, range, dist-tag, URL, or file specifier without shell metacharacters.",
        why: "npm.cmd requires a command shell on Windows, so untrusted shell metacharacters cannot be forwarded.",
      },
    );
  }
  try {
    npa.resolve(name, version);
  } catch {
    throw new PmCliError(
      `Extension runtime dependency "${name}@${version}" is not a valid npm dependency specifier.`,
      EXIT_CODE.USAGE,
      {
        code: "extension_dependency_spec_invalid",
        required:
          "Use a valid npm package name and npm-supported version, range, dist-tag, URL, or file specifier.",
        why: "Only grammar-validated dependency specs may be written to the isolated runtime install manifest.",
      },
    );
  }
  return `${name}@${version}`;
}

function runtimeDependencyInstallSpecs(manifest: {
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}): string[] {
  const specs = new Map<string, string>();
  for (const dependencyMap of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    if (typeof dependencyMap !== "object" || dependencyMap === null) {
      continue;
    }
    for (const [name, version] of Object.entries(dependencyMap)) {
      if (
        name === PM_CLI_PACKAGE_NAME ||
        typeof version !== "string" ||
        version.trim().length === 0 ||
        specs.has(name)
      ) {
        continue;
      }
      const normalizedVersion = version.trim();
      specs.set(name, validateRuntimeDependencySpec(name, normalizedVersion));
    }
  }
  return [...specs.values()];
}

async function resolvePackageExtensionDirectory(
  packageRoot: string,
  sourceLabel: string,
): Promise<string> {
  const discovered = await collectPackageExtensionDirectories(packageRoot);
  if (discovered.length === 1) {
    return discovered[0];
  }
  if (discovered.length > 1) {
    const choices = discovered
      .map((entry) =>
        path.relative(packageRoot, entry).replaceAll(path.sep, "/"),
      )
      .sort((left, right) => left.localeCompare(right));
    throw new PmCliError(
      `Package source "${sourceLabel}" contains multiple extension manifests. Provide an explicit extension path. Candidates: ${choices.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  throw new PmCliError(
    `Unable to locate a pm extension manifest in package source "${sourceLabel}". Package installs currently activate only extension resources, so add package.json pm.extensions or an extensions/ directory. Metadata-only resources like pm.docs/pm.examples are catalog metadata and do not activate commands.`,
    EXIT_CODE.USAGE,
  );
}

async function resolveGithubSourceDirectory(
  cloneDirectory: string,
  source: GithubInstallSource,
): Promise<{ directory: string; resolved_subpath?: string }> {
  const candidatePaths: string[] = [];
  /* c8 ignore start -- subpath candidate expansion permutations are covered by source-resolution integration suites */
  if (source.subpath) {
    candidatePaths.push(source.subpath);
    candidatePaths.push(
      path.posix.join(".agents/pm/extensions", source.subpath),
    );
    candidatePaths.push(
      path.posix.join(".custom/pm-extensions", source.subpath),
    );
    candidatePaths.push(
      path.posix.join(".custom/pm-extension", source.subpath),
    );
  }
  /* c8 ignore stop */

  for (const candidate of candidatePaths) {
    const absolute = path.resolve(cloneDirectory, candidate);
    if (!isPathWithinDirectory(cloneDirectory, absolute)) {
      // source.subpath is user-controlled; never resolve a manifest outside the
      // cloned repository (path-traversal guard).
      continue;
    }
    if (await pathExists(path.join(absolute, "manifest.json"))) {
      return { directory: absolute, resolved_subpath: candidate };
    }
  }

  if (await pathExists(path.join(cloneDirectory, "manifest.json"))) {
    return { directory: cloneDirectory, resolved_subpath: "." };
  }

  const discoveredDirectory = await resolvePackageExtensionDirectory(
    cloneDirectory,
    source.input,
  );
  return {
    directory: discoveredDirectory,
    resolved_subpath: path
      .relative(cloneDirectory, discoveredDirectory)
      .replaceAll(path.sep, "/"),
  };
}

/** Bare package-ish names (no path separators, or a single-scope npm name) that miss local resolution are almost always intended as npm or bundled installs, so the not-found error must route agents to those sources instead of dead-ending. */
function looksLikeBarePackageName(input: string): boolean {
  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("~")
  ) {
    return false;
  }
  if (trimmed.startsWith("@")) {
    return trimmed.split("/").length === 2;
  }
  return !trimmed.includes("/") && !trimmed.includes("\\");
}

async function buildLocalSourceNotFoundError(
  source: LocalInstallSource,
): Promise<PmCliError> {
  const baseMessage = `Local extension source does not exist: "${source.absolute_path}".`;
  const input = source.input.trim();
  if (!looksLikeBarePackageName(input)) {
    return new PmCliError(baseMessage, EXIT_CODE.NOT_FOUND);
  }
  let bundledAliases: string[] = [];
  try {
    const envPackageRoot = process.env.PM_CLI_PACKAGE_ROOT;
    const cacheKey =
      typeof envPackageRoot === "string" && envPackageRoot.trim().length > 0
        ? path.resolve(envPackageRoot.trim())
        : "";
    if (bundledPackageAliasesCache?.key !== cacheKey) {
      bundledPackageAliasesCache = {
        key: cacheKey,
        aliases: await listBundledPackageAliases(),
      };
    }
    bundledAliases = bundledPackageAliasesCache.aliases;
  } catch {
    // Alias discovery is best-effort; the npm: hint alone still unblocks agents.
  }
  const nextSteps = [
    `Retry with pm install npm:${input} if the package is published to npm.`,
    `Or inspect bundled packages with pm package catalog --project --json before installing by alias. Known aliases (blank means none found): ${bundledAliases.join(", ")}`,
  ];
  return new PmCliError(
    `${baseMessage} "${input}" did not match a local directory, bundled package alias, or bundled package name; if you meant an npm package, install it as "npm:${input}".`,
    EXIT_CODE.NOT_FOUND,
    {
      code: "local_source_not_found_bare_name",
      required: `Use "npm:${input}" for npm registry packages, a bundled catalog alias, or an existing local directory path.`,
      why: "Bare names resolve as local paths only after bundled aliases, so unmatched names need an explicit npm: source.",
      examples: [
        `pm install npm:${input}`,
        "pm package catalog --project --json",
      ],
      nextSteps,
      recovery: {
        attempted_command: `pm install ${input}`,
        normalized_args: ["install", input],
        next_best_command: `pm install npm:${input}`,
      },
    },
  );
}

/** Implements resolve install source for the public runtime surface of this module. */
export async function resolveInstallSource(
  source: InstallSource,
): Promise<ResolvedInstallSource> {
  if (source.kind === "local") {
    let localStats;
    try {
      localStats = await fs.stat(source.absolute_path);
    } catch {
      throw await buildLocalSourceNotFoundError(source);
    }
    if (localStats.isFile() && isLocalPackageArchive(source.absolute_path)) {
      const resolved = await extractLocalPackageArchive(source.absolute_path);
      return {
        source,
        directory: resolved.directory,
        source_root: path.dirname(resolved.directory),
        resolved_subpath: path
          .relative(path.dirname(resolved.directory), resolved.directory)
          .replaceAll(path.sep, "/"),
        npm_package: resolved.package,
        npm_version: resolved.version,
        cleanup: resolved.cleanup,
      };
    }
    if (!localStats.isDirectory()) {
      throw new PmCliError(
        `Local extension source must be a directory or npm .tgz/.tar.gz archive: "${source.absolute_path}".`,
        EXIT_CODE.USAGE,
      );
    }
    const directory = await resolvePackageExtensionDirectory(
      source.absolute_path,
      source.input,
    );
    return {
      source,
      directory,
      source_root: source.absolute_path,
    };
  }

  if (source.kind === "npm") {
    const resolved = await resolveNpmSourceDirectory(source);
    return {
      source,
      directory: resolved.directory,
      source_root: path.dirname(resolved.directory),
      cleanup: resolved.cleanup,
      resolved_subpath: path
        .relative(path.dirname(resolved.directory), resolved.directory)
        .replaceAll(path.sep, "/"),
      npm_package: resolved.package,
      npm_version: resolved.version,
    };
  }

  const cloneDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pm-extension-source-"),
  );
  const cloneArgs = ["clone", "--depth", "1"];
  if (source.ref) {
    cloneArgs.push("--branch", source.ref);
  }
  cloneArgs.push(source.repository, cloneDirectory);

  try {
    await runGitCommand(cloneArgs);
    const commit = await runGitCommand([
      "-C",
      cloneDirectory,
      "rev-parse",
      "HEAD",
    ]);
    const resolved = await resolveGithubSourceDirectory(cloneDirectory, source);
    return {
      source,
      directory: resolved.directory,
      source_root: cloneDirectory,
      resolved_subpath: resolved.resolved_subpath,
      commit,
      cleanup: async () => {
        await fs.rm(cloneDirectory, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await fs.rm(cloneDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Implements are directories equivalent for the public runtime surface of this module. */
export async function areDirectoriesEquivalent(
  left: string,
  right: string,
): Promise<boolean> {
  if (!(await pathExists(left)) || !(await pathExists(right))) {
    return false;
  }
  const [leftRealPath, rightRealPath] = await Promise.all([
    fs.realpath(left),
    fs.realpath(right),
  ]);
  return leftRealPath === rightRealPath;
}

/** Public contract for test only install sources, shared by SDK and presentation-layer consumers. */
export const _testOnlyInstallSources = {
  extractLocalPackageArchive,
  validateLocalPackageArchiveEntry,
  installNpmPackageRuntimeDependencies,
  npmPackageNameFromSpec,
  parsePackedNpmPackage,
  resolveNpmSourceDirectoryWithRunner,
  resolveNpmSourceDirectory,
  resolveNpmPackSpec,
  findInstalledNpmPackageCandidate,
  resolvePackageExtensionDirectory,
  runtimeDependencyInstallSpecs,
  hasHostedPmCliDependency,
  removeHostedPmCliDependency,
  linkHostedPmCliDependency,
  resolveDirectorySymlinkType,
  runNpmCommand,
};
