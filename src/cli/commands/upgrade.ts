/**
 * @module cli/commands/upgrade
 *
 * Implements the pm upgrade command surface and its agent-facing runtime behavior.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  readManagedExtensionState,
  runExtension,
  type ExtensionScope,
  type ManagedExtensionRecord,
  type ManagedExtensionSource,
} from "./extension.js";
import { resolveExtensionRoots } from "../../core/extensions/loader.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { resolvePmCliVersion } from "../../core/packages/root.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CLI_PACKAGE = "@unbrained/pm-cli";
const DEFAULT_TAG = "latest";

/** Documents the upgrade command options payload exchanged by command, SDK, and package integrations. */
export interface UpgradeCommandOptions {
  /** Value that configures or reports dry run for this contract. */
  dryRun?: boolean;
  /** Value that configures or reports cli only for this contract. */
  cliOnly?: boolean;
  /** Value that configures or reports packages only for this contract. */
  packagesOnly?: boolean;
  /** Value that configures or reports project for this contract. */
  project?: boolean;
  /** Value that configures or reports local for this contract. */
  local?: boolean;
  /** Value that configures or reports global for this contract. */
  global?: boolean;
  /** Value that configures or reports repair for this contract. */
  repair?: boolean;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports package name for this contract. */
  packageName?: string;
  /** Value that configures or reports command runner for this contract. */
  commandRunner?: UpgradeCommandRunner;
}

/** Public contract for test only, shared by SDK and presentation-layer consumers. */
export const _testOnly = {
  defaultCommandRunner,
  isLocalNpmSpec,
  normalizeTarget,
  packageRecordMatchesTarget,
  resolveCliPackage,
  resolvePackageInstallSource,
  resolveRunnablePackageSource,
  resolveScope,
  resolveTag,
  packageCommandFor,
  summarize,
};

/** Documents the upgrade command runner result payload exchanged by command, SDK, and package integrations. */
export interface UpgradeCommandRunnerResult {
  /** Value that configures or reports stdout for this contract. */
  stdout: string;
  /** Value that configures or reports stderr for this contract. */
  stderr: string;
}

/** Restricts upgrade command runner values accepted by command, SDK, and storage contracts. */
export type UpgradeCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<UpgradeCommandRunnerResult>;

/** Documents the upgrade cli result payload exchanged by command, SDK, and package integrations. */
export interface UpgradeCliResult {
  /** Value that configures or reports requested for this contract. */
  requested: boolean;
  /** Lifecycle state reported for status. */
  status: "planned" | "updated" | "failed" | "skipped";
  /** Value that configures or reports package for this contract. */
  package: string;
  /** Value that configures or reports target for this contract. */
  target: string;
  /** Value that configures or reports command for this contract. */
  command: string[];
  /** Value that configures or reports before version for this contract. */
  before_version?: string;
  /** Value that configures or reports after version for this contract. */
  after_version?: string;
  /** Value that configures or reports repair for this contract. */
  repair: boolean;
  /** Value that configures or reports reason for this contract. */
  reason?: string;
  /** Value that configures or reports error for this contract. */
  error?: string;
}

/** Documents the upgrade package result payload exchanged by command, SDK, and package integrations. */
export interface UpgradePackageResult {
  /** Value that configures or reports name for this contract. */
  name: string;
  /** Value that configures or reports directory for this contract. */
  directory: string;
  /** Value that configures or reports scope for this contract. */
  scope: ExtensionScope;
  /** Value that configures or reports source for this contract. */
  source: ManagedExtensionSource;
  /** Lifecycle state reported for status. */
  status: "planned" | "updated" | "failed" | "skipped";
  /** Value that configures or reports command for this contract. */
  command: string[];
  /** Value that configures or reports previous version for this contract. */
  previous_version: string;
  /** Value that configures or reports installed version for this contract. */
  installed_version?: string;
  /** Value that configures or reports reason for this contract. */
  reason?: string;
  /** Value that configures or reports error for this contract. */
  error?: string;
}

/** Documents the upgrade result payload exchanged by command, SDK, and package integrations. */
export interface UpgradeResult {
  /** Whether the operation completed without a blocking failure. */
  ok: boolean;
  /** Value that configures or reports action for this contract. */
  action: "upgrade";
  /** Value that configures or reports dry run for this contract. */
  dry_run: boolean;
  /** Value that configures or reports scope for this contract. */
  scope: ExtensionScope;
  /** Value that configures or reports target for this contract. */
  target?: string;
  /** Value that configures or reports cli for this contract. */
  cli: UpgradeCliResult;
  /** Value that configures or reports packages for this contract. */
  packages: UpgradePackageResult[];
  /** Value that configures or reports summary for this contract. */
  summary: {
    requested_cli: boolean;
    requested_packages: boolean;
    planned: number;
    updated: number;
    skipped: number;
    failed: number;
  };
}

