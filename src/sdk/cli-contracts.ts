export type { CommanderOptionAliasContract, CommanderOptionRegistrationContract } from "./cli-contracts/commander-types.js";
export {
  ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS,
  CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS,
  CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS,
  LIST_COMMANDER_STRING_OPTION_CONTRACTS,
  SEARCH_COMMANDER_STRING_OPTION_CONTRACTS,
  readFirstValueFromCommanderOptions,
  readFirstStringFromCommanderOptions,
  readStringArrayFromCommanderOptions,
} from "./cli-contracts/commander-types.js";
export {
  CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  CREATE_COMMANDER_STRING_OPTION_CONTRACTS,
  UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS,
  UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS,
  UPDATE_COMMANDER_STRING_OPTION_CONTRACTS,
} from "./cli-contracts/commander-mutation-options.js";
// PM_* enum/guard contracts and the bulk tool-parameter property/metadata data
// tables live in sibling modules and are re-exported here so existing import
// sites (sdk/index.ts, mcp/server.ts, commands/contracts.ts, completion.ts, …)
// keep importing everything from "./cli-contracts.js" unchanged.
export {
  PM_EXTENSION_CAPABILITY_CONTRACTS,
  PM_EXTENSION_SERVICE_NAME_CONTRACTS,
  PM_EXTENSION_POLICY_MODE_CONTRACTS,
  PM_EXTENSION_TRUST_MODE_CONTRACTS,
  PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS,
  PM_EXTENSION_POLICY_SURFACE_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  PM_TOOL_ACTIONS,
  isPmToolAction,
  isPmExtensionCapabilityContract,
  isPmExtensionServiceNameContract,
  isPmExtensionPolicyModeContract,
  isPmExtensionPolicySurfaceContract,
} from "./cli-contracts/enum-contracts.js";
export type {
  PmExtensionCapabilityContract,
  PmExtensionServiceNameContract,
  PmExtensionPolicyModeContract,
  PmExtensionTrustModeContract,
  PmExtensionSandboxProfileContract,
  PmExtensionPolicySurfaceContract,
  PmToolAction,
} from "./cli-contracts/enum-contracts.js";
export {
  TOOL_LIST_FILTER_OPTION_CONTRACTS,
  TOOL_AGGREGATE_OPTION_CONTRACTS,
  TOOL_DEDUPE_AUDIT_OPTION_CONTRACTS,
  TOOL_SEARCH_FILTER_OPTION_CONTRACTS,
  TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS,
  TOOL_CREATE_OPTION_CONTRACTS,
  TOOL_UPDATE_OPTION_CONTRACTS,
  TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS,
  TOOL_NORMALIZE_FILTER_OPTION_CONTRACTS,
  TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS,
  TOOL_CALENDAR_OPTION_CONTRACTS,
  TOOL_ACTIVITY_OPTION_CONTRACTS,
  TOOL_CONTEXT_OPTION_CONTRACTS,
  TOOL_DEPS_OPTION_CONTRACTS,
} from "./cli-contracts/tool-option-contracts.js";
import { PM_TOOL_ACTIONS, type PmToolAction } from "./cli-contracts/enum-contracts.js";
import {
  TOOL_CREATE_OPTION_CONTRACTS,
  TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS,
  TOOL_UPDATE_OPTION_CONTRACTS,
  TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS,
  TOOL_NORMALIZE_FILTER_OPTION_CONTRACTS,
  TOOL_CONTEXT_OPTION_CONTRACTS,
  TOOL_ACTIVITY_OPTION_CONTRACTS,
  TOOL_LIST_FILTER_OPTION_CONTRACTS,
  TOOL_AGGREGATE_OPTION_CONTRACTS,
  TOOL_DEDUPE_AUDIT_OPTION_CONTRACTS,
  TOOL_SEARCH_FILTER_OPTION_CONTRACTS,
  TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS,
} from "./cli-contracts/tool-option-contracts.js";
import {
  PM_TOOL_PARAMETER_PROPERTIES,
  PM_TOOL_PARAMETER_METADATA,
  PLAN_ACTION_PARAMETER_PROPERTIES,
  PLAN_ACTION_PARAMETER_METADATA,
} from "./cli-contracts/tool-parameter-tables.js";

export interface CliFlagContract {
  flag: string;
  short?: string;
  aliases?: string[];
  description?: string;
  required?: boolean;
  repeatable?: boolean;
  /**
   * Comma-separated multi-value flag whose repeated occurrences should
   * accumulate (e.g. `--tag a --tag b` ≡ `--tags a,b`). Argv normalization
   * coalesces repeats of these into one comma-joined token to avoid
   * scalar keep-last data loss in Commander.
   */
  list?: boolean;
  value_name?: string;
  value_type?: "string" | "number" | "boolean";
}

export interface ToolOptionFlagContract {
  param: string;
  flag: string;
  allowEmpty?: boolean;
  repeatable?: boolean;
  booleanish?: boolean;
}

function normalizeUniqueStringList(values: Iterable<string>): string[] {
  return [...new Set(Array.from(values).filter((value) => value.trim().length > 0))];
}

function normalizeFlagAliasKey(flag: string): string {
  if (!flag.startsWith("--")) {
    return flag;
  }
  return `--${flag.slice(2).replaceAll("_", "-")}`;
}

export function withFlagAliasMetadata(flagContracts: CliFlagContract[]): CliFlagContract[] {
  const aliasesByCanonical = new Map<string, Set<string>>();
  for (const contract of flagContracts) {
    const canonical = normalizeFlagAliasKey(contract.flag);
    const bucket = aliasesByCanonical.get(canonical) ?? new Set<string>();
    if (contract.flag !== canonical) {
      bucket.add(contract.flag);
    }
    for (const alias of contract.aliases ?? []) {
      if (alias !== canonical) {
        bucket.add(alias);
      }
    }
    aliasesByCanonical.set(canonical, bucket);
  }

  return flagContracts.map((contract) => {
    const canonical = normalizeFlagAliasKey(contract.flag);
    if (contract.flag !== canonical) {
      return contract;
    }
    const aliases = normalizeUniqueStringList([
      ...(contract.aliases ?? []),
      ...aliasesByCanonical.get(canonical)!,
    ]).filter((alias) => alias !== canonical);
    if (aliases.length === 0) {
      return contract;
    }
    return {
      ...contract,
      aliases,
    };
  });
}

export function compactFlagAliasContracts(flagContracts: CliFlagContract[]): CliFlagContract[] {
  const withAliases = withFlagAliasMetadata(flagContracts);
  const canonicalFlags = new Set(withAliases.map((contract) => contract.flag));
  return withAliases.filter((contract) => {
    const canonical = normalizeFlagAliasKey(contract.flag);
    return contract.flag === canonical || !canonicalFlags.has(canonical);
  });
}

export const SUBCOMMAND_GLOBAL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--json" },
  { flag: "--quiet" },
  { flag: "--no-changed-fields" },
  { flag: "--id-only" },
  { flag: "--pm-path", aliases: ["--path"] },
  { flag: "--no-extensions" },
  { flag: "--no-pager" },
  { flag: "--profile" },
  { flag: "--help" },
];

export const GLOBAL_FLAG_CONTRACTS: CliFlagContract[] = [
  ...SUBCOMMAND_GLOBAL_FLAG_CONTRACTS,
  { flag: "--version" },
];

export const LIST_FILTER_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status", list: true },
  { flag: "--type" },
  { flag: "--tag", aliases: ["--tags"] },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--updated-after" },
  { flag: "--updated-before" },
  { flag: "--created-after" },
  { flag: "--created-before" },
  { flag: "--ids", list: true },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--filter-ac-missing" },
  { flag: "--filter-estimates-missing", aliases: ["--filter-estimate-missing"] },
  { flag: "--filter-resolution-missing" },
  { flag: "--filter-metadata-missing" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--no-truncate", aliases: ["--all"] },
  { flag: "--compact" },
  { flag: "--brief" },
  { flag: "--full" },
  { flag: "--fields", list: true },
  { flag: "--sort" },
  { flag: "--order" },
  { flag: "--tree" },
  { flag: "--tree-depth" },
  { flag: "--tree_depth" },
  { flag: "--include-body" },
  { flag: "--stream" },
];

export const AGGREGATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--group-by", list: true },
  { flag: "--count" },
  { flag: "--completion" },
  { flag: "--sum" },
  { flag: "--avg" },
  { flag: "--include-unparented" },
  { flag: "--include_unparented" },
  { flag: "--status" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--sprint" },
  { flag: "--release" },
];

export const DEDUPE_AUDIT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--limit" },
  { flag: "--threshold" },
  { flag: "--status" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--sprint" },
  { flag: "--release" },
];

export const COMMENTS_AUDIT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--type" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--parent" },
  { flag: "--tag" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--priority" },
  { flag: "--limit-items" },
  { flag: "--limit" },
  { flag: "--full-history" },
  { flag: "--latest" },
];

