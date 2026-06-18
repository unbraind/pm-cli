/**
 * @module cli/commands/completion
 *
 * Implements the pm completion command surface and its agent-facing runtime behavior.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  AGGREGATE_FLAG_CONTRACTS,
  ACTIVITY_FLAG_CONTRACTS,
  APPEND_FLAG_CONTRACTS,
  CALENDAR_FLAG_CONTRACTS,
  CLOSE_MANY_FLAG_CONTRACTS,
  COMPLETION_FLAG_CONTRACTS,
  CONTRACTS_FLAG_CONTRACTS,
  CONTEXT_FLAG_CONTRACTS,
  COPY_FLAG_CONTRACTS,
  FOCUS_FLAG_CONTRACTS,
  MEET_FLAG_CONTRACTS,
  REMIND_FLAG_CONTRACTS,
  CREATE_FLAG_CONTRACTS,
  DEPS_FLAG_CONTRACTS,
  GET_FLAG_CONTRACTS,
  GUIDE_FLAG_CONTRACTS,
  GLOBAL_FLAG_CONTRACTS,
  HEALTH_FLAG_CONTRACTS,
  INIT_FLAG_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  NORMALIZE_FLAG_CONTRACTS,
  PLAN_FLAG_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  SEARCH_FLAG_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
  UPDATE_MANY_FLAG_CONTRACTS,
  toCompletionFlagString,
} from "../../sdk/cli-contracts.js";
import { BUILTIN_ITEM_TYPE_VALUES, STATUS_VALUES } from "../../types/index.js";
import { listGuideTopicIds } from "../guide-topics.js";

/**
 * Restricts completion shell values accepted by command, SDK, and storage contracts.
 */
export type CompletionShell = "bash" | "zsh" | "fish";

/**
 * Documents the completion result payload exchanged by command, SDK, and package integrations.
 */
export interface CompletionResult {
  shell: CompletionShell;
  script: string;
  setup_hint: string;
}

const VALID_SHELLS: CompletionShell[] = ["bash", "zsh", "fish"];
const DEFAULT_ITEM_TYPES = [...BUILTIN_ITEM_TYPE_VALUES];
const DEFAULT_STATUS_VALUES = [...STATUS_VALUES];

type CompletionFlagCommand = "list" | "create" | "update" | "update-many" | "search" | "calendar" | "context";

/**
 * Documents the completion runtime config payload exchanged by command, SDK, and package integrations.
 */
export interface CompletionRuntimeConfig {
  item_types?: string[];
  statuses?: string[];
  command_flags?: Partial<Record<CompletionFlagCommand, string[]>>;
}

const ALL_COMMANDS = [...PM_CORE_COMMAND_NAMES];
const LIST_FLAGS = toCompletionFlagString(LIST_FILTER_FLAG_CONTRACTS);
const AGGREGATE_FLAGS = toCompletionFlagString(AGGREGATE_FLAG_CONTRACTS);
const APPEND_FLAGS = toCompletionFlagString(APPEND_FLAG_CONTRACTS);
const COPY_FLAGS = toCompletionFlagString(COPY_FLAG_CONTRACTS);
const FOCUS_FLAGS = toCompletionFlagString(FOCUS_FLAG_CONTRACTS);
const MEET_FLAGS = toCompletionFlagString(MEET_FLAG_CONTRACTS);
const REMIND_FLAGS = toCompletionFlagString(REMIND_FLAG_CONTRACTS);
const CREATE_FLAGS = toCompletionFlagString(CREATE_FLAG_CONTRACTS);
const GET_FLAGS = toCompletionFlagString(GET_FLAG_CONTRACTS);
const UPDATE_FLAGS = toCompletionFlagString(UPDATE_FLAG_CONTRACTS);
const UPDATE_MANY_FLAGS = toCompletionFlagString(UPDATE_MANY_FLAG_CONTRACTS);
const CLOSE_MANY_FLAGS = toCompletionFlagString(CLOSE_MANY_FLAG_CONTRACTS);
const NORMALIZE_FLAGS = toCompletionFlagString(NORMALIZE_FLAG_CONTRACTS);
const ACTIVITY_FLAGS = toCompletionFlagString(ACTIVITY_FLAG_CONTRACTS);
const CALENDAR_FLAGS = toCompletionFlagString(CALENDAR_FLAG_CONTRACTS);
const CONTEXT_FLAGS = toCompletionFlagString(CONTEXT_FLAG_CONTRACTS);
const DEPS_FLAGS = toCompletionFlagString(DEPS_FLAG_CONTRACTS);
const GUIDE_FLAGS = toCompletionFlagString(GUIDE_FLAG_CONTRACTS);
const SEARCH_FLAGS = toCompletionFlagString(SEARCH_FLAG_CONTRACTS);
const HEALTH_FLAGS = toCompletionFlagString(HEALTH_FLAG_CONTRACTS);
const INIT_FLAGS = toCompletionFlagString(INIT_FLAG_CONTRACTS);
const CONTRACTS_FLAGS = toCompletionFlagString(CONTRACTS_FLAG_CONTRACTS);
const PLAN_FLAGS = toCompletionFlagString(PLAN_FLAG_CONTRACTS);
const PLAN_SUBCOMMANDS_LIST =
  "create show add-step update-step complete-step block-step reorder-step remove-step link unlink decision discovery validation resume approve materialize";
const COMPLETION_FLAGS = toCompletionFlagString(COMPLETION_FLAG_CONTRACTS);
const COMPLETION_SHELL_CHOICES = `${COMPLETION_FLAGS} bash zsh fish`;
const GUIDE_TOPIC_CHOICES = joinCompletionValues(listGuideTopicIds());

const MUTATION_FLAGS = "--author --message --force --json --quiet --no-changed-fields --id-only --pm-path --path --no-extensions --no-pager --profile --help";
const DELETE_MUTATION_FLAGS = "--dry-run --author --message --force --json --quiet --no-changed-fields --id-only --pm-path --path --no-extensions --no-pager --profile --help";
const CLOSE_MUTATION_FLAGS = "--author --message --validate-close --duplicate-of --force --json --quiet --no-changed-fields --id-only --pm-path --path --no-extensions --no-pager --profile --help";
const RELEASE_MUTATION_FLAGS =
  "--allow-audit-release --author --message --force --json --quiet --no-changed-fields --id-only --pm-path --path --no-extensions --no-pager --profile --help";

const GLOBAL_FLAGS = GLOBAL_FLAG_CONTRACTS.flatMap((entry) => [entry.short, entry.flag, ...(entry.aliases ?? [])])
  .filter((value): value is string => Boolean(value))
  .join(" ");

function joinCompletionValues(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right))
    .join(" ");
}

function joinCompletionValuesInOrder(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].join(" ");
}

function shellDoubleQuote(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}

function completionTypeValues(itemTypes: string[], runtime: CompletionRuntimeConfig): string {
  return joinCompletionValuesInOrder(itemTypes.length > 0 ? itemTypes : (runtime.item_types ?? DEFAULT_ITEM_TYPES));
}

function completionStatusValues(runtime: CompletionRuntimeConfig): string {
  return joinCompletionValues(runtime.statuses ?? DEFAULT_STATUS_VALUES);
}

function mergeFlagStrings(baseFlags: string, runtimeFlags: string[] | undefined): string {
  const merged = [...baseFlags.split(/\s+/u).filter((value) => value.length > 0), ...(runtimeFlags ?? [])];
  return joinCompletionValues(merged);
}

