import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GlobalOptions } from "../../../../src/sdk/runtime.js";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";

interface GovernanceRuntimeSdkModule {
  runDedupeAudit: (options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
  runCommentsAudit: (options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
  runNormalize: (options: Record<string, unknown>, global: GlobalOptions) => Promise<unknown>;
  readStringOption: (options: Record<string, unknown>, key: string, aliases?: string[]) => string | undefined;
  readBooleanOption: (options: Record<string, unknown>, key: string, aliases?: string[]) => boolean | undefined;
}

let governanceModule: GovernanceRuntimeSdkModule | null = null;
let governanceModulePromise: Promise<GovernanceRuntimeSdkModule> | null = null;

async function ensureGovernanceModule(): Promise<GovernanceRuntimeSdkModule> {
  if (governanceModule) {
    return governanceModule;
  }
  if (!governanceModulePromise) {
    governanceModulePromise = loadGovernanceModule();
  }
  governanceModule = await governanceModulePromise;
  return governanceModule;
}

async function loadGovernanceModule(): Promise<GovernanceRuntimeSdkModule> {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-governance-audit requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<GovernanceRuntimeSdkModule>;
    if (
      typeof loaded.runDedupeAudit === "function" &&
      typeof loaded.runCommentsAudit === "function" &&
      typeof loaded.runNormalize === "function" &&
      typeof loaded.readStringOption === "function" &&
      typeof loaded.readBooleanOption === "function"
    ) {
      return loaded as GovernanceRuntimeSdkModule;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-governance-audit failed to load governance SDK runtime exports from ${modulePath}.`,
  );
}

function normalizeDedupeAuditOptions(
  sdk: GovernanceRuntimeSdkModule,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const readStringOption = sdk.readStringOption;
  return {
    mode: readStringOption(raw, "mode"),
    status: readStringOption(raw, "status"),
    type: readStringOption(raw, "type"),
    tag: readStringOption(raw, "tag"),
    priority: readStringOption(raw, "priority"),
    deadlineBefore: readStringOption(raw, "deadlineBefore", ["deadline_before"]),
    deadlineAfter: readStringOption(raw, "deadlineAfter", ["deadline_after"]),
    assignee: readStringOption(raw, "assignee"),
    assigneeFilter: readStringOption(raw, "assigneeFilter", ["assignee_filter"]),
    parent: readStringOption(raw, "parent"),
    sprint: readStringOption(raw, "sprint"),
    release: readStringOption(raw, "release"),
    limit: readStringOption(raw, "limit"),
    threshold: readStringOption(raw, "threshold"),
  };
}

function normalizeCommentsAuditOptions(
  sdk: GovernanceRuntimeSdkModule,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const readStringOption = sdk.readStringOption;
  const readBooleanOption = sdk.readBooleanOption;
  return {
    status: readStringOption(raw, "status"),
    type: readStringOption(raw, "type"),
    tag: readStringOption(raw, "tag"),
    priority: readStringOption(raw, "priority"),
    parent: readStringOption(raw, "parent"),
    sprint: readStringOption(raw, "sprint"),
    release: readStringOption(raw, "release"),
    assignee: readStringOption(raw, "assignee"),
    assigneeFilter: readStringOption(raw, "assigneeFilter", ["assignee_filter"]),
    limit: readStringOption(raw, "limit"),
    limitItems: readStringOption(raw, "limitItems", ["limit_items"]),
    latest: readStringOption(raw, "latest"),
    fullHistory: readBooleanOption(raw, "fullHistory", ["full_history"]) === true ? true : undefined,
  };
}

function normalizeNormalizeOptions(
  sdk: GovernanceRuntimeSdkModule,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const readStringOption = sdk.readStringOption;
  const readBooleanOption = sdk.readBooleanOption;
  return {
    status: readStringOption(raw, "filterStatus", ["filter_status", "status"]),
    list: {
      type: readStringOption(raw, "type"),
      tag: readStringOption(raw, "tag"),
      priority: readStringOption(raw, "priority"),
      deadlineBefore: readStringOption(raw, "deadlineBefore", ["deadline_before"]),
      deadlineAfter: readStringOption(raw, "deadlineAfter", ["deadline_after"]),
      assignee: readStringOption(raw, "assignee"),
      assigneeFilter: readStringOption(raw, "assigneeFilter", ["assignee_filter"]),
      parent: readStringOption(raw, "parent"),
      sprint: readStringOption(raw, "sprint"),
      release: readStringOption(raw, "release"),
      limit: readStringOption(raw, "limit"),
      offset: readStringOption(raw, "offset"),
      includeBody: readBooleanOption(raw, "includeBody", ["include_body"]) === true ? true : undefined,
      compact: readBooleanOption(raw, "compact") === true ? true : undefined,
      fields: readStringOption(raw, "fields"),
      sort: readStringOption(raw, "sort"),
      order: readStringOption(raw, "order"),
    },
    dryRun: readBooleanOption(raw, "dryRun", ["dry_run"]) === true ? true : undefined,
    apply: readBooleanOption(raw, "apply") === true ? true : undefined,
    author: readStringOption(raw, "author"),
    message: readStringOption(raw, "message"),
    force: readBooleanOption(raw, "force") === true ? true : undefined,
    allowAuditUpdate: readBooleanOption(raw, "allowAuditUpdate", ["allow_audit_update"]) === true ? true : undefined,
  };
}

export async function runDedupeAuditPackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const module = await ensureGovernanceModule();
  return module.runDedupeAudit(normalizeDedupeAuditOptions(module, options), global);
}

export async function runCommentsAuditPackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const module = await ensureGovernanceModule();
  return module.runCommentsAudit(normalizeCommentsAuditOptions(module, options), global);
}

export async function runNormalizePackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const module = await ensureGovernanceModule();
  return module.runNormalize(normalizeNormalizeOptions(module, options), global);
}
