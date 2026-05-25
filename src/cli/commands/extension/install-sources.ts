import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { collectPackageExtensionDirectories } from "../../../core/packages/manifest.js";
import { pathExists } from "../../../core/fs/fs-utils.js";
import { isPathWithinDirectory } from "../../../core/fs/path-utils.js";
import { EXIT_CODE } from "../../../core/shared/constants.js";
import { PmCliError } from "../../../core/shared/errors.js";

const execFileAsync = promisify(execFile);

interface LocalInstallSource {
  kind: "local";
  input: string;
  absolute_path: string;
}

interface GithubInstallSource {
  kind: "github";
  input: string;
  owner: string;
  repo: string;
  repository: string;
  ref?: string;
  subpath?: string;
}

interface NpmInstallSource {
  kind: "npm";
  input: string;
  spec: string;
}

type InstallSource = LocalInstallSource | GithubInstallSource | NpmInstallSource;

interface ResolvedInstallSource {
  source: InstallSource;
  directory: string;
  resolved_subpath?: string;
  commit?: string;
  npm_package?: string;
  npm_version?: string;
  cleanup?: () => Promise<void>;
}

function parseGithubPathSpec(pathSpec: string, input: string, refOverride?: string): GithubInstallSource | null {
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

export function parseExtensionInstallSource(input: string, options: { forceGithub?: boolean; ref?: string } = {}): InstallSource {
  const normalizedInput = input.trim();
  if (normalizedInput.length === 0) {
    throw new PmCliError("Extension source is required for --install.", EXIT_CODE.USAGE);
  }
  const refOverride = typeof options.ref === "string" && options.ref.trim().length > 0 ? options.ref.trim() : undefined;

  if (normalizedInput.startsWith("npm:")) {
    const spec = normalizedInput.slice("npm:".length).trim();
    if (spec.length === 0) {
      throw new PmCliError('npm package source must include a package spec after "npm:".', EXIT_CODE.USAGE);
    }
    if (options.forceGithub) {
      throw new PmCliError('Options "--gh/--github" cannot be combined with npm: package sources.', EXIT_CODE.USAGE);
    }
    if (refOverride) {
      throw new PmCliError('Option "--ref" cannot be combined with npm: package sources.', EXIT_CODE.USAGE);
    }
    return {
      kind: "npm",
      input: normalizedInput,
      spec,
    };
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

  const strippedDomainInput = normalizedInput.startsWith("github.com/") ? normalizedInput.slice("github.com/".length) : null;
  if (strippedDomainInput) {
    const parsed = parseGithubPathSpec(strippedDomainInput, normalizedInput, refOverride);
    if (!parsed) {
      throw new PmCliError(`Invalid GitHub source "${normalizedInput}".`, EXIT_CODE.USAGE);
    }
    return parsed;
  }

  if (options.forceGithub) {
    const parsed = parseGithubPathSpec(normalizedInput, normalizedInput, refOverride);
    if (!parsed) {
      throw new PmCliError(`Invalid GitHub shorthand "${normalizedInput}".`, EXIT_CODE.USAGE);
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

export async function runGitCommand(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { encoding: "utf8" });
    return (result.stdout ?? "").trim();
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
    const message = stderr.trim().length > 0 ? stderr.trim() : error instanceof Error ? error.message : String(error);
    throw new PmCliError(`Git command failed: git ${args.join(" ")}\n${message}`, EXIT_CODE.GENERIC_FAILURE);
  }
}

async function runNpmCommand(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFileAsync("npm", args, { cwd, encoding: "utf8" });
    return (result.stdout ?? "").trim();
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
    const message = stderr.trim().length > 0 ? stderr.trim() : error instanceof Error ? error.message : String(error);
    throw new PmCliError(`npm command failed: npm ${args.join(" ")}\n${message}`, EXIT_CODE.GENERIC_FAILURE);
  }
}

async function resolveLocalNpmPackagePath(spec: string): Promise<string | null> {
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
    return pathToFileURL(localPath).href;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    return spec;
  }

  return spec;
}

function parsePackedNpmPackage(stdout: string, packDirectory: string): { tarball: string; package?: string; version?: string } {
  try {
    const parsed = JSON.parse(stdout) as Array<{ filename?: unknown; name?: unknown; version?: unknown }>;
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    if (first && typeof first.filename === "string" && first.filename.trim().length > 0) {
      return {
        tarball: path.resolve(packDirectory, first.filename),
        package: typeof first.name === "string" ? first.name : undefined,
        version: typeof first.version === "string" ? first.version : undefined,
      };
    }
  } catch {
    // Fall back to the last stdout line for older npm output.
  }
  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!lastLine) {
    throw new PmCliError("npm pack did not report a tarball filename.", EXIT_CODE.GENERIC_FAILURE);
  }
  return {
    tarball: path.resolve(packDirectory, lastLine),
  };
}