function resolveScope(options: UpgradeCommandOptions): ExtensionScope {
  const projectLike = options.project === true || options.local === true;
  const global = options.global === true;
  if (projectLike && global) {
    throw new PmCliError(
      'Options "--project/--local" and "--global" are mutually exclusive.',
      EXIT_CODE.USAGE,
    );
  }
  return global ? "global" : "project";
}

function normalizeTarget(value: string): string {
  return value.trim().toLowerCase();
}

function packageRecordMatchesTarget(
  record: ManagedExtensionRecord,
  target: string,
): boolean {
  const normalizedTarget = normalizeTarget(target);
  const values = [
    record.name,
    record.directory,
    record.source.input,
    record.source.location,
    record.source.package,
    record.source.repository,
    record.source.owner && record.source.repo
      ? `${record.source.owner}/${record.source.repo}`
      : undefined,
  ];
  return values.some(
    (value) =>
      typeof value === "string" && normalizeTarget(value) === normalizedTarget,
  );
}

function resolveRoots(
  scope: ExtensionScope,
  global: GlobalOptions,
): {
  selected_root: string;
} {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const roots = resolveExtensionRoots(pmRoot, process.cwd());
  return {
    selected_root: scope === "global" ? roots.global : roots.project,
  };
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<UpgradeCommandRunnerResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error: unknown) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    const message =
      stderr.trim().length > 0
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new PmCliError(
      `Command failed: ${command} ${args.join(" ")}\n${message}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
}

async function readCurrentVersion(): Promise<string | undefined> {
  return resolvePmCliVersion(import.meta.url, ["../../.."]);
}

function resolveTag(options: UpgradeCommandOptions): string {
  return typeof options.tag === "string" && options.tag.trim().length > 0
    ? options.tag.trim()
    : DEFAULT_TAG;
}

function resolveCliPackage(options: UpgradeCommandOptions): string {
  return typeof options.packageName === "string" &&
    options.packageName.trim().length > 0
    ? options.packageName.trim()
    : DEFAULT_CLI_PACKAGE;
}

async function upgradeCli(
  options: UpgradeCommandOptions,
  dryRun: boolean,
): Promise<UpgradeCliResult> {
  const runner = options.commandRunner ?? defaultCommandRunner;
  const packageName = resolveCliPackage(options);
  const tag = resolveTag(options);
  const target = `${packageName}@${tag}`;
  const command = ["npm", "install", "-g", target];
  if (options.repair === true) {
    command.push("--force");
  }
  const beforeVersion = await readCurrentVersion();
  const planned: UpgradeCliResult = {
    requested: true,
    status: "planned",
    package: packageName,
    target,
    command,
    before_version: beforeVersion,
    repair: options.repair === true,
  };
  if (dryRun) {
    return planned;
  }
  try {
    await runner(command[0]!, command.slice(1));
    const verified = await runner("pm", ["--version"]);
    return {
      ...planned,
      status: "updated",
      after_version: verified.stdout.trim() || undefined,
    };
  } catch (error: unknown) {
    return {
      ...planned,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isLocalNpmSpec(spec: string): boolean {
  return (
    path.isAbsolute(spec) ||
    spec.startsWith(".") ||
    spec.startsWith("..") ||
    spec.startsWith("file:")
  );
}

function resolvePackageInstallSource(
  source: ManagedExtensionSource,
  tag: string,
): string {
  if (source.kind === "npm") {
    const rawSpec = source.input.startsWith("npm:")
      ? source.input.slice("npm:".length).trim()
      : source.input.trim();
    if (
      !isLocalNpmSpec(rawSpec) &&
      source.package &&
      source.package.trim().length > 0
    ) {
      return `npm:${source.package.trim()}@${tag}`;
    }
    return source.input.startsWith("npm:")
      ? source.input
      : `npm:${source.input}`;
  }
  return source.input;
}

async function resolveRunnablePackageSource(
  source: ManagedExtensionSource,
  tag: string,
): Promise<string> {
  const installSource = resolvePackageInstallSource(source, tag);
  if (source.kind !== "local") {
    return installSource;
  }
  if (await pathExists(installSource)) {
    return installSource;
  }
  if (await pathExists(source.location)) {
    return source.location;
  }
  return installSource;
}

function packageCommandFor(
  source: ManagedExtensionSource,
  installSource: string,
  scope: ExtensionScope,
  ref?: string,
): string[] {
  const command = [
    "pm",
    "install",
    installSource,
    scope === "global" ? "--global" : "--project",
  ];
  if (source.kind === "github" && ref && ref.trim().length > 0) {
    command.push("--ref", ref.trim());
  }
  return command;
}

async function readManagedRecords(
  scope: ExtensionScope,
  global: GlobalOptions,
): Promise<ManagedExtensionRecord[]> {
  const roots = resolveRoots(scope, global);
  const managedState = await readManagedExtensionState(roots.selected_root);
  return managedState.state.entries.filter((entry) => entry.scope === scope);
}

async function refreshManagedRecord(
  scope: ExtensionScope,
  global: GlobalOptions,
  record: ManagedExtensionRecord,
): Promise<ManagedExtensionRecord | undefined> {
  const records = await readManagedRecords(scope, global);
  return (
    records.find((candidate) =>
      packageRecordMatchesTarget(candidate, record.name),
    ) ??
    records.find(
      (candidate) =>
        normalizeTarget(candidate.directory) ===
        normalizeTarget(record.directory),
    )
  );
}

async function upgradePackageRecord(
  record: ManagedExtensionRecord,
  options: UpgradeCommandOptions,
  global: GlobalOptions,
  scope: ExtensionScope,
  dryRun: boolean,
): Promise<UpgradePackageResult> {
  const tag = resolveTag(options);
  const installSource = await resolveRunnablePackageSource(record.source, tag);
  const command = packageCommandFor(
    record.source,
    installSource,
    scope,
    record.source.ref,
  );
  const planned: UpgradePackageResult = {
    name: record.name,
    directory: record.directory,
    scope,
    source: record.source,
    status: "planned",
    command,
    previous_version: record.manifest_version,
  };
  if (dryRun) {
    return planned;
  }
  try {
    await runExtension(
      installSource,
      {
        install: true,
        project: scope === "project",
        global: scope === "global",
        ref: record.source.kind === "github" ? record.source.ref : undefined,
      },
      global,
    );
    const refreshed = await refreshManagedRecord(scope, global, record);
    return {
      ...planned,
      status: "updated",
      installed_version: refreshed?.manifest_version,
    };
  } catch (error: unknown) {
    return {
      ...planned,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarize(
  cli: UpgradeCliResult,
  packages: UpgradePackageResult[],
  includeCli: boolean,
  includePackages: boolean,
): UpgradeResult["summary"] {
  const statuses = [
    includeCli ? cli.status : undefined,
    ...packages.map((entry) => entry.status),
  ].filter(
    (value): value is UpgradeCliResult["status"] => typeof value === "string",
  );
  return {
    requested_cli: includeCli,
    requested_packages: includePackages,
    planned: statuses.filter((status) => status === "planned").length,
    updated: statuses.filter((status) => status === "updated").length,
    skipped: statuses.filter((status) => status === "skipped").length,
    failed: statuses.filter((status) => status === "failed").length,
  };
}

/** Implements run upgrade for the public runtime surface of this module. */
export async function runUpgrade(
  target: string | undefined,
  options: UpgradeCommandOptions,
  global: GlobalOptions,
): Promise<UpgradeResult> {
  if (options.cliOnly === true && options.packagesOnly === true) {
    throw new PmCliError(
      'Options "--cli-only" and "--packages-only" are mutually exclusive.',
      EXIT_CODE.USAGE,
    );
  }

  const scope = resolveScope(options);
  const dryRun = options.dryRun === true;
  const normalizedTarget =
    typeof target === "string" && target.trim().length > 0
      ? target.trim()
      : undefined;
  if (options.cliOnly === true && normalizedTarget) {
    throw new PmCliError(
      'A package target cannot be used with "--cli-only".',
      EXIT_CODE.USAGE,
    );
  }
  const includeCli =
    options.packagesOnly === true || normalizedTarget ? false : true;
  const includePackages = options.cliOnly === true ? false : true;
  const cli = includeCli
    ? await upgradeCli(options, dryRun)
    : ({
        requested: false,
        status: "skipped",
        package: resolveCliPackage(options),
        target: `${resolveCliPackage(options)}@${resolveTag(options)}`,
        command: [
          "npm",
          "install",
          "-g",
          `${resolveCliPackage(options)}@${resolveTag(options)}`,
        ],
        repair: options.repair === true,
        reason: "not_requested",
      } as UpgradeCliResult);

  let packageRecords = includePackages
    ? await readManagedRecords(scope, global)
    : [];
  if (normalizedTarget) {
    packageRecords = packageRecords.filter((entry) =>
      packageRecordMatchesTarget(entry, normalizedTarget),
    );
    if (packageRecords.length === 0) {
      throw new PmCliError(
        `Managed package "${normalizedTarget}" was not found in ${scope} scope.`,
        EXIT_CODE.NOT_FOUND,
      );
    }
  }

  const packages: UpgradePackageResult[] = [];
  for (const record of packageRecords) {
    packages.push(
      await upgradePackageRecord(record, options, global, scope, dryRun),
    );
  }

  const summary = summarize(cli, packages, includeCli, includePackages);
  return {
    ok: summary.failed === 0,
    action: "upgrade",
    dry_run: dryRun,
    scope,
    target: normalizedTarget,
    cli,
    packages,
    summary,
  };
}
