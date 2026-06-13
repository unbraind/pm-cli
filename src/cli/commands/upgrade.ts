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

export interface UpgradeCommandOptions {
  dryRun?: boolean;
  cliOnly?: boolean;
  packagesOnly?: boolean;
  project?: boolean;
  local?: boolean;
  global?: boolean;
  repair?: boolean;
  tag?: string;
  packageName?: string;
  commandRunner?: UpgradeCommandRunner;
}

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

export interface UpgradeCommandRunnerResult {
  stdout: string;
  stderr: string;
}

export type UpgradeCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<UpgradeCommandRunnerResult>;

export interface UpgradeCliResult {
  requested: boolean;
  status: "planned" | "updated" | "failed" | "skipped";
  package: string;
  target: string;
  command: string[];
  before_version?: string;
  after_version?: string;
  repair: boolean;
  reason?: string;
  error?: string;
}

export interface UpgradePackageResult {
  name: string;
  directory: string;
  scope: ExtensionScope;
  source: ManagedExtensionSource;
  status: "planned" | "updated" | "failed" | "skipped";
  command: string[];
  previous_version: string;
  installed_version?: string;
  reason?: string;
  error?: string;
}

export interface UpgradeResult {
  ok: boolean;
  action: "upgrade";
  dry_run: boolean;
  scope: ExtensionScope;
  target?: string;
  cli: UpgradeCliResult;
  packages: UpgradePackageResult[];
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
    throw new PmCliError('Options "--project/--local" and "--global" are mutually exclusive.', EXIT_CODE.USAGE);
  }
  return global ? "global" : "project";
}

function normalizeTarget(value: string): string {
  return value.trim().toLowerCase();
}

function packageRecordMatchesTarget(record: ManagedExtensionRecord, target: string): boolean {
  const normalizedTarget = normalizeTarget(target);
  const values = [
    record.name,
    record.directory,
    record.source.input,
    record.source.location,
    record.source.package,
    record.source.repository,
    record.source.owner && record.source.repo ? `${record.source.owner}/${record.source.repo}` : undefined,
  ];
  return values.some((value) => typeof value === "string" && normalizeTarget(value) === normalizedTarget);
}

function resolveRoots(scope: ExtensionScope, global: GlobalOptions): {
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
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : "";
    const message = stderr.trim().length > 0 ? stderr.trim() : error instanceof Error ? error.message : String(error);
    throw new PmCliError(`Command failed: ${command} ${args.join(" ")}\n${message}`, EXIT_CODE.GENERIC_FAILURE);
  }
}

async function readCurrentVersion(): Promise<string | undefined> {
  return resolvePmCliVersion(import.meta.url, ["../../.."]);
}

function resolveTag(options: UpgradeCommandOptions): string {
  return typeof options.tag === "string" && options.tag.trim().length > 0 ? options.tag.trim() : DEFAULT_TAG;
}

function resolveCliPackage(options: UpgradeCommandOptions): string {
  return typeof options.packageName === "string" && options.packageName.trim().length > 0
    ? options.packageName.trim()
    : DEFAULT_CLI_PACKAGE;
}

async function upgradeCli(options: UpgradeCommandOptions, dryRun: boolean): Promise<UpgradeCliResult> {
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
  return path.isAbsolute(spec) || spec.startsWith(".") || spec.startsWith("..") || spec.startsWith("file:");
}

function resolvePackageInstallSource(source: ManagedExtensionSource, tag: string): string {
  if (source.kind === "npm") {
    const rawSpec = source.input.startsWith("npm:") ? source.input.slice("npm:".length).trim() : source.input.trim();
    if (!isLocalNpmSpec(rawSpec) && source.package && source.package.trim().length > 0) {
      return `npm:${source.package.trim()}@${tag}`;
    }
    return source.input.startsWith("npm:") ? source.input : `npm:${source.input}`;
  }
  return source.input;
}

async function resolveRunnablePackageSource(source: ManagedExtensionSource, tag: string): Promise<string> {
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

function packageCommandFor(source: ManagedExtensionSource, installSource: string, scope: ExtensionScope, ref?: string): string[] {
  const command = ["pm", "install", installSource, scope === "global" ? "--global" : "--project"];
  if (source.kind === "github" && ref && ref.trim().length > 0) {
    command.push("--ref", ref.trim());
  }
  return command;
}

async function readManagedRecords(scope: ExtensionScope, global: GlobalOptions): Promise<ManagedExtensionRecord[]> {
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
  return records.find((candidate) => packageRecordMatchesTarget(candidate, record.name)) ??
    records.find((candidate) => normalizeTarget(candidate.directory) === normalizeTarget(record.directory));
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
  const command = packageCommandFor(record.source, installSource, scope, record.source.ref);
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
  const statuses = [includeCli ? cli.status : undefined, ...packages.map((entry) => entry.status)].filter(
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

export async function runUpgrade(
  target: string | undefined,
  options: UpgradeCommandOptions,
  global: GlobalOptions,
): Promise<UpgradeResult> {
  if (options.cliOnly === true && options.packagesOnly === true) {
    throw new PmCliError('Options "--cli-only" and "--packages-only" are mutually exclusive.', EXIT_CODE.USAGE);
  }

  const scope = resolveScope(options);
  const dryRun = options.dryRun === true;
  const normalizedTarget = typeof target === "string" && target.trim().length > 0 ? target.trim() : undefined;
  if (options.cliOnly === true && normalizedTarget) {
    throw new PmCliError('A package target cannot be used with "--cli-only".', EXIT_CODE.USAGE);
  }
  const includeCli = options.packagesOnly === true || normalizedTarget ? false : true;
  const includePackages = options.cliOnly === true ? false : true;
  const cli = includeCli
    ? await upgradeCli(options, dryRun)
    : {
        requested: false,
        status: "skipped",
        package: resolveCliPackage(options),
        target: `${resolveCliPackage(options)}@${resolveTag(options)}`,
        command: ["npm", "install", "-g", `${resolveCliPackage(options)}@${resolveTag(options)}`],
        repair: options.repair === true,
        reason: "not_requested",
      } as UpgradeCliResult;

  let packageRecords = includePackages ? await readManagedRecords(scope, global) : [];
  if (normalizedTarget) {
    packageRecords = packageRecords.filter((entry) => packageRecordMatchesTarget(entry, normalizedTarget));
    if (packageRecords.length === 0) {
      throw new PmCliError(`Managed package "${normalizedTarget}" was not found in ${scope} scope.`, EXIT_CODE.NOT_FOUND);
    }
  }

  const packages: UpgradePackageResult[] = [];
  for (const record of packageRecords) {
    packages.push(await upgradePackageRecord(record, options, global, scope, dryRun));
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
