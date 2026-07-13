/**
 * Runtime contracts and behavior for packages/pm governance audit/extensions/governance audit/runtime.
 *
 * @module packages/pm-governance-audit/extensions/governance-audit/runtime
 */
import {
  readBooleanOption,
  readCsvListOption,
  readStringOption,
  type GlobalOptions,
} from "./sdk.ts";
import { runCommentsAudit } from "./comments-audit.ts";
import { runDedupeAudit } from "./dedupe-audit.ts";
import { runDedupeMerge } from "./dedupe-merge.ts";
import { runNormalize } from "./normalize.ts";

interface GovernanceRuntimeSdkModule {
  runDedupeAudit: typeof runDedupeAudit;
  runDedupeMerge: typeof runDedupeMerge;
  runCommentsAudit: typeof runCommentsAudit;
  runNormalize: typeof runNormalize;
  readStringOption: (
    options: Record<string, unknown>,
    key: string,
    aliases?: string[],
  ) => string | undefined;
  readBooleanOption: (
    options: Record<string, unknown>,
    key: string,
    aliases?: string[],
  ) => boolean | undefined;
  readCsvListOption: (
    options: Record<string, unknown>,
    key: string,
    aliases?: string[],
  ) => string[] | undefined;
}

const governanceModule: GovernanceRuntimeSdkModule = {
  runDedupeAudit,
  runDedupeMerge,
  runCommentsAudit,
  runNormalize,
  readStringOption,
  readBooleanOption,
  readCsvListOption,
};

async function ensureGovernanceModule(): Promise<GovernanceRuntimeSdkModule> {
  return governanceModule;
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
    deadlineBefore: readStringOption(raw, "deadlineBefore", [
      "deadline_before",
    ]),
    deadlineAfter: readStringOption(raw, "deadlineAfter", ["deadline_after"]),
    assignee: readStringOption(raw, "assignee"),
    assigneeFilter: readStringOption(raw, "assigneeFilter", [
      "assignee_filter",
    ]),
    parent: readStringOption(raw, "parent"),
    sprint: readStringOption(raw, "sprint"),
    release: readStringOption(raw, "release"),
    limit: readStringOption(raw, "limit"),
    threshold: readStringOption(raw, "threshold"),
  };
}

function normalizeDedupeMergeOptions(
  sdk: GovernanceRuntimeSdkModule,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const readStringOption = sdk.readStringOption;
  const readBooleanOption = sdk.readBooleanOption;
  return {
    keep: readStringOption(raw, "keep"),
    close: sdk.readCsvListOption(raw, "close"),
    apply: readBooleanOption(raw, "apply") === true ? true : undefined,
    dryRun:
      readBooleanOption(raw, "dryRun", ["dry_run"]) === true ? true : undefined,
    // --skip-children opts out of re-parenting; otherwise core defaults to true.
    reparentChildren:
      readBooleanOption(raw, "skipChildren", ["skip_children"]) === true
        ? false
        : undefined,
    author: readStringOption(raw, "author"),
    message: readStringOption(raw, "message"),
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
    assigneeFilter: readStringOption(raw, "assigneeFilter", [
      "assignee_filter",
    ]),
    limit: readStringOption(raw, "limit"),
    limitItems: readStringOption(raw, "limitItems", ["limit_items"]),
    latest: readStringOption(raw, "latest"),
    fullHistory:
      readBooleanOption(raw, "fullHistory", ["full_history"]) === true
        ? true
        : undefined,
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
      deadlineBefore: readStringOption(raw, "deadlineBefore", [
        "deadline_before",
      ]),
      deadlineAfter: readStringOption(raw, "deadlineAfter", ["deadline_after"]),
      assignee: readStringOption(raw, "assignee"),
      assigneeFilter: readStringOption(raw, "assigneeFilter", [
        "assignee_filter",
      ]),
      parent: readStringOption(raw, "parent"),
      sprint: readStringOption(raw, "sprint"),
      release: readStringOption(raw, "release"),
      limit: readStringOption(raw, "limit"),
      offset: readStringOption(raw, "offset"),
      includeBody:
        readBooleanOption(raw, "includeBody", ["include_body"]) === true
          ? true
          : undefined,
      compact: readBooleanOption(raw, "compact") === true ? true : undefined,
      fields: readStringOption(raw, "fields"),
      sort: readStringOption(raw, "sort"),
      order: readStringOption(raw, "order"),
    },
    dryRun:
      readBooleanOption(raw, "dryRun", ["dry_run"]) === true ? true : undefined,
    apply: readBooleanOption(raw, "apply") === true ? true : undefined,
    author: readStringOption(raw, "author"),
    message: readStringOption(raw, "message"),
    force: readBooleanOption(raw, "force") === true ? true : undefined,
    allowAuditUpdate:
      readBooleanOption(raw, "allowAuditUpdate", ["allow_audit_update"]) ===
      true
        ? true
        : undefined,
  };
}

/** Executes the dedupe audit package operation through the package runtime. */
export async function runDedupeAuditPackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const module = await ensureGovernanceModule();
  return module.runDedupeAudit(
    normalizeDedupeAuditOptions(module, options) as Parameters<
      typeof runDedupeAudit
    >[0],
    global,
  );
}

/** Executes the dedupe merge package operation through the package runtime. */
export async function runDedupeMergePackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const module = await ensureGovernanceModule();
  return module.runDedupeMerge(
    normalizeDedupeMergeOptions(module, options) as Parameters<
      typeof runDedupeMerge
    >[0],
    global,
  );
}

/** Executes the comments audit package operation through the package runtime. */
export async function runCommentsAuditPackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const module = await ensureGovernanceModule();
  return module.runCommentsAudit(
    normalizeCommentsAuditOptions(module, options) as Parameters<
      typeof runCommentsAudit
    >[0],
    global,
  );
}

/** Executes the normalize package operation through the package runtime. */
export async function runNormalizePackage(
  options: Record<string, unknown>,
  global: GlobalOptions,
): Promise<unknown> {
  const module = await ensureGovernanceModule();
  return module.runNormalize(
    normalizeNormalizeOptions(module, options) as unknown as Parameters<
      typeof runNormalize
    >[0],
    global,
  );
}