export const COMMENTS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add", aliases: ["--comment"] },
  { flag: "--stdin" },
  { flag: "--file" },
  { flag: "--limit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-comment" },
  { flag: "--force" },
];

export const NOTES_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add", aliases: ["--note"] },
  { flag: "--limit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-note" },
  { flag: "--allow-audit-comment" },
  { flag: "--force" },
];

export const LEARNINGS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add", aliases: ["--learning"] },
  { flag: "--limit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-learning" },
  { flag: "--allow-audit-comment" },
  { flag: "--force" },
];

export const FILES_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--add-glob" },
  { flag: "--remove" },
  { flag: "--migrate" },
  // GH-170 (pm-pfnx): single-value note applied to every --add/--add-glob link
  // in the invocation (embedded note= wins; usage error without an add).
  { flag: "--note" },
  { flag: "--list" },
  { flag: "--append-stable" },
  { flag: "--validate-paths" },
  { flag: "--audit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const DOCS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--add-glob" },
  { flag: "--remove" },
  { flag: "--migrate" },
  // GH-170 (pm-pfnx): see FILES_FLAG_CONTRACTS --note.
  { flag: "--note" },
  { flag: "--list" },
  { flag: "--validate-paths" },
  { flag: "--audit" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const HISTORY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--limit" },
  { flag: "--compact" },
  { flag: "--full" },
  { flag: "--diff" },
  { flag: "--field" },
  { flag: "--verify" },
];

export const HISTORY_REDACT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--literal" },
  { flag: "--regex" },
  { flag: "--replacement" },
  { flag: "--dry-run" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const HISTORY_REPAIR_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--all" },
  { flag: "--dry-run" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const HISTORY_COMPACT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--before" },
  { flag: "--dry-run" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const SCHEMA_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--description" },
  { flag: "--default-status", aliases: ["--default_status"] },
  { flag: "--folder" },
  { flag: "--alias" },
  // --role is a repeatable Commander collect flag (NOT a comma-list contract),
  // mirroring --alias; list:false keeps the bootstrap coalescer from corrupting
  // values.
  { flag: "--role" },
  { flag: "--order" },
  { flag: "--author" },
  { flag: "--force" },
];

export const PLAN_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--title" },
  { flag: "--description" },
  { flag: "--scope" },
  { flag: "--parent" },
  { flag: "--related" },
  { flag: "--blocks" },
  { flag: "--blocked-by", aliases: ["--blocked_by"] },
  { flag: "--harness" },
  { flag: "--mode" },
  { flag: "--resume-context", aliases: ["--resume_context"] },
  { flag: "--tags", aliases: ["--tag"], list: true },
  { flag: "--priority" },
  { flag: "--body" },
  { flag: "--claim" },
  { flag: "--from-search", aliases: ["--from_search"] },
  { flag: "--step-title", aliases: ["--step_title"] },
  // pm-6mit: --step is a Commander collect repeatable (ordered step titles on
  // create; single-value stepTitle alias elsewhere). It must NOT be list:true —
  // the bootstrap coalescer comma-joins list flags and would corrupt titles
  // containing commas.
  { flag: "--step" },
  { flag: "--step-body", aliases: ["--step_body"] },
  { flag: "--step-owner", aliases: ["--step_owner"] },
  { flag: "--step-status", aliases: ["--step_status"] },
  { flag: "--step-evidence", aliases: ["--step_evidence"] },
  { flag: "--step-blocked-reason", aliases: ["--step_blocked_reason"] },
  { flag: "--step-replacement", aliases: ["--step_replacement"] },
  { flag: "--depends-on", aliases: ["--depends_on"] },
  { flag: "--link" },
  { flag: "--link-kind", aliases: ["--link_kind"] },
  { flag: "--link-note", aliases: ["--link_note"] },
  { flag: "--promote-to-item-dep", aliases: ["--promote_to_item_dep"] },
  { flag: "--allow-multiple-active", aliases: ["--allow_multiple_active"] },
  { flag: "--file" },
  { flag: "--test" },
  { flag: "--doc" },
  { flag: "--decision-text", aliases: ["--decision_text", "--decision"] },
  { flag: "--decision-rationale", aliases: ["--decision_rationale"] },
  { flag: "--decision-evidence", aliases: ["--decision_evidence"] },
  { flag: "--discovery-text", aliases: ["--discovery_text", "--discovery"] },
  { flag: "--validation-text", aliases: ["--validation_text", "--validation"] },
  { flag: "--validation-command", aliases: ["--validation_command"] },
  { flag: "--validation-expected", aliases: ["--validation_expected"] },
  { flag: "--depth" },
  { flag: "--fields", list: true },
  { flag: "--steps" },
  { flag: "--materialize-type", aliases: ["--materialize_type"] },
  { flag: "--materialize-parent", aliases: ["--materialize_parent"] },
  { flag: "--materialize-tags", aliases: ["--materialize_tags"] },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const INIT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--preset" },
  { flag: "--type-preset" },
  { flag: "--defaults", short: "-y", aliases: ["--yes"] },
  { flag: "--author" },
  { flag: "--agent-guidance" },
  { flag: "--with-packages" },
  { flag: "--force" },
  { flag: "--verbose" },
];

export const CONFIG_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--criterion" },
  { flag: "--clear-criteria" },
  { flag: "--format" },
  { flag: "--policy" },
  { flag: "--default-depth" },
  { flag: "--activity-limit" },
  { flag: "--stale-threshold-days" },
  { flag: "--section-hierarchy" },
  { flag: "--section-activity" },
  { flag: "--section-progress" },
  { flag: "--section-blockers" },
  { flag: "--section-files" },
  { flag: "--section-workload" },
  { flag: "--section-staleness" },
  { flag: "--section-tests" },
];

export const EXTENSION_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--init" },
  { flag: "--scaffold" },
  { flag: "--install" },
  { flag: "--uninstall" },
  { flag: "--explore" },
  { flag: "--list" },
  { flag: "--manage" },
  { flag: "--reload" },
  { flag: "--watch" },
  { flag: "--doctor" },
  { flag: "--catalog" },
  { flag: "--adopt" },
  { flag: "--adopt-all" },
  { flag: "--activate" },
  { flag: "--deactivate" },
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
  { flag: "--gh" },
  { flag: "--github" },
  { flag: "--ref" },
  { flag: "--detail" },
  { flag: "--trace" },
  { flag: "--runtime-probe" },
  { flag: "--fix-managed-state" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
];

export const EXTENSION_INIT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
];

export const EXTENSION_INSTALL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
  { flag: "--gh" },
  { flag: "--github" },
  { flag: "--ref" },
];

export const EXTENSION_UNINSTALL_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_INIT_FLAG_CONTRACTS;
export const EXTENSION_EXPLORE_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_INIT_FLAG_CONTRACTS;
export const EXTENSION_ADOPT_ALL_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_INIT_FLAG_CONTRACTS;
export const EXTENSION_ACTIVATE_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_INIT_FLAG_CONTRACTS;
export const EXTENSION_DEACTIVATE_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_INIT_FLAG_CONTRACTS;

export const EXTENSION_MANAGE_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_INIT_FLAG_CONTRACTS,
  { flag: "--runtime-probe" },
  { flag: "--fix-managed-state" },
];

export const EXTENSION_RELOAD_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_INIT_FLAG_CONTRACTS,
  { flag: "--watch" },
];

export const EXTENSION_DOCTOR_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_INIT_FLAG_CONTRACTS,
  { flag: "--detail" },
  { flag: "--trace" },
  { flag: "--fix-managed-state" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
];

export const EXTENSION_CATALOG_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_INIT_FLAG_CONTRACTS,
  { flag: "--fields", list: true },
];

export const EXTENSION_ADOPT_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_INIT_FLAG_CONTRACTS,
  { flag: "--gh" },
  { flag: "--github" },
  { flag: "--ref" },
];

export const INSTALL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
  { flag: "--gh" },
  { flag: "--github" },
  { flag: "--ref" },
];

export const UPGRADE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--dry-run" },
  { flag: "--cli-only" },
  { flag: "--packages-only" },
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
  { flag: "--repair" },
  { flag: "--tag" },
  { flag: "--package-name" },
];

export const REINDEX_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--progress" },
];

export const CLOSE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--reason" },
  { flag: "--close-reason" },
  { flag: "--duplicate-of" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--validate-close" },
  // pm-fl0c #11 (2026-05-28) + Codex P2 follow-up: inline closure-validation
  // fields. Surface them through the contract so `pm contracts --command
  // close`, the JSON help payload, and bootstrap flag normalization /
  // suggestions all stay consistent with the commander registration.
  { flag: "--resolution" },
  { flag: "--expected-result", aliases: ["--expected_result", "--expected"] },
  { flag: "--actual-result", aliases: ["--actual_result", "--actual"] },
  { flag: "--force" },
];

