import path from "node:path";
import { pathToFileURL } from "node:url";

const PM_PACKAGE_ROOT_ENV = "PM_CLI_PACKAGE_ROOT";
let governanceModule = null;
let governanceModulePromise = null;

async function ensureGovernanceModule() {
  if (governanceModule) {
    return governanceModule;
  }
  if (!governanceModulePromise) {
    governanceModulePromise = loadGovernanceModule();
  }
  governanceModule = await governanceModulePromise;
  return governanceModule;
}

async function loadGovernanceModule() {
  const envRoot = process.env[PM_PACKAGE_ROOT_ENV];
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      `builtin-governance-audit requires ${PM_PACKAGE_ROOT_ENV} to locate core SDK runtime exports.`,
    );
  }
  const modulePath = path.join(path.resolve(envRoot.trim()), "dist", "sdk", "runtime.js");
  try {
    const loaded = await import(pathToFileURL(modulePath).href);
    if (
      typeof loaded.runDedupeAudit === "function" &&
      typeof loaded.runCommentsAudit === "function" &&
      typeof loaded.runNormalize === "function"
    ) {
      return loaded;
    }
  } catch {
    // Fall through to deterministic failure message below.
  }
  throw new Error(
    `builtin-governance-audit failed to load governance SDK runtime exports from ${modulePath}.`,
  );
}

function readStringOption(options, key, aliases = []) {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readBooleanOption(options, key, aliases = []) {
  const keys = [key, ...aliases];
  for (const candidate of keys) {
    const value = options[candidate];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
        return false;
      }
    }
  }
  return undefined;
}

function normalizeDedupeAuditOptions(raw) {
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

function normalizeCommentsAuditOptions(raw) {
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

function normalizeNormalizeOptions(raw) {
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

export async function runDedupeAuditPackage(options, global) {
  const module = await ensureGovernanceModule();
  return module.runDedupeAudit(normalizeDedupeAuditOptions(options), global);
}

export async function runCommentsAuditPackage(options, global) {
  const module = await ensureGovernanceModule();
  return module.runCommentsAudit(normalizeCommentsAuditOptions(options), global);
}

export async function runNormalizePackage(options, global) {
  const module = await ensureGovernanceModule();
  return module.runNormalize(normalizeNormalizeOptions(options), global);
}