function normalizeRuntimeCompletionFlags(runtimeFlags: string[] | undefined): string[] {
  const normalized = (runtimeFlags ?? [])
    .map((value) => value.trim())
    .filter((value) => value.startsWith("--") && value.length > 2)
    .map((value) => `--${value.slice(2).replaceAll("_", "-")}`);
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function renderZshRuntimeFieldFlagSpecs(runtimeFlags: string[] | undefined): string {
  const normalized = normalizeRuntimeCompletionFlags(runtimeFlags);
  if (normalized.length === 0) {
    return "";
  }
  return `${normalized.map((flag) => `            '${flag}[Runtime schema field flag]:value' \\`).join("\n")}\n`;
}

function renderFishRuntimeFieldFlagSpecs(commands: string[], runtimeFlags: string[] | undefined): string {
  const normalizedFlags = normalizeRuntimeCompletionFlags(runtimeFlags).map((flag) => flag.slice(2));
  if (commands.length === 0 || normalizedFlags.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const command of commands) {
    for (const flag of normalizedFlags) {
      lines.push(`complete -c pm -n '__fish_seen_subcommand_from ${command}' -l ${flag} -d 'Runtime schema field flag' -r`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderBashDynamicChoiceResolver(kind: "status" | "type", command: "completion-statuses" | "completion-types", fallback: string): string[] {
  const envKind = kind.toUpperCase();
  const cacheVar = `PM_COMPLETION_${envKind}_CACHE`;
  const cacheTsVar = `PM_COMPLETION_${envKind}_CACHE_TS`;
  const ttlVar = `PM_COMPLETION_${envKind}_TTL`;
  const escapedFallback = shellDoubleQuote(fallback);
  return [
    `_pm_completion_${kind}_choices() {`,
    "  local now ttl cache_ts resolved",
    "  now=\"$(date +%s 2>/dev/null || echo 0)\"",
    `  ttl="\${${ttlVar}:-120}"`,
    `  cache_ts="\${${cacheTsVar}:-0}"`,
    `  if [[ -n "\${${cacheVar}:-}" && "$now" -ne 0 && $((now - cache_ts)) -lt "$ttl" ]]; then`,
    `    printf '%s\\n' "\$${cacheVar}"`,
    "    return 0",
    "  fi",
    `  resolved="$(pm ${command} 2>/dev/null)"`,
    "  if [[ -z \"$resolved\" ]]; then",
    `    resolved="${escapedFallback}"`,
    "  fi",
    `  ${cacheVar}="$resolved"`,
    `  ${cacheTsVar}="$now"`,
    `  printf '%s\\n' "\$${cacheVar}"`,
    "}",
  ];
}

function renderZshDynamicChoiceResolver(kind: "status" | "type", command: "completion-statuses" | "completion-types", fallback: string): string {
  const envKind = kind.toUpperCase();
  const cacheVar = `PM_COMPLETION_${envKind}_CACHE`;
  const cacheTsVar = `PM_COMPLETION_${envKind}_CACHE_TS`;
  const ttlVar = `PM_COMPLETION_${envKind}_TTL`;
  const escapedFallback = shellDoubleQuote(fallback);
  return `
_pm_${kind}_choices() {
  local now ttl cache_ts resolved
  now=\${EPOCHSECONDS:-0}
  ttl=\${${ttlVar}:-120}
  cache_ts=\${${cacheTsVar}:-0}
  if [[ -n "\${${cacheVar}:-}" && "$now" -ne 0 && $((now - cache_ts)) -lt "$ttl" ]]; then
    print -r -- "$${cacheVar}"
    return
  fi
  resolved="$(pm ${command} 2>/dev/null)"
  if [[ -z "$resolved" ]]; then
    resolved="${escapedFallback}"
  fi
  ${cacheVar}="$resolved"
  ${cacheTsVar}="$now"
  print -r -- "$${cacheVar}"
}
`;
}

function renderFishDynamicChoiceResolver(kind: "status" | "type", command: "completion-statuses" | "completion-types", fallback: string): string {
  const envKind = kind.toUpperCase();
  const escapedFallback = fallback.replaceAll("'", "\\'");
  return `
function __pm_${kind}_choices
  set -l now (date +%s ^/dev/null)
  if test -z "$now"
    set now 0
  end
  set -l ttl 120
  if set -q PM_COMPLETION_${envKind}_TTL
    set ttl $PM_COMPLETION_${envKind}_TTL
  end
  if set -q PM_COMPLETION_${envKind}_CACHE; and set -q PM_COMPLETION_${envKind}_CACHE_TS
    set -l age (math "$now - $PM_COMPLETION_${envKind}_CACHE_TS")
    if test $age -lt $ttl
      printf '%s\\n' $PM_COMPLETION_${envKind}_CACHE
      return
    end
  end
  set -l resolved (pm ${command} ^/dev/null)
  if test (count $resolved) -eq 0
    set resolved '${escapedFallback}'
  end
  set -gx PM_COMPLETION_${envKind}_CACHE $resolved
  set -gx PM_COMPLETION_${envKind}_CACHE_TS $now
  printf '%s\\n' $resolved
end
`;
}

/**
 * Implements generate bash script for the public runtime surface of this module.
 */
export function generateBashScript(
  itemTypes: string[] = [],
  tags: string[] = [],
  eagerTagExpansion = false,
  runtime: CompletionRuntimeConfig = {},
): string {
  const cmds = ALL_COMMANDS.join(" ");
  const useDynamicTypeExpansion = itemTypes.length === 0;
  const typeValues = completionTypeValues(itemTypes, runtime);
  const statusValues = completionStatusValues(runtime);
  const tagValues = joinCompletionValues(tags);
  const listFlags = mergeFlagStrings(LIST_FLAGS, runtime.command_flags?.list);
  const createFlags = mergeFlagStrings(CREATE_FLAGS, runtime.command_flags?.create);
  const updateFlags = mergeFlagStrings(UPDATE_FLAGS, runtime.command_flags?.update);
  const updateManyFlags = mergeFlagStrings(UPDATE_MANY_FLAGS, runtime.command_flags?.["update-many"]);
  const normalizeFlags = NORMALIZE_FLAGS;
  const searchFlags = mergeFlagStrings(SEARCH_FLAGS, runtime.command_flags?.search);
  const calendarFlags = mergeFlagStrings(CALENDAR_FLAGS, runtime.command_flags?.calendar);
  const contextFlags = mergeFlagStrings(CONTEXT_FLAGS, runtime.command_flags?.context);
  const useEagerTagExpansion = eagerTagExpansion || tags.length > 0;
  // Note: "${...}" inside regular (non-template) strings are literal characters,
  // not JS interpolation. Only backtick template literals interpolate ${...}.
  const compgen = (flags: string): string => `$(compgen -W "${flags}" -- "$cur")`;
  return [
    "# bash completion for pm",
    '# Source this file or add \'eval "$(pm completion bash)"\' to ~/.bashrc',
    "",
    ...(useDynamicTypeExpansion ? [...renderBashDynamicChoiceResolver("type", "completion-types", typeValues), ""] : []),
    ...renderBashDynamicChoiceResolver("status", "completion-statuses", statusValues),
    "",
    "_pm_completion() {",
    "  local cur prev words cword",
    "  _init_completion 2>/dev/null || {",
    '    cur="${COMP_WORDS[COMP_CWORD]}"',
    '    prev="${COMP_WORDS[COMP_CWORD-1]}"',
    "    cword=$COMP_CWORD",
    "  }",
    "",
    "  if [[ $cword -eq 1 ]]; then",
    `    COMPREPLY=(${compgen(cmds)})`,
    "    return 0",
    "  fi",
    "",
    '  if [[ "$prev" == "--type" ]]; then',
    useDynamicTypeExpansion
      ? '    COMPREPLY=($(compgen -W "$(_pm_completion_type_choices)" -- "$cur"))'
      : `    COMPREPLY=(${compgen(typeValues)})`,
    "    return 0",
    "  fi",
    "",
    '  if [[ "$prev" == "--status" ]]; then',
    '    COMPREPLY=($(compgen -W "$(_pm_completion_status_choices)" -- "$cur"))',
    "    return 0",
    "  fi",
    "",
    ...(useEagerTagExpansion
      ? [
          '  if [[ "$prev" == "--tag" || "$prev" == "--tags" ]]; then',
          `    COMPREPLY=(${compgen(tagValues)})`,
          "    return 0",
          "  fi",
        ]
      : [
          '  if [[ "$prev" == "--tag" || "$prev" == "--tags" ]]; then',
          '    local now ttl cache_ts tag_values',
          '    now="$(date +%s 2>/dev/null || echo 0)"',
          '    ttl="${PM_COMPLETION_TAG_TTL:-120}"',
          '    cache_ts="${PM_COMPLETION_TAG_CACHE_TS:-0}"',
          '    tag_values="${PM_COMPLETION_TAG_CACHE:-}"',
          '    if [[ -z "$tag_values" || "$now" -eq 0 || $((now - cache_ts)) -ge "$ttl" ]]; then',
          '      tag_values="$(pm completion-tags 2>/dev/null)"',
          '      PM_COMPLETION_TAG_CACHE="$tag_values"',
          '      PM_COMPLETION_TAG_CACHE_TS="$now"',
          "    fi",
          '    COMPREPLY=($(compgen -W "$tag_values" -- "$cur"))',
          "    return 0",
          "  fi",
        ]),
    "",
    '  local cmd="${COMP_WORDS[1]}"',
    "",
    '  case "$cmd" in',
    "    list|list-all|list-draft|list-open|list-in-progress|list-blocked|list-closed|list-canceled)",
    `      COMPREPLY=(${compgen(listFlags)})`,
    "      ;;",
    "    aggregate)",
    `      COMPREPLY=(${compgen(AGGREGATE_FLAGS)})`,
    "      ;;",
    "    dedupe-audit)",
    `      COMPREPLY=(${compgen("--mode --limit --threshold --status --type --tag --priority --deadline-before --deadline-after --assignee --assignee-filter --parent --sprint --release --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    create)",
    `      COMPREPLY=(${compgen(createFlags)})`,
    "      ;;",
    "    copy)",
    `      COMPREPLY=(${compgen(COPY_FLAGS)})`,
    "      ;;",
    "    focus)",
    `      COMPREPLY=(${compgen(FOCUS_FLAGS)})`,
    "      ;;",
    "    update)",
    `      COMPREPLY=(${compgen(updateFlags)})`,
    "      ;;",
    "    update-many)",
    `      COMPREPLY=(${compgen(updateManyFlags)})`,
    "      ;;",
    "    normalize)",
    `      COMPREPLY=(${compgen(normalizeFlags)})`,
    "      ;;",
    "    calendar|cal)",
      `      COMPREPLY=(${compgen(calendarFlags)})`,
      "      ;;",
    "    context|ctx)",
    `      COMPREPLY=(${compgen(contextFlags)})`,
    "      ;;",
    "    guide)",
    `      COMPREPLY=(${compgen(`${GUIDE_FLAGS} ${GUIDE_TOPIC_CHOICES}`)})`,
    "      ;;",
    "    search)",
    `      COMPREPLY=(${compgen(searchFlags)})`,
    "      ;;",
    "    reindex)",
    `      COMPREPLY=(${compgen("--mode --progress --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    init)",
    `      COMPREPLY=(${compgen(`${INIT_FLAGS} --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help`)})`,
    "      ;;",
    "    config)",
    `      COMPREPLY=(${compgen("--criterion --clear-criteria --format --policy --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    extension)",
    `      COMPREPLY=(${compgen("init scaffold install uninstall explore manage reload doctor adopt adopt-all activate deactivate --init --scaffold --install --uninstall --explore --manage --reload --watch --doctor --adopt --adopt-all --activate --deactivate --project --local --global --gh --github --ref --detail --trace --runtime-probe --fix-managed-state --strict-exit --fail-on-warn --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    comments)",
    `      COMPREPLY=(${compgen("--add --stdin --file --edit --delete --limit --author --message --allow-audit-comment --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    comments-audit)",
    `      COMPREPLY=(${compgen("--status --type --tag --priority --parent --sprint --release --assignee --assignee-filter --limit-items --limit --full-history --latest --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    notes)",
    `      COMPREPLY=(${compgen("--add --limit --author --message --allow-audit-note --allow-audit-comment --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    learnings)",
    `      COMPREPLY=(${compgen("--add --limit --author --message --allow-audit-learning --allow-audit-comment --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    files)",
    `      COMPREPLY=(${compgen("discover --add --add-glob --remove --migrate --list --apply --note --append-stable --validate-paths --audit --author --message --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    docs)",
    `      COMPREPLY=(${compgen("--add --add-glob --remove --migrate --note --validate-paths --audit --author --message --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    append)",
    `      COMPREPLY=(${compgen(APPEND_FLAGS)})`,
    "      ;;",
    "    deps)",
    `      COMPREPLY=(${compgen(DEPS_FLAGS)})`,
    "      ;;",
    "    test)",
    `      COMPREPLY=(${compgen("--add --add-json --remove --list --run --match --only-index --only-last --background --timeout --progress --env-set --env-clear --shared-host-safe --pm-context --override-linked-pm-context --fail-on-context-mismatch --fail-on-skipped --fail-on-empty-test-run --require-assertions-for-pm --check-context --auto-pm-context --author --message --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    test-all)",
    `      COMPREPLY=(${compgen("--status --limit --offset --background --timeout --progress --env-set --env-clear --shared-host-safe --pm-context --override-linked-pm-context --fail-on-context-mismatch --fail-on-skipped --fail-on-empty-test-run --require-assertions-for-pm --check-context --auto-pm-context --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    test-runs)",
    `      COMPREPLY=(${compgen("list status logs stop resume --status --limit --stream --tail --force --author --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    validate)",
    `      COMPREPLY=(${compgen("--check-metadata --metadata-profile --check-resolution --check-lifecycle --check-stale-blockers --dependency-cycle-severity --parent-cycle-severity --check-files --scan-mode --include-pm-internals --verbose-file-lists --verbose-diagnostics --all-affected-ids --strict-exit --fail-on-warn --fix-hints --auto-fix --dry-run --fix-scope --prune-missing --check-history-drift --check-command-references --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    health)",
    `      COMPREPLY=(${compgen(HEALTH_FLAGS)})`,
    "      ;;",
    "    history)",
    `      COMPREPLY=(${compgen("--limit --compact --full --diff --field --verify --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    history-compact)",
    `      COMPREPLY=(${compgen("--before --ids --all-over --scope --min-entries --dry-run --author --message --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    get)",
    `      COMPREPLY=(${compgen(GET_FLAGS)})`,
    "      ;;",
    "    history-redact)",
    `      COMPREPLY=(${compgen("--literal --regex --replacement --dry-run --author --message --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    history-repair)",
    `      COMPREPLY=(${compgen("--all --dry-run --author --message --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    schema)",
    `      COMPREPLY=(${compgen("list show show-status add-type remove-type add-status remove-status add-field remove-field list-fields show-field apply-preset --description --default-status --folder --alias --role --order --type --commands --cli-flag --required --required-on-create --no-allow-unset --required-types --infer --min-count --apply --author --force --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    plan)",
    `      COMPREPLY=(${compgen(`${PLAN_SUBCOMMANDS_LIST} ${PLAN_FLAGS}`)})`,
    "      ;;",
    "    activity)",
    `      COMPREPLY=(${compgen(ACTIVITY_FLAGS)})`,
    "      ;;",
    "    contracts)",
    `      COMPREPLY=(${compgen(CONTRACTS_FLAGS)})`,
    "      ;;",
    "    gc)",
    `      COMPREPLY=(${compgen("--dry-run --scope --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    stats)",
    `      COMPREPLY=(${compgen("--storage --metadata-coverage --field-utilization --by-assignee --by-tag --by-priority --tag-prefix --json --quiet --no-changed-fields --pm-path --path --no-extensions --no-pager --profile --help")})`,
    "      ;;",
    "    close|close-task)",
    `      COMPREPLY=(${compgen(CLOSE_MUTATION_FLAGS)})`,
    "      ;;",
    "    close-many)",
    `      COMPREPLY=(${compgen(CLOSE_MANY_FLAGS)})`,
    "      ;;",
    "    release)",
    `      COMPREPLY=(${compgen(RELEASE_MUTATION_FLAGS)})`,
    "      ;;",
    "    delete)",
    `      COMPREPLY=(${compgen(DELETE_MUTATION_FLAGS)})`,
    "      ;;",
    "    claim|restore|start-task|pause-task)",
    `      COMPREPLY=(${compgen(MUTATION_FLAGS)})`,
    "      ;;",
    "    meet|event)",
    `      COMPREPLY=(${compgen(MEET_FLAGS)})`,
    "      ;;",
    "    remind)",
    `      COMPREPLY=(${compgen(REMIND_FLAGS)})`,
    "      ;;",
    "    completion)",
    `      COMPREPLY=(${compgen(COMPLETION_SHELL_CHOICES)})`,
    "      ;;",
    "    templates)",
    `      COMPREPLY=(${compgen("save list show")})`,
    "      ;;",
    "    *)",
    `      COMPREPLY=(${compgen(GLOBAL_FLAGS)})`,
    "      ;;",
    "  esac",
    "  return 0",
    "}",
    "",
    "complete -F _pm_completion pm",
  ].join("\n");
}

/**
 * Implements generate zsh script for the public runtime surface of this module.
 */
export function generateZshScript(
  itemTypes: string[] = [],
  tags: string[] = [],
  eagerTagExpansion = false,
  runtime: CompletionRuntimeConfig = {},
): string {
  const cmds = ALL_COMMANDS.map((c) => `'${c}'`).join(" ");
  const useDynamicTypeExpansion = itemTypes.length === 0;
  const typeFallbackChoices = completionTypeValues(itemTypes, runtime);
  const statusFallbackChoices = completionStatusValues(runtime);
  const typeChoices = useDynamicTypeExpansion ? '${(f)"$(_pm_type_choices)"}' : typeFallbackChoices;
  const statusChoices = '${(f)"$(_pm_status_choices)"}';
  const guideTopicChoices = GUIDE_TOPIC_CHOICES;
  const tagChoices = joinCompletionValues(tags);
  const useEagerTagExpansion = eagerTagExpansion || tags.length > 0;
  const zshTagChoices = useEagerTagExpansion ? tagChoices : '${(f)"$(_pm_tag_choices)"}';
  const zshListRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(runtime.command_flags?.list);
  const zshCreateRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(runtime.command_flags?.create);
  const zshUpdateRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(runtime.command_flags?.update);
  const zshUpdateManyRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(runtime.command_flags?.["update-many"]);
  const zshSearchRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(runtime.command_flags?.search);
  const zshCalendarRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(runtime.command_flags?.calendar);
  const zshContextRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(runtime.command_flags?.context);
  const dynamicTagResolver = useEagerTagExpansion
    ? ""
    : `
_pm_tag_choices() {
  local now ttl cache_ts
  now=\${EPOCHSECONDS:-0}
  ttl=\${PM_COMPLETION_TAG_TTL:-120}
  cache_ts=\${PM_COMPLETION_TAG_CACHE_TS:-0}
  if [[ -n "\${PM_COMPLETION_TAG_CACHE:-}" && "$now" -ne 0 && $((now - cache_ts)) -lt "$ttl" ]]; then
    print -r -- "$PM_COMPLETION_TAG_CACHE"
    return
  fi
  PM_COMPLETION_TAG_CACHE="$(pm completion-tags 2>/dev/null)"
  PM_COMPLETION_TAG_CACHE_TS="$now"
  print -r -- "$PM_COMPLETION_TAG_CACHE"
}
`;
  return `#compdef pm
# zsh completion for pm
# Source this file or add 'eval "$(pm completion zsh)"' to ~/.zshrc

_pm_commands() {
  local -a commands
  commands=(
    'init:Initialize pm storage for the current workspace'
    'config:Read or update pm settings'
    'extension:Manage extension lifecycle operations'
    'create:Create a new project management item'
    'copy:Copy an existing item to a new ID'
    'focus:Set/clear/show the session focused parent for new items'
    'list:List active items with optional filters'
    'list-all:List all items with optional filters'
    'list-draft:List draft items with optional filters'
    'list-open:List open items with optional filters'
    'list-in-progress:List in-progress items with optional filters'
    'list-blocked:List blocked items with optional filters'
    'list-closed:List closed items with optional filters'
    'list-canceled:List canceled items with optional filters'
    'aggregate:Aggregate grouped item counts and numeric stats for governance queries'
    'dedupe-audit:Audit potential duplicate items and emit merge suggestions'
    'guide:Browse local progressive-disclosure guides'
    'calendar:Show calendar views for deadlines and reminders'
    'cal:Alias for calendar'
    'context:Show a token-efficient project context snapshot'
    'ctx:Alias for context'
    'get:Show item details by ID'
    'search:Search items with keyword, semantic, or hybrid modes'
    'reindex:Rebuild search artifacts'
    'history:Show item history entries'
    'history-compact:Compact history streams into a synthetic baseline + retained tail'
    'history-redact:Redact sensitive literals/patterns and recompute history hashes'
    'history-repair:Re-anchor a drifted history chain so pm health/validate report ok'
    'schema:Manage custom item types and statuses in .agents/pm/schema/*.json'
    'plan:Agent-optimized Plan item workflow (create/show/add-step/update-step/complete-step/link/approve/materialize)'
    'activity:Show recent activity across items'
    'restore:Restore an item to an earlier state'
    'update:Update item fields and metadata'
    'update-many:Bulk-update matched items with dry-run and rollback checkpoints'
    'normalize:Normalize lifecycle metadata with dry-run planning or apply mode'
    'close:Close an item (reason requirement follows governance settings)'
    'close-many:Bulk-close matched items with an optional shared reason and rollback checkpoint'
    'delete:Delete an item and record the change'
    'append:Append text to an item body'
    'comments:List or add comments for an item'
    'comments-audit:Audit latest comments or full history across filtered items'
    'notes:List or add notes for an item'
    'learnings:List or add learnings for an item'
    'files:Manage linked files'
    'docs:Manage linked docs'
    'deps:Show dependency relationships for an item'
    'test:Manage linked tests and optionally run them'
    'test-all:Run linked tests across matching items'
    'test-runs:Manage background linked-test runs'
    'stats:Show project tracker statistics'
    'health:Show project tracker health checks'
    'validate:Run standalone validation checks'
    'gc:Clean optional cache artifacts'
    'contracts:Show machine-readable command and schema contracts'
    'claim:Claim an item for active work'
    'release:Release the active claim for an item'
    'start-task:Lifecycle alias to claim and set in_progress'
    'pause-task:Lifecycle alias to reopen and release claim'
    'close-task:Lifecycle alias to close and release claim'
    'meet:Shortcut to create a Meeting with scheduling defaults'
    'event:Shortcut to create an Event with scheduling defaults'
    'remind:Shortcut to create a Reminder from a point in time'
    'templates:Manage reusable create templates'
    'completion:Generate shell completion'
    'help:Display help for a command'
  )
  _describe 'command' commands
}
${dynamicTagResolver}
${useDynamicTypeExpansion ? renderZshDynamicChoiceResolver("type", "completion-types", typeFallbackChoices) : ""}
${renderZshDynamicChoiceResolver("status", "completion-statuses", statusFallbackChoices)}

_pm() {
  local context state line
  _arguments -C \\
    '--json[Output JSON instead of TOON]' \\
    '--quiet[Suppress stdout output]' \\
    '--no-changed-fields[Omit changed_fields array from mutation output]' \\
    '--pm-path[Explicit tracker storage path for this command]:path:_files -/' \\
    '--path[Compatibility alias for --pm-path]:path:_files -/' \\
    '--no-extensions[Disable extension loading]' \\
    '--no-pager[Disable pager integration for help and long output]' \\
    '--profile[Print deterministic timing diagnostics]' \\
    '(-V --version)--version[Output the version number]' \\
    '(-h --help)--help[Display help]' \\
    '1: :_pm_commands' \\
    '*:: :->args' && return 0

  case $state in
    args)
      case $line[1] in
        list|list-all|list-draft|list-open|list-in-progress|list-blocked|list-closed|list-canceled)
          _arguments \\
            '--type[Filter by item type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--tags[Alias for --tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--deadline-before[Filter by deadline upper bound (ISO/date string or relative)]:date' \\
            '--deadline-after[Filter by deadline lower bound (ISO/date string or relative)]:date' \\
            '--updated-after[Filter by updated_at lower bound (ISO/relative)]:timestamp' \\
            '--updated-before[Filter by updated_at upper bound (ISO/relative)]:timestamp' \\
            '--created-after[Filter by created_at lower bound (ISO/relative)]:timestamp' \\
            '--created-before[Filter by created_at upper bound (ISO/relative)]:timestamp' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--filter-reviewer-missing[Select only items missing reviewer]' \\
            '--filter-risk-missing[Select only items missing risk]' \\
            '--filter-confidence-missing[Select only items missing confidence]' \\
            '--filter-sprint-missing[Select only items missing sprint]' \\
            '--filter-release-missing[Select only items missing release]' \\
            '--has-notes[Select only items that have notes]' \\
            '--no-notes[Select only items with no notes]' \\
            '--has-learnings[Select only items that have learnings]' \\
            '--no-learnings[Select only items with no learnings]' \\
            '--has-files[Select only items that have linked files]' \\
            '--no-files[Select only items with no linked files]' \\
            '--has-docs[Select only items that have linked docs]' \\
            '--no-docs[Select only items with no linked docs]' \\
            '--has-tests[Select only items that have linked tests]' \\
            '--no-tests[Select only items with no linked tests]' \\
            '--has-comments[Select only items that have comments]' \\
            '--no-comments[Select only items with no comments]' \\
            '--has-deps[Select only items that have dependencies]' \\
            '--no-deps[Select only items with no dependencies]' \\
            '--has-body[Select only items with non-empty body]' \\
            '--empty-body[Select only items with empty body]' \\
            '--has-linked-command[Select only items that have a linked command]' \\
            '--no-linked-command[Select only items with no linked command]' \\
            '--limit[Limit returned item count]:number' \\
            '--offset[Skip the first n matching rows before limit]:number' \\
            '--no-truncate[Return every matched row, overriding --limit]' \\
            '--all[Alias for --no-truncate]' \\
            '--include-body[Include item body in each returned list row]' \\
            '--compact[Render compact list projection fields]' \\
            '--fields[Render custom comma-separated list fields]:fields' \\
            '--tree[Render hierarchical subtree output rooted at --parent or top-level parents]' \\
            '--tree-depth[Cap recursion depth for --tree (0 = root only)]:number' \\
            '--sort[Sort field]:(priority deadline updated_at created_at title parent)' \\
            '--order[Sort order (requires --sort)]:(asc desc)' \\
            '--stream[Emit line-delimited JSON rows (requires --json)]' \\
${zshListRuntimeFieldFlags}            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]' \\
            '--pm-path[Explicit tracker storage path]:path:_files -/' \\
            '--path[Compatibility alias for --pm-path]:path:_files -/'
          ;;
        aggregate)
          _arguments \\
            '--group-by[Comma-separated group-by fields (supported: parent,type,priority,status,assignee,tags,sprint,release)]:fields' \\
            '--count[Return grouped counts]' \\
            '--completion[Add open/in_progress/closed/other counts and completion percentage]' \\
            '--sum[Numeric field to sum per group]:field' \\
            '--avg[Numeric field to average per group]:field' \\
            '--include-unparented[Include unparented rows when grouping by parent]' \\
            '--status[Filter by status]:(${statusChoices})' \\
            '--type[Filter by item type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--deadline-before[Filter by deadline upper bound (ISO/date string or relative)]:date' \\
            '--deadline-after[Filter by deadline lower bound (ISO/date string or relative)]:date' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--parent[Filter by parent item ID]:parent_id' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        dedupe-audit)
          _arguments \\
            '--mode[Dedupe mode]:(title_exact title_fuzzy parent_scope)' \\
            '--limit[Limit returned duplicate clusters]:number' \\
            '--threshold[Fuzzy mode token similarity threshold between 0 and 1]:number' \\
            '--status[Filter by status]:(${statusChoices})' \\
            '--type[Filter by item type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--deadline-before[Filter by deadline upper bound (ISO/date string or relative)]:date' \\
            '--deadline-after[Filter by deadline lower bound (ISO/date string or relative)]:date' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--parent[Filter by parent item ID]:parent_id' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        create)
          _arguments \\
            '(-t --title)'{-t,--title}'[Item title]:title' \\
            '(-d --description)'{-d,--description}'[Item description]:description' \\
            '--type[Item type]:(${typeChoices})' \\
            '--create-mode[Create required-option policy mode]:(strict progressive)' \\
            '--schedule-preset[Scheduling preset for Reminder/Meeting/Event]:(lightweight)' \\
            '(-s --status)'{-s,--status}'[Item status]:(${statusChoices})' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '--tags[Comma-separated tags]:tags' \\
            '--add-tags[Add tags additively without replacing existing]:tags' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '--body-file[Load the item body from a file]:body_file:_files' \\
            '--deadline[Deadline (ISO/date string or relative +6h/+1d/+2w/+6m)]:deadline' \\
            '--estimate[Estimated minutes]:minutes' \\
            '--acceptance-criteria[Acceptance criteria]:criteria' \\
            '--reminder[Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>]:reminder' \\
            '--event[Event entry start=<iso|relative>,end=<iso|relative>,recur_*]:event' \\
            '--type-option[Type option key=value or key=<name>,value=<value>]:type_option' \\
            '--unset[Clear scalar metadata field by name]:field' \\
            '--replace-deps[Atomically replace dependencies with provided --dep values]' \\
            '--replace-tests[Atomically replace linked tests with provided --test values]' \\
            '--clear-deps[Clear dependency entries]' \\
            '--clear-comments[Clear comments]' \\
            '--clear-notes[Clear notes]' \\
            '--clear-learnings[Clear learnings]' \\
            '--clear-files[Clear linked files]' \\
            '--clear-tests[Clear linked tests]' \\
            '--clear-docs[Clear linked docs]' \\
            '--clear-reminders[Clear reminders]' \\
            '--clear-events[Clear events]' \\
            '--clear-type-options[Clear type options]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--assignee[Assignee]:assignee' \\
${zshCreateRuntimeFieldFlags}            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        copy)
          _arguments \\
            '--title[Override copied title]:title' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force ownership override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        focus)
          _arguments \\
            '--clear[Clear the focused item]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        meet|event)
          _arguments \\
            '--start[Start time (ISO, now, or relative)]:start' \\
            '--duration[Duration from start (default 1h)]:duration' \\
            '--end[End time (overrides --duration)]:end' \\
            '--location[Location]:location' \\
            '--timezone[IANA timezone]:timezone' \\
            '--all-day[Mark as an all-day event]' \\
            '--parent[Parent item id]:parent' \\
            '--allow-missing-parent[Permit a parent id that does not exist yet]' \\
            '--tags[Comma-separated tags]:tags' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '(-d --description)'{-d,--description}'[Short description]:description' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        remind)
          _arguments \\
            '--at[Reminder time (default +1d)]:at' \\
            '--text[Reminder text (defaults to title)]:text' \\
            '--parent[Parent item id]:parent' \\
            '--allow-missing-parent[Permit a parent id that does not exist yet]' \\
            '--tags[Comma-separated tags]:tags' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '(-d --description)'{-d,--description}'[Short description]:description' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        update)
          _arguments \\
            '(-t --title)'{-t,--title}'[Item title]:title' \\
            '(-d --description)'{-d,--description}'[Item description]:description' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '--body-file[Load the item body from a file]:body_file:_files' \\
            '(-s --status)'{-s,--status}'[Item status]:(${statusChoices})' \\
            '--close-reason[Set close reason]:close_reason' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '--type[Item type]:(${typeChoices})' \\
            '--tags[Comma-separated tags]:tags' \\
            '--add-tags[Add tags additively without replacing existing]:tags' \\
            '--remove-tags[Remove tags from the existing list]:tags' \\
            '--expected[Short alias for --expected-result]:expected_result' \\
            '--actual[Short alias for --actual-result]:actual_result' \\
            '--comment[Comment seed author=<value>,created_at=<iso|now>,text=<value>]:comment' \\
            '--note[Note seed author=<value>,created_at=<iso|now>,text=<value>]:note' \\
            '--learning[Learning seed author=<value>,created_at=<iso|now>,text=<value>]:learning' \\
            '--file[Linked file path=<value>,scope=<project|global>,note=<text>]:file' \\
            '--test[Linked test command=<value>,path=<value>,scope=<project|global>]:test' \\
            '--doc[Linked doc path=<value>,scope=<project|global>,note=<text>]:doc' \\
            '--reminder[Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>]:reminder' \\
            '--event[Event entry start=<iso|relative>,end=<iso|relative>,recur_*]:event' \\
            '--type-option[Type option key=value or key=<name>,value=<value>]:type_option' \\
            '--unset[Clear scalar metadata field by name]:field' \\
            '--clear-deps[Clear dependency entries]' \\
            '--clear-comments[Clear comments]' \\
            '--clear-notes[Clear notes]' \\
            '--clear-learnings[Clear learnings]' \\
            '--clear-files[Clear linked files]' \\
            '--clear-tests[Clear linked tests]' \\
            '--clear-docs[Clear linked docs]' \\
            '--clear-reminders[Clear reminders]' \\
            '--clear-events[Clear events]' \\
            '--clear-type-options[Clear type options]' \\
${zshUpdateRuntimeFieldFlags}            '--allow-audit-update[Allow non-owner metadata-only audit updates without requiring --force]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        update-many)
          _arguments \\
            '--filter-status[Filter by status before applying updates]:(${statusChoices})' \\
            '--filter-type[Filter by type before applying updates]:(${typeChoices})' \\
            '--filter-tag[Filter by tag before applying updates]:(${zshTagChoices})' \\
            '--filter-priority[Filter by priority before applying updates]:(0 1 2 3 4)' \\
            '--filter-deadline-before[Filter by deadline upper bound]:deadline' \\
            '--filter-deadline-after[Filter by deadline lower bound]:deadline' \\
            '--filter-updated-after[Filter by updated_at lower bound (ISO/relative)]:timestamp' \\
            '--filter-updated-before[Filter by updated_at upper bound (ISO/relative)]:timestamp' \\
            '--filter-created-after[Filter by created_at lower bound (ISO/relative)]:timestamp' \\
            '--filter-created-before[Filter by created_at upper bound (ISO/relative)]:timestamp' \\
            '--filter-assignee[Filter by assignee before applying updates]:assignee' \\
            '--filter-assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--filter-parent[Filter by parent item ID]:parent' \\
            '--filter-sprint[Filter by sprint]:sprint' \\
            '--filter-release[Filter by release]:release' \\
            '--filter-ac-missing[Select only items missing acceptance_criteria]' \\
            '--filter-estimates-missing[Select only items missing estimated_minutes]' \\
            '--filter-resolution-missing[Select only terminal items missing resolution]' \\
            '--filter-metadata-missing[Select only items missing any tracked metadata]' \\
            '--filter-reviewer-missing[Select only items missing reviewer]' \\
            '--filter-risk-missing[Select only items missing risk]' \\
            '--filter-confidence-missing[Select only items missing confidence]' \\
            '--filter-sprint-missing[Select only items missing sprint]' \\
            '--filter-release-missing[Select only items missing release]' \\
            '--filter-has-notes[Select only items that have notes]' \\
            '--filter-no-notes[Select only items with no notes]' \\
            '--filter-has-learnings[Select only items that have learnings]' \\
            '--filter-no-learnings[Select only items with no learnings]' \\
            '--filter-has-files[Select only items that have linked files]' \\
            '--filter-no-files[Select only items with no linked files]' \\
            '--filter-has-docs[Select only items that have linked docs]' \\
            '--filter-no-docs[Select only items with no linked docs]' \\
            '--filter-has-tests[Select only items that have linked tests]' \\
            '--filter-no-tests[Select only items with no linked tests]' \\
            '--filter-has-comments[Select only items that have comments]' \\
            '--filter-no-comments[Select only items with no comments]' \\
            '--filter-has-deps[Select only items that have dependencies]' \\
            '--filter-no-deps[Select only items with no dependencies]' \\
            '--filter-has-body[Select only items with non-empty body]' \\
            '--filter-empty-body[Select only items with empty body]' \\
            '--filter-has-linked-command[Select only items that have a linked command]' \\
            '--filter-no-linked-command[Select only items with no linked command]' \\
            '--ids[Explicit comma-separated ID allowlist]:ids' \\
            '--limit[Limit matched item count]:number' \\
            '--offset[Skip first n matched rows]:number' \\
            '--dry-run[Preview updates without mutating]' \\
            '--rollback[Rollback checkpoint ID]:checkpoint_id' \\
            '--no-checkpoint[Disable checkpoint creation during apply mode]' \\
            '(-t --title)'{-t,--title}'[Item title]:title' \\
            '(-d --description)'{-d,--description}'[Item description]:description' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '--type[Item type]:(${typeChoices})' \\
            '--tags[Comma-separated tags]:tags' \\
            '--add-tags[Add tags additively without replacing existing]:tags' \\
            '--remove-tags[Remove tags from the existing list]:tags' \\
            '--deadline[Deadline (ISO/date string or relative +6h/+1d/+2w/+6m)]:deadline' \\
            '--estimate[Estimated minutes]:minutes' \\
            '--acceptance-criteria[Acceptance criteria]:criteria' \\
            '--definition-of-ready[Definition of ready]:definition_of_ready' \\
            '--order[Planning order/rank]:order' \\
            '--goal[Goal identifier]:goal' \\
            '--objective[Objective identifier]:objective' \\
            '--value[Business value summary]:value' \\
            '--impact[Business impact summary]:impact' \\
            '--outcome[Expected outcome summary]:outcome' \\
            '--why-now[Why-now rationale]:why_now' \\
            '--reviewer[Reviewer]:reviewer' \\
            '--risk[Risk level]:risk' \\
            '--confidence[Confidence level]:confidence' \\
            '--sprint[Sprint identifier]:sprint' \\
            '--release[Release identifier]:release' \\
            '--reporter[Issue reporter]:reporter' \\
            '--severity[Issue severity]:severity' \\
            '--environment[Issue environment context]:environment' \\
            '--repro-steps[Issue reproduction steps]:repro_steps' \\
            '--resolution[Issue resolution summary]:resolution' \\
            '--expected-result[Issue expected behavior]:expected_result' \\
            '--actual-result[Issue observed behavior]:actual_result' \\
            '--expected[Short alias for --expected-result]:expected_result' \\
            '--actual[Short alias for --actual-result]:actual_result' \\
            '--affected-version[Affected version identifier]:affected_version' \\
            '--fixed-version[Fixed version identifier]:fixed_version' \\
            '--component[Issue component ownership]:component' \\
            '--regression[Regression marker true|false|1|0]:regression' \\
            '--customer-impact[Customer impact summary]:customer_impact' \\
            '--dep[Dependency seed id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>]:dep' \\
            '--dep-remove[Dependency removal selector id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>]:dep_remove' \\
            '--replace-deps[Atomically replace dependencies with provided --dep values]' \\
            '--replace-tests[Atomically replace linked tests with provided --test values]' \\
            '--comment[Comment seed author=<value>,created_at=<iso|now>,text=<value>]:comment' \\
            '--note[Note seed author=<value>,created_at=<iso|now>,text=<value>]:note' \\
            '--learning[Learning seed author=<value>,created_at=<iso|now>,text=<value>]:learning' \\
            '--file[Linked file path=<value>,scope=<project|global>,note=<text>]:file' \\
            '--test[Linked test command=<value>,path=<value>,scope=<project|global>]:test' \\
            '--doc[Linked doc path=<value>,scope=<project|global>,note=<text>]:doc' \\
            '--reminder[Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>]:reminder' \\
            '--event[Event entry start=<iso|relative>,end=<iso|relative>,recur_*]:event' \\
            '--type-option[Type option key=value or key=<name>,value=<value>]:type_option' \\
            '--unset[Clear scalar metadata field by name]:field' \\
            '--clear-deps[Clear dependency entries]' \\
            '--clear-comments[Clear comments]' \\
            '--clear-notes[Clear notes]' \\
            '--clear-learnings[Clear learnings]' \\
            '--clear-files[Clear linked files]' \\
            '--clear-tests[Clear linked tests]' \\
            '--clear-docs[Clear linked docs]' \\
            '--clear-reminders[Clear reminders]' \\
            '--clear-events[Clear events]' \\
            '--clear-type-options[Clear type options]' \\
${zshUpdateManyRuntimeFieldFlags}            '--allow-audit-update[Allow non-owner metadata-only audit updates without requiring --force]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        close-many)
          _arguments \\
            '--filter-status[Filter by status before closing]:(${statusChoices})' \\
            '--filter-type[Filter by type before closing]:(${typeChoices})' \\
            '--filter-tag[Filter by tag before closing]:(${zshTagChoices})' \\
            '--filter-priority[Filter by priority before closing]:(0 1 2 3 4)' \\
            '--filter-deadline-before[Filter by deadline upper bound]:deadline' \\
            '--filter-deadline-after[Filter by deadline lower bound]:deadline' \\
            '--filter-updated-after[Filter by updated_at lower bound (ISO/relative)]:timestamp' \\
            '--filter-updated-before[Filter by updated_at upper bound (ISO/relative)]:timestamp' \\
            '--filter-created-after[Filter by created_at lower bound (ISO/relative)]:timestamp' \\
            '--filter-created-before[Filter by created_at upper bound (ISO/relative)]:timestamp' \\
            '--filter-assignee[Filter by assignee before closing]:assignee' \\
            '--filter-assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--filter-parent[Filter by parent item ID]:parent' \\
            '--filter-sprint[Filter by sprint]:sprint' \\
            '--filter-release[Filter by release]:release' \\
            '--filter-reviewer-missing[Select only items missing reviewer]' \\
            '--filter-risk-missing[Select only items missing risk]' \\
            '--filter-confidence-missing[Select only items missing confidence]' \\
            '--filter-sprint-missing[Select only items missing sprint]' \\
            '--filter-release-missing[Select only items missing release]' \\
            '--filter-has-notes[Select only items that have notes]' \\
            '--filter-no-notes[Select only items with no notes]' \\
            '--filter-has-learnings[Select only items that have learnings]' \\
            '--filter-no-learnings[Select only items with no learnings]' \\
            '--filter-has-files[Select only items that have linked files]' \\
            '--filter-no-files[Select only items with no linked files]' \\
            '--filter-has-docs[Select only items that have linked docs]' \\
            '--filter-no-docs[Select only items with no linked docs]' \\
            '--filter-has-tests[Select only items that have linked tests]' \\
            '--filter-no-tests[Select only items with no linked tests]' \\
            '--filter-has-comments[Select only items that have comments]' \\
            '--filter-no-comments[Select only items with no comments]' \\
            '--filter-has-deps[Select only items that have dependencies]' \\
            '--filter-no-deps[Select only items with no dependencies]' \\
            '--filter-has-body[Select only items with non-empty body]' \\
            '--filter-empty-body[Select only items with empty body]' \\
            '--filter-has-linked-command[Select only items that have a linked command]' \\
            '--filter-no-linked-command[Select only items with no linked command]' \\
            '--ids[Explicit comma-separated ID allowlist]:ids' \\
            '--limit[Limit matched item count]:number' \\
            '--offset[Skip first n matched rows]:number' \\
            '--reason[Optional shared close reason applied to every matched item]:reason' \\
            '--resolution[Shared closure resolution]:resolution' \\
            '--expected-result[Shared expected-result note]:expected_result' \\
            '--actual-result[Shared actual-result note]:actual_result' \\
            '--expected[Short alias for --expected-result]:expected_result' \\
            '--actual[Short alias for --actual-result]:actual_result' \\
            '--validate-close[Validate closure metadata per item]:(off warn strict)' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Re-close terminal matches and override ownership]' \\
            '--dry-run[Preview matched items without mutating]' \\
            '--rollback[Rollback checkpoint ID]:checkpoint_id' \\
            '--no-checkpoint[Disable checkpoint creation during apply mode]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        normalize)
          _arguments \\
            '--filter-status[Filter by status before planning or apply]:(${statusChoices})' \\
            '--filter-type[Filter by type before planning or apply]:(${typeChoices})' \\
            '--filter-tag[Filter by tag before planning or apply]:(${zshTagChoices})' \\
            '--filter-priority[Filter by priority before planning or apply]:(0 1 2 3 4)' \\
            '--filter-deadline-before[Filter by deadline upper bound]:deadline' \\
            '--filter-deadline-after[Filter by deadline lower bound]:deadline' \\
            '--filter-assignee[Filter by assignee before planning or apply]:assignee' \\
            '--filter-assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--filter-parent[Filter by parent item ID]:parent' \\
            '--filter-sprint[Filter by sprint]:sprint' \\
            '--filter-release[Filter by release]:release' \\
            '--limit[Limit matched item count]:number' \\
            '--offset[Skip first n matched rows]:number' \\
            '--dry-run[Preview normalize findings without mutating]' \\
            '--apply[Apply normalize changes]' \\
            '--allow-audit-update[Allow non-owner metadata-only audit updates without requiring --force]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        calendar|cal)
          _arguments \\
            '--view[Calendar view]:(agenda day week month)' \\
            '--date[Anchor date/time (ISO/date string or relative)]:date' \\
            '--from[Agenda lower bound (ISO/date string or relative)]:date' \\
            '--to[Agenda upper bound (ISO/date string or relative)]:date' \\
            '--past[Include past entries]' \\
            '--full-period[Include full anchored day/week/month period]' \\
            '--type[Filter by type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--status[Filter by status]:(${statusChoices})' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
${zshCalendarRuntimeFieldFlags}            '--include[Include event sources]:(all deadlines reminders events scheduled)' \\
            '--recurrence-lookahead-days[Bound open-ended recurrence lookahead]:days' \\
            '--recurrence-lookback-days[Bound open-ended recurrence lookback]:days' \\
            '--occurrence-limit[Cap occurrences per recurring event]:number' \\
            '--limit[Limit returned events]:number' \\
            '--format[Output override]:(markdown toon json)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        context|ctx)
          _arguments \\
            '--date[Anchor date/time (ISO/date string or relative)]:date' \\
            '--from[Agenda lower bound (ISO/date string or relative)]:date' \\
            '--to[Agenda upper bound (ISO/date string or relative)]:date' \\
            '--past[Include past entries in bounded windows]' \\
            '--type[Filter by type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--parent[Scope snapshot to one item subtree]:id' \\
            '--limit[Limit focus and agenda rows per section]:number' \\
            '--depth[Context depth]:(brief standard deep full)' \\
            '--format[Output override]:(markdown toon json)' \\
${zshContextRuntimeFieldFlags}            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        guide)
          _arguments \\
            '1:topic:(${guideTopicChoices})' \\
            '--list[Show guide topic index]' \\
            '--format[Output override]:(markdown toon json)' \\
            '--depth[Guide detail depth]:(brief standard deep)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        search)
          _arguments \\
            '--mode[Search mode]:(keyword semantic hybrid)' \\
            '--match-mode[Token match mode]:(and or exact)' \\
            '--min-score[Per-query minimum score threshold]:number' \\
            '--count[Return only the match count]' \\
            '--include-linked[Include linked content in scoring]' \\
            '--limit[Max results]:number' \\
            '--status[Filter by status (open/closed/canceled, csv)]:(${statusChoices})' \\
            '--type[Filter by type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--tags[Alias for --tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--updated-after[Filter by updated_at lower bound]:value' \\
            '--updated-before[Filter by updated_at upper bound]:value' \\
            '--created-after[Filter by created_at lower bound]:value' \\
            '--created-before[Filter by created_at upper bound]:value' \\
            '--assignee[Filter by assignee]:value' \\
            '--sprint[Filter by sprint]:value' \\
            '--release[Filter by release]:value' \\
            '--parent[Filter by parent item ID]:value' \\
            '--filter-reviewer-missing[Select only items missing reviewer]' \\
            '--filter-risk-missing[Select only items missing risk]' \\
            '--filter-confidence-missing[Select only items missing confidence]' \\
            '--filter-sprint-missing[Select only items missing sprint]' \\
            '--filter-release-missing[Select only items missing release]' \\
            '--has-notes[Select only items that have notes]' \\
            '--no-notes[Select only items with no notes]' \\
            '--has-learnings[Select only items that have learnings]' \\
            '--no-learnings[Select only items with no learnings]' \\
            '--has-files[Select only items that have linked files]' \\
            '--no-files[Select only items with no linked files]' \\
            '--has-docs[Select only items that have linked docs]' \\
            '--no-docs[Select only items with no linked docs]' \\
            '--has-tests[Select only items that have linked tests]' \\
            '--no-tests[Select only items with no linked tests]' \\
            '--has-comments[Select only items that have comments]' \\
            '--no-comments[Select only items with no comments]' \\
            '--has-deps[Select only items that have dependencies]' \\
            '--no-deps[Select only items with no dependencies]' \\
            '--has-body[Select only items with non-empty body]' \\
            '--empty-body[Select only items with empty body]' \\
            '--has-linked-command[Select only items that have a linked command]' \\
            '--no-linked-command[Select only items with no linked command]' \\
${zshSearchRuntimeFieldFlags}            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        reindex)
          _arguments \\
            '--mode[Reindex mode]:(keyword semantic hybrid)' \\
            '--progress[Emit progress updates to stderr]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        history)
          _arguments \\
            '--limit[Max entries]:number' \\
            '--compact[Condensed history projection]' \\
            '--full[Show full history entries]' \\
            '--diff[Include per-entry field-level before/after value diffs]' \\
            '--field[With --diff, show only entries that changed this field]:field' \\
            '--verify[Verify history hash chain and replay integrity]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        history-compact)
          _arguments \\
            '--before[Compact entries strictly before this version number or ISO timestamp]:before' \\
            '--ids[Bulk: compact an explicit comma-separated list of item ids]:ids' \\
            '--all-over[Bulk: compact every stream with more than N entries]:all-over' \\
            '--scope[Bulk: lifecycle scope to scan (closed|all-streams)]:scope' \\
            '--min-entries[Bulk: skip streams with at most N entries]:min-entries' \\
            '--dry-run[Preview compaction impact without writing the history file]' \\
            '--author[Mutation author]:author' \\
            '--message[Audit history message]:message' \\
            '--force[Force ownership/lock override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        get)
          _arguments \\
            '--depth[Detail depth]:(brief standard deep full)' \\
            '--full[Explicit full item read]' \\
            '--fields[Render custom comma-separated item fields]:fields' \\
            '--tree[Include descendant subtree in result payload]' \\
            '--tree-depth[Cap subtree depth for --tree (0 = root only)]:number' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        history-redact)
          _arguments \\
            '--literal[Literal string matcher to redact from history/item payloads]:literal' \\
            '--regex[Regex matcher to redact (/pattern/flags or raw pattern)]:regex' \\
            '--replacement[Replacement text (defaults to [redacted])]:replacement' \\
            '--dry-run[Preview redaction impact without writing files]' \\
            '--author[Mutation author]:author' \\
            '--message[Audit history message]:message' \\
            '--force[Force ownership/lock override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        history-repair)
          _arguments \\
            '--all[Repair every drifted stream in one audited pass]' \\
            '--dry-run[Preview the re-anchor impact without writing the history file]' \\
            '--author[Mutation author]:author' \\
            '--message[Audit history message]:message' \\
            '--force[Force ownership/lock override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        schema)
          _arguments \\
            '1:subcommand:(list show show-status add-type remove-type add-status remove-status add-field remove-field list-fields show-field apply-preset)' \\
            '--description[Human description for the custom item type, status, or field]:text' \\
            '--default-status[Default status hint for the custom item type]:status' \\
            '--folder[Storage folder for items of this custom type]:dir' \\
            '--alias[Alias for the custom type, status, or field flag (repeatable)]:name' \\
            '--role[Lifecycle role for a custom status (repeatable)]:role' \\
            '--order[Display/sort order for a custom status]:n' \\
            '--type[Value type for a custom field]:type:(string number boolean string_array)' \\
            '--commands[Commands a custom field is wired onto (repeatable)]:commands' \\
            '--cli-flag[Override the auto-derived CLI flag for a custom field]:flag' \\
            '--required[Mark a custom field as always required]' \\
            '--required-on-create[Mark a custom field as required at create time]' \\
            '--no-allow-unset[Disallow clearing a custom field via --unset]' \\
            '--required-types[Restrict a custom field requirement to specific item types (repeatable)]:types' \\
            '--infer[Infer item types from title-prefix conventions (add-type)]' \\
            '--min-count[Minimum items sharing a prefix for --infer]:n' \\
            '--apply[Register inferred types (with --infer)]' \\
            '--author[Mutation author]:author' \\
            '--force[Force ownership/lock override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        plan)
          _arguments \\
            '1:subcommand:(create show add-step update-step complete-step block-step reorder-step remove-step link unlink decision discovery validation resume approve materialize)' \\
            '--title[Plan title]:title' \\
            '--scope[Plan scope statement]:scope' \\
            '--harness[Plan harness provenance]:harness:(codex claude-code cursor generic)' \\
            '--mode[Plan mode]:mode:(draft research review approved executing paused completed superseded)' \\
            '--resume-context[Resume context summary]:text' \\
            '--step-title[Step title]:title' \\
            '*--step[Step title (repeatable on create)]:title' \\
            '--step-status[Step status]:status:(pending in_progress completed blocked skipped superseded)' \\
            '--step-evidence[Step evidence]:text' \\
            '--depends-on[Pm item id step depends on]:id' \\
            '--link[Pm item id to link]:id' \\
            '--link-kind[Link kind]:kind:(related blocks blocked_by depends_on discovered_from implements verifies supersedes)' \\
            '--depth[Show depth]:depth:(brief standard deep)' \\
            '--steps[Step ids/orders for materialize]:steps' \\
            '--materialize-type[Item type for materialized steps]:type' \\
            '--allow-multiple-active[Allow multiple in_progress steps]' \\
            '--promote-to-item-dep[Also add link as top-level item dependency]' \\
            '--author[Mutation author]:author' \\
            '--message[Mutation message]:message' \\
            '--force[Force ownership override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        activity)
          _arguments \\
            '--id[Filter by item ID]:id' \\
            '--op[Filter by history operation]:op' \\
            '--author[Filter by history author]:author' \\
            '--from[Lower timestamp bound (ISO/date string or relative)]:date' \\
            '--to[Upper timestamp bound (ISO/date string or relative)]:date' \\
            '--limit[Max entries]:number' \\
            '--compact[Condensed activity projection]' \\
            '--full[Show full activity entries]' \\
            '--stream[Emit line-delimited JSON rows]:mode' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        contracts)
          _arguments \\
            '--action[Filter schema by tool action]:action' \\
            '--command[Scope output to one command (narrow-by-default)]:command' \\
            '--schema-only[Return schema-only payload]' \\
            '--flags-only[Return command flag contracts only]' \\
            '--availability-only[Return action availability only]' \\
            '--runtime-only[Include only actions invocable in the current runtime]' \\
            '--active-only[Alias for --runtime-only]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        gc)
          _arguments \\
            '--dry-run[Preview cleanup targets without deleting files]' \\
            '--scope[Limit cleanup to one or more scopes: index, embeddings, runtime, locks]:scope' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        stats)
          _arguments \\
            '--storage[Include aggregate history-stream storage metrics]' \\
            '--metadata-coverage[Include metadata coverage percentages overall and by type]' \\
            '--field-utilization[Include content-field utilization rates across all items]' \\
            '--by-assignee[Lifecycle-bucketed breakdown grouped by assignee]' \\
            '--by-tag[Lifecycle-bucketed breakdown grouped by tag]' \\
            '--by-priority[Lifecycle-bucketed breakdown grouped by priority]' \\
            '--tag-prefix[With --by-tag: only count tags with this prefix]:prefix' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        comments)
          _arguments \\
            '--add[Add one entry (plain text, text=<value>, markdown pairs, or - for stdin)]:text' \\
            '--stdin[Read comment text from stdin (supports multiline markdown)]' \\
            '--file[Read comment text from file (supports multiline markdown)]:path' \\
            '--edit[Replace the comment at 1-based index (text from positional/--add/--stdin/--file)]:index' \\
            '--delete[Delete the comment at 1-based index]:index' \\
            '--limit[Return only latest n entries]:number' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--allow-audit-comment[Allow non-owner append-only comment audits without requiring --force]' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        notes)
          _arguments \\
            '--add[Add one entry (plain text, text=<value>, markdown pairs, or - for stdin)]:text' \\
            '--limit[Return only latest n entries]:number' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--allow-audit-note[Allow non-owner append-only note audits without requiring --force]' \\
            '--allow-audit-comment[Backward-compatible alias for --allow-audit-note]' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        learnings)
          _arguments \\
            '--add[Add one entry (plain text, text=<value>, markdown pairs, or - for stdin)]:text' \\
            '--limit[Return only latest n entries]:number' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--allow-audit-learning[Allow non-owner append-only learning audits without requiring --force]' \\
            '--allow-audit-comment[Backward-compatible alias for --allow-audit-learning]' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        deps)
          _arguments \\
            '--format[Output format]:(tree graph)' \\
            '--max-depth[Maximum traversal depth (0 keeps root only)]:depth' \\
            '--collapse[Collapse mode]:(none repeated)' \\
            '--summary[Return counts only without tree/graph payload]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        test)
          _arguments \\
            '--add[Add linked test entry]:entry' \\
            '--add-json[Add linked test entry from JSON object/array]:json' \\
            '--remove[Remove linked test entry by command/path]:entry' \\
            '--list[List linked tests without mutating]' \\
            '--run[Run linked tests]' \\
            '--match[Run linked tests whose command/path contains substring]:substring' \\
            '--only-index[Run one linked test by 1-based index]:number' \\
            '--only-last[Run the most recently added linked test]' \\
            '--background[Run linked tests in managed background mode]' \\
            '--timeout[Default timeout seconds]:seconds' \\
            '--progress[Emit linked-test progress to stderr]' \\
            '--env-set[Set linked-test runtime environment values]:entry' \\
            '--env-clear[Clear linked-test runtime environment values]:name' \\
            '--shared-host-safe[Apply shared-host-safe runtime defaults]' \\
            '--pm-context[PM linked-test context mode]:(schema tracker auto)' \\
            '--override-linked-pm-context[Force run-level --pm-context over per-linked-test pm_context_mode metadata]' \\
            '--fail-on-context-mismatch[Fail when context item counts mismatch]' \\
            '--fail-on-skipped[Treat skipped linked tests as dependency failures]' \\
            '--fail-on-empty-test-run[Treat empty linked-test selections as failures]' \\
            '--require-assertions-for-pm[Require assertions for linked PM command tests]' \\
            '--check-context[Preflight linked PM command context diagnostics before execution]' \\
            '--auto-pm-context[Auto-remediate tracker-read context mismatches using tracker context]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        test-all)
          _arguments \\
            '--status[Filter by status]:(open in_progress)' \\
            '--limit[Limit matching items before running linked tests]:number' \\
            '--offset[Skip matching items before running linked tests]:number' \\
            '--background[Run linked tests in managed background mode]' \\
            '--timeout[Default timeout seconds]:seconds' \\
            '--progress[Emit linked-test progress to stderr]' \\
            '--env-set[Set linked-test runtime environment values]:entry' \\
            '--env-clear[Clear linked-test runtime environment values]:name' \\
            '--shared-host-safe[Apply shared-host-safe runtime defaults]' \\
            '--pm-context[PM linked-test context mode]:(schema tracker auto)' \\
            '--override-linked-pm-context[Force run-level --pm-context over per-linked-test pm_context_mode metadata]' \\
            '--fail-on-context-mismatch[Fail when context item counts mismatch]' \\
            '--fail-on-skipped[Treat skipped linked tests as dependency failures]' \\
            '--fail-on-empty-test-run[Treat empty linked-test selections as failures]' \\
            '--require-assertions-for-pm[Require assertions for linked PM command tests]' \\
            '--check-context[Preflight linked PM command context diagnostics before execution]' \\
            '--auto-pm-context[Auto-remediate tracker-read context mismatches using tracker context]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        test-runs)
          _arguments \\
            '1:subcommand:(list status logs stop resume)' \\
            '--status[Filter by background run status]:status:(queued running passed failed stopped canceled)' \\
            '--limit[Limit returned runs]:number' \\
            '--stream[Background log stream]:stream:(stdout stderr both)' \\
            '--tail[Tail number of lines]:number' \\
            '--force[Force stop with SIGKILL]' \\
            '--author[Resume author]:author' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        init)
          _arguments \\
            '--preset[Governance preset for new setups]:preset:(minimal default strict)' \\
            '--defaults[Use non-interactive setup defaults]' \\
            '-y[Alias for --defaults]' \\
            '--yes[Alias for --defaults]' \\
            '--author[Set the default mutation author for this project]:author' \\
            '--agent-guidance[Agent guidance mode]:mode:(ask add skip status)' \\
            '--type-preset[Register domain item types]:type-preset:(agile ops research)' \\
            '--with-packages[Install bundled first-party packages during initialization]' \\
            '--verbose[Include the full resolved settings tree in init output]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        init)
          _arguments \\
            '--preset[Governance preset for new setups]:preset:(minimal default strict)' \\
            '--defaults[Use non-interactive setup defaults]' \\
            '-y[Alias for --defaults]' \\
            '--yes[Alias for --defaults]' \\
            '--author[Set the default mutation author for this project]:author' \\
            '--agent-guidance[Agent guidance mode]:mode:(ask add skip status)' \\
            '--type-preset[Register domain item types]:type-preset:(agile ops research)' \\
            '--with-packages[Install bundled first-party packages during initialization]' \\
            '--verbose[Include the full resolved settings tree in init output]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        config)
          _arguments \\
            '--criterion[Criteria value for definition-of-done metadata-required-fields or lifecycle pattern keys (repeatable for set)]:criterion' \\
            '--clear-criteria[Clear config criteria-list key values]' \\
            '--format[Item format for item-format key]:format:(toon)' \\
            '--policy[Policy value for supported policy keys]:policy' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        close)
          _arguments \\
            '--reason[Closure reason]:reason' \\
            '--close-reason[Alias for --reason]:close_reason' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--validate-close[Validate closure metadata mode]:(off warn strict)' \\
            '--resolution[Closure resolution summary]:resolution' \\
            '--expected-result[Expected behavior note]:expected_result' \\
            '--actual-result[Observed behavior note]:actual_result' \\
            '--expected[Short alias for --expected-result]:expected_result' \\
            '--actual[Short alias for --actual-result]:actual_result' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        claim)
          _arguments \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        release)
          _arguments \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--allow-audit-release[Allow non-owner release handoffs without requiring --force]' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        delete)
          _arguments \\
            '--dry-run[Preview the item file that would be deleted without mutating]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        start-task|pause-task)
          _arguments \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        close-task)
          _arguments \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--validate-close[Validate closure metadata mode]:(off warn strict)' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        validate)
          _arguments \\
            '--check-metadata[Run metadata completeness checks]' \\
            '--metadata-profile[Select metadata validation profile for --check-metadata]:(core strict custom)' \\
            '--check-resolution[Run closed-item resolution metadata checks]' \\
            '--check-lifecycle[Run active-item lifecycle governance drift checks]' \\
            '--check-stale-blockers[Include stale blocker-pattern diagnostics in lifecycle checks]' \\
            '--dependency-cycle-severity[Set dependency-cycle warning policy for lifecycle checks]:(off warn error)' \\
            '--parent-cycle-severity[Set parent-hierarchy cycle warning policy for lifecycle checks]:(off warn error)' \\
            '--check-files[Run linked-file and orphaned-file checks]' \\
            '--scan-mode[Select file candidate scan mode for --check-files]:(default tracked-all tracked-all-strict)' \\
            '--include-pm-internals[Include PM storage internals in tracked-all candidate scans]' \\
            '--verbose-file-lists[Include full file-path lists for validate --check-files details]' \\
            '--verbose-diagnostics[Include full validate diagnostic ID lists instead of compact summaries]' \\
            '--all-affected-ids[Emit complete missing_* affected-ID lists with no truncation (implied by --json)]' \\
            '--strict-exit[Return non-zero exit when validation warnings are present]' \\
            '--fail-on-warn[Alias for --strict-exit]' \\
            '--fix-hints[Add a machine-executable fix_hints[] of pm commands to each failing check]' \\
            '--auto-fix[Apply the safe, deterministic subset of fix-hint remediations automatically]' \\
            '--dry-run[Preview planned --auto-fix/--prune-missing fixes without applying them]' \\
            '--fix-scope[Grant --auto-fix scopes (estimates/lifecycle must be named explicitly)]:(metadata resolution estimates lifecycle)' \\
            '--prune-missing[Remove stale linked-file/doc links classified as deleted]' \\
            '--check-history-drift[Run item/history hash drift checks]' \\
            '--check-command-references[Run linked-command PM-ID reference checks]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        health)
          _arguments \\
            '--strict-directories[Treat optional item-type directories as required failures]' \\
            '--check-only[Run read-only health diagnostics without refreshing vectors]' \\
            '--no-refresh[Disable automatic vector refresh attempts during health checks]' \\
            '--refresh-vectors[Explicitly enable vector refresh attempts during health checks]' \\
            '--verbose-stale-items[Include full stale vectorization ID lists in health output]' \\
            '--brief[Emit compact health details for low-token agent checks]' \\
            '--summary[Emit one-line-style health status with check names and warning count]' \\
            '--strict-exit[Return non-zero exit when health warnings are present]' \\
            '--fail-on-warn[Alias for --strict-exit]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        comments-audit)
          _arguments \\
            '--status[Filter by item status]:status:(${statusChoices})' \\
            '--type[Filter by item type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--parent[Filter by parent item ID]:parent_id' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--limit-items[Limit returned item count]:number' \\
            '--limit[Alias for --limit-items]:number' \\
            '--full-history[Export full comment history rows (cannot be combined with --latest)]' \\
            '--latest[Return latest n comments per item (0 for summary-only rows)]:number' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        extension)
          _arguments \\
            '1:extension_action:(init scaffold install uninstall explore manage reload doctor adopt adopt-all activate deactivate)' \\
            '--init[Generate a starter extension scaffold at target path]' \\
            '--scaffold[Alias for --init]' \\
            '--install[Install extension from local path or GitHub source]' \\
            '--uninstall[Uninstall extension by name]' \\
            '--explore[List discovered extensions for selected scope]' \\
            '--manage[List managed extensions with update metadata]' \\
            '--reload[Reload extensions with cache-busted module imports]' \\
            '--watch[Enable watch mode with --reload]' \\
            '--doctor[Run consolidated extension diagnostics (summary/deep)]' \\
            '--adopt[Adopt an unmanaged extension into managed metadata]' \\
            '--adopt-all[Adopt all unmanaged extensions into managed metadata]' \\
            '--activate[Activate extension in selected scope settings]' \\
            '--deactivate[Deactivate extension in selected scope settings]' \\
            '--project[Use project extension scope (default)]' \\
            '--local[Alias for --project]' \\
            '--global[Use global extension scope]' \\
            '--gh[Install from GitHub shorthand owner/repo/path]:github_spec' \\
            '--github[Alias for --gh]:github_spec' \\
            '--ref[Git ref/branch/tag for GitHub source]:git_ref' \\
            '--detail[Detail mode for extension diagnostics]:detail_mode:(summary deep)' \\
            '--trace[Include registration traces in doctor deep diagnostics]' \\
            '--runtime-probe[Opt-in runtime activation probe for manage output]' \\
            '--fix-managed-state[Adopt unmanaged extensions before diagnostics/update checks]' \\
            '--strict-exit[Return non-zero exit when doctor warnings are present]' \\
            '--fail-on-warn[Alias for --strict-exit (doctor)]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]' \\
            '*:target_or_name:_files -/'
          ;;
        completion)
          _arguments \\
            '--eager-tags[Embed current tracker tags directly in script output]' \\
            '1:shell:(bash zsh fish)'
          ;;
        templates)
          local -a templates_cmds
          templates_cmds=('save:Save or update a create template' 'list:List saved create templates' 'show:Show saved template details')
          _describe 'templates command' templates_cmds
          ;;
      esac
      ;;
  esac
}

compdef _pm pm`;
}

/**
 * Implements generate fish script for the public runtime surface of this module.
 */
export function generateFishScript(
  itemTypes: string[] = [],
  tags: string[] = [],
  eagerTagExpansion = false,
  runtime: CompletionRuntimeConfig = {},
): string {
  const listCommandNames = ALL_COMMANDS.filter((command) => command === "list" || command.startsWith("list-"));
  const listCmds = listCommandNames.join(" ");
  const noSubcommandList = ALL_COMMANDS.join(" ");
  const useDynamicTypeExpansion = itemTypes.length === 0;
  const typeFallbackChoices = completionTypeValues(itemTypes, runtime);
  const statusFallbackChoices = completionStatusValues(runtime);
  const typeChoices = useDynamicTypeExpansion ? "(__pm_type_choices)" : typeFallbackChoices;
  const statusChoices = "(__pm_status_choices)";
  const guideTopicChoices = GUIDE_TOPIC_CHOICES;
  const tagChoices = joinCompletionValues(tags);
  const useEagerTagExpansion = eagerTagExpansion || tags.length > 0;
  const fishTagChoices = useEagerTagExpansion ? `'${tagChoices}'` : "'(__pm_tag_choices)'";
  const fishListRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(listCommandNames, runtime.command_flags?.list);
  const fishCreateRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(["create"], runtime.command_flags?.create);
  const fishUpdateRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(["update"], runtime.command_flags?.update);
  const fishUpdateManyRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(["update-many"], runtime.command_flags?.["update-many"]);
  const fishSearchRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(["search"], runtime.command_flags?.search);
  const fishCalendarRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(["calendar", "cal"], runtime.command_flags?.calendar);
  const fishContextRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(["context", "ctx"], runtime.command_flags?.context);
  const dynamicTagResolver = useEagerTagExpansion
    ? ""
    : `
function __pm_tag_choices
  set -l now (date +%s ^/dev/null)
  if test -z "$now"
    set now 0
  end
  set -l ttl 120
  if set -q PM_COMPLETION_TAG_TTL
    set ttl $PM_COMPLETION_TAG_TTL
  end
  if set -q PM_COMPLETION_TAG_CACHE; and set -q PM_COMPLETION_TAG_CACHE_TS
    set -l age (math "$now - $PM_COMPLETION_TAG_CACHE_TS")
    if test $age -lt $ttl
      printf '%s\n' $PM_COMPLETION_TAG_CACHE
      return
    end
  end
  set -l resolved (pm completion-tags ^/dev/null)
  set -gx PM_COMPLETION_TAG_CACHE $resolved
  set -gx PM_COMPLETION_TAG_CACHE_TS $now
  printf '%s\n' $resolved
end
`;
  return `# Fish shell completion for pm
# Save to ~/.config/fish/completions/pm.fish
# or run: pm completion fish > ~/.config/fish/completions/pm.fish

# Disable file completion by default
complete -c pm -f

# Global flags (available for all subcommands)
complete -c pm -l json -d 'Output JSON instead of TOON'
complete -c pm -l quiet -d 'Suppress stdout output'
complete -c pm -l no-changed-fields -d 'Omit changed_fields array from mutation output'
complete -c pm -l id-only -d 'Print only id and status for single-item mutation output'
complete -c pm -l pm-path -d 'Explicit tracker storage path for this command' -r
complete -c pm -l path -d 'Override PM path for this command' -r
complete -c pm -l no-extensions -d 'Disable extension loading'
complete -c pm -l profile -d 'Print deterministic timing diagnostics'
complete -c pm -s V -l version -d 'Output the version number'
complete -c pm -s h -l help -d 'Display help'

# Helper: true when no subcommand has been given yet
function __pm_no_subcommand
  not __fish_seen_subcommand_from ${noSubcommandList}
end
${dynamicTagResolver}
${useDynamicTypeExpansion ? renderFishDynamicChoiceResolver("type", "completion-types", typeFallbackChoices) : ""}
${renderFishDynamicChoiceResolver("status", "completion-statuses", statusFallbackChoices)}

# Subcommands
complete -c pm -n __pm_no_subcommand -a init          -d 'Initialize pm storage for the current workspace'
complete -c pm -n __pm_no_subcommand -a config        -d 'Read or update pm settings'
complete -c pm -n __pm_no_subcommand -a extension     -d 'Manage extension lifecycle operations'
complete -c pm -n __pm_no_subcommand -a create        -d 'Create a new project management item'
complete -c pm -n __pm_no_subcommand -a copy          -d 'Copy an existing item to a new ID'
complete -c pm -n __pm_no_subcommand -a focus         -d 'Set/clear/show the session focused parent for new items'
complete -c pm -n __pm_no_subcommand -a list          -d 'List active items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-all      -d 'List all items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-draft    -d 'List draft items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-open     -d 'List open items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-in-progress -d 'List in-progress items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-blocked  -d 'List blocked items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-closed   -d 'List closed items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-canceled -d 'List canceled items with optional filters'
complete -c pm -n __pm_no_subcommand -a aggregate     -d 'Aggregate grouped item counts and numeric stats for governance queries'
complete -c pm -n __pm_no_subcommand -a dedupe-audit  -d 'Audit potential duplicate items and emit merge suggestions'
complete -c pm -n __pm_no_subcommand -a guide         -d 'Browse local progressive-disclosure guides'
complete -c pm -n __pm_no_subcommand -a calendar      -d 'Show deadline/reminder calendar views'
complete -c pm -n __pm_no_subcommand -a cal           -d 'Alias for calendar'
complete -c pm -n __pm_no_subcommand -a context       -d 'Show a token-efficient project context snapshot'
complete -c pm -n __pm_no_subcommand -a ctx           -d 'Alias for context'
complete -c pm -n __pm_no_subcommand -a get           -d 'Show item details by ID'
complete -c pm -n __pm_no_subcommand -a search        -d 'Search items with keyword, semantic, or hybrid modes'
complete -c pm -n __pm_no_subcommand -a reindex       -d 'Rebuild search artifacts'
complete -c pm -n __pm_no_subcommand -a history       -d 'Show item history entries'
complete -c pm -n __pm_no_subcommand -a history-compact -d 'Compact history streams into a synthetic baseline + retained tail'
complete -c pm -n __pm_no_subcommand -a history-redact -d 'Redact sensitive literals/patterns and recompute history hashes'
complete -c pm -n __pm_no_subcommand -a history-repair -d 'Re-anchor a drifted history chain so pm health/validate report ok'
complete -c pm -n __pm_no_subcommand -a schema        -d 'Inspect and manage runtime schema'
complete -c pm -n __pm_no_subcommand -a plan          -d 'Agent-optimized Plan workflow (create/show/add-step/update-step/complete-step/link/approve/materialize)'
complete -c pm -n __pm_no_subcommand -a activity      -d 'Show recent activity across items'
complete -c pm -n __pm_no_subcommand -a restore       -d 'Restore an item to an earlier state'
complete -c pm -n __pm_no_subcommand -a update        -d 'Update item fields and metadata'
complete -c pm -n __pm_no_subcommand -a update-many   -d 'Bulk-update matched items with dry-run and rollback checkpoints'
complete -c pm -n __pm_no_subcommand -a normalize     -d 'Normalize lifecycle metadata with dry-run planning or apply mode'
complete -c pm -n __pm_no_subcommand -a close         -d 'Close an item (reason requirement follows governance settings)'
complete -c pm -n __pm_no_subcommand -a close-many    -d 'Bulk-close matched items with an optional shared reason and rollback checkpoint'
complete -c pm -n __pm_no_subcommand -a delete        -d 'Delete an item and record the change'
complete -c pm -n __pm_no_subcommand -a append        -d 'Append text to an item body'
complete -c pm -n __pm_no_subcommand -a comments      -d 'List or add comments for an item'
complete -c pm -n __pm_no_subcommand -a comments-audit -d 'Audit latest comments or full history across filtered items'
complete -c pm -n __pm_no_subcommand -a notes         -d 'List or add notes for an item'
complete -c pm -n __pm_no_subcommand -a learnings     -d 'List or add learnings for an item'
complete -c pm -n __pm_no_subcommand -a files         -d 'Manage linked files'
complete -c pm -n __pm_no_subcommand -a docs          -d 'Manage linked docs'
complete -c pm -n __pm_no_subcommand -a deps          -d 'Show dependency relationships for an item'
complete -c pm -n __pm_no_subcommand -a test          -d 'Manage linked tests and optionally run them'
complete -c pm -n __pm_no_subcommand -a test-all      -d 'Run linked tests across matching items'
complete -c pm -n __pm_no_subcommand -a test-runs     -d 'Manage background linked-test runs'
complete -c pm -n __pm_no_subcommand -a stats         -d 'Show project tracker statistics'
complete -c pm -n __pm_no_subcommand -a health        -d 'Show project tracker health checks'
complete -c pm -n __pm_no_subcommand -a validate      -d 'Run standalone validation checks'
complete -c pm -n __pm_no_subcommand -a gc            -d 'Clean optional cache artifacts'
complete -c pm -n __pm_no_subcommand -a contracts     -d 'Show machine-readable command and schema contracts'
complete -c pm -n __pm_no_subcommand -a claim         -d 'Claim an item for active work'
complete -c pm -n __pm_no_subcommand -a release       -d 'Release the active claim for an item'
complete -c pm -n __pm_no_subcommand -a start-task    -d 'Lifecycle alias to claim and set in-progress'
complete -c pm -n __pm_no_subcommand -a pause-task    -d 'Lifecycle alias to reopen and release claim'
complete -c pm -n __pm_no_subcommand -a close-task    -d 'Lifecycle alias to close and release claim'
complete -c pm -n __pm_no_subcommand -a meet          -d 'Shortcut to create a Meeting with scheduling defaults'
complete -c pm -n __pm_no_subcommand -a event         -d 'Shortcut to create an Event with scheduling defaults'
complete -c pm -n __pm_no_subcommand -a remind        -d 'Shortcut to create a Reminder from a point in time'
complete -c pm -n __pm_no_subcommand -a templates     -d 'Manage reusable create templates'
complete -c pm -n __pm_no_subcommand -a completion    -d 'Generate shell completion'

# list* flags
for list_cmd in ${listCmds}
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l type     -d 'Filter by item type' -r -a '${typeChoices}'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l tag      -d 'Filter by tag' -r -a ${fishTagChoices}
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l tags     -d 'Alias for --tag' -r -a ${fishTagChoices}
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l priority -d 'Filter by priority' -r -a '0 1 2 3 4'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l assignee -d 'Filter by assignee' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l sprint   -d 'Filter by sprint' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l release  -d 'Filter by release' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l limit    -d 'Limit returned item count' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l offset   -d 'Skip the first n matching rows before limit' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-truncate -d 'Return every matched row, overriding --limit'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l all -d 'Alias for --no-truncate'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l include-body -d 'Include item body in each returned list row'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l compact -d 'Render compact list projection fields'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l fields -d 'Render custom comma-separated list fields' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l tree -d 'Render hierarchical subtree output rooted at --parent or top-level parents'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l tree-depth -d 'Cap recursion depth for --tree (0 = root only)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l sort -d 'Sort field' -r -a 'priority deadline updated_at created_at title parent'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l order -d 'Sort order (requires --sort)' -r -a 'asc desc'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l stream -d 'Emit line-delimited JSON rows (requires --json)'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l deadline-before -d 'Filter by deadline upper bound (ISO/date string or relative)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l deadline-after  -d 'Filter by deadline lower bound (ISO/date string or relative)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l updated-after  -d 'Filter by updated_at lower bound (ISO/relative)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l updated-before -d 'Filter by updated_at upper bound (ISO/relative)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l created-after  -d 'Filter by created_at lower bound (ISO/relative)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l created-before -d 'Filter by created_at upper bound (ISO/relative)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l filter-reviewer-missing   -d 'Select only items missing reviewer'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l filter-risk-missing       -d 'Select only items missing risk'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l filter-confidence-missing -d 'Select only items missing confidence'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l filter-sprint-missing     -d 'Select only items missing sprint'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l filter-release-missing    -d 'Select only items missing release'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-notes            -d 'Select only items that have notes'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-notes             -d 'Select only items with no notes'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-learnings        -d 'Select only items that have learnings'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-learnings         -d 'Select only items with no learnings'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-files            -d 'Select only items that have linked files'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-files             -d 'Select only items with no linked files'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-docs             -d 'Select only items that have linked docs'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-docs              -d 'Select only items with no linked docs'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-tests            -d 'Select only items that have linked tests'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-tests             -d 'Select only items with no linked tests'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-comments         -d 'Select only items that have comments'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-comments          -d 'Select only items with no comments'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-deps             -d 'Select only items that have dependencies'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-deps              -d 'Select only items with no dependencies'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-body             -d 'Select only items with non-empty body'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l empty-body           -d 'Select only items with empty body'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-linked-command   -d 'Select only items that have a linked command'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-linked-command    -d 'Select only items with no linked command'
end
${fishListRuntimeFieldFlags}

# aggregate flags
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l group-by -d 'Comma-separated group-by fields (supported: parent,type,priority,status,assignee,tags,sprint,release)' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l count -d 'Return grouped counts'
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l completion -d 'Add completion counts and percentage per group'
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l sum -d 'Numeric field to sum per group' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l avg -d 'Numeric field to average per group' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l include-unparented -d 'Include unparented rows when grouping by parent'
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l status -d 'Filter by status' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l type -d 'Filter by item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l tag -d 'Filter by tag' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l priority -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l deadline-before -d 'Filter by deadline upper bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l deadline-after -d 'Filter by deadline lower bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l assignee -d 'Filter by assignee' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l parent -d 'Filter by parent item ID' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l sprint -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from aggregate' -l release -d 'Filter by release' -r

# dedupe-audit flags
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l mode -d 'Dedupe mode' -r -a 'title_exact title_fuzzy parent_scope'
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l limit -d 'Limit returned duplicate clusters' -r
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l threshold -d 'Fuzzy mode token similarity threshold between 0 and 1' -r
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l status -d 'Filter by status' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l type -d 'Filter by item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l tag -d 'Filter by tag' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l priority -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l deadline-before -d 'Filter by deadline upper bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l deadline-after -d 'Filter by deadline lower bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l assignee -d 'Filter by assignee' -r
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l parent -d 'Filter by parent item ID' -r
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l sprint -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from dedupe-audit' -l release -d 'Filter by release' -r

# create flags
complete -c pm -n '__fish_seen_subcommand_from create' -s t -l title              -d 'Item title' -r
complete -c pm -n '__fish_seen_subcommand_from create' -s d -l description        -d 'Item description' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l type                    -d 'Item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from create' -l create-mode             -d 'Create required-option policy mode' -r -a 'strict progressive'
complete -c pm -n '__fish_seen_subcommand_from create' -l schedule-preset         -d 'Scheduling preset for Reminder/Meeting/Event' -r -a 'lightweight'
complete -c pm -n '__fish_seen_subcommand_from create' -s s -l status             -d 'Item status' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from create' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from create' -l tags                    -d 'Comma-separated tags' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l add-tags                -d 'Add tags additively without replacing existing' -r
complete -c pm -n '__fish_seen_subcommand_from create' -s b -l body               -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l body-file               -d 'Load the item body from a file' -r -F
complete -c pm -n '__fish_seen_subcommand_from create' -l deadline                -d 'Deadline (ISO/date string or relative +6h/+1d/+2w/+6m)' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l estimate                -d 'Estimated minutes' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l acceptance-criteria     -d 'Acceptance criteria' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l reminder                -d 'Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l event                   -d 'Event entry start=<iso|relative>,end=<iso|relative>,recur_*' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l type-option             -d 'Type option key=value or key=<name>,value=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l assignee                -d 'Assignee' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l unset                   -d 'Clear scalar metadata field by name' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-deps              -d 'Clear dependency entries'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-comments          -d 'Clear comments'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-notes             -d 'Clear notes'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-learnings         -d 'Clear learnings'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-files             -d 'Clear linked files'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-tests             -d 'Clear linked tests'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-docs              -d 'Clear linked docs'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-reminders         -d 'Clear reminders'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-events            -d 'Clear events'
complete -c pm -n '__fish_seen_subcommand_from create' -l clear-type-options      -d 'Clear type options'
${fishCreateRuntimeFieldFlags}

# copy flags
complete -c pm -n '__fish_seen_subcommand_from copy' -l title   -d 'Override copied title' -r
complete -c pm -n '__fish_seen_subcommand_from copy' -l author  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from copy' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from copy' -l force   -d 'Force ownership override'

# focus flags
complete -c pm -n '__fish_seen_subcommand_from focus' -l clear -d 'Clear the focused item'

# update flags
complete -c pm -n '__fish_seen_subcommand_from update' -s t -l title              -d 'Item title' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s d -l description        -d 'Item description' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s b -l body               -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l body-file               -d 'Load the item body from a file' -r -F
complete -c pm -n '__fish_seen_subcommand_from update' -s s -l status             -d 'Item status' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from update' -l close-reason            -d 'Set close reason' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from update' -l type                    -d 'Item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from update' -l add-tags                -d 'Add tags additively without replacing existing' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l remove-tags             -d 'Remove tags from the existing list' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l expected                -d 'Short alias for --expected-result' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l actual                  -d 'Short alias for --actual-result' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l comment                 -d 'Comment seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l note                    -d 'Note seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l learning                -d 'Learning seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l file                    -d 'Linked file path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l test                    -d 'Linked test command=<value>,path=<value>,scope=<project|global>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l doc                     -d 'Linked doc path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l reminder                -d 'Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l event                   -d 'Event entry start=<iso|relative>,end=<iso|relative>,recur_*' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l type-option             -d 'Type option key=value or key=<name>,value=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l unset                   -d 'Clear scalar metadata field by name' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l replace-deps            -d 'Atomically replace dependencies with provided --dep values'
complete -c pm -n '__fish_seen_subcommand_from update' -l replace-tests           -d 'Atomically replace linked tests with provided --test values'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-deps              -d 'Clear dependency entries'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-comments          -d 'Clear comments'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-notes             -d 'Clear notes'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-learnings         -d 'Clear learnings'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-files             -d 'Clear linked files'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-tests             -d 'Clear linked tests'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-docs              -d 'Clear linked docs'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-reminders         -d 'Clear reminders'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-events            -d 'Clear events'
complete -c pm -n '__fish_seen_subcommand_from update' -l clear-type-options      -d 'Clear type options'
complete -c pm -n '__fish_seen_subcommand_from update' -l allow-audit-update      -d 'Allow non-owner metadata-only audit updates without requiring --force'
complete -c pm -n '__fish_seen_subcommand_from update' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l force                   -d 'Force override'
${fishUpdateRuntimeFieldFlags}

# update-many flags
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-status           -d 'Filter by status before applying updates' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-type             -d 'Filter by type before applying updates' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-tag              -d 'Filter by tag before applying updates' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-priority         -d 'Filter by priority before applying updates' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-deadline-before  -d 'Filter by deadline upper bound' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-deadline-after   -d 'Filter by deadline lower bound' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-updated-after    -d 'Filter by updated_at lower bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-updated-before   -d 'Filter by updated_at upper bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-created-after    -d 'Filter by created_at lower bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-created-before   -d 'Filter by created_at upper bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-assignee         -d 'Filter by assignee before applying updates' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-assignee-filter  -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-parent           -d 'Filter by parent item ID' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-sprint           -d 'Filter by sprint before applying updates' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-release          -d 'Filter by release before applying updates' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-ac-missing       -d 'Select only items missing acceptance_criteria'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-estimates-missing -d 'Select only items missing estimated_minutes'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-resolution-missing -d 'Select only terminal items missing resolution'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-metadata-missing  -d 'Select only items missing any tracked metadata'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-reviewer-missing   -d 'Select only items missing reviewer'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-risk-missing       -d 'Select only items missing risk'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-confidence-missing -d 'Select only items missing confidence'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-sprint-missing     -d 'Select only items missing sprint'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-release-missing    -d 'Select only items missing release'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-notes          -d 'Select only items that have notes'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-notes           -d 'Select only items with no notes'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-learnings      -d 'Select only items that have learnings'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-learnings       -d 'Select only items with no learnings'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-files          -d 'Select only items that have linked files'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-files           -d 'Select only items with no linked files'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-docs           -d 'Select only items that have linked docs'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-docs            -d 'Select only items with no linked docs'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-tests          -d 'Select only items that have linked tests'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-tests           -d 'Select only items with no linked tests'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-comments       -d 'Select only items that have comments'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-comments        -d 'Select only items with no comments'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-deps           -d 'Select only items that have dependencies'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-deps            -d 'Select only items with no dependencies'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-body           -d 'Select only items with non-empty body'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-empty-body         -d 'Select only items with empty body'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-has-linked-command -d 'Select only items that have a linked command'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l filter-no-linked-command  -d 'Select only items with no linked command'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l ids                     -d 'Explicit comma-separated ID allowlist' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l limit                   -d 'Limit matched item count' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l offset                  -d 'Skip first n matched rows' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l dry-run                 -d 'Preview updates without mutating'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l rollback                -d 'Rollback checkpoint ID' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l no-checkpoint           -d 'Disable checkpoint creation during apply mode'
complete -c pm -n '__fish_seen_subcommand_from update-many' -s t -l title              -d 'Item title' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -s d -l description        -d 'Item description' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -s b -l body               -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l type                    -d 'Item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l tags                    -d 'Comma-separated tags' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l add-tags                -d 'Add tags additively without replacing existing' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l remove-tags             -d 'Remove tags from the existing list' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l deadline                -d 'Deadline (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l estimate                -d 'Estimated minutes' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l acceptance-criteria     -d 'Acceptance criteria' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l definition-of-ready     -d 'Definition of ready' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l order                   -d 'Planning order/rank' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l goal                    -d 'Goal identifier' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l objective               -d 'Objective identifier' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l value                   -d 'Business value summary' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l impact                  -d 'Business impact summary' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l outcome                 -d 'Expected outcome summary' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l why-now                 -d 'Why-now rationale' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l reviewer                -d 'Reviewer' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l risk                    -d 'Risk level' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l confidence              -d 'Confidence level' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l sprint                  -d 'Sprint identifier' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l release                 -d 'Release identifier' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l reporter                -d 'Issue reporter' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l severity                -d 'Issue severity' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l environment             -d 'Issue environment context' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l repro-steps             -d 'Issue reproduction steps' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l resolution              -d 'Issue resolution summary' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l expected-result         -d 'Issue expected behavior' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l actual-result           -d 'Issue observed behavior' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l expected                 -d 'Short alias for --expected-result' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l actual                   -d 'Short alias for --actual-result' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l affected-version        -d 'Affected version identifier' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l fixed-version           -d 'Fixed version identifier' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l component               -d 'Issue component ownership' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l regression              -d 'Regression marker true|false|1|0' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l customer-impact         -d 'Customer impact summary' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l dep                     -d 'Dependency seed id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l dep-remove              -d 'Dependency removal selector id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l replace-deps            -d 'Atomically replace dependencies with provided --dep values'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l replace-tests           -d 'Atomically replace linked tests with provided --test values'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l comment                 -d 'Comment seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l note                    -d 'Note seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l learning                -d 'Learning seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l file                    -d 'Linked file path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l test                    -d 'Linked test command=<value>,path=<value>,scope=<project|global>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l doc                     -d 'Linked doc path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l reminder                -d 'Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l event                   -d 'Event entry start=<iso|relative>,end=<iso|relative>,recur_*' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l type-option             -d 'Type option key=value or key=<name>,value=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l unset                   -d 'Clear scalar metadata field by name' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-deps              -d 'Clear dependency entries'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-comments          -d 'Clear comments'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-notes             -d 'Clear notes'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-learnings         -d 'Clear learnings'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-files             -d 'Clear linked files'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-tests             -d 'Clear linked tests'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-docs              -d 'Clear linked docs'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-reminders         -d 'Clear reminders'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-events            -d 'Clear events'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l clear-type-options      -d 'Clear type options'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l allow-audit-update      -d 'Allow non-owner metadata-only audit updates without requiring --force'
complete -c pm -n '__fish_seen_subcommand_from update-many' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from update-many' -l force                   -d 'Force override'
${fishUpdateManyRuntimeFieldFlags}

# normalize flags
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-status           -d 'Filter by status before planning or apply' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-type             -d 'Filter by type before planning or apply' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-tag              -d 'Filter by tag before planning or apply' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-priority         -d 'Filter by priority before planning or apply' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-deadline-before  -d 'Filter by deadline upper bound' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-deadline-after   -d 'Filter by deadline lower bound' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-assignee         -d 'Filter by assignee before planning or apply' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-assignee-filter  -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-parent           -d 'Filter by parent item ID' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-sprint           -d 'Filter by sprint before planning or apply' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l filter-release          -d 'Filter by release before planning or apply' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l limit                   -d 'Limit matched item count' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l offset                  -d 'Skip first n matched rows' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l dry-run                 -d 'Preview normalize findings without mutating'
complete -c pm -n '__fish_seen_subcommand_from normalize' -l apply                   -d 'Apply normalize changes'
complete -c pm -n '__fish_seen_subcommand_from normalize' -l allow-audit-update      -d 'Allow non-owner metadata-only audit updates without requiring --force'
complete -c pm -n '__fish_seen_subcommand_from normalize' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from normalize' -l force                   -d 'Force override'

# search flags
complete -c pm -n '__fish_seen_subcommand_from search' -l mode          -d 'Search mode' -r -a 'keyword semantic hybrid'
complete -c pm -n '__fish_seen_subcommand_from search' -l match-mode    -d 'Token match mode' -r -a 'and or exact'
complete -c pm -n '__fish_seen_subcommand_from search' -l min-score     -d 'Per-query minimum score threshold' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l count          -d 'Return only the match count'
complete -c pm -n '__fish_seen_subcommand_from search' -l include-linked -d 'Include linked content in scoring'
complete -c pm -n '__fish_seen_subcommand_from search' -l limit          -d 'Max results' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l status         -d 'Filter by status (open/closed/canceled, csv)' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from search' -l type           -d 'Filter by type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from search' -l tag            -d 'Filter by tag' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from search' -l tags           -d 'Alias for --tag' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from search' -l priority       -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from search' -l updated-after  -d 'Filter by updated_at lower bound' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l updated-before -d 'Filter by updated_at upper bound' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l created-after  -d 'Filter by created_at lower bound' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l created-before -d 'Filter by created_at upper bound' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l assignee       -d 'Filter by assignee' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l sprint         -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l release        -d 'Filter by release' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l parent         -d 'Filter by parent item ID' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l filter-reviewer-missing   -d 'Select only items missing reviewer'
complete -c pm -n '__fish_seen_subcommand_from search' -l filter-risk-missing       -d 'Select only items missing risk'
complete -c pm -n '__fish_seen_subcommand_from search' -l filter-confidence-missing -d 'Select only items missing confidence'
complete -c pm -n '__fish_seen_subcommand_from search' -l filter-sprint-missing     -d 'Select only items missing sprint'
complete -c pm -n '__fish_seen_subcommand_from search' -l filter-release-missing    -d 'Select only items missing release'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-notes          -d 'Select only items that have notes'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-notes           -d 'Select only items with no notes'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-learnings      -d 'Select only items that have learnings'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-learnings       -d 'Select only items with no learnings'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-files          -d 'Select only items that have linked files'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-files           -d 'Select only items with no linked files'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-docs           -d 'Select only items that have linked docs'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-docs            -d 'Select only items with no linked docs'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-tests          -d 'Select only items that have linked tests'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-tests           -d 'Select only items with no linked tests'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-comments       -d 'Select only items that have comments'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-comments        -d 'Select only items with no comments'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-deps           -d 'Select only items that have dependencies'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-deps            -d 'Select only items with no dependencies'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-body           -d 'Select only items with non-empty body'
complete -c pm -n '__fish_seen_subcommand_from search' -l empty-body         -d 'Select only items with empty body'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-linked-command -d 'Select only items that have a linked command'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-linked-command  -d 'Select only items with no linked command'
${fishSearchRuntimeFieldFlags}

# calendar flags
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l view      -d 'Calendar view' -r -a 'agenda day week month'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l date      -d 'Anchor date/time (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l from      -d 'Agenda lower bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l to        -d 'Agenda upper bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l past      -d 'Include past entries'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l full-period -d 'Include full anchored day/week/month period'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l type      -d 'Filter by type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l tag       -d 'Filter by tag' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l priority  -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l status    -d 'Filter by status' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l assignee  -d 'Filter by assignee' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l sprint    -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l release   -d 'Filter by release' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l include   -d 'Include event sources' -r -a 'all deadlines reminders events scheduled'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l recurrence-lookahead-days -d 'Bound open-ended recurrence lookahead' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l recurrence-lookback-days -d 'Bound open-ended recurrence lookback' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l occurrence-limit -d 'Cap occurrences per recurring event' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l limit     -d 'Limit returned events' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l format    -d 'Output override' -r -a 'markdown toon json'
${fishCalendarRuntimeFieldFlags}

# context flags
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l date      -d 'Anchor date/time (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l from      -d 'Agenda lower bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l to        -d 'Agenda upper bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l past      -d 'Include past entries in bounded windows'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l type      -d 'Filter by type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l tag       -d 'Filter by tag' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l priority  -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l assignee  -d 'Filter by assignee' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l sprint    -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l release   -d 'Filter by release' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l parent    -d 'Scope snapshot to one item subtree' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l limit     -d 'Limit focus and agenda rows per section' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l depth     -d 'Context depth' -r -a 'brief standard deep full'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l format    -d 'Output override' -r -a 'markdown toon json'
${fishContextRuntimeFieldFlags}

# guide flags
complete -c pm -n '__fish_seen_subcommand_from guide' -l list      -d 'Show guide topic index'
complete -c pm -n '__fish_seen_subcommand_from guide' -l format    -d 'Output override' -r -a 'markdown toon json'
complete -c pm -n '__fish_seen_subcommand_from guide' -l depth     -d 'Guide detail depth' -r -a 'brief standard deep'
complete -c pm -n '__fish_seen_subcommand_from guide' -a '${guideTopicChoices}' -d 'Guide topic'

# reindex flags
complete -c pm -n '__fish_seen_subcommand_from reindex' -l mode -d 'Reindex mode' -r -a 'keyword semantic hybrid'
complete -c pm -n '__fish_seen_subcommand_from reindex' -l progress -d 'Emit progress updates to stderr'

# get flags
complete -c pm -n '__fish_seen_subcommand_from get' -l depth -d 'Detail depth' -r -a 'brief standard deep full'
complete -c pm -n '__fish_seen_subcommand_from get' -l full -d 'Explicit full item read'
complete -c pm -n '__fish_seen_subcommand_from get' -l fields -d 'Render custom comma-separated item fields' -r
complete -c pm -n '__fish_seen_subcommand_from get' -l tree -d 'Include descendant subtree in result payload'
complete -c pm -n '__fish_seen_subcommand_from get' -l tree-depth -d 'Cap subtree depth for --tree (0 = root only)' -r

# history / activity flags
complete -c pm -n '__fish_seen_subcommand_from history'  -l limit -d 'Max history entries' -r
complete -c pm -n '__fish_seen_subcommand_from history'  -l compact -d 'Condensed history projection'
complete -c pm -n '__fish_seen_subcommand_from history'  -l full -d 'Show full history entries'
complete -c pm -n '__fish_seen_subcommand_from history'  -l diff -d 'Include per-entry field-level before/after value diffs'
complete -c pm -n '__fish_seen_subcommand_from history'  -l field -d 'With --diff, show only entries that changed this field' -r
complete -c pm -n '__fish_seen_subcommand_from history'  -l verify -d 'Verify history hash chain and replay integrity'
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l before -d 'Compact entries strictly before this version number or ISO timestamp' -r
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l ids -d 'Bulk: compact an explicit comma-separated list of item ids' -r
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l all-over -d 'Bulk: compact every stream with more than N entries' -r
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l scope -d 'Bulk: lifecycle scope to scan (closed|all-streams)' -r
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l min-entries -d 'Bulk: skip streams with at most N entries' -r
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l dry-run -d 'Preview compaction impact without writing the history file'
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l message -d 'Audit history message' -r
complete -c pm -n '__fish_seen_subcommand_from history-compact' -l force -d 'Force ownership/lock override'
complete -c pm -n '__fish_seen_subcommand_from history-redact' -l literal -d 'Literal string matcher to redact from history/item payloads' -r
complete -c pm -n '__fish_seen_subcommand_from history-redact' -l regex -d 'Regex matcher to redact (/pattern/flags or raw pattern)' -r
complete -c pm -n '__fish_seen_subcommand_from history-redact' -l replacement -d 'Replacement text (defaults to [redacted])' -r
complete -c pm -n '__fish_seen_subcommand_from history-redact' -l dry-run -d 'Preview redaction impact without writing files'
complete -c pm -n '__fish_seen_subcommand_from history-redact' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from history-redact' -l message -d 'Audit history message' -r
complete -c pm -n '__fish_seen_subcommand_from history-redact' -l force -d 'Force ownership/lock override'
complete -c pm -n '__fish_seen_subcommand_from history-repair' -l all -d 'Repair every drifted stream in one audited pass'
complete -c pm -n '__fish_seen_subcommand_from history-repair' -l dry-run -d 'Preview the re-anchor impact without writing the history file'
complete -c pm -n '__fish_seen_subcommand_from history-repair' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from history-repair' -l message -d 'Audit history message' -r
complete -c pm -n '__fish_seen_subcommand_from history-repair' -l force -d 'Force ownership/lock override'
complete -c pm -n '__fish_seen_subcommand_from schema' -a 'list show show-status add-type remove-type add-status remove-status add-field remove-field list-fields show-field apply-preset' -d 'Schema subcommand'
complete -c pm -n '__fish_seen_subcommand_from schema' -l description -d 'Human description for the custom item type, status, or field' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l default-status -d 'Default status hint for the custom item type' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l folder -d 'Storage folder for items of this custom type' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l alias -d 'Alias for the custom type, status, or field flag (repeatable)' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l role -d 'Lifecycle role for a custom status (repeatable)' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l order -d 'Display/sort order for a custom status' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l type -d 'Value type for a custom field' -r -a 'string number boolean string_array'
complete -c pm -n '__fish_seen_subcommand_from schema' -l commands -d 'Commands a custom field is wired onto (repeatable)' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l cli-flag -d 'Override the auto-derived CLI flag for a custom field' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l required -d 'Mark a custom field as always required'
complete -c pm -n '__fish_seen_subcommand_from schema' -l required-on-create -d 'Mark a custom field as required at create time'
complete -c pm -n '__fish_seen_subcommand_from schema' -l no-allow-unset -d 'Disallow clearing a custom field via --unset'
complete -c pm -n '__fish_seen_subcommand_from schema' -l required-types -d 'Restrict a custom field requirement to specific item types (repeatable)' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l infer -d 'Infer item types from title-prefix conventions (add-type)'
complete -c pm -n '__fish_seen_subcommand_from schema' -l min-count -d 'Minimum items sharing a prefix for --infer' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l apply -d 'Register inferred types (with --infer)'
complete -c pm -n '__fish_seen_subcommand_from schema' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l force -d 'Force ownership/lock override'
complete -c pm -n '__fish_seen_subcommand_from plan' -a 'create show add-step update-step complete-step block-step reorder-step remove-step link unlink decision discovery validation resume approve materialize' -d 'Plan subcommand'
complete -c pm -n '__fish_seen_subcommand_from plan' -l title -d 'Plan title' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l scope -d 'Plan scope statement' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l harness -d 'Plan harness provenance' -r -a 'codex claude-code cursor generic'
complete -c pm -n '__fish_seen_subcommand_from plan' -l mode -d 'Plan mode' -r -a 'draft research review approved executing paused completed superseded'
complete -c pm -n '__fish_seen_subcommand_from plan' -l resume-context -d 'Resume context summary' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l step-title -d 'Step title' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l step -d 'Step title (repeatable on create)' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l step-status -d 'Step status' -r -a 'pending in_progress completed blocked skipped superseded'
complete -c pm -n '__fish_seen_subcommand_from plan' -l step-evidence -d 'Step evidence' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l depends-on -d 'Pm item id step depends on' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l link -d 'Pm item id to link' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l link-kind -d 'Link kind' -r -a 'related blocks blocked_by depends_on discovered_from implements verifies supersedes'
complete -c pm -n '__fish_seen_subcommand_from plan' -l depth -d 'Show depth' -r -a 'brief standard deep'
complete -c pm -n '__fish_seen_subcommand_from plan' -l steps -d 'Step ids/orders for materialize' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l materialize-type -d 'Item type for materialized steps' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l allow-multiple-active -d 'Allow multiple in_progress steps'
complete -c pm -n '__fish_seen_subcommand_from plan' -l promote-to-item-dep -d 'Also add link as item dependency'
complete -c pm -n '__fish_seen_subcommand_from plan' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l message -d 'Mutation message' -r
complete -c pm -n '__fish_seen_subcommand_from plan' -l force -d 'Force ownership override'
complete -c pm -n '__fish_seen_subcommand_from activity' -l id -d 'Filter by item ID' -r
complete -c pm -n '__fish_seen_subcommand_from activity' -l op -d 'Filter by history operation' -r
complete -c pm -n '__fish_seen_subcommand_from activity' -l author -d 'Filter by history author' -r
complete -c pm -n '__fish_seen_subcommand_from activity' -l from -d 'Lower timestamp bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from activity' -l to -d 'Upper timestamp bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from activity' -l limit -d 'Max activity entries' -r
complete -c pm -n '__fish_seen_subcommand_from activity' -l compact -d 'Condensed activity projection'
complete -c pm -n '__fish_seen_subcommand_from activity' -l full -d 'Show full activity entries'
complete -c pm -n '__fish_seen_subcommand_from activity' -l stream -d 'Emit line-delimited JSON rows'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l action -d 'Filter schema by tool action' -r
complete -c pm -n '__fish_seen_subcommand_from contracts' -l command -d 'Scope output to one command (narrow-by-default)' -r
complete -c pm -n '__fish_seen_subcommand_from contracts' -l schema-only -d 'Return schema-only payload'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l flags-only -d 'Return command flag contracts only'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l availability-only -d 'Return action availability only'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l runtime-only -d 'Include only actions invocable in the current runtime'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l active-only -d 'Alias for --runtime-only'
complete -c pm -n '__fish_seen_subcommand_from deps' -l format -d 'Output format' -r -a 'tree graph'
complete -c pm -n '__fish_seen_subcommand_from deps' -l max-depth -d 'Maximum traversal depth (0 keeps root only)' -r
complete -c pm -n '__fish_seen_subcommand_from deps' -l collapse -d 'Collapse mode' -r -a 'none repeated'
complete -c pm -n '__fish_seen_subcommand_from deps' -l summary -d 'Return counts only without tree/graph payload'

# comments / notes / learnings flags
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l add -d 'Add one entry (text=<value> or plain text)' -r
complete -c pm -n '__fish_seen_subcommand_from comments' -l stdin -d 'Read comment text from stdin (supports multiline markdown)'
complete -c pm -n '__fish_seen_subcommand_from comments' -l file -d 'Read comment text from file (supports multiline markdown)' -r
complete -c pm -n '__fish_seen_subcommand_from comments' -l edit -d 'Replace the comment at 1-based index (text from positional/--add/--stdin/--file)' -r
complete -c pm -n '__fish_seen_subcommand_from comments' -l delete -d 'Delete the comment at 1-based index' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l limit -d 'Return only latest n entries' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l author -d 'Entry author' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l allow-audit-comment -d 'Allow non-owner append-only comment audits (legacy alias for notes/learnings)'
complete -c pm -n '__fish_seen_subcommand_from notes' -l allow-audit-note -d 'Allow non-owner append-only note audits without requiring --force'
complete -c pm -n '__fish_seen_subcommand_from learnings' -l allow-audit-learning -d 'Allow non-owner append-only learning audits without requiring --force'
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l force -d 'Force override'

# test flags
complete -c pm -n '__fish_seen_subcommand_from test' -l add -d 'Add linked test entry' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l add-json -d 'Add linked test entry from JSON object/array' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l remove -d 'Remove linked test entry' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l list -d 'List linked tests without mutating'
complete -c pm -n '__fish_seen_subcommand_from test' -l run -d 'Run linked tests'
complete -c pm -n '__fish_seen_subcommand_from test' -l match -d 'Run linked tests whose command/path contains substring' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l only-index -d 'Run one linked test by 1-based index' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l only-last -d 'Run the most recently added linked test'
complete -c pm -n '__fish_seen_subcommand_from test' -l background -d 'Run linked tests in managed background mode'
complete -c pm -n '__fish_seen_subcommand_from test' -l timeout -d 'Default timeout seconds' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l progress -d 'Emit linked-test progress to stderr'
complete -c pm -n '__fish_seen_subcommand_from test' -l env-set -d 'Set linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l env-clear -d 'Clear linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l shared-host-safe -d 'Apply shared-host-safe runtime defaults'
complete -c pm -n '__fish_seen_subcommand_from test' -l pm-context -d 'PM linked-test context mode' -r -a 'schema tracker auto'
complete -c pm -n '__fish_seen_subcommand_from test' -l override-linked-pm-context -d 'Force run-level --pm-context over per-linked-test metadata'
complete -c pm -n '__fish_seen_subcommand_from test' -l fail-on-context-mismatch -d 'Fail when context item counts mismatch'
complete -c pm -n '__fish_seen_subcommand_from test' -l fail-on-skipped -d 'Treat skipped linked tests as dependency failures'
complete -c pm -n '__fish_seen_subcommand_from test' -l fail-on-empty-test-run -d 'Treat empty linked-test selections as failures'
complete -c pm -n '__fish_seen_subcommand_from test' -l require-assertions-for-pm -d 'Require assertions for linked PM command tests'
complete -c pm -n '__fish_seen_subcommand_from test' -l check-context -d 'Preflight linked PM command context diagnostics before execution'
complete -c pm -n '__fish_seen_subcommand_from test' -l auto-pm-context -d 'Auto-remediate tracker-read context mismatches using tracker context'
complete -c pm -n '__fish_seen_subcommand_from test' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l force -d 'Force override'

# test-all flags
complete -c pm -n '__fish_seen_subcommand_from test-all' -l status  -d 'Filter by status' -r -a 'open in_progress'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l limit -d 'Limit matching items before running linked tests' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l offset -d 'Skip matching items before running linked tests' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l background -d 'Run linked tests in managed background mode'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l timeout -d 'Default timeout seconds' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l progress -d 'Emit linked-test progress to stderr'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l env-set -d 'Set linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l env-clear -d 'Clear linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l shared-host-safe -d 'Apply shared-host-safe runtime defaults'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l pm-context -d 'PM linked-test context mode' -r -a 'schema tracker auto'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l override-linked-pm-context -d 'Force run-level --pm-context over per-linked-test metadata'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l fail-on-context-mismatch -d 'Fail when context item counts mismatch'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l fail-on-skipped -d 'Treat skipped linked tests as dependency failures'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l fail-on-empty-test-run -d 'Treat empty linked-test selections as failures'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l require-assertions-for-pm -d 'Require assertions for linked PM command tests'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l check-context -d 'Preflight linked PM command context diagnostics before execution'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l auto-pm-context -d 'Auto-remediate tracker-read context mismatches using tracker context'

# test-runs flags
complete -c pm -n '__fish_seen_subcommand_from test-runs' -a 'list status logs stop resume' -d 'test-runs subcommand'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l status -d 'Filter background runs by status' -r -a 'queued running passed failed stopped canceled'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l limit -d 'Limit returned runs' -r
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l stream -d 'Background log stream selector' -r -a 'stdout stderr both'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l tail -d 'Tail number of lines from logs' -r
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l force -d 'Force-stop run with SIGKILL'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l author -d 'Resume author' -r

# gc flags
complete -c pm -n '__fish_seen_subcommand_from gc' -l dry-run -d 'Preview cleanup targets without deleting files'
complete -c pm -n '__fish_seen_subcommand_from gc' -l scope -d 'Limit cleanup to index/embeddings/runtime/locks scopes' -r

# stats flags
complete -c pm -n '__fish_seen_subcommand_from stats' -l storage -d 'Include aggregate history-stream storage metrics'
complete -c pm -n '__fish_seen_subcommand_from stats' -l metadata-coverage -d 'Include metadata coverage percentages overall and by type'
complete -c pm -n '__fish_seen_subcommand_from stats' -l field-utilization -d 'Include content-field utilization rates across all items'
complete -c pm -n '__fish_seen_subcommand_from stats' -l by-assignee -d 'Lifecycle-bucketed breakdown grouped by assignee'
complete -c pm -n '__fish_seen_subcommand_from stats' -l by-tag -d 'Lifecycle-bucketed breakdown grouped by tag'
complete -c pm -n '__fish_seen_subcommand_from stats' -l by-priority -d 'Lifecycle-bucketed breakdown grouped by priority'
complete -c pm -n '__fish_seen_subcommand_from stats' -l tag-prefix -d 'With --by-tag: only count tags with this prefix' -r

# append flags
complete -c pm -n '__fish_seen_subcommand_from append' -s b -l body -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from append' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from append' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from append' -l force -d 'Force override'

# close flags
complete -c pm -n '__fish_seen_subcommand_from claim release start-task pause-task close close-task delete' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from claim release start-task pause-task close close-task delete' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from claim release start-task pause-task close close-task delete' -l force -d 'Force override'
complete -c pm -n '__fish_seen_subcommand_from close close-task' -l validate-close -d 'Validate closure metadata mode' -r -a 'off warn strict'
complete -c pm -n '__fish_seen_subcommand_from close' -l reason -d 'Closure reason' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l close-reason -d 'Alias for --reason' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l resolution -d 'Closure resolution summary' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l expected-result -d 'Expected behavior note' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l actual-result -d 'Observed behavior note' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l expected -d 'Short alias for --expected-result' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l actual -d 'Short alias for --actual-result' -r
complete -c pm -n '__fish_seen_subcommand_from release' -l allow-audit-release -d 'Allow non-owner release handoffs without requiring --force'
complete -c pm -n '__fish_seen_subcommand_from delete' -l dry-run -d 'Preview the item file that would be deleted without mutating'

# scheduling shortcut flags (meet/event/remind)
complete -c pm -n '__fish_seen_subcommand_from meet event' -l start -d 'Start time (ISO, now, or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from meet event' -l duration -d 'Duration from start (default 1h)' -r
complete -c pm -n '__fish_seen_subcommand_from meet event' -l end -d 'End time (overrides --duration)' -r
complete -c pm -n '__fish_seen_subcommand_from meet event' -l location -d 'Location' -r
complete -c pm -n '__fish_seen_subcommand_from meet event' -l timezone -d 'IANA timezone' -r
complete -c pm -n '__fish_seen_subcommand_from meet event' -l all-day -d 'Mark as an all-day event'
complete -c pm -n '__fish_seen_subcommand_from remind' -l at -d 'Reminder time (default +1d)' -r
complete -c pm -n '__fish_seen_subcommand_from remind' -l text -d 'Reminder text (defaults to title)' -r
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l parent -d 'Parent item id' -r
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l allow-missing-parent -d 'Permit a parent id that does not exist yet'
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l tags -d 'Comma-separated tags' -r
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l priority -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l body -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l description -d 'Short description' -r
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from meet event remind' -l message -d 'History message' -r

# close-many flags
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-status          -d 'Filter by status before closing' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-type            -d 'Filter by type before closing' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-tag             -d 'Filter by tag before closing' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-priority        -d 'Filter by priority before closing' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-deadline-before -d 'Filter by deadline upper bound' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-deadline-after  -d 'Filter by deadline lower bound' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-updated-after   -d 'Filter by updated_at lower bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-updated-before  -d 'Filter by updated_at upper bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-created-after   -d 'Filter by created_at lower bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-created-before  -d 'Filter by created_at upper bound (ISO/relative)' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-assignee        -d 'Filter by assignee before closing' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-parent          -d 'Filter by parent item ID' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-sprint          -d 'Filter by sprint before closing' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-release         -d 'Filter by release before closing' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-reviewer-missing   -d 'Select only items missing reviewer'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-risk-missing       -d 'Select only items missing risk'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-confidence-missing -d 'Select only items missing confidence'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-sprint-missing     -d 'Select only items missing sprint'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-release-missing    -d 'Select only items missing release'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-notes          -d 'Select only items that have notes'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-notes           -d 'Select only items with no notes'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-learnings      -d 'Select only items that have learnings'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-learnings       -d 'Select only items with no learnings'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-files          -d 'Select only items that have linked files'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-files           -d 'Select only items with no linked files'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-docs           -d 'Select only items that have linked docs'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-docs            -d 'Select only items with no linked docs'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-tests          -d 'Select only items that have linked tests'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-tests           -d 'Select only items with no linked tests'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-comments       -d 'Select only items that have comments'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-comments        -d 'Select only items with no comments'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-deps           -d 'Select only items that have dependencies'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-deps            -d 'Select only items with no dependencies'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-body           -d 'Select only items with non-empty body'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-empty-body         -d 'Select only items with empty body'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-has-linked-command -d 'Select only items that have a linked command'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l filter-no-linked-command  -d 'Select only items with no linked command'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l ids                    -d 'Explicit comma-separated ID allowlist' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l limit                  -d 'Limit matched item count' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l offset                 -d 'Skip first n matched rows' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l reason                 -d 'Optional shared close reason applied to every matched item' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l resolution             -d 'Shared closure resolution' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l expected-result        -d 'Shared expected-result note' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l actual-result          -d 'Shared actual-result note' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l expected               -d 'Short alias for --expected-result' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l actual                 -d 'Short alias for --actual-result' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l validate-close         -d 'Validate closure metadata per item' -r -a 'off warn strict'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l author                 -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l message                -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l force                  -d 'Re-close terminal matches and override ownership'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l dry-run                -d 'Preview matched items without mutating'
complete -c pm -n '__fish_seen_subcommand_from close-many' -l rollback               -d 'Rollback checkpoint ID' -r
complete -c pm -n '__fish_seen_subcommand_from close-many' -l no-checkpoint          -d 'Disable checkpoint creation during apply mode'

# validate flags
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-metadata -d 'Run metadata completeness checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l metadata-profile -d 'Select metadata validation profile for --check-metadata' -r -a 'core strict custom'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-resolution -d 'Run closed-item resolution metadata checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-lifecycle -d 'Run active-item lifecycle governance drift checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-stale-blockers -d 'Include stale blocker-pattern diagnostics in lifecycle checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l dependency-cycle-severity -d 'Set dependency-cycle warning policy for lifecycle checks' -r -a 'off warn error'
complete -c pm -n '__fish_seen_subcommand_from validate' -l parent-cycle-severity -d 'Set parent-hierarchy cycle warning policy for lifecycle checks' -r -a 'off warn error'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-files -d 'Run linked-file and orphaned-file checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l scan-mode -d 'Select file candidate scan mode for --check-files' -r -a 'default tracked-all tracked-all-strict'
complete -c pm -n '__fish_seen_subcommand_from validate' -l include-pm-internals -d 'Include PM storage internals in tracked-all candidate scans'
complete -c pm -n '__fish_seen_subcommand_from validate' -l verbose-file-lists -d 'Include full file-path lists for validate --check-files details'
complete -c pm -n '__fish_seen_subcommand_from validate' -l verbose-diagnostics -d 'Include full validate diagnostic ID lists instead of compact summaries'
complete -c pm -n '__fish_seen_subcommand_from validate' -l all-affected-ids -d 'Emit complete missing_* affected-ID lists with no truncation (implied by --json)'
complete -c pm -n '__fish_seen_subcommand_from validate' -l strict-exit -d 'Return non-zero exit when validation warnings are present'
complete -c pm -n '__fish_seen_subcommand_from validate' -l fail-on-warn -d 'Alias for --strict-exit'
complete -c pm -n '__fish_seen_subcommand_from validate' -l fix-hints -d 'Add a machine-executable fix_hints[] of pm commands to each failing check'
complete -c pm -n '__fish_seen_subcommand_from validate' -l auto-fix -d 'Apply the safe, deterministic subset of fix-hint remediations automatically'
complete -c pm -n '__fish_seen_subcommand_from validate' -l dry-run -d 'Preview planned --auto-fix/--prune-missing fixes without applying them'
complete -c pm -n '__fish_seen_subcommand_from validate' -l fix-scope -d 'Grant --auto-fix scopes (estimates/lifecycle must be named explicitly)' -r -a 'metadata resolution estimates lifecycle'
complete -c pm -n '__fish_seen_subcommand_from validate' -l prune-missing -d 'Remove stale linked-file/doc links classified as deleted'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-history-drift -d 'Run item/history hash drift checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-command-references -d 'Run linked-command PM-ID reference checks'
complete -c pm -n '__fish_seen_subcommand_from init' -l preset -d 'Governance preset for new setups' -r -a 'minimal default strict'
complete -c pm -n '__fish_seen_subcommand_from init' -l defaults -d 'Use non-interactive setup defaults'
complete -c pm -n '__fish_seen_subcommand_from init' -s y -l yes -d 'Alias for --defaults'
complete -c pm -n '__fish_seen_subcommand_from init' -l author -d 'Set the default mutation author for this project' -r
complete -c pm -n '__fish_seen_subcommand_from init' -l agent-guidance -d 'Agent guidance mode' -r -a 'ask add skip status'
complete -c pm -n '__fish_seen_subcommand_from init' -l type-preset -d 'Register domain item types' -r -a 'agile ops research'
complete -c pm -n '__fish_seen_subcommand_from init' -l with-packages -d 'Install bundled first-party packages during initialization'
complete -c pm -n '__fish_seen_subcommand_from init' -l verbose -d 'Include the full resolved settings tree in init output'
complete -c pm -n '__fish_seen_subcommand_from config' -l criterion -d 'Criteria value for definition-of-done metadata-required-fields or lifecycle pattern keys (repeatable for set)' -r
complete -c pm -n '__fish_seen_subcommand_from config' -l clear-criteria -d 'Clear config criteria-list key values'
complete -c pm -n '__fish_seen_subcommand_from config' -l format -d 'Item format for item-format key' -r -a 'toon'
complete -c pm -n '__fish_seen_subcommand_from config' -l policy -d 'Policy value for supported policy keys' -r
complete -c pm -n '__fish_seen_subcommand_from health' -l strict-directories -d 'Treat optional item-type directories as required failures'
complete -c pm -n '__fish_seen_subcommand_from health' -l check-only -d 'Run read-only health diagnostics without refreshing vectors'
complete -c pm -n '__fish_seen_subcommand_from health' -l no-refresh -d 'Disable automatic vector refresh attempts during health checks'
complete -c pm -n '__fish_seen_subcommand_from health' -l refresh-vectors -d 'Explicitly enable vector refresh attempts during health checks'
complete -c pm -n '__fish_seen_subcommand_from health' -l verbose-stale-items -d 'Include full stale vectorization ID lists in health output'
complete -c pm -n '__fish_seen_subcommand_from health' -l brief -d 'Emit compact health details for low-token agent checks'
complete -c pm -n '__fish_seen_subcommand_from health' -l summary -d 'Emit one-line-style health status with check names and warning count'
complete -c pm -n '__fish_seen_subcommand_from health' -l strict-exit -d 'Return non-zero exit when health warnings are present'
complete -c pm -n '__fish_seen_subcommand_from health' -l fail-on-warn -d 'Alias for --strict-exit'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l status -d 'Filter by item status' -r -a '${statusChoices}'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l type -d 'Filter by item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l tag -d 'Filter by tag' -r -a ${fishTagChoices}
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l priority -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l parent -d 'Filter by parent item ID' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l sprint -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l release -d 'Filter by release' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l assignee -d 'Filter by assignee' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l limit-items -d 'Limit returned item count' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l limit -d 'Alias for --limit-items' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l full-history -d 'Export full comment history rows (cannot be combined with --latest)'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l latest -d 'Return latest n comments per item (0 for summary-only rows)' -r

# completion shell argument
complete -c pm -n '__fish_seen_subcommand_from completion' -l eager-tags -d 'Embed current tracker tags directly in script output'
complete -c pm -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell type'

# templates subcommands
complete -c pm -n '__fish_seen_subcommand_from templates' -a 'save list show' -d 'Templates command'

# extension lifecycle flags
complete -c pm -n '__fish_seen_subcommand_from extension' -a 'init scaffold install uninstall explore manage reload doctor adopt adopt-all activate deactivate' -d 'Extension action subcommand'
complete -c pm -n '__fish_seen_subcommand_from extension' -l init -d 'Generate starter extension scaffold'
complete -c pm -n '__fish_seen_subcommand_from extension' -l scaffold -d 'Alias for --init'
complete -c pm -n '__fish_seen_subcommand_from extension' -l install -d 'Install extension from local path or GitHub source'
complete -c pm -n '__fish_seen_subcommand_from extension' -l uninstall -d 'Uninstall extension by name'
complete -c pm -n '__fish_seen_subcommand_from extension' -l explore -d 'List discovered extensions for selected scope'
complete -c pm -n '__fish_seen_subcommand_from extension' -l manage -d 'List managed extensions with update metadata'
complete -c pm -n '__fish_seen_subcommand_from extension' -l reload -d 'Reload extensions with cache-busted module imports'
complete -c pm -n '__fish_seen_subcommand_from extension' -l watch -d 'Enable watch mode with --reload'
complete -c pm -n '__fish_seen_subcommand_from extension' -l doctor -d 'Run consolidated extension diagnostics'
complete -c pm -n '__fish_seen_subcommand_from extension' -l adopt -d 'Adopt an unmanaged extension into managed metadata'
complete -c pm -n '__fish_seen_subcommand_from extension' -l adopt-all -d 'Adopt all unmanaged extensions into managed metadata'
complete -c pm -n '__fish_seen_subcommand_from extension' -l activate -d 'Activate extension in selected scope settings'
complete -c pm -n '__fish_seen_subcommand_from extension' -l deactivate -d 'Deactivate extension in selected scope settings'
complete -c pm -n '__fish_seen_subcommand_from extension' -l project -d 'Use project extension scope'
complete -c pm -n '__fish_seen_subcommand_from extension' -l local -d 'Alias for --project'
complete -c pm -n '__fish_seen_subcommand_from extension' -l global -d 'Use global extension scope'
complete -c pm -n '__fish_seen_subcommand_from extension' -l gh -d 'GitHub shorthand owner/repo/path' -r
complete -c pm -n '__fish_seen_subcommand_from extension' -l github -d 'Alias for --gh' -r
complete -c pm -n '__fish_seen_subcommand_from extension' -l ref -d 'Git ref/branch/tag for GitHub source' -r
complete -c pm -n '__fish_seen_subcommand_from extension' -l detail -d 'Detail mode for extension diagnostics' -r -a 'summary deep'
complete -c pm -n '__fish_seen_subcommand_from extension' -l trace -d 'Include registration traces in doctor deep diagnostics'
complete -c pm -n '__fish_seen_subcommand_from extension' -l runtime-probe -d 'Opt-in runtime activation probe for manage output'
complete -c pm -n '__fish_seen_subcommand_from extension' -l fix-managed-state -d 'Adopt unmanaged extensions before diagnostics/update checks'
complete -c pm -n '__fish_seen_subcommand_from extension' -l strict-exit -d 'Return non-zero exit when doctor warnings are present'
complete -c pm -n '__fish_seen_subcommand_from extension' -l fail-on-warn -d 'Alias for --strict-exit (doctor)'`;
}

const SETUP_HINTS: Record<CompletionShell, string> = {
  bash: 'Add to ~/.bashrc or ~/.bash_profile: eval "$(pm completion bash)"',
  zsh: 'Add to ~/.zshrc: eval "$(pm completion zsh)"',
  fish: "Run: pm completion fish > ~/.config/fish/completions/pm.fish",
};

/**
 * Implements run completion for the public runtime surface of this module.
 */
export function runCompletion(
  shell: string,
  itemTypes: string[] = [],
  tags: string[] = [],
  eagerTagExpansion = false,
  runtime: CompletionRuntimeConfig = {},
): CompletionResult {
  const normalized = shell.trim().toLowerCase();
  if (!VALID_SHELLS.includes(normalized as CompletionShell)) {
    throw new PmCliError(
      `Unknown shell: "${shell}". Supported shells: ${VALID_SHELLS.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  const validShell = normalized as CompletionShell;
  let script: string;
  if (validShell === "bash") {
    script = generateBashScript(itemTypes, tags, eagerTagExpansion, runtime);
  } else if (validShell === "zsh") {
    script = generateZshScript(itemTypes, tags, eagerTagExpansion, runtime);
  } else {
    script = generateFishScript(itemTypes, tags, eagerTagExpansion, runtime);
  }
  return {
    shell: validShell,
    script,
    setup_hint: SETUP_HINTS[validShell],
  };
}