// close-many shares update-many's `--filter-*` scoping family and close's
// inline closure-validation fields. The shared close reason is required for the
// audited bulk close (each matched item routes through runClose semantics).
export const CLOSE_MANY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--filter-status", list: true },
  { flag: "--filter-type" },
  { flag: "--filter-tag" },
  { flag: "--filter-priority" },
  { flag: "--filter-deadline-before" },
  { flag: "--filter-deadline-after" },
  { flag: "--filter-updated-after" },
  { flag: "--filter-updated-before" },
  { flag: "--filter-created-after" },
  { flag: "--filter-created-before" },
  { flag: "--filter-assignee" },
  { flag: "--filter-assignee-filter" },
  { flag: "--filter-assignee_filter" },
  { flag: "--filter-parent" },
  { flag: "--filter-sprint" },
  { flag: "--filter-release" },
  { flag: "--ids", list: true },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--reason" },
  { flag: "--resolution" },
  { flag: "--expected-result", aliases: ["--expected_result", "--expected"] },
  { flag: "--actual-result", aliases: ["--actual_result", "--actual"] },
  { flag: "--validate-close" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
  { flag: "--dry-run" },
  { flag: "--rollback" },
  { flag: "--no-checkpoint" },
];

export const APPEND_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--body", short: "-b" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const CLAIM_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const RESTORE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const DELETE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--dry-run" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const RELEASE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-release" },
  { flag: "--force" },
];

export const START_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const PAUSE_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const CLOSE_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--validate-close" },
  { flag: "--force" },
];

export const TEST_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--add" },
  { flag: "--add-json" },
  { flag: "--remove" },
  { flag: "--run" },
  { flag: "--match" },
  { flag: "--only-index" },
  { flag: "--only-last" },
  { flag: "--background" },
  { flag: "--timeout" },
  { flag: "--progress" },
  { flag: "--env-set" },
  { flag: "--env-clear" },
  { flag: "--shared-host-safe" },
  { flag: "--pm-context" },
  { flag: "--override-linked-pm-context" },
  { flag: "--fail-on-context-mismatch" },
  { flag: "--fail-on-skipped" },
  { flag: "--fail-on-empty-test-run" },
  { flag: "--require-assertions-for-pm" },
  { flag: "--check-context" },
  { flag: "--auto-pm-context" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const TEST_ALL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--background" },
  { flag: "--timeout" },
  { flag: "--progress" },
  { flag: "--env-set" },
  { flag: "--env-clear" },
  { flag: "--shared-host-safe" },
  { flag: "--pm-context" },
  { flag: "--override-linked-pm-context" },
  { flag: "--fail-on-context-mismatch" },
  { flag: "--fail-on-skipped" },
  { flag: "--fail-on-empty-test-run" },
  { flag: "--require-assertions-for-pm" },
  { flag: "--check-context" },
  { flag: "--auto-pm-context" },
];

export const TELEMETRY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--limit" },
];

export const TEST_RUNS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status" },
  { flag: "--limit" },
  { flag: "--stream" },
  { flag: "--tail" },
  { flag: "--force" },
  { flag: "--author" },
];

export const GC_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--dry-run" },
  { flag: "--scope" },
];

export const STATS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--storage" },
  { flag: "--metadata-coverage" },
  { flag: "--by-assignee" },
  { flag: "--by-tag" },
  { flag: "--by-priority" },
  { flag: "--tag-prefix" },
];

export const HEALTH_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--strict-directories" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
  { flag: "--check-only" },
  { flag: "--check-telemetry" },
  { flag: "--no-refresh" },
  { flag: "--refresh-vectors" },
  { flag: "--verbose-stale-items" },
  { flag: "--brief" },
  { flag: "--summary" },
  { flag: "--skip-vectors" },
  { flag: "--skip-integrity" },
  { flag: "--skip-drift" },
  { flag: "--full" },
];

export const VALIDATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--check-metadata" },
  { flag: "--metadata-profile" },
  { flag: "--check-resolution" },
  { flag: "--check-lifecycle" },
  { flag: "--check-stale-blockers" },
  { flag: "--dependency-cycle-severity" },
  { flag: "--check-files" },
  { flag: "--scan-mode" },
  { flag: "--include-pm-internals" },
  { flag: "--verbose-file-lists" },
  { flag: "--verbose-diagnostics" },
  { flag: "--all-affected-ids" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
  { flag: "--fix-hints" },
  { flag: "--auto-fix" },
  { flag: "--dry-run" },
  // NOT list:true — repeatable via Commander's collector; the bootstrap
  // coalescer must not comma-join occurrences (values may also be
  // comma-separated lists which the resolver splits itself).
  { flag: "--fix-scope" },
  { flag: "--prune-missing" },
  { flag: "--check-history-drift" },
  { flag: "--check-command-references" },
];

export const CREATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { short: "-t", flag: "--title" },
  { short: "-d", flag: "--description" },
  { flag: "--type" },
  { flag: "--template" },
  { flag: "--create-mode" },
  { flag: "--create_mode" },
  { flag: "--schedule-preset" },
  { flag: "--schedule_preset" },
  { short: "-s", flag: "--status" },
  { short: "-p", flag: "--priority" },
  { flag: "--tags", aliases: ["--tag"], list: true },
  // NOT list:true — these use Commander's repeatable collector. Marking them
  // list:true would make the bootstrap coalescer comma-join repeated
  // occurrences (`--add-tags '["a","b"]' --add-tags c` -> `["a","b"],c`),
  // corrupting the JSON-array value form before parseTags sees it.
  { flag: "--add-tags", aliases: ["--add_tags"] },
  { short: "-b", flag: "--body" },
  { flag: "--body-file" },
  { flag: "--deadline" },
  { flag: "--estimate" },
  { flag: "--estimated-minutes" },
  { flag: "--estimated_minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--acceptance_criteria" },
  { flag: "--ac" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--assignee" },
  { flag: "--parent" },
  { flag: "--allow-missing-parent" },
  { flag: "--reviewer" },
  { flag: "--risk" },
  { flag: "--confidence" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--blocked-by" },
  { flag: "--blocked-reason" },
  { flag: "--unblock-note" },
  { flag: "--reporter" },
  { flag: "--severity" },
  { flag: "--environment" },
  { flag: "--repro-steps" },
  { flag: "--resolution" },
  { flag: "--expected-result" },
  { flag: "--actual-result" },
  { flag: "--affected-version" },
  { flag: "--fixed-version" },
  { flag: "--component" },
  { flag: "--regression" },
  { flag: "--customer-impact" },
  { flag: "--customer_impact" },
  { flag: "--definition-of-ready" },
  { flag: "--definition_of_ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--why_now" },
  { flag: "--blocked_by" },
  { flag: "--blocked_reason" },
  { flag: "--unblock_note" },
  { flag: "--repro_steps" },
  { flag: "--expected_result" },
  { flag: "--actual_result" },
  { flag: "--expected" },
  { flag: "--actual" },
  { flag: "--affected_version" },
  { flag: "--fixed_version" },
  { flag: "--dep" },
  { flag: "--type-option" },
  { flag: "--type_option" },
  { flag: "--field" },
  { flag: "--reminder" },
  { flag: "--event" },
  { flag: "--comment" },
  { flag: "--note" },
  { flag: "--learning" },
  { flag: "--file" },
  { flag: "--test" },
  { flag: "--doc" },
  { flag: "--unset" },
  { flag: "--clear-deps" },
  { flag: "--clear-comments" },
  { flag: "--clear-notes" },
  { flag: "--clear-learnings" },
  { flag: "--clear-files" },
  { flag: "--clear-tests" },
  { flag: "--clear-docs" },
  { flag: "--clear-reminders" },
  { flag: "--clear-events" },
  { flag: "--clear-type-options" },
];

export const COPY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--title" },
  { flag: "--author" },
  { flag: "--message" },
];

