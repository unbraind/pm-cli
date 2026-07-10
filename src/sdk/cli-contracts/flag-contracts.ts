/**
 * @module sdk/cli-contracts/flag-contracts
 *
 * Per-command CLI flag contracts — the canonical `--flag` vocabulary every pm
 * command accepts. The argv bootstrap normalizer, Commander registration, shell
 * completion, and the `pm contracts` command all read these contracts so the
 * flag surface stays single-sourced across the CLI, SDK, and MCP boundaries.
 */
import { normalizeUniqueStringList } from "./string-lists.js";

/**
 * A single CLI flag's contract: its canonical `--flag`, optional short form,
 * aliases, value metadata, and repeat/list semantics. One source of truth shared
 * by Commander registration, argv normalization, shell completion, and the
 * `pm contracts` command so every surface agrees on the flag vocabulary.
 */
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

/**
 * Maps an MCP tool option `param` to the CLI `flag` it forwards to, plus the
 * value semantics (`allowEmpty`, `repeatable`, `booleanish`) the bridge needs to
 * translate a structured tool call into argv.
 */
export interface ToolOptionFlagContract {
  param: string;
  flag: string;
  allowEmpty?: boolean;
  repeatable?: boolean;
  booleanish?: boolean;
}

function normalizeFlagAliasKey(flag: string): string {
  if (!flag.startsWith("--")) {
    return flag;
  }
  return `--${flag.slice(2).replaceAll("_", "-")}`;
}

/**
 * Returns the flag contracts with their `aliases` populated by folding every
 * dash/underscore spelling of a flag into its canonical `--kebab-case` entry, so
 * a single contract row advertises all accepted spellings.
 */
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

/**
 * Collapses alias-only duplicate rows into their canonical flag: runs
 * {@link withFlagAliasMetadata}, then drops contracts that merely restate an
 * alias already attached to a canonical flag, yielding a deduplicated list.
 */
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

/**
 * Governance-missing (GH-236) + content-field presence/absence (GH-242)
 * selection-filter flags shared verbatim by the `list` and `search` flag
 * tables. Module-private on purpose — spread into both tables at the same
 * position so the published contract order is unchanged.
 */
const GOVERNANCE_AND_CONTENT_FILTER_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--filter-reviewer-missing" },
  { flag: "--filter-risk-missing" },
  { flag: "--filter-confidence-missing" },
  { flag: "--filter-sprint-missing" },
  { flag: "--filter-release-missing" },
  { flag: "--has-notes" },
  { flag: "--no-notes" },
  { flag: "--has-learnings" },
  { flag: "--no-learnings" },
  { flag: "--has-files" },
  { flag: "--no-files" },
  { flag: "--filter-files-missing" },
  { flag: "--has-docs" },
  { flag: "--no-docs" },
  { flag: "--filter-docs-missing" },
  { flag: "--has-tests" },
  { flag: "--no-tests" },
  { flag: "--has-comments" },
  { flag: "--no-comments" },
  { flag: "--has-deps" },
  { flag: "--no-deps" },
  { flag: "--has-body" },
  { flag: "--empty-body" },
  { flag: "--has-linked-command" },
  { flag: "--no-linked-command" },
];

/**
 * `--filter-*`-prefixed governance/content selection flags plus the trailing
 * `--ids`/`--limit`/`--offset` scoping entries shared verbatim by the bulk
 * `update-many` and `close-many` flag tables. Module-private on purpose —
 * spread into both tables at the same position so the published contract
 * order is unchanged.
 */
const MANY_GOVERNANCE_AND_CONTENT_FILTER_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--filter-reviewer-missing" },
  { flag: "--filter-risk-missing" },
  { flag: "--filter-confidence-missing" },
  { flag: "--filter-sprint-missing" },
  { flag: "--filter-release-missing" },
  { flag: "--filter-has-notes" },
  { flag: "--filter-no-notes" },
  { flag: "--filter-has-learnings" },
  { flag: "--filter-no-learnings" },
  { flag: "--filter-has-files" },
  { flag: "--filter-no-files" },
  { flag: "--filter-has-docs" },
  { flag: "--filter-no-docs" },
  { flag: "--filter-has-tests" },
  { flag: "--filter-no-tests" },
  { flag: "--filter-has-comments" },
  { flag: "--filter-no-comments" },
  { flag: "--filter-has-deps" },
  { flag: "--filter-no-deps" },
  { flag: "--filter-has-body" },
  { flag: "--filter-empty-body" },
  { flag: "--filter-has-linked-command" },
  { flag: "--filter-no-linked-command" },
  { flag: "--ids", list: true },
  { flag: "--limit" },
  { flag: "--offset" },
];