async function resolveNpmSourceDirectory(source: NpmInstallSource): Promise<{
  directory: string;
  package?: string;
  version?: string;
  cleanup: () => Promise<void>;
}> {
  const localPackageRoot = await resolveLocalNpmPackagePath(source.spec);
  if (localPackageRoot) {
    const packageJsonPath = path.join(localPackageRoot, "package.json");
    const packageJson = (await pathExists(packageJsonPath))
      ? JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown }
      : {};
    return {
      directory: await resolvePackageExtensionDirectory(localPackageRoot, source.input),
      package: typeof packageJson.name === "string" ? packageJson.name : undefined,
      version: typeof packageJson.version === "string" ? packageJson.version : undefined,
      cleanup: async () => {},
    };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-npm-package-source-"));
  const packDirectory = path.join(tempRoot, "pack");
  const extractDirectory = path.join(tempRoot, "extract");
  await fs.mkdir(packDirectory, { recursive: true });
  await fs.mkdir(extractDirectory, { recursive: true });

  try {
    const packSpec = await resolveNpmPackSpec(source.spec);
    const packStdout = await runNpmCommand(["pack", packSpec, "--json", "--pack-destination", packDirectory]);
    const packed = parsePackedNpmPackage(packStdout, packDirectory);
    await execFileAsync("tar", ["-xzf", packed.tarball, "-C", extractDirectory], { encoding: "utf8" });
    const packageRoot = path.join(extractDirectory, "package");
    await installNpmPackageRuntimeDependencies(packageRoot);
    const directory = await resolvePackageExtensionDirectory(packageRoot, source.input);
    return {
      directory,
      package: packed.package,
      version: packed.version,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function installNpmPackageRuntimeDependencies(packageRoot: string): Promise<void> {
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

  const manifest = parsed as { dependencies?: unknown; optionalDependencies?: unknown; peerDependencies?: unknown };
  const dependencySpecs = runtimeDependencyInstallSpecs(manifest);
  if (dependencySpecs.length === 0) {
    return;
  }

  const runtimeOnlyManifest = { ...(parsed as Record<string, unknown>) };
  delete runtimeOnlyManifest.devDependencies;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(runtimeOnlyManifest, null, 2)}\n`, "utf8");
  await Promise.all([
    fs.rm(path.join(packageRoot, "package-lock.json"), { force: true }),
    fs.rm(path.join(packageRoot, "npm-shrinkwrap.json"), { force: true }),
  ]);

  await runNpmCommand(
    ["install", "--ignore-scripts", "--no-audit", "--fund=false", "--package-lock=false", "--no-save", ...dependencySpecs],
    packageRoot,
  );
}

function runtimeDependencyInstallSpecs(manifest: {
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}): string[] {
  const specs = new Map<string, string>();
  for (const dependencyMap of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
    if (typeof dependencyMap !== "object" || dependencyMap === null) {
      continue;
    }
    for (const [name, version] of Object.entries(dependencyMap)) {
      if (typeof version !== "string" || version.trim().length === 0 || specs.has(name)) {
        continue;
      }
      specs.set(name, `${name}@${version.trim()}`);
    }
  }
  return [...specs.values()];
}

async function resolvePackageExtensionDirectory(packageRoot: string, sourceLabel: string): Promise<string> {
  const discovered = await collectPackageExtensionDirectories(packageRoot);
  if (discovered.length === 1) {
    return discovered[0];
  }
  if (discovered.length > 1) {
    const choices = discovered
      .map((entry) => path.relative(packageRoot, entry).replaceAll(path.sep, "/"))
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

async function resolveGithubSourceDirectory(cloneDirectory: string, source: GithubInstallSource): Promise<{ directory: string; resolved_subpath?: string }> {
  const candidatePaths: string[] = [];
  if (source.subpath) {
    candidatePaths.push(source.subpath);
    candidatePaths.push(path.posix.join(".agents/pm/extensions", source.subpath));
    candidatePaths.push(path.posix.join(".custom/pm-extensions", source.subpath));
    candidatePaths.push(path.posix.join(".custom/pm-extension", source.subpath));
  }

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

  const discoveredDirectory = await resolvePackageExtensionDirectory(cloneDirectory, source.input);
  return {
    directory: discoveredDirectory,
    resolved_subpath: path.relative(cloneDirectory, discoveredDirectory).replaceAll(path.sep, "/"),
  };
}

export async function resolveInstallSource(source: InstallSource): Promise<ResolvedInstallSource> {
  if (source.kind === "local") {
    let localStats;
    try {
      localStats = await fs.stat(source.absolute_path);
    } catch {
      throw new PmCliError(`Local extension source does not exist: "${source.absolute_path}".`, EXIT_CODE.NOT_FOUND);
    }
    if (!localStats.isDirectory()) {
      throw new PmCliError(`Local extension source must be a directory: "${source.absolute_path}".`, EXIT_CODE.USAGE);
    }
    const directory = await resolvePackageExtensionDirectory(source.absolute_path, source.input);
    return {
      source,
      directory,
    };
  }

  if (source.kind === "npm") {
    const resolved = await resolveNpmSourceDirectory(source);
    return {
      source,
      directory: resolved.directory,
      cleanup: resolved.cleanup,
      resolved_subpath: path.relative(path.dirname(resolved.directory), resolved.directory).replaceAll(path.sep, "/"),
      npm_package: resolved.package,
      npm_version: resolved.version,
    };
  }

  const cloneDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-extension-source-"));
  const cloneArgs = ["clone", "--depth", "1"];
  if (source.ref) {
    cloneArgs.push("--branch", source.ref);
  }
  cloneArgs.push(source.repository, cloneDirectory);

  try {
    await runGitCommand(cloneArgs);
    const commit = await runGitCommand(["-C", cloneDirectory, "rev-parse", "HEAD"]);
    const resolved = await resolveGithubSourceDirectory(cloneDirectory, source);
    return {
      source,
      directory: resolved.directory,
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

export async function areDirectoriesEquivalent(left: string, right: string): Promise<boolean> {
  if (!(await pathExists(left)) || !(await pathExists(right))) {
    return false;
  }
  const [leftRealPath, rightRealPath] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
  return leftRealPath === rightRealPath;
}