export const UPDATE_FLAG_CONTRACTS: CliFlagContract[] = [
  { short: "-t", flag: "--title" },
  { short: "-d", flag: "--description" },
  { short: "-b", flag: "--body" },
  { flag: "--body-file" },
  { short: "-s", flag: "--status" },
  { flag: "--close-reason" },
  { flag: "--close_reason" },
  { short: "-p", flag: "--priority" },
  { flag: "--type" },
  { flag: "--tags", aliases: ["--tag"], list: true },
  // NOT list:true — Commander's repeatable collector accumulates these, so
  // bootstrap coalescing must not comma-join repeated occurrences (it would
  // corrupt JSON-array values like `--add-tags '["a","b"]' --add-tags c`).
  { flag: "--add-tags", aliases: ["--add_tags"] },
  { flag: "--remove-tags", aliases: ["--remove_tags"] },
  { flag: "--deadline" },
  { flag: "--estimate" },
  { flag: "--estimated-minutes" },
  { flag: "--estimated_minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--acceptance_criteria" },
  { flag: "--ac" },
  { flag: "--assignee" },
  { flag: "--parent" },
  { flag: "--reviewer" },
  { flag: "--risk" },
  { flag: "--confidence" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--blocked-by" },
  { flag: "--blocked-reason" },
  { flag: "--unblock-note" },
  { flag: "--reporter" },
  { flag: "--severity" },
  { flag: "--environment" },
  { flag: "--repro-steps" },
  { flag: "--resolution" },
  { flag: "--expected-result" },
  { flag: "--actual-result" },
  { flag: "--affected-version" },
  { flag: "--fixed-version" },
  { flag: "--fixed_version" },
  { flag: "--component" },
  { flag: "--regression" },
  { flag: "--customer-impact" },
  { flag: "--customer_impact" },
  { flag: "--definition-of-ready" },
  { flag: "--definition_of_ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--why_now" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--blocked_by" },
  { flag: "--blocked_reason" },
  { flag: "--unblock_note" },
  { flag: "--repro_steps" },
  { flag: "--expected_result" },
  { flag: "--actual_result" },
  { flag: "--expected" },
  { flag: "--actual" },
  { flag: "--affected_version" },
  { flag: "--dep" },
  { flag: "--dep-remove" },
  { flag: "--dep_remove" },
  { flag: "--replace-deps" },
  { flag: "--replace-tests" },
  { flag: "--comment" },
  { flag: "--note" },
  { flag: "--learning" },
  { flag: "--file" },
  { flag: "--test" },
  { flag: "--doc" },
  { flag: "--reminder" },
  { flag: "--event" },
  { flag: "--type-option" },
  { flag: "--type_option" },
  { flag: "--field" },
  { flag: "--unset" },
  { flag: "--clear-deps" },
  { flag: "--clear-comments" },
  { flag: "--clear-notes" },
  { flag: "--clear-learnings" },
  { flag: "--clear-files" },
  { flag: "--clear-tests" },
  { flag: "--clear-docs" },
  { flag: "--clear-reminders" },
  { flag: "--clear-events" },
  { flag: "--clear-type-options" },
  { flag: "--allow-audit-update" },
  { flag: "--allow_audit_update" },
  { flag: "--allow-audit-dep-update" },
  { flag: "--allow_audit_dep_update" },
  { flag: "--force" },
];

export const UPDATE_MANY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--filter-status" },
  { flag: "--filter-type" },
  { flag: "--filter-tag" },
  { flag: "--filter-priority" },
  { flag: "--filter-deadline-before" },
  { flag: "--filter-deadline-after" },
  { flag: "--filter-updated-after" },
  { flag: "--filter-updated-before" },
  { flag: "--filter-created-after" },
  { flag: "--filter-created-before" },
  { flag: "--filter-assignee" },
  { flag: "--filter-assignee-filter" },
  { flag: "--filter-assignee_filter" },
  { flag: "--filter-parent" },
  { flag: "--filter-sprint" },
  { flag: "--filter-release" },
  { flag: "--filter-ac-missing" },
  { flag: "--filter-estimates-missing", aliases: ["--filter-estimate-missing"] },
  { flag: "--filter-resolution-missing" },
  { flag: "--filter-metadata-missing" },
  { flag: "--ids", list: true },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--dry-run" },
  { flag: "--rollback" },
  { flag: "--no-checkpoint" },
  { short: "-t", flag: "--title" },
  { short: "-d", flag: "--description" },
  { short: "-b", flag: "--body" },
  { short: "-p", flag: "--priority" },
  { flag: "--type" },
  { flag: "--tags", aliases: ["--tag"], list: true },
  // NOT list:true — Commander's repeatable collector accumulates these, so
  // bootstrap coalescing must not comma-join repeated occurrences (it would
  // corrupt JSON-array values like `--add-tags '["a","b"]' --add-tags c`).
  { flag: "--add-tags", aliases: ["--add_tags"] },
  { flag: "--remove-tags", aliases: ["--remove_tags"] },
  { flag: "--deadline" },
  { flag: "--estimate" },
  { flag: "--estimated-minutes" },
  { flag: "--estimated_minutes" },
  { flag: "--acceptance-criteria" },
  { flag: "--acceptance_criteria" },
  { flag: "--ac" },
  { flag: "--definition-of-ready" },
  { flag: "--definition_of_ready" },
  { flag: "--order" },
  { flag: "--rank" },
  { flag: "--goal" },
  { flag: "--objective" },
  { flag: "--value" },
  { flag: "--impact" },
  { flag: "--outcome" },
  { flag: "--why-now" },
  { flag: "--why_now" },
  { flag: "--reviewer" },
  { flag: "--risk" },
  { flag: "--confidence" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--reporter" },
  { flag: "--severity" },
  { flag: "--environment" },
  { flag: "--repro-steps" },
  { flag: "--repro_steps" },
  { flag: "--resolution" },
  { flag: "--expected-result" },
  { flag: "--expected_result" },
  { flag: "--expected" },
  { flag: "--actual-result" },
  { flag: "--actual_result" },
  { flag: "--actual" },
  { flag: "--affected-version" },
  { flag: "--affected_version" },
  { flag: "--fixed-version" },
  { flag: "--fixed_version" },
  { flag: "--component" },
  { flag: "--regression" },
  { flag: "--customer-impact" },
  { flag: "--customer_impact" },
  { flag: "--dep" },
  { flag: "--dep-remove" },
  { flag: "--dep_remove" },
  { flag: "--replace-deps" },
  { flag: "--replace-tests" },
  { flag: "--comment" },
  { flag: "--note" },
  { flag: "--learning" },
  { flag: "--file" },
  { flag: "--test" },
  { flag: "--doc" },
  { flag: "--reminder" },
  { flag: "--event" },
  { flag: "--type-option" },
  { flag: "--type_option" },
  { flag: "--unset" },
  { flag: "--clear-deps" },
  { flag: "--clear-comments" },
  { flag: "--clear-notes" },
  { flag: "--clear-learnings" },
  { flag: "--clear-files" },
  { flag: "--clear-tests" },
  { flag: "--clear-docs" },
  { flag: "--clear-reminders" },
  { flag: "--clear-events" },
  { flag: "--clear-type-options" },
  { flag: "--allow-audit-update" },
  { flag: "--allow_audit_update" },
  { flag: "--allow-audit-dep-update" },
  { flag: "--allow_audit_dep_update" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--force" },
];

export const NORMALIZE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--filter-status" },
  { flag: "--filter-type" },
  { flag: "--filter-tag" },
  { flag: "--filter-priority" },
  { flag: "--filter-deadline-before" },
  { flag: "--filter-deadline-after" },
  { flag: "--filter-assignee" },
  { flag: "--filter-assignee-filter" },
  { flag: "--filter-assignee_filter" },
  { flag: "--filter-parent" },
  { flag: "--filter-sprint" },
  { flag: "--filter-release" },
  { flag: "--limit" },
  { flag: "--offset" },
  { flag: "--dry-run" },
  { flag: "--apply" },
  { flag: "--author" },
  { flag: "--message" },
  { flag: "--allow-audit-update" },
  { flag: "--allow_audit_update" },
  { flag: "--force" },
];

export const CALENDAR_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--view" },
  { flag: "--date" },
  { flag: "--from" },
  { flag: "--to" },
  { flag: "--past" },
  { flag: "--full-period" },
  { flag: "--full_period" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--status" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--include" },
  { flag: "--recurrence-lookahead-days" },
  { flag: "--recurrence-lookback-days" },
  { flag: "--occurrence-limit" },
  { flag: "--limit" },
  { flag: "--format" },
];

export const ACTIVITY_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--id" },
  { flag: "--op" },
  { flag: "--author" },
  { flag: "--from" },
  { flag: "--to" },
  { flag: "--limit" },
  { flag: "--compact" },
  { flag: "--full" },
  { flag: "--stream" },
];

export const CONTEXT_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--date" },
  { flag: "--from" },
  { flag: "--to" },
  { flag: "--past" },
  { flag: "--type" },
  { flag: "--tag" },
  { flag: "--priority" },
  { flag: "--assignee" },
  { flag: "--assignee-filter" },
  { flag: "--assignee_filter" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--parent" },
  { flag: "--limit" },
  { flag: "--format" },
  { flag: "--depth" },
  { flag: "--section" },
  { flag: "--activity-limit" },
  { flag: "--stale-threshold" },
];

export const GET_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--depth" },
  { flag: "--full" },
  { flag: "--fields", list: true },
  { flag: "--tree" },
  { flag: "--tree-depth" },
  { flag: "--tree_depth" },
];

export const GUIDE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--list" },
  { flag: "--format" },
  { flag: "--depth" },
];

export const DEPS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--format" },
  { flag: "--max-depth" },
  { flag: "--collapse" },
  { flag: "--summary" },
];