export const LIST_FILTER_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--status", list: true },
  { flag: "--type" },
  { flag: "--tag", aliases: ["--tags"] },
  { flag: "--priority" },
  { flag: "--deadline-before" },
  { flag: "--deadline-after" },
  { flag: "--today" },
  { flag: "--recent" },
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
  ...GOVERNANCE_AND_CONTENT_FILTER_FLAG_CONTRACTS,
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
  { flag: "--format" },
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

export const DEDUPE_MERGE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--keep" },
  { flag: "--close", list: true },
  { flag: "--apply" },
  { flag: "--dry-run" },
  { flag: "--skip-children" },
  { flag: "--author" },
  { flag: "--message" },
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
  { flag: "--add", aliases: ["--comment", "--body"] },
  { flag: "--stdin" },
  { flag: "--file" },
  { flag: "--edit" },
  { flag: "--delete" },
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
  { flag: "--format" },
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
  { flag: "--ids", list: true },
  { flag: "--all-over", value_type: "number" },
  { flag: "--closed" },
  { flag: "--all-streams" },
  { flag: "--min-entries", value_type: "number" },
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
  // add-field flags (custom runtime fields). --commands/--required-types are
  // repeatable Commander collect flags (comma-splitting handled in the action),
  // so they stay off the comma-list contract for the same reason as --alias.
  { flag: "--type" },
  { flag: "--commands" },
  { flag: "--cli-flag" },
  { flag: "--required" },
  { flag: "--required-on-create" },
  { flag: "--no-allow-unset" },
  { flag: "--required-types" },
  // add-type --infer flags (title-prefix type inference).
  { flag: "--infer" },
  { flag: "--min-count" },
  { flag: "--apply" },
  { flag: "--author" },
  { flag: "--force" },
];

/**
 * Flags accepted by the `pm profile` command (list/show/apply subcommands).
 */
export const PROFILE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--dry-run" },
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
  { flag: "--template" },
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
  { flag: "--workspace" },
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
  { flag: "--capability" },
  { flag: "--install" },
  { flag: "--uninstall" },
  { flag: "--explore" },
  { flag: "--list" },
  { flag: "--manage" },
  { flag: "--describe" },
  { flag: "--markdown" },
  { flag: "--output" },
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
  { flag: "--isolated" },
  { flag: "--ignore-global" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
];

export const EXTENSION_SCOPE_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
];

export const EXTENSION_INIT_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_SCOPE_FLAG_CONTRACTS,
  { flag: "--capability" },
];

// `pm package` / `pm packages` additionally accept `--declarative` to scaffold the
// `composeExtension` blueprint starter. It is a runtime SDK *value* import that only
// package-mode authoring links, so `pm extension` omits it — the lone flag where the
// package surface diverges from the extension surface.
export const PACKAGE_FLAG_CONTRACTS: CliFlagContract[] = [...EXTENSION_FLAG_CONTRACTS, { flag: "--declarative" }];

export const PACKAGE_INIT_FLAG_CONTRACTS: CliFlagContract[] = [...EXTENSION_INIT_FLAG_CONTRACTS, { flag: "--declarative" }];

export const EXTENSION_INSTALL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--project" },
  { flag: "--local" },
  { flag: "--global" },
  { flag: "--gh" },
  { flag: "--github" },
  { flag: "--ref" },
];

export const EXTENSION_UNINSTALL_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_SCOPE_FLAG_CONTRACTS;
export const EXTENSION_EXPLORE_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_SCOPE_FLAG_CONTRACTS;
export const EXTENSION_DESCRIBE_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_SCOPE_FLAG_CONTRACTS,
  { flag: "--markdown" },
  { flag: "--output" },
];
export const EXTENSION_ADOPT_ALL_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_SCOPE_FLAG_CONTRACTS;
export const EXTENSION_ACTIVATE_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_SCOPE_FLAG_CONTRACTS;
export const EXTENSION_DEACTIVATE_FLAG_CONTRACTS: CliFlagContract[] = EXTENSION_SCOPE_FLAG_CONTRACTS;

export const EXTENSION_MANAGE_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_SCOPE_FLAG_CONTRACTS,
  { flag: "--runtime-probe" },
  { flag: "--fix-managed-state" },
];

export const EXTENSION_RELOAD_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_SCOPE_FLAG_CONTRACTS,
  { flag: "--watch" },
];