export const SEARCH_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--semantic" },
  { flag: "--hybrid" },
  { flag: "--match-mode" },
  { flag: "--min-score" },
  { flag: "--count" },
  { flag: "--semantic-weight" },
  { flag: "--include-linked" },
  { flag: "--title-exact" },
  { flag: "--phrase-exact" },
  { flag: "--compact" },
  { flag: "--full" },
  { flag: "--fields", list: true },
  { flag: "--limit" },
  { flag: "--status", list: true },
  { flag: "--type" },
  { flag: "--tag", aliases: ["--tags"] },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--updated-after" },
  { flag: "--updated-before" },
  { flag: "--created-after" },
  { flag: "--created-before" },
  { flag: "--assignee" },
  { flag: "--sprint" },
  { flag: "--release" },
  { flag: "--parent" },
];

export const CONTRACTS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--action" },
  { flag: "--command" },
  { flag: "--schema-only" },
  { flag: "--flags-only" },
  { flag: "--availability-only" },
  { flag: "--runtime-only" },
  { flag: "--active-only" },
  { flag: "--full" },
];

export const COMPLETION_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--eager-tags" },
];

function toUniqueFlagContracts(contracts: CliFlagContract[]): CliFlagContract[] {
  const seen = new Set<string>();
  const unique: CliFlagContract[] = [];
  for (const contract of contracts) {
    const aliasKey = (contract.aliases ?? []).join(",");
    const key = `${contract.flag}|${contract.short ?? ""}|${aliasKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(contract);
  }
  return unique;
}

function withSubcommandGlobalFlags(contracts: CliFlagContract[]): CliFlagContract[] {
  return withFlagAliasMetadata(toUniqueFlagContracts([...SUBCOMMAND_GLOBAL_FLAG_CONTRACTS, ...contracts]));
}

const LIST_COMMAND_NAME_CONTRACTS = new Set([
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
]);

const NO_SURFACE_COMMAND_NAME_CONTRACTS = new Set([
  "reindex",
  "help",
]);

function normalizeCommandNameForContracts(commandName: string | undefined): string {
  if (typeof commandName !== "string") {
    return "";
  }
  return commandName.trim().toLowerCase();
}

export function resolveSubcommandFlagContractsForCommand(commandName: string | undefined): CliFlagContract[] {
  const normalized = normalizeCommandNameForContracts(commandName);
  if (normalized.length === 0) {
    return withSubcommandGlobalFlags([]);
  }
  if (LIST_COMMAND_NAME_CONTRACTS.has(normalized)) {
    return withSubcommandGlobalFlags(LIST_FILTER_FLAG_CONTRACTS);
  }
  if (NO_SURFACE_COMMAND_NAME_CONTRACTS.has(normalized)) {
    return withSubcommandGlobalFlags([]);
  }
  if (normalized === "templates") {
    return withSubcommandGlobalFlags(CREATE_FLAG_CONTRACTS);
  }
  if (normalized === "cal") {
    return withSubcommandGlobalFlags(CALENDAR_FLAG_CONTRACTS);
  }
  if (normalized === "ctx") {
    return withSubcommandGlobalFlags(CONTEXT_FLAG_CONTRACTS);
  }
  if (normalized === "test-runs-worker") {
    return withSubcommandGlobalFlags(TEST_RUNS_FLAG_CONTRACTS);
  }
  const [rootCommand, lifecycleSubcommand, ...extraParts] = normalized.split(/\s+/);
  if (
    (rootCommand === "extension" || rootCommand === "package" || rootCommand === "packages") &&
    lifecycleSubcommand &&
    extraParts.length === 0
  ) {
    switch (lifecycleSubcommand) {
      case "init":
        return withSubcommandGlobalFlags(EXTENSION_INIT_FLAG_CONTRACTS);
      case "install":
        return withSubcommandGlobalFlags(EXTENSION_INSTALL_FLAG_CONTRACTS);
      case "uninstall":
        return withSubcommandGlobalFlags(EXTENSION_UNINSTALL_FLAG_CONTRACTS);
      case "explore":
        return withSubcommandGlobalFlags(EXTENSION_EXPLORE_FLAG_CONTRACTS);
      case "manage":
        return withSubcommandGlobalFlags(EXTENSION_MANAGE_FLAG_CONTRACTS);
      case "reload":
        return withSubcommandGlobalFlags(EXTENSION_RELOAD_FLAG_CONTRACTS);
      case "doctor":
        return withSubcommandGlobalFlags(EXTENSION_DOCTOR_FLAG_CONTRACTS);
      case "catalog":
        return withSubcommandGlobalFlags(EXTENSION_CATALOG_FLAG_CONTRACTS);
      case "adopt":
        return withSubcommandGlobalFlags(EXTENSION_ADOPT_FLAG_CONTRACTS);
      case "adopt-all":
        return withSubcommandGlobalFlags(EXTENSION_ADOPT_ALL_FLAG_CONTRACTS);
      case "activate":
        return withSubcommandGlobalFlags(EXTENSION_ACTIVATE_FLAG_CONTRACTS);
      case "deactivate":
        return withSubcommandGlobalFlags(EXTENSION_DEACTIVATE_FLAG_CONTRACTS);
      default:
        return withSubcommandGlobalFlags([]);
    }
  }
  switch (normalized) {
    case "init":
      return withSubcommandGlobalFlags(INIT_FLAG_CONTRACTS);
    case "config":
      return withSubcommandGlobalFlags(CONFIG_FLAG_CONTRACTS);
    case "extension":
    case "package":
    case "packages":
      return withSubcommandGlobalFlags(EXTENSION_FLAG_CONTRACTS);
    case "install":
      return withSubcommandGlobalFlags(INSTALL_FLAG_CONTRACTS);
    case "upgrade":
      return withSubcommandGlobalFlags(UPGRADE_FLAG_CONTRACTS);
    case "create":
      return withSubcommandGlobalFlags(CREATE_FLAG_CONTRACTS);
    case "copy":
      return withSubcommandGlobalFlags(COPY_FLAG_CONTRACTS);
    case "aggregate":
      return withSubcommandGlobalFlags(AGGREGATE_FLAG_CONTRACTS);
    case "calendar":
      return withSubcommandGlobalFlags(CALENDAR_FLAG_CONTRACTS);
    case "context":
      return withSubcommandGlobalFlags(CONTEXT_FLAG_CONTRACTS);
    case "get":
      return withSubcommandGlobalFlags(GET_FLAG_CONTRACTS);
    case "search":
      return withSubcommandGlobalFlags(SEARCH_FLAG_CONTRACTS);
    case "history":
      return withSubcommandGlobalFlags(HISTORY_FLAG_CONTRACTS);
    case "history-redact":
      return withSubcommandGlobalFlags(HISTORY_REDACT_FLAG_CONTRACTS);
    case "history-repair":
      return withSubcommandGlobalFlags(HISTORY_REPAIR_FLAG_CONTRACTS);
    case "history-compact":
      return withSubcommandGlobalFlags(HISTORY_COMPACT_FLAG_CONTRACTS);
    case "schema":
      return withSubcommandGlobalFlags(SCHEMA_FLAG_CONTRACTS);
    case "plan":
      return withSubcommandGlobalFlags(PLAN_FLAG_CONTRACTS);
    case "activity":
      return withSubcommandGlobalFlags(ACTIVITY_FLAG_CONTRACTS);
    case "restore":
      return withSubcommandGlobalFlags(RESTORE_FLAG_CONTRACTS);
    case "update":
      return withSubcommandGlobalFlags(UPDATE_FLAG_CONTRACTS);
    case "update-many":
      return withSubcommandGlobalFlags(UPDATE_MANY_FLAG_CONTRACTS);
    case "close":
      return withSubcommandGlobalFlags(CLOSE_FLAG_CONTRACTS);
    case "close-many":
      return withSubcommandGlobalFlags(CLOSE_MANY_FLAG_CONTRACTS);
    case "delete":
      return withSubcommandGlobalFlags(DELETE_FLAG_CONTRACTS);
    case "append":
      return withSubcommandGlobalFlags(APPEND_FLAG_CONTRACTS);
    case "comments":
      return withSubcommandGlobalFlags(COMMENTS_FLAG_CONTRACTS);
    case "notes":
      return withSubcommandGlobalFlags(NOTES_FLAG_CONTRACTS);
    case "learnings":
      return withSubcommandGlobalFlags(LEARNINGS_FLAG_CONTRACTS);
    case "files":
      return withSubcommandGlobalFlags(FILES_FLAG_CONTRACTS);
    case "docs":
      return withSubcommandGlobalFlags(DOCS_FLAG_CONTRACTS);
    case "deps":
      return withSubcommandGlobalFlags(DEPS_FLAG_CONTRACTS);
    case "test":
      return withSubcommandGlobalFlags(TEST_FLAG_CONTRACTS);
    case "test-all":
      return withSubcommandGlobalFlags(TEST_ALL_FLAG_CONTRACTS);
    case "telemetry":
      return withSubcommandGlobalFlags(TELEMETRY_FLAG_CONTRACTS);
    case "health":
      return withSubcommandGlobalFlags(HEALTH_FLAG_CONTRACTS);
    case "validate":
      return withSubcommandGlobalFlags(VALIDATE_FLAG_CONTRACTS);
    case "gc":
      return withSubcommandGlobalFlags(GC_FLAG_CONTRACTS);
    case "stats":
      return withSubcommandGlobalFlags(STATS_FLAG_CONTRACTS);
    case "contracts":
      return withSubcommandGlobalFlags(CONTRACTS_FLAG_CONTRACTS);
    case "claim":
      return withSubcommandGlobalFlags(CLAIM_FLAG_CONTRACTS);
    case "release":
      return withSubcommandGlobalFlags(RELEASE_FLAG_CONTRACTS);
    case "start-task":
      return withSubcommandGlobalFlags(START_TASK_FLAG_CONTRACTS);
    case "pause-task":
      return withSubcommandGlobalFlags(PAUSE_TASK_FLAG_CONTRACTS);
    case "close-task":
      return withSubcommandGlobalFlags(CLOSE_TASK_FLAG_CONTRACTS);
    default:
      return withSubcommandGlobalFlags([]);
  }
}

export function toCompletionFlagString(flagContracts: CliFlagContract[], includeGlobal = true): string {
  const aliasAwareContracts = withFlagAliasMetadata(flagContracts);
  const scoped = aliasAwareContracts
    .flatMap((entry) => [entry.short, entry.flag, ...(entry.aliases ?? [])])
    .filter((value): value is string => Boolean(value));
  const all = includeGlobal
    ? [
        ...scoped,
        ...SUBCOMMAND_GLOBAL_FLAG_CONTRACTS.flatMap((entry) => [entry.short, entry.flag, ...(entry.aliases ?? [])]).filter(
          (value): value is string => Boolean(value),
        ),
      ]
    : scoped;
  return normalizeUniqueStringList(all).join(" ");
}


const PM_TOOL_GLOBAL_PARAMETER_KEYS = [
  "json",
  "quiet",
  "profile",
  "noExtensions",
  "noPager",
  "path",
  "pmExecutable",
  "timeoutMs",
] as const;

const PM_TOOL_ACTION_MUTATION_PARAMETER_KEYS: Partial<Record<PmToolAction, readonly string[]>> = {
  create: ["fullChangedFields", "idOnly"],
  copy: ["fullChangedFields", "idOnly"],
  update: ["fullChangedFields", "idOnly"],
  close: ["fullChangedFields", "idOnly"],
  append: ["fullChangedFields"],
  "update-many": ["fullChangedFields"],
  "close-many": ["fullChangedFields"],
};

export interface PmActionSchemaContract {
  required?: string[];
  optional?: string[];
  anyOfRequired?: Array<string[]>;
  oneOfRequired?: Array<string[]>;
  dependentAnyOfRequired?: Array<{
    property: string;
    anyOfRequired: Array<string[]>;
  }>;
  conditionalRequired?: Array<{
    property: string;
    value: string;
    required: string[];
  }>;
}

function toSchemaKeyList(values: string[]): string[] {
  return normalizeUniqueStringList(values);
}

const CREATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CREATE_OPTION_CONTRACTS.map((entry) => entry.param),
  ...TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "assignee",
]);

const UPDATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  ...TOOL_SHARED_CREATE_UPDATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "force",
]);

const UPDATE_MANY_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_UPDATE_MANY_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  ...UPDATE_CONTRACT_PARAMETER_KEYS,
  "dryRun",
  "rollback",
  "noCheckpoint",
]);

const NORMALIZE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_NORMALIZE_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  "dryRun",
  "apply",
  "author",
  "message",
  "allowAuditUpdate",
  "force",
]);

const CLOSE_MANY_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CLOSE_MANY_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  "reason",
  "resolution",
  "expectedResult",
  "actualResult",
  "validateClose",
  "dryRun",
  "rollback",
  "noCheckpoint",
  "author",
  "message",
  "force",
]);

const CONTEXT_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_CONTEXT_OPTION_CONTRACTS.map((entry) => entry.param),
  "past",
  "section",
]);

const ACTIVITY_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_ACTIVITY_OPTION_CONTRACTS.map((entry) => entry.param),
  "stream",
]);

const LIST_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_LIST_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
  "includeBody",
  "noTruncate",
  "compact",
  "brief",
  "full",
]);
const AGGREGATE_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  ...TOOL_AGGREGATE_OPTION_CONTRACTS.map((entry) => entry.param),
  "count",
  "completion",
  "includeUnparented",
]);
const DEDUPE_AUDIT_CONTRACT_PARAMETER_KEYS = toSchemaKeyList(TOOL_DEDUPE_AUDIT_OPTION_CONTRACTS.map((entry) => entry.param));
const SEARCH_CONTRACT_PARAMETER_KEYS = toSchemaKeyList([
  "query",
  "keywords",
  "mode",
  "semantic",
  "hybrid",
  "includeLinked",
  "titleExact",
  "phraseExact",
  "compact",
  "full",
  ...TOOL_SEARCH_FILTER_OPTION_CONTRACTS.map((entry) => entry.param),
]);

const AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS = ["author", "message", "force"];

const PM_TOOL_ACTION_SCHEMA_CONTRACTS: Record<string, PmActionSchemaContract> = {
  init: { optional: ["prefix", "preset", "typePreset", "defaults", "author", "agentGuidance", "withPackages", "force", "verbose"] },
  config: {
    required: ["scope", "configAction"],
    optional: ["key", "value", "criterion", "clearCriteria", "format", "policy"],
  },
  "extension-init": { required: ["target"], optional: ["scope"] },
  "extension-install": {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  "extension-uninstall": { required: ["target"], optional: ["scope"] },
  "extension-explore": { optional: ["scope"] },
  "extension-manage": { optional: ["scope", "runtimeProbe", "fixManagedState"] },
  "extension-reload": { optional: ["scope", "watch"] },
  "extension-doctor": { optional: ["scope", "detail", "trace", "fixManagedState", "strictExit", "failOnWarn"] },
  "extension-catalog": { optional: ["scope", "fields"] },
  "extension-adopt": { required: ["target"], optional: ["scope", "github", "ref"] },
  "extension-adopt-all": { optional: ["scope"] },
  "extension-activate": { required: ["target"], optional: ["scope"] },
  "extension-deactivate": { required: ["target"], optional: ["scope"] },
  extension: {
    optional: [
      "target",
      "scope",
      "github",
      "ref",
      "init",
      "install",
      "uninstall",
      "explore",
      "manage",
      "reload",
      "doctor",
      "catalog",
      "adopt",
      "adoptAll",
      "activate",
      "deactivate",
      "runtimeProbe",
      "fixManagedState",
      "detail",
      "trace",
      "watch",
      "strictExit",
      "failOnWarn",
    ],
  },
  "package-init": { required: ["target"], optional: ["scope"] },
  "package-install": {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  "package-uninstall": { required: ["target"], optional: ["scope"] },
  "package-explore": { optional: ["scope"] },
  "package-manage": { optional: ["scope", "runtimeProbe", "fixManagedState"] },
  "package-reload": { optional: ["scope", "watch"] },
  "package-doctor": { optional: ["scope", "detail", "trace", "fixManagedState", "strictExit", "failOnWarn"] },
  "package-catalog": { optional: ["scope", "fields"] },
  "package-adopt": { required: ["target"], optional: ["scope", "github", "ref"] },
  "package-adopt-all": { optional: ["scope"] },
  "package-activate": { required: ["target"], optional: ["scope"] },
  "package-deactivate": { required: ["target"], optional: ["scope"] },
  package: {
    optional: [
      "target",
      "scope",
      "github",
      "ref",
      "init",
      "install",
      "uninstall",
      "explore",
      "manage",
      "reload",
      "doctor",
      "catalog",
      "adopt",
      "adoptAll",
      "activate",
      "deactivate",
      "runtimeProbe",
      "fixManagedState",
      "detail",
      "trace",
      "watch",
      "strictExit",
      "failOnWarn",
    ],
  },
  install: {
    optional: ["target", "github", "scope", "ref"],
    anyOfRequired: [["target"], ["github"]],
  },
  upgrade: {
    optional: ["target", "scope", "dryRun", "cliOnly", "packagesOnly", "repair", "tag", "packageName"],
  },
  create: {
    required: ["title", "description", "type", "status", "priority", "message"],
    optional: CREATE_CONTRACT_PARAMETER_KEYS,
  },
  copy: { required: ["id"], optional: ["title", "author", "message"] },
  list: { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-all": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-draft": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-open": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-in-progress": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-blocked": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-closed": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  "list-canceled": { optional: LIST_CONTRACT_PARAMETER_KEYS },
  aggregate: { optional: AGGREGATE_CONTRACT_PARAMETER_KEYS },
  "dedupe-audit": { optional: DEDUPE_AUDIT_CONTRACT_PARAMETER_KEYS },
  guide: { optional: ["format", "depth"] },
  context: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
  ctx: { optional: CONTEXT_CONTRACT_PARAMETER_KEYS },
  get: { required: ["id"], optional: ["depth", "full", "fields", "tree", "treeDepth"] },
  search: {
    optional: SEARCH_CONTRACT_PARAMETER_KEYS,
    anyOfRequired: [["query"], ["keywords"]],
  },
  reindex: { optional: ["mode", "progress"] },
  history: { required: ["id"], optional: ["limit", "compact", "full", "diff", "verify"] },
  "history-redact": {
    required: ["id"],
    optional: ["literal", "regex", "replacement", "dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
    anyOfRequired: [["literal"], ["regex"]],
  },
  "history-repair": {
    // Exactly one of `id` (single stream) or `all` (bulk drift repair) is required.
    optional: ["id", "all", "dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
    oneOfRequired: [["id"], ["all"]],
  },
  "history-compact": {
    required: ["id"],
    optional: ["before", "dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  schema: {
    required: ["subcommand"],
    // No --message: schema mutations write config files, not item history.
    optional: ["name", "description", "defaultStatus", "folder", "alias", "role", "order", "author", "force"],
    conditionalRequired: [
      { property: "subcommand", value: "show", required: ["name"] },
      { property: "subcommand", value: "show-status", required: ["name"] },
      { property: "subcommand", value: "add-type", required: ["name"] },
      { property: "subcommand", value: "remove-type", required: ["name"] },
      // show-status/add-status/remove-status pass the status id as `name`.
      { property: "subcommand", value: "add-status", required: ["name"] },
      { property: "subcommand", value: "remove-status", required: ["name"] },
    ],
  },
  plan: {
    required: ["subcommand"],
    optional: [
      "id",
      "stepRef",
      "reorderTo",
      "title",
      "description",
      "scope",
      "parent",
      "related",
      "blocks",
      "blockedBy",
      "harness",
      "mode",
      "resumeContext",
      "tags",
      "priority",
      "body",
      "claim",
      "fromSearch",
      "stepTitle",
      "step",
      "stepBody",
      "stepOwner",
      "stepStatus",
      "stepEvidence",
      "stepBlockedReason",
      "stepReplacement",
      "dependsOn",
      "link",
      "linkKind",
      "linkNote",
      "promoteToItemDep",
      "allowMultipleActive",
      "file",
      "test",
      "doc",
      "decisionText",
      "decision",
      "decisionRationale",
      "decisionEvidence",
      "discoveryText",
      "discovery",
      "validationText",
      "validation",
      "validationCommand",
      "validationExpected",
      "depth",
      "fields",
      "steps",
      "materializeType",
      "materializeParent",
      "materializeTags",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
  },
  activity: { optional: ACTIVITY_CONTRACT_PARAMETER_KEYS },
  restore: { required: ["id", "target"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  update: { required: ["id"], optional: UPDATE_CONTRACT_PARAMETER_KEYS },
  "update-many": { optional: UPDATE_MANY_CONTRACT_PARAMETER_KEYS },
  normalize: { optional: NORMALIZE_CONTRACT_PARAMETER_KEYS },
  close: { required: ["id"], optional: ["text", "duplicateOf", "validateClose", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  "close-many": { optional: CLOSE_MANY_CONTRACT_PARAMETER_KEYS },
  delete: { required: ["id"], optional: ["dryRun", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  append: { required: ["id", "body"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  comments: {
    required: ["id"],
    optional: ["text", "add", "stdin", "file", "limit", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  "comments-audit": {
    optional: [
      "status",
      "type",
      "assignee",
      "assigneeFilter",
      "parent",
      "tag",
      "sprint",
      "release",
      "priority",
      "limitItems",
      "limit",
      "fullHistory",
      "latest",
    ],
  },
  notes: {
    required: ["id"],
    optional: ["text", "add", "limit", "allowAuditNote", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  learnings: {
    required: ["id"],
    optional: ["text", "add", "limit", "allowAuditLearning", "allowAuditComment", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS],
  },
  files: {
    required: ["id"],
    optional: [
      "add",
      "addGlob",
      "remove",
      "migrate",
      // GH-170 (pm-pfnx): `addNote` is the MCP spelling of the CLI --note flag
      // (the shared `note` parameter is the array-typed create/update note
      // seed, so files/docs use a distinct single-string key).
      "addNote",
      "discover",
      "apply",
      "discoveryNote",
      "appendStable",
      "validatePaths",
      "audit",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
    dependentAnyOfRequired: [{ property: "addNote", anyOfRequired: [["add"], ["addGlob"]] }],
  },
  docs: {
    required: ["id"],
    optional: [
      "add",
      "addGlob",
      "remove",
      "migrate",
      "addNote",
      "list",
      "validatePaths",
      "audit",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
    dependentAnyOfRequired: [{ property: "addNote", anyOfRequired: [["add"], ["addGlob"]] }],
  },
  deps: { required: ["id"], optional: ["format", "maxDepth", "collapse", "summary"] },
  test: {
    required: ["id"],
    optional: [
      "add",
      "addJson",
      "remove",
      "run",
      "match",
      "onlyIndex",
      "onlyLast",
      "background",
      "timeout",
      "progress",
      "envSet",
      "envClear",
      "sharedHostSafe",
      "pmContext",
      "overrideLinkedPmContext",
      "failOnContextMismatch",
      "failOnSkipped",
      "failOnEmptyTestRun",
      "requireAssertionsForPm",
      "checkContext",
      "autoPmContext",
      ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS,
    ],
  },
  "test-all": {
    optional: [
      "status",
      "limit",
      "offset",
      "background",
      "timeout",
      "progress",
      "envSet",
      "envClear",
      "sharedHostSafe",
      "pmContext",
      "overrideLinkedPmContext",
      "failOnContextMismatch",
      "failOnSkipped",
      "failOnEmptyTestRun",
      "requireAssertionsForPm",
      "checkContext",
      "autoPmContext",
    ],
  },
  telemetry: {
    optional: ["subcommand", "limit"],
  },
  "test-runs-list": {
    optional: ["status", "limit"],
  },
  "test-runs-status": {
    required: ["runId"],
  },
  "test-runs-logs": {
    required: ["runId"],
    optional: ["stream", "tail"],
  },
  "test-runs-stop": {
    required: ["runId"],
    optional: ["force"],
  },
  "test-runs-resume": {
    required: ["runId"],
    optional: ["author"],
  },
  stats: { optional: ["storage", "metadataCoverage", "byAssignee", "byTag", "byPriority", "tagPrefix"] },
  health: {
    optional: [
      "strictDirectories",
      "strictExit",
      "failOnWarn",
      "checkOnly",
      "checkTelemetry",
      "noRefresh",
      "refreshVectors",
      "verboseStaleItems",
      "summary",
      "skipVectors",
      "skipIntegrity",
      "skipDrift",
      "full",
    ],
  },
  validate: {
    optional: [
      "checkMetadata",
      "metadataProfile",
      "checkResolution",
      "checkLifecycle",
      "checkStaleBlockers",
      "dependencyCycleSeverity",
      "checkFiles",
      "scanMode",
      "includePmInternals",
      "verboseFileLists",
      "verboseDiagnostics",
      "allAffectedIds",
      "strictExit",
      "failOnWarn",
      "fixHints",
      "autoFix",
      "dryRun",
      "fixScope",
      "pruneMissing",
      "checkHistoryDrift",
      "checkCommandReferences",
    ],
  },
  gc: { optional: ["dryRun", "gcScope"] },
  contracts: { optional: ["contractAction", "command", "schemaOnly", "flagsOnly", "availabilityOnly", "runtimeOnly", "activeOnly"] },
  completion: { required: ["shell"], optional: ["eagerTags"] },
  claim: { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  release: { required: ["id"], optional: ["allowAuditRelease", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
  "start-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "pause-task": { required: ["id"], optional: AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS },
  "close-task": { required: ["id"], optional: ["text", ...AUTHOR_MESSAGE_FORCE_PARAMETER_KEYS] },
};

export const PM_TOOL_ACTION_PARAMETER_CONTRACTS: Readonly<Record<PmToolAction, PmActionSchemaContract>> =
  Object.freeze(
    Object.fromEntries(PM_TOOL_ACTIONS.map((action) => [action, PM_TOOL_ACTION_SCHEMA_CONTRACTS[action]])),
  ) as Readonly<Record<PmToolAction, PmActionSchemaContract>>;

function fallbackToolParameterDescription(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .trim()
    .replace(/^./, (value) => value.toUpperCase())
    .concat(".");
}

function decorateToolParameterDefinition(key: string, definition: unknown): Record<string, unknown> {
  const baseDefinition = typeof definition === "object" && definition !== null ? { ...(definition as Record<string, unknown>) } : {};
  const metadata = PM_TOOL_PARAMETER_METADATA[key];
  return {
    ...baseDefinition,
    description: metadata?.description ?? fallbackToolParameterDescription(key),
    ...(metadata?.examples ? { examples: metadata.examples } : {}),
  };
}

function actionScopedToolParameterMetadata(
  action: PmToolAction,
  key: string,
): { description: string; examples?: unknown[] } | undefined {
  if (action === "plan" && Object.prototype.hasOwnProperty.call(PLAN_ACTION_PARAMETER_METADATA, key)) {
    return PLAN_ACTION_PARAMETER_METADATA[key];
  }
  return PM_TOOL_PARAMETER_METADATA[key];
}

function decorateActionScopedToolParameterDefinition(
  action: PmToolAction,
  key: string,
  definition: unknown,
): Record<string, unknown> {
  const baseDefinition = typeof definition === "object" && definition !== null ? { ...(definition as Record<string, unknown>) } : {};
  const metadata = actionScopedToolParameterMetadata(action, key);
  return {
    ...baseDefinition,
    description: metadata?.description ?? fallbackToolParameterDescription(key),
    ...(metadata?.examples ? { examples: metadata.examples } : {}),
  };
}

function actionScopedToolParameterDefinition(action: PmToolAction, key: string): unknown {
  if (action === "plan" && Object.prototype.hasOwnProperty.call(PLAN_ACTION_PARAMETER_PROPERTIES, key)) {
    return PLAN_ACTION_PARAMETER_PROPERTIES[key];
  }
  return PM_TOOL_PARAMETER_PROPERTIES[key];
}

function buildActionScopedToolSchema(action: PmToolAction): Record<string, unknown> {
  const contract = PM_TOOL_ACTION_SCHEMA_CONTRACTS[action];
  const required = toSchemaKeyList(contract.required ?? []);
  const optional = toSchemaKeyList(contract.optional ?? []);
  const mutationParameterKeys = PM_TOOL_ACTION_MUTATION_PARAMETER_KEYS[action] ?? [];
  const allowedKeys = toSchemaKeyList(["action", ...PM_TOOL_GLOBAL_PARAMETER_KEYS, ...mutationParameterKeys, ...required, ...optional]);
  const properties: Record<string, unknown> = {
    action: {
      const: action,
      description: PM_TOOL_PARAMETER_METADATA.action?.description ?? "Tool action to execute.",
    },
  };
  for (const key of allowedKeys) {
    if (key === "action") {
      continue;
    }
    const definition = actionScopedToolParameterDefinition(action, key);
    if (definition) {
      properties[key] = decorateActionScopedToolParameterDefinition(action, key, definition);
    }
  }
  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["action", ...required],
    title: `pm action "${action}" parameters`,
    properties,
  };
  if (contract.anyOfRequired && contract.anyOfRequired.length > 0) {
    schema.anyOf = contract.anyOfRequired.map((requiredFields) => ({
      required: [...requiredFields],
    }));
  }
  const oneOfRequiredGroups = contract.oneOfRequired;
  if (oneOfRequiredGroups && oneOfRequiredGroups.length > 0) {
    const allOneOfFields = oneOfRequiredGroups.flat();
    schema.oneOf = oneOfRequiredGroups.map((requiredFields) => {
      const otherFields = allOneOfFields.filter((field) => !requiredFields.includes(field));
      return {
        required: [...requiredFields],
        ...(otherFields.length > 0 ? { not: { anyOf: otherFields.map((field) => ({ required: [field] })) } } : {}),
        ...(action === "history-repair" && requiredFields.includes("all") ? { properties: { all: { const: true } } } : {}),
      };
    });
  }
  if (contract.conditionalRequired && contract.conditionalRequired.length > 0) {
    schema.allOf = contract.conditionalRequired.map((entry) => ({
      if: {
        properties: {
          [entry.property]: { const: entry.value },
        },
        required: [entry.property],
      },
      then: {
        required: entry.required,
      },
    }));
  }
  if (contract.dependentAnyOfRequired && contract.dependentAnyOfRequired.length > 0) {
    const allOf = Array.isArray(schema.allOf) ? [...(schema.allOf as Array<Record<string, unknown>>)] : [];
    for (const entry of contract.dependentAnyOfRequired) {
      allOf.push({
        if: { required: [entry.property] },
        then: {
          anyOf: entry.anyOfRequired.map((requiredFields) => ({
            required: [...requiredFields],
          })),
        },
      });
    }
    schema.allOf = allOf;
  }
  return schema;
}

// Building the full MCP tool-parameter schemas (one variant per action) is only
// needed by the MCP server, the `pm contracts` command, and SDK consumers — never
// on the hot CLI path that imports this module for flag contracts. Wrap them in a
// memoized lazy Proxy so the build is deferred until first property access and the
// object API (`.type`, `.oneOf`, spread, JSON.stringify) stays identical.
function createLazyContractSchema(
  build: () => Record<string, unknown>,
): Record<string, unknown> {
  let value: Record<string, unknown> | undefined;
  const resolve = (): Record<string, unknown> => (value ??= build());
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => resolve()[prop as string],
    has: (_target, prop) => prop in resolve(),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), prop);
      if (descriptor) {
        descriptor.configurable = true;
      }
      return descriptor;
    },
  });
}

/**
 * Canonical version of the action-scoped strict MCP tool-parameters schema
 * (`PM_TOOL_PARAMETERS_SCHEMA`). Exported as the single source of truth so the
 * MCP server, the `pm contracts` command, SDK consumers, and the contract tests
 * all bind to one constant instead of re-typing the `"4.0.2"` literal (pm-r9sz).
 * Bump the patch/minor for additive, backward-compatible schema changes; bump
 * the MAJOR for breaking changes — the major also drives the `$id`
 * `tool-parameters-v{major}` slug, so the two never drift.
 */
export const PM_TOOL_PARAMETERS_SCHEMA_VERSION = "4.0.3" as const;

/**
 * Major component of {@link PM_TOOL_PARAMETERS_SCHEMA_VERSION}, used to build the
 * schema `$id` slug so a breaking version bump renames the document in lockstep.
 */
export const PM_TOOL_PARAMETERS_SCHEMA_MAJOR = PM_TOOL_PARAMETERS_SCHEMA_VERSION.split(".")[0];

/**
 * Version of the provider-compatible flat tool-parameters schema
 * (`PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`). Tracked separately from the strict
 * schema because the flat projection evolves independently.
 */
export const PM_PROVIDER_TOOL_PARAMETERS_SCHEMA_VERSION = "1.0.0" as const;

export const PM_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = createLazyContractSchema(() => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://schema.unbrained.dev/pm-cli/tool-parameters-v${PM_TOOL_PARAMETERS_SCHEMA_MAJOR}.schema.json`,
  title: "pm-cli tool parameters (action-scoped strict schema)",
  "x-schema-version": PM_TOOL_PARAMETERS_SCHEMA_VERSION,
  type: "object",
  oneOf: PM_TOOL_ACTIONS.map((action) => buildActionScopedToolSchema(action)),
}));

function toProviderCompatibleParameterDefinition(key: string, definition: unknown): Record<string, unknown> {
  const decorated = decorateToolParameterDefinition(key, definition);
  if (typeof decorated.type === "string") {
    return decorated;
  }
  const anyOf = Array.isArray(decorated.anyOf) ? (decorated.anyOf as Array<Record<string, unknown>>) : [];
  const firstTypedVariant = anyOf.find((variant) => typeof variant.type === "string");
  if (firstTypedVariant) {
    const { anyOf: _anyOf, ...rest } = decorated;
    return {
      ...rest,
      type: firstTypedVariant.type,
    };
  }
  const { anyOf: _anyOf, ...rest } = decorated;
  return {
    ...rest,
    type: "string",
  };
}

function buildProviderCompatibleToolSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      description: PM_TOOL_PARAMETER_METADATA.action?.description ?? "Tool action to execute.",
    },
    options: {
      type: "object",
      additionalProperties: true,
      description: "Advanced command options object forwarded to the selected pm action.",
    },
  };
  for (const key of Object.keys(PM_TOOL_PARAMETER_PROPERTIES).sort()) {
    properties[key] = toProviderCompatibleParameterDefinition(key, PM_TOOL_PARAMETER_PROPERTIES[key]);
  }
  return {
    title: "pm-cli tool parameters (provider-compatible flat schema)",
    "x-schema-version": PM_PROVIDER_TOOL_PARAMETERS_SCHEMA_VERSION,
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties,
  };
}

export const PM_PROVIDER_TOOL_PARAMETERS_SCHEMA: Record<string, unknown> = createLazyContractSchema(
  buildProviderCompatibleToolSchema,
);

export const _testOnlyCliContracts = {
  buildActionScopedToolSchema,
  buildProviderCompatibleToolSchema,
  decorateActionScopedToolParameterDefinition,
  decorateToolParameterDefinition,
  toolActionSchemaContracts: PM_TOOL_ACTION_SCHEMA_CONTRACTS,
  toolParameterMetadata: PM_TOOL_PARAMETER_METADATA,
  toProviderCompatibleParameterDefinition,
  toUniqueFlagContracts,
  withFlagAliasMetadata,
};