export const EXTENSION_DOCTOR_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_SCOPE_FLAG_CONTRACTS,
  { flag: "--detail" },
  { flag: "--trace" },
  { flag: "--fix-managed-state" },
  { flag: "--isolated" },
  { flag: "--ignore-global" },
  { flag: "--strict-exit" },
  { flag: "--fail-on-warn" },
];

export const EXTENSION_CATALOG_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_SCOPE_FLAG_CONTRACTS,
  { flag: "--fields", list: true },
];

export const EXTENSION_ADOPT_FLAG_CONTRACTS: CliFlagContract[] = [
  ...EXTENSION_SCOPE_FLAG_CONTRACTS,
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
  ...MANY_GOVERNANCE_AND_CONTENT_FILTER_FLAG_CONTRACTS,
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
  { flag: "--author", aliases: ["--assignee"] },
  { flag: "--message" },
  { flag: "--force" },
  { flag: "--if-available" },
  { flag: "--next" },
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
  { flag: "--author", aliases: ["--assignee"] },
  { flag: "--message" },
  { flag: "--allow-audit-release" },
  { flag: "--force" },
];

export const START_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author", aliases: ["--assignee"] },
  { flag: "--message" },
  { flag: "--force" },
];

export const PAUSE_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author", aliases: ["--assignee"] },
  { flag: "--message" },
  { flag: "--force" },
];

export const CLOSE_TASK_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--author", aliases: ["--assignee"] },
  { flag: "--message" },
  { flag: "--validate-close" },
  { flag: "--force" },
];

/** Shared create-passthrough flags for every scheduling shortcut (GH-217). */
const SCHEDULING_SHORTCUT_COMMON_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--parent" },
  { flag: "--allow-missing-parent" },
  { flag: "--tags" },
  { flag: "--priority" },
  { flag: "--body" },
  { flag: "--description" },
  { flag: "--author" },
  { flag: "--message" },
];

export const MEET_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--start" },
  { flag: "--duration" },
  { flag: "--end" },
  { flag: "--location" },
  { flag: "--timezone" },
  { flag: "--all-day" },
  ...SCHEDULING_SHORTCUT_COMMON_FLAG_CONTRACTS,
];

export const EVENT_FLAG_CONTRACTS: CliFlagContract[] = MEET_FLAG_CONTRACTS;

export const REMIND_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--at" },
  { flag: "--text" },
  ...SCHEDULING_SHORTCUT_COMMON_FLAG_CONTRACTS,
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
  { flag: "--field-utilization" },
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
  { flag: "--parent-cycle-severity" },
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
  { flag: "--id" },
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

export const FOCUS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--clear" },
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
  ...MANY_GOVERNANCE_AND_CONTENT_FILTER_FLAG_CONTRACTS,
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
  { flag: "--limit", aliases: ["--max-items"] },
  { flag: "--format" },
  { flag: "--depth" },
  { flag: "--fields", list: true },
  { flag: "--section" },
  { flag: "--activity-limit" },
  { flag: "--stale-threshold" },
  { flag: "--explain-ranking" },
  { flag: "--explain_ranking" },
];

export const GET_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--depth" },
  { flag: "--full" },
  { flag: "--fields", list: true },
  { flag: "--tree" },
  { flag: "--tree-depth" },
  { flag: "--tree_depth" },
  { flag: "--format" },
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

export const EVAL_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--mode" },
  { flag: "--k" },
  { flag: "--fail-under" },
  { flag: "--queries" },
  { flag: "--format" },
];

export const NEXT_FLAG_CONTRACTS: CliFlagContract[] = [
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
  { flag: "--blocked-limit" },
  { flag: "--blocked_limit" },
  { flag: "--ready-only" },
  { flag: "--ready_only" },
  { flag: "--format" },
  { flag: "--explain-ranking" },
  { flag: "--explain_ranking" },
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
  { flag: "--highlight" },
  { flag: "--compact" },
  { flag: "--full" },
  { flag: "--fields", list: true },
  { flag: "--format" },
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
  ...GOVERNANCE_AND_CONTENT_FILTER_FLAG_CONTRACTS,
];

export const CONTRACTS_FLAG_CONTRACTS: CliFlagContract[] = [
  { flag: "--action" },
  { flag: "--command" },
  { flag: "--summary" },
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

/**
 * Deduplicates flag contracts by their `flag`/`short`/`aliases` identity,
 * preserving first-seen order. Used when merging the shared subcommand-global
 * flags into a command's own contracts so a flag declared by both surfaces is
 * registered only once.
 */
export function toUniqueFlagContracts(contracts: CliFlagContract[]): CliFlagContract[] {
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

const LIST_COMMAND_FLAG_ALIASES = [
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
];

// Single-token command (plus the `list`/`cal`/`ctx`/`templates` aliases) → its
// dedicated flag-contract table. Lookups fall back to the subcommand-global set,
// so tokens absent here (`reindex`, `help`, or any unknown command) degrade to
// globals exactly as the prior `switch` `default` arm did. A `Map` (rather than a
// plain object) keeps an untrusted command token from ever resolving an inherited
// member such as `constructor` or `toString`.
const SUBCOMMAND_FLAG_CONTRACTS_BY_COMMAND = new Map<string, CliFlagContract[]>([
  ...LIST_COMMAND_FLAG_ALIASES.map((command): [string, CliFlagContract[]] => [command, LIST_FILTER_FLAG_CONTRACTS]),
  ["templates", CREATE_FLAG_CONTRACTS],
  ["cal", CALENDAR_FLAG_CONTRACTS],
  ["ctx", CONTEXT_FLAG_CONTRACTS],
  ["test-runs-worker", TEST_RUNS_FLAG_CONTRACTS],
  ["init", INIT_FLAG_CONTRACTS],
  ["config", CONFIG_FLAG_CONTRACTS],
  ["extension", EXTENSION_FLAG_CONTRACTS],
  // `--declarative` is package-only (see PACKAGE_FLAG_CONTRACTS).
  ["package", PACKAGE_FLAG_CONTRACTS],
  ["packages", PACKAGE_FLAG_CONTRACTS],
  ["install", INSTALL_FLAG_CONTRACTS],
  ["upgrade", UPGRADE_FLAG_CONTRACTS],
  ["create", CREATE_FLAG_CONTRACTS],
  ["copy", COPY_FLAG_CONTRACTS],
  ["focus", FOCUS_FLAG_CONTRACTS],
  ["aggregate", AGGREGATE_FLAG_CONTRACTS],
  ["dedupe-audit", DEDUPE_AUDIT_FLAG_CONTRACTS],
  ["dedupe-merge", DEDUPE_MERGE_FLAG_CONTRACTS],
  ["normalize", NORMALIZE_FLAG_CONTRACTS],
  ["calendar", CALENDAR_FLAG_CONTRACTS],
  ["context", CONTEXT_FLAG_CONTRACTS],
  ["get", GET_FLAG_CONTRACTS],
  ["guide", GUIDE_FLAG_CONTRACTS],
  ["search", SEARCH_FLAG_CONTRACTS],
  ["next", NEXT_FLAG_CONTRACTS],
  ["eval", EVAL_FLAG_CONTRACTS],
  ["history", HISTORY_FLAG_CONTRACTS],
  ["history-redact", HISTORY_REDACT_FLAG_CONTRACTS],
  ["history-repair", HISTORY_REPAIR_FLAG_CONTRACTS],
  ["history-compact", HISTORY_COMPACT_FLAG_CONTRACTS],
  ["schema", SCHEMA_FLAG_CONTRACTS],
  ["profile", PROFILE_FLAG_CONTRACTS],
  ["plan", PLAN_FLAG_CONTRACTS],
  ["activity", ACTIVITY_FLAG_CONTRACTS],
  ["restore", RESTORE_FLAG_CONTRACTS],
  ["update", UPDATE_FLAG_CONTRACTS],
  ["update-many", UPDATE_MANY_FLAG_CONTRACTS],
  ["close", CLOSE_FLAG_CONTRACTS],
  ["close-many", CLOSE_MANY_FLAG_CONTRACTS],
  ["delete", DELETE_FLAG_CONTRACTS],
  ["append", APPEND_FLAG_CONTRACTS],
  ["comments", COMMENTS_FLAG_CONTRACTS],
  ["comments-audit", COMMENTS_AUDIT_FLAG_CONTRACTS],
  ["notes", NOTES_FLAG_CONTRACTS],
  ["learnings", LEARNINGS_FLAG_CONTRACTS],
  ["files", FILES_FLAG_CONTRACTS],
  ["docs", DOCS_FLAG_CONTRACTS],
  ["deps", DEPS_FLAG_CONTRACTS],
  ["test", TEST_FLAG_CONTRACTS],
  ["test-all", TEST_ALL_FLAG_CONTRACTS],
  ["telemetry", TELEMETRY_FLAG_CONTRACTS],
  ["health", HEALTH_FLAG_CONTRACTS],
  ["validate", VALIDATE_FLAG_CONTRACTS],
  ["gc", GC_FLAG_CONTRACTS],
  ["stats", STATS_FLAG_CONTRACTS],
  ["contracts", CONTRACTS_FLAG_CONTRACTS],
  ["completion", COMPLETION_FLAG_CONTRACTS],
  ["claim", CLAIM_FLAG_CONTRACTS],
  ["release", RELEASE_FLAG_CONTRACTS],
  ["start-task", START_TASK_FLAG_CONTRACTS],
  ["pause-task", PAUSE_TASK_FLAG_CONTRACTS],
  ["close-task", CLOSE_TASK_FLAG_CONTRACTS],
  ["meet", MEET_FLAG_CONTRACTS],
  ["event", EVENT_FLAG_CONTRACTS],
  ["remind", REMIND_FLAG_CONTRACTS],
]);

// `extension`/`package`/`packages <subcommand>` lifecycle flag tables. `init` is
// resolved separately because its `--declarative` flag is package-only; every
// other lifecycle subcommand shares one table across the extension and package
// command roots.
const EXTENSION_LIFECYCLE_FLAG_CONTRACTS_BY_SUBCOMMAND = new Map<string, CliFlagContract[]>([
  ["install", EXTENSION_INSTALL_FLAG_CONTRACTS],
  ["uninstall", EXTENSION_UNINSTALL_FLAG_CONTRACTS],
  ["explore", EXTENSION_EXPLORE_FLAG_CONTRACTS],
  ["manage", EXTENSION_MANAGE_FLAG_CONTRACTS],
  ["describe", EXTENSION_DESCRIBE_FLAG_CONTRACTS],
  ["reload", EXTENSION_RELOAD_FLAG_CONTRACTS],
  ["doctor", EXTENSION_DOCTOR_FLAG_CONTRACTS],
  ["catalog", EXTENSION_CATALOG_FLAG_CONTRACTS],
  ["adopt", EXTENSION_ADOPT_FLAG_CONTRACTS],
  ["adopt-all", EXTENSION_ADOPT_ALL_FLAG_CONTRACTS],
  ["activate", EXTENSION_ACTIVATE_FLAG_CONTRACTS],
  ["deactivate", EXTENSION_DEACTIVATE_FLAG_CONTRACTS],
]);

function normalizeCommandNameForContracts(commandName: string | undefined): string {
  if (typeof commandName !== "string") {
    return "";
  }
  return commandName.trim().toLowerCase();
}

/**
 * Resolves the flag contracts an `extension`/`package <subcommand>` lifecycle
 * invocation accepts. `init` carries the package-only `--declarative` flag, so
 * `package`/`packages init` resolve to the package init table while `extension
 * init` resolves to the extension init table; every other lifecycle subcommand
 * shares one table, and an unknown subcommand falls back to globals-only.
 */
function resolveExtensionLifecycleFlagContracts(rootCommand: string, lifecycleSubcommand: string): CliFlagContract[] {
  if (lifecycleSubcommand === "init") {
    // `--declarative` is package-only, so `package init` / `packages init` carry it.
    return rootCommand === "extension" ? EXTENSION_INIT_FLAG_CONTRACTS : PACKAGE_INIT_FLAG_CONTRACTS;
  }
  return EXTENSION_LIFECYCLE_FLAG_CONTRACTS_BY_SUBCOMMAND.get(lifecycleSubcommand) ?? [];
}

/**
 * Resolves the flag contracts a given command (or list/extension subcommand)
 * accepts, merged with the shared subcommand-global flags. Returns the global
 * set for unknown or surface-less commands so completion and validation degrade
 * gracefully.
 */
export function resolveSubcommandFlagContractsForCommand(commandName: string | undefined): CliFlagContract[] {
  const normalized = normalizeCommandNameForContracts(commandName);
  if (normalized.length === 0) {
    return withSubcommandGlobalFlags([]);
  }
  const [rootCommand, lifecycleSubcommand, ...extraParts] = normalized.split(/\s+/);
  if (
    (rootCommand === "extension" || rootCommand === "package" || rootCommand === "packages") &&
    lifecycleSubcommand !== undefined &&
    extraParts.length === 0
  ) {
    return withSubcommandGlobalFlags(resolveExtensionLifecycleFlagContracts(rootCommand, lifecycleSubcommand));
  }
  return withSubcommandGlobalFlags(SUBCOMMAND_FLAG_CONTRACTS_BY_COMMAND.get(normalized) ?? []);
}

/**
 * Renders a space-separated, de-duplicated list of every flag spelling (short,
 * canonical, and aliases) for shell-completion candidate generation, optionally
 * appending the shared subcommand-global flags.
 */
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
