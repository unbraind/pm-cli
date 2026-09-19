/**
 * @module sdk/completion/zsh
 * Renders Zsh completion from shared command contracts and runtime schema.
 */
import {
  PM_NAMESPACED_COMMAND_ALIASES
} from "../cli-contracts.js";
import { SCAFFOLD_CAPABILITIES } from "../extension/scaffold.js";
import type { CompletionRuntimeConfig } from "./shared.js";
import { ATTEST_INVOCATIONS,COMMAND_COMPLETION_DESCRIPTIONS,EXTENSION_LIFECYCLE_ACTIONS,GLOBAL_COMPLETION_INLINE_PATTERNS,GLOBAL_COMPLETION_SWITCH_PATTERNS,GLOBAL_COMPLETION_VALUE_PATTERNS,GUIDE_TOPIC_CHOICES,HIDDEN_COMMAND_ALIASES,NAMESPACE_NOUNS,PACKAGE_LIFECYCLE_ACTIONS,RESTORE_INVOCATIONS,SCHEMA_SUBCOMMAND_CHOICES,completionNamespaceLeaves,completionStatusValues,completionTypeValues,joinCompletionValues,normalizeRuntimeCompletionFlags,shellDoubleQuote } from "./shared.js";

/** Escape static choice tokens for _arguments evaluation, then for the surrounding single-quoted shell source. */
function escapeZshStaticChoices(value: string): string {
  return value.replace(/([^a-zA-Z0-9_./\s-])/gu, "\\$1").replaceAll("'", "'\\''");
}

/** Render normalized runtime field flags as value-taking Zsh argument specifications, or no text when none exist. */
function renderZshRuntimeFieldFlagSpecs(
  runtimeFlags: string[] | undefined,
): string {
  const normalized = normalizeRuntimeCompletionFlags(runtimeFlags);
  if (normalized.length === 0) {
    return "";
  }
  return `${normalized.map((flag) => `            '${escapeZshStaticChoices(flag)}[Runtime schema field flag]:value' \\`).join("\n")}\n`;
}

/** Join Zsh argument specifications with explicit continuation control so adjacent command blocks remain syntactically separate. */
function renderZshArgumentSpecs(
  specs: readonly string[],
  options: { readonly trailingContinuation?: boolean } = {},
): string {
  const trailingContinuation = options.trailingContinuation ?? true;
  const lastSpecIndex = specs.length - 1;
  return specs
    .map(
      (spec, index) =>
        `            ${spec}${trailingContinuation || index !== lastSpecIndex ? " \\" : ""}`,
    )
    .join("\n");
}

/** Render root Zsh descriptions while keeping executable compatibility aliases out of default suggestions. */
function renderZshCommandDescriptions(): string {
  return [...COMMAND_COMPLETION_DESCRIPTIONS, ["ops", "Workspace maintenance and diagnostics"] as const].filter(([command]) => !HIDDEN_COMMAND_ALIASES.has(command)).map(
    ([command, description]) => `    '${command}:${description}'`,
  ).join("\n");
}

/** Render paired content-presence and missing-metadata flags using the command-specific prefixes and alias policy. */
function renderZshPresenceFilterSpecs(options: {
  readonly missingPrefix: "" | "filter-";
  readonly pairedPrefix: "" | "filter-";
  readonly includeContentMissingAliases?: boolean;
}): string {
  const missingSpecs = [
    "reviewer-missing[Select only items missing reviewer]",
    "risk-missing[Select only items missing risk]",
    "confidence-missing[Select only items missing confidence]",
    "sprint-missing[Select only items missing sprint]",
    "release-missing[Select only items missing release]",
  ];
  const contentMissingAliasSpecs =
    options.includeContentMissingAliases === true
      ? [
          "files-missing[Alias for --no-files]",
          "docs-missing[Alias for --no-docs]",
        ]
      : [];
  const pairedSpecs = [
    [
      "has-notes[Select only items that have notes]",
      "no-notes[Select only items with no notes]",
    ],
    [
      "has-learnings[Select only items that have learnings]",
      "no-learnings[Select only items with no learnings]",
    ],
    [
      "has-files[Select only items that have linked files]",
      "no-files[Select only items with no linked files]",
    ],
    [
      "has-docs[Select only items that have linked docs]",
      "no-docs[Select only items with no linked docs]",
    ],
    [
      "has-tests[Select only items that have linked tests]",
      "no-tests[Select only items with no linked tests]",
    ],
    [
      "has-comments[Select only items that have comments]",
      "no-comments[Select only items with no comments]",
    ],
    [
      "has-deps[Select only items that have dependencies]",
      "no-deps[Select only items with no dependencies]",
    ],
    [
      "has-body[Select only items with non-empty body]",
      "empty-body[Select only items with empty body]",
    ],
    [
      "has-linked-command[Select only items that have a linked command]",
      "no-linked-command[Select only items with no linked command]",
    ],
  ];
  return renderZshArgumentSpecs([
    ...[...missingSpecs, ...contentMissingAliasSpecs].map(
      (spec) => `'--${options.missingPrefix}${spec}'`,
    ),
    ...pairedSpecs.flatMap(([positive, negative]) => [
      `'--${options.pairedPrefix}${positive}'`,
      `'--${options.pairedPrefix}${negative}'`,
    ]),
  ]);
}

const ZSH_MUTATION_COLLECTION_ARGUMENT_SPECS = [
  "'--comment[Comment seed author=<value>,created_at=<iso|now>,text=<value>]:comment'",
  "'--note[Note seed author=<value>,created_at=<iso|now>,text=<value>]:note'",
  "'--learning[Learning seed author=<value>,created_at=<iso|now>,text=<value>]:learning'",
  "'--file[Linked file path=<value>,scope=<project|global>,note=<text>]:file'",
  "'--test[Linked test command=<value>,path=<value>,scope=<project|global>]:test'",
  "'--doc[Linked doc path=<value>,scope=<project|global>,note=<text>]:doc'",
  "'--reminder[Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>]:reminder'",
  "'--event[Event entry start=<iso|relative>,end=<iso|relative>,recur_*]:event'",
  "'--type-option[Type option key=value or key=<name>,value=<value>]:type_option'",
  "'--unset[Clear scalar metadata field by name]:field'",
  "'--replace-files[Atomically replace linked files with provided --file values]'",
  "'--replace-docs[Atomically replace linked docs with provided --doc values]'",
  "'--clear-deps[Clear dependency entries]'",
  "'--clear-comments[Clear comments]'",
  "'--clear-notes[Clear notes]'",
  "'--clear-learnings[Clear learnings]'",
  "'--clear-files[Clear linked files]'",
  "'--clear-tests[Clear linked tests]'",
  "'--clear-docs[Clear linked docs]'",
  "'--clear-reminders[Clear reminders]'",
  "'--clear-events[Clear events]'",
  "'--clear-type-options[Clear type options]'",
];

/** Render shared scheduling option specifications for commands that accept reminder and event metadata. */
function renderZshScheduleItemSpecs(kind: "reminder" | "event"): string {
  const leadingSpecs =
    kind === "reminder"
      ? [
          "'--at[Reminder time (default +1d)]:at'",
          "'--text[Reminder text (defaults to title)]:text'",
        ]
      : [
          "'--start[Start time (ISO, now, or relative)]:start'",
          "'--duration[Duration from start (default 1h)]:duration'",
          "'--end[End time (overrides --duration)]:end'",
          "'--location[Location]:location'",
          "'--timezone[IANA timezone]:timezone'",
          "'--all-day[Mark as an all-day event]'",
        ];
  return renderZshArgumentSpecs(
    [
      ...leadingSpecs,
      "'--parent[Parent item id]:parent'",
      "'--allow-missing-parent[Permit a parent id that does not exist yet]'",
      "'--tags[Comma-separated tags]:tags'",
      "'(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)'",
      "'(-b --body)'{-b,--body}'[Item body]:body'",
      "'(-d --description)'{-d,--description}'[Short description]:description'",
      "'--author[Mutation author]:author'",
      "'--message[History message]:message'",
      "'--json[Output JSON]'",
      "'--quiet[Suppress stdout]'",
    ],
    { trailingContinuation: false },
  );
}

/** Render the shared selection filters accepted by bulk mutation commands as Zsh argument specifications. */
function renderZshBulkSelectionFilterSpecs(
  action: "applying updates" | "closing",
  statusChoices: string,
  typeChoices: string,
  tagChoices: string,
): string {
  return renderZshArgumentSpecs([
    `'--filter-status[Filter by status before ${action}]:(${statusChoices})'`,
    `'--filter-type[Filter by type before ${action}]:(${typeChoices})'`,
    `'--filter-tag[Filter by tag before ${action}]:(${tagChoices})'`,
    `'--filter-priority[Filter by priority before ${action}]:(0 1 2 3 4)'`,
    "'--filter-deadline-before[Filter by deadline upper bound]:deadline'",
    "'--filter-deadline-after[Filter by deadline lower bound]:deadline'",
    "'--filter-updated-after[Filter by updated_at lower bound (ISO/relative)]:timestamp'",
    "'--filter-updated-before[Filter by updated_at upper bound (ISO/relative)]:timestamp'",
    "'--filter-created-after[Filter by created_at lower bound (ISO/relative)]:timestamp'",
    "'--filter-created-before[Filter by created_at upper bound (ISO/relative)]:timestamp'",
    `'--filter-assignee[Filter by assignee before ${action}]:assignee'`,
    "'--filter-assignee-filter[Filter assignee presence]:(assigned unassigned)'",
    "'--filter-parent[Filter by parent item ID]:parent'",
    "'--filter-sprint[Filter by sprint]:sprint'",
    "'--filter-release[Filter by release]:release'",
  ]);
}

/** Emit a cached Zsh status or type resolver that falls back to the configured choices when live resolution is empty. */
function renderZshDynamicChoiceResolver(
  kind: "status" | "type",
  command: "completion-statuses" | "completion-types",
  fallback: string,
): string {
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

/** Implements generate zsh script for the public runtime surface of this module. */
export function generateZshScript(
  itemTypes: string[] = [],
  tags: string[] = [],
  eagerTagExpansion = false,
  runtime: CompletionRuntimeConfig = {},
): string {
  const namespaceLeaves = completionNamespaceLeaves(runtime);
  const useDynamicTypeExpansion = itemTypes.length === 0;
  const typeFallbackChoices = completionTypeValues(itemTypes, runtime);
  const statusFallbackChoices = completionStatusValues(runtime);
  const typeChoices = useDynamicTypeExpansion
    ? '${(f)"$(_pm_type_choices)"}'
    : escapeZshStaticChoices(typeFallbackChoices);
  const statusChoices = '${(f)"$(_pm_status_choices)"}';
  const guideTopicChoices = GUIDE_TOPIC_CHOICES;
  const tagChoices = joinCompletionValues(tags);
  const useEagerTagExpansion = eagerTagExpansion || tags.length > 0;
  const zshTagChoices = useEagerTagExpansion
    ? escapeZshStaticChoices(tagChoices)
    : '${(f)"$(_pm_tag_choices)"}';
  const zshListRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(
    runtime.command_flags?.list,
  );
  const zshCreateRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(
    runtime.command_flags?.create,
  );
  const zshSearchRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(
    runtime.command_flags?.search,
  );
  const zshCalendarRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(
    runtime.command_flags?.calendar,
  );
  const zshContextRuntimeFieldFlags = renderZshRuntimeFieldFlagSpecs(
    runtime.command_flags?.context,
  );
  const zshPresenceFilterFlags = renderZshPresenceFilterSpecs({
    missingPrefix: "filter-",
    pairedPrefix: "",
    includeContentMissingAliases: true,
  });
  const zshBulkPresenceFilterFlags = renderZshPresenceFilterSpecs({
    missingPrefix: "filter-",
    pairedPrefix: "filter-",
  });
  const zshMutationCollectionFlags = renderZshArgumentSpecs(
    ZSH_MUTATION_COLLECTION_ARGUMENT_SPECS,
  );
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
${renderZshCommandDescriptions()}
  )
  _describe 'command' commands
}
${dynamicTagResolver}
${useDynamicTypeExpansion ? renderZshDynamicChoiceResolver("type", "completion-types", typeFallbackChoices) : ""}
${renderZshDynamicChoiceResolver("status", "completion-statuses", statusFallbackChoices)}

_pm() {
  local context state line
  local -a words=("$words[@]")
  local CURRENT=$CURRENT
  local word_index=2 namespace_noun="" operation_path="" operation_index=0 word
  while (( word_index < CURRENT )); do
    word="$words[word_index]"
    case "\${word//_/-}" in
      ${GLOBAL_COMPLETION_VALUE_PATTERNS}) (( word_index += 2 )); continue ;;
      ${GLOBAL_COMPLETION_INLINE_PATTERNS}|${GLOBAL_COMPLETION_SWITCH_PATTERNS}) (( word_index++ )); continue ;;
      --) break ;;
    esac
    if [[ -z "$namespace_noun" ]]; then
      [[ "$word" == "ctx" ]] && word="context"
      case "$word" in ${NAMESPACE_NOUNS.join("|")}) ;; *) break ;; esac
      namespace_noun="$word"
    else
      case "$namespace_noun $word" in
${PM_NAMESPACED_COMMAND_ALIASES.map((entry) => `        "${entry.canonical}") namespace_noun="${entry.canonical}"; operation_path="$namespace_noun"; operation_index=$word_index ;;`).join("\n")}
        *) break ;;
      esac
    fi
    (( word_index++ ))
  done
  if [[ -n "$namespace_noun" ]] && (( word_index == CURRENT )) && [[ "$words[CURRENT]" != -* ]]; then
    local -a history_commands
    case "$namespace_noun" in
${Object.entries(namespaceLeaves).map(([noun, leaves]) => `      "${noun}") history_commands=(${leaves}) ;;`).join("\n")}
    esac
    if (( \${#history_commands} > 0 )); then
      _describe 'command operation' history_commands
      return
    fi
  fi
  if (( operation_index > 0 )); then
    case "$operation_path" in
${PM_NAMESPACED_COMMAND_ALIASES.map((entry) => `      "${entry.canonical}") words=("$words[1]" "${entry.alias}" "\${words[@]:$operation_index}"); (( CURRENT -= operation_index - 2 )) ;;`).join("\n")}
    esac
  fi
  _arguments -C \\
    '--json[Output JSON instead of TOON]' \\
    '--all[Reveal every public command and compatibility alias]' \\
    '--quiet[Suppress stdout output]' \\
    '--output-include[Retain comma-separated read fields or sections]:selectors' \\
    '--output-limit[Set the universal read row ceiling]:limit' \\
    '--output-budget[Set the universal estimated-token ceiling]:tokens' \\
    '--output-format[Select the universal read encoding]:(toon json)' \\
    '--output-session[Carry cross-call read budget and served-item state]:state' \\
    '--output-row-contract[Include row schema metadata in read output]' \\
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
        list)
          _arguments \\
            '*--status[Filter by status; repeatable, comma-separated, or all]:(${statusChoices})' \\
            '--all[Include every lifecycle status]' \\
            '--type[Filter by item type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${zshTagChoices})' \\
            '--tags[Alias for --tag]:(${zshTagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--deadline-before[Filter by deadline upper bound (ISO/date string or relative)]:date' \\
            '--deadline-after[Filter by deadline lower bound (ISO/date string or relative)]:date' \\
            '--today[Filter to items updated since local midnight today]' \\
            '--recent[Filter to items updated in the last 7 days]' \\
            '--updated-after[Filter by updated_at lower bound (ISO/relative)]:timestamp' \\
            '--updated-before[Filter by updated_at upper bound (ISO/relative)]:timestamp' \\
            '--created-after[Filter by created_at lower bound (ISO/relative)]:timestamp' \\
            '--created-before[Filter by created_at upper bound (ISO/relative)]:timestamp' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
${zshPresenceFilterFlags}
            '--limit[Limit returned item count]:number' \\
            '--offset[Skip the first n matching rows before limit]:number' \\
            '--no-truncate[Return every matched row, overriding --limit]' \\
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
        duplicates)
          _arguments \\
            '*--status[Include lifecycle status (repeatable)]:(${statusChoices})' \\
            '--since[Only inspect items created at or after this ISO timestamp]:timestamp' \\
            '--threshold[Minimum similarity score from zero through one]:number' \\
            '--limit[Maximum duplicate clusters]:number'
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
${renderZshScheduleItemSpecs("event")}
          ;;
        remind)
          _arguments \\
${renderZshScheduleItemSpecs("reminder")}
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
            '--add-ac[Add one acceptance criterion without replacing existing]:criteria' \\
            '--remove-ac[Remove one acceptance criterion by exact text]:criteria' \\
            '--expected[Short alias for --expected-result]:expected_result' \\
            '--actual[Short alias for --actual-result]:actual_result' \\
${zshMutationCollectionFlags}
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        update-many)
          _arguments \\
${renderZshBulkSelectionFilterSpecs("applying updates", statusChoices, typeChoices, zshTagChoices)}
            '--filter-ac-missing[Select only items missing acceptance_criteria]' \\
            '--filter-estimates-missing[Select only items missing estimated_minutes]' \\
            '--filter-resolution-missing[Select only terminal items missing resolution]' \\
            '--filter-metadata-missing[Select only items missing any tracked metadata]' \\
${zshBulkPresenceFilterFlags}
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
            '--add-ac[Add one acceptance criterion without replacing existing]:criteria' \\
            '--remove-ac[Remove one acceptance criterion by exact text]:criteria' \\
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
${zshMutationCollectionFlags}
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        close-many)
          _arguments \\
${renderZshBulkSelectionFilterSpecs("closing", statusChoices, typeChoices, zshTagChoices)}
${zshBulkPresenceFilterFlags}
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
        next)
          _arguments \\
            '--type[Filter candidates by type]:(${typeChoices})' \\
            '--tag[Filter candidates by tag]:(${zshTagChoices})' \\
            '--priority[Filter candidates by priority]:(0 1 2 3 4)' \\
            '--assignee[Filter candidates by assignee]:assignee' \\
            '--assignee-filter[Filter assignee presence]:(assigned unassigned)' \\
            '--sprint[Filter candidates by sprint]:sprint' \\
            '--release[Filter candidates by release]:release' \\
            '--parent[Scope to one item subtree]:id' \\
            '--limit[Limit ready rows]:number' \\
            '--blocked-limit[Limit blocked rows]:number' \\
            '--ready-only[Omit the blocked companion list]' \\
            '--format[Output override]:(markdown toon json)' \\
            '--json[Output JSON]' \\
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
            '--highlight[Emit per-field matched-text snippets on each hit]' \\
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
${zshPresenceFilterFlags}
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
            '--provenance[Patch-free identity and agent provenance projection]' \\
            '--provenance-summary[Include bounded provenance completeness counts]' \\
            '*--harness[Filter by recorded or vocabulary-resolved harness]:harness' \\
            '*--agent-instance[Filter by privacy-safe agent instance]:instance' \\
            '*--provenance-filter[Filter by exact declared provenance value]:dimension=value' \\
            '--diff[Include per-entry field-level before/after value diffs]' \\
            '--field[With --diff, show only entries that changed this field]:field' \\
            '--verify[Verify history hash chain and replay integrity]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        events)
          _arguments \\
            '--since[Resume after a cursor or from an ISO timestamp]:cursor_or_timestamp' \\
            '*--type[Filter by mutation operation]:operation' \\
            '*--author[Filter by mutation author]:author' \\
            '*--item[Filter by item or workspace stream]:item' \\
            '--limit[Maximum events, up to 1000]:number' \\
            '--full[Include complete authoritative history entries]' \\
            '--provenance[Include patch-free identity and agent provenance]' \\
            '--provenance-summary[Include bounded provenance completeness counts]' \\
            '*--harness[Filter by recorded or vocabulary-resolved harness]:harness' \\
            '*--agent-instance[Filter by privacy-safe agent instance]:instance' \\
            '*--provenance-filter[Filter by exact declared provenance value]:dimension=value' \\
            '--follow[Continue emitting committed events]' \\
            '--interval-ms[Empty-read delay while following]:milliseconds' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        history-attest)
          _arguments \\
${renderZshArgumentSpecs(ATTEST_INVOCATIONS.map((flag) => `'${flag.flag}[${flag.description}]${flag.takes_value ? ":value" : ""}'`), { trailingContinuation: false })}
          ;;
        history-compact)
          _arguments \\
            '--id[Item ID (alternative to positional ID)]:id' \\
            '--before[Compact entries strictly before this version number or ISO timestamp]:before' \\
            '--ids[Bulk: compact an explicit comma-separated list of item ids]:ids' \\
            '--all-over[Bulk: compact every stream with more than N entries]:all-over' \\
            '--closed[Bulk: compact only closed (terminal) items streams]' \\
            '--all-streams[Bulk: compact every history stream regardless of lifecycle state]' \\
            '--min-entries[Bulk: skip streams with at most N entries]:min-entries' \\
            '--dry-run[Preview compaction impact without writing the history file]' \\
            '--author[Mutation author]:author' \\
            '--message[Audit history message]:message' \\
            '--force[Force ownership/lock override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        history-author-acknowledge)
          _arguments \\
            '*--event[Actionable unknown-author event]:item_and_line' \\
            '--all-actionable[Select every currently actionable event]' \\
            '--dry-run[Preview a deterministic source-bound plan]' \\
            '--plan-fingerprint[Apply the exact dry-run plan]:sha256' \\
            '--limit[Maximum coordinate rows returned in the plan]:number' \\
            '--attributed-author[Principal attributed by maintainer review]:author' \\
            '--reviewer[Reviewer recording the disposition]:reviewer' \\
            '--reason[Evidence-backed review rationale]:reason' \\
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
            '--id[Item ID (alternative to positional ID)]:id' \\
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
            '--id[Item ID (alternative to positional ID)]:id' \\
            '--salvage-tail[Recover an invalid suffix after a verified prefix]' \\
            '--normalize-provenance[Remove invalid provenance with aggregate evidence]' \\
            '--all[Repair every drifted stream in one audited pass]' \\
            '--dry-run[Preview the re-anchor impact without writing the history file]' \\
            '--author[Mutation author]:author' \\
            '--message[Audit history message]:message' \\
            '--force[Force ownership/lock override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        schema)
          if [[ "\${words[CURRENT-1]}" == policy-mode ]]; then
            compadd advise refuse
            return
          fi
          _arguments \\
            '1:subcommand:(${SCHEMA_SUBCOMMAND_CHOICES})' \\
            '--definition[Policy definition or proposed fields JSON]:json' \\
            '--policy[Approval policy id]:id' \\
            '--message[History rationale]:text' \\
            '--dry-run[Preview schema changes]' \\
            '--description[Human description for the custom item type, status, or field]:text' \\
            '--default-status[Default status hint for the custom item type]:status' \\
            '--folder[Storage folder for items of this custom type]:dir' \\
            '--alias[Alias for the custom type, status, or field flag (repeatable)]:name' \\
            '--role[Lifecycle role for a custom status (repeatable)]:role' \\
            '--order[Display/sort order for a custom status]:n' \\
            '--type[Value type for a custom field]:type:(string number boolean string_array array object)' \\
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
        profile)
          _arguments \\
            '1:subcommand:(list show apply lint)' \\
            '2:name:(agile ops research)' \\
            '--dry-run[Preview the apply diff without writing any files]' \\
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
            '--unbounded[Return every matching activity entry]' \\
            '--compact[Condensed activity projection]' \\
            '--raw[Emit raw compact per-event activity output]' \\
            '--full[Show full activity entries]' \\
            '--provenance[Patch-free identity and agent provenance projection]' \\
            '--provenance-summary[Include bounded provenance completeness counts]' \\
            '*--harness[Filter by recorded or vocabulary-resolved harness]:harness' \\
            '*--agent-instance[Filter by privacy-safe agent instance]:instance' \\
            '*--provenance-filter[Filter by exact declared provenance value]:dimension=value' \\
            '--stream[Emit line-delimited JSON rows (requires --json)]::mode:(rows ndjson jsonl)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        contracts)
          _arguments \\
            '--action[Filter schema by tool action]:action' \\
            '--command[Scope output to one command (narrow-by-default)]:command' \\
            '--summary[Return compact command intent summary]' \\
            '--schema-only[Return schema-only payload]' \\
            '--flags-only[Return command flag contracts only]' \\
            '--availability-only[Return action availability only]' \\
            '--runtime-only[Include only actions invocable in the current runtime]' \\
            '--active-only[Alias for --runtime-only]' \\
            '--full[Include complete command and schema contract details]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        gc)
          _arguments \\
            '--dry-run[Preview cleanup targets without deleting files]' \\
            '--scope[Limit cleanup to one or more scopes: index, embeddings, runtime, locks, checkpoints, transactions]:scope' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        stats)
          _arguments \\
            '--include-empty[Include registered zero-count type and status buckets]' \\
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
            '--text[Alias for --add]:text' \\
            '--stdin[Read comment text from stdin (supports multiline markdown)]' \\
            '--file[Read comment text from file (supports multiline markdown)]:path' \\
            '--edit[Replace the comment at 1-based index (text from positional/--add/--stdin/--file)]:index' \\
            '--delete[Delete the comment at 1-based index]:index' \\
            '--limit[Return only latest n entries]:number' \\
            '--full-history[Return complete post-mutation history]' \\
            '--if-absent[Append only when the resolved author and text are absent]' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        notes)
          _arguments \\
            '--add[Add one entry (plain text, text=<value>, markdown pairs, or - for stdin)]:text' \\
            '--text[Alias for --add]:text' \\
            '--add-json[Append one validated JSON context event]:json' \\
            '--stdin[Read entry text from stdin]' \\
            '--file[Read entry text from file]:path' \\
            '--edit[Replace the entry at a 1-based index]:index' \\
            '--delete[Delete the entry at a 1-based index]:index' \\
            '--limit[Return only latest n entries]:number' \\
            '--since[Return structured events at or after an ISO timestamp]:timestamp' \\
            '--event-type[Return structured events with this top-level type]:event_type' \\
            '--include-meta[Include result counts and truncation metadata]' \\
            '--full-history[Return complete post-mutation history]' \\
            '--if-absent[Append only when the resolved author and text are absent]' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        learnings)
          _arguments \\
            '--add[Add one entry (plain text, text=<value>, markdown pairs, or - for stdin)]:text' \\
            '--text[Alias for --add]:text' \\
            '--stdin[Read entry text from stdin]' \\
            '--file[Read entry text from file]:path' \\
            '--edit[Replace the entry at a 1-based index]:index' \\
            '--delete[Delete the entry at a 1-based index]:index' \\
            '--limit[Return only latest n entries]:number' \\
            '--full-history[Return complete post-mutation history]' \\
            '--if-absent[Append only when the resolved author and text are absent]' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        files)
          _arguments \\
            '1:subcommand:(discover lookup)' \\
            '--add[Add a linked file]:file' \\
            '--add-glob[Add linked files matching a glob]:glob' \\
            '--remove[Remove a linked file]:file' \\
            '--migrate[Migrate linked-file metadata]' \\
            '--list[List linked files]' \\
            '--apply[Apply discovered linked files]' \\
            '--note[Linked-file note]:note' \\
            '--append-stable[Preserve stable append ordering]' \\
            '--validate-paths[Validate linked-file paths]' \\
            '--scope[Filter lookup by evidence scope]:(project global)' \\
            '--limit[Maximum lookup matches]:number' \\
            '--offset[Skip the first lookup matches]:number' \\
            '--no-truncate[Return every lookup match]' \\
            '--strict-read[Require authoritative source reads]' \\
            '--explain[Include ranked source-to-work rationale]' \\
            '--lines[Attribute an inclusive source line range]:start_end' \\
            '--decision-depth[Maximum governing-decision relationship depth]:number' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        deps)
          _arguments \\
            '--format[Output format]:(tree graph context)' \\
            '--max-depth[Maximum traversal depth (0 keeps root only)]:depth' \\
            '--collapse[Collapse mode]:(none repeated)' \\
            '--summary[Return counts only without tree/graph payload]' \\
            '--node-limit[Maximum nodes in context output]:number' \\
            '--edge-limit[Maximum edges in context output]:number' \\
            '--token-budget[Maximum estimated tokens in context output]:number' \\
            '--cursor[Continue an equivalent context query]:cursor' \\
            '--direction[Context traversal direction]:(outgoing incoming both)' \\
            '--kind[Restrict context traversal to relationship kinds]:kind' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        graph)
          _arguments \\
            '1:subcommand:(ancestors descendants predecessors successors paths impact analyze audit communities redundancy dominators slack centrality articulation plan index)' \\
            '--kind[Restrict traversal to registered relationship kinds]:kind' \\
            '--max-depth[Maximum traversal depth]:depth' \\
            '--limit[Maximum returned rows per bounded collection]:number' \\
            '--after[Resume a traversal after this node id]:id' \\
            '--direction[Edge orientation for paths/impact]:(outgoing incoming both)' \\
            '--max-paths[Maximum enumerated paths]:number' \\
            '--sample[Maximum evidence sample entries per audit finding]:number' \\
            '--exempt-isolate[Item ids treated as explicitly valid isolates]:id' \\
            '--exempt-isolate-type[Item types whose active isolates are policy-valid]:type' \\
            '--save-baseline[Persist the audit census as the comparison baseline]' \\
            '--rebuild[Rebuild and warm the durable graph index]' \\
            '--clear[Delete the durable graph index]' \\
            '--summary[Return counts-first envelopes without row collections]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        test)
          _arguments \\
            '--add[Add linked test entry]:entry' \\
            '--add-json[Add linked test entry from JSON object/array]:json' \\
            '--remove[Remove linked test entry by command/path]:entry' \\
            '--remove-index[Remove linked test entry by 1-based index]:index' \\
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
            '(1)--id-prefix[Set the item ID prefix]:prefix' \\
            '(1)--prefix[Alias for --id-prefix]:prefix' \\
            '1:optional id prefix or tracker path' \\
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
            '--release-assignment[Close and release assignment]' \\
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
            '--start[Claim and start work]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--if-available[Skip work held by another author]' \\
            '--next[Atomically claim the next actionable item]' \\
            '--type[Filter --next candidates by type]:(${typeChoices})' \\
            '--tag[Filter --next candidates by tag]:(${zshTagChoices})' \\
            '--priority[Filter --next candidates by priority]:(0 1 2 3 4)' \\
            '--assignee-filter[Filter --next candidates by ownership]:assignee_filter:(assigned unassigned)' \\
            '--parent[Scope --next candidates to a subtree]:parent' \\
            '--sprint[Filter --next candidates by sprint]:sprint' \\
            '--release[Filter --next candidates by release]:release' \\
            '--max-attempts[Bound the --next candidate walk]:max_attempts' \\
            '--include-decisions[Allow human-gated Decision candidates]' \\
            '--token-budget[Bound ranked candidate tokens]:token_budget' \\
            '--explain-ranking[Include ranking provenance]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        release)
          _arguments \\
            '--pause[Return to open and release ownership]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
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
        restore)
          _arguments \\
${renderZshArgumentSpecs(RESTORE_INVOCATIONS.map((flag) => `'${flag.flag}[${flag.description}]${flag.takes_value ? ":value" : ""}'`), { trailingContinuation: false })}
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
            '--check-completeness[Check declarative required fields]' \\
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
            '--fix-scope[Grant --auto-fix scopes (estimates/timestamps/lifecycle require opt-in)]:(metadata resolution estimates timestamps lifecycle)' \\
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
            '--verbose-author-events[Include complete actionable unknown-author coordinates]' \\
            '--brief[Emit compact health details for low-token agent checks]' \\
            '--summary[Emit one-line-style health status with check names and warning count]' \\
            '--strict-exit[Return non-zero exit when health warnings are present]' \\
            '--fail-on-warn[Alias for --strict-exit]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        extension)
          _arguments \\
            '1:extension_action:(${EXTENSION_LIFECYCLE_ACTIONS})' \\
            '--init[Generate a starter extension scaffold at target path]' \\
            '--scaffold[Alias for --init]' \\
            '--capability[Capability the init scaffold targets]:capability:(${SCAFFOLD_CAPABILITIES.join(" ")})' \\
            '--install[Install extension from local path or GitHub source]' \\
            '--uninstall[Uninstall extension by name]' \\
            '--explore[List discovered extensions for selected scope]' \\
            '--manage[List managed extensions with update metadata]' \\
            '--describe[Map every surface a loaded extension registers]' \\
            '--markdown[Render describe output as a Markdown reference document]' \\
            '--output[Write describe Markdown to a file]:path:_files' \\
            '--reload[Reload extensions with cache-busted module imports]' \\
            '--watch[Enable watch mode with --reload]' \\
            '--doctor[Run consolidated extension diagnostics (summary/deep)]' \\
            '--catalog[List bundled first-party package catalog entries]' \\
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
            '--isolated[Run doctor against project-scope extensions only]' \\
            '--ignore-global[Alias for --isolated]' \\
            '--strict-exit[Return non-zero exit when doctor warnings are present]' \\
            '--fail-on-warn[Alias for --strict-exit (doctor)]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]' \\
            '*:target_or_name:_files -/'
          ;;
        package|packages)
          _arguments \\
            '1:package_action:(${PACKAGE_LIFECYCLE_ACTIONS})' \\
            '--init[Generate a starter package scaffold at target path]' \\
            '--scaffold[Alias for --init]' \\
            '--capability[Capability the init scaffold targets]:capability:(${SCAFFOLD_CAPABILITIES.join(" ")})' \\
            '--declarative[Generate a composeExtension blueprint starter]' \\
            '--install[Install package from local path, GitHub source, npm source, or bundled alias]' \\
            '--uninstall[Uninstall package by name]' \\
            '--explore[List discovered packages for selected scope]' \\
            '--manage[List managed packages with update metadata]' \\
            '--describe[Map every surface a loaded package registers]' \\
            '--markdown[Render describe output as a Markdown reference document]' \\
            '--output[Write describe Markdown to a file]:path:_files' \\
            '--reload[Reload packages with cache-busted module imports]' \\
            '--watch[Enable watch mode with --reload]' \\
            '--doctor[Run consolidated package diagnostics (summary/deep)]' \\
            '--catalog[List bundled first-party package catalog entries]' \\
            '--adopt[Adopt an unmanaged package into managed metadata]' \\
            '--adopt-all[Adopt all unmanaged packages into managed metadata]' \\
            '--activate[Activate package in selected scope settings]' \\
            '--deactivate[Deactivate package in selected scope settings]' \\
            '--project[Use project package scope (default)]' \\
            '--local[Alias for --project]' \\
            '--global[Use global package scope]' \\
            '--gh[Install from GitHub shorthand owner/repo/path]:github_spec' \\
            '--github[Alias for --gh]:github_spec' \\
            '--ref[Git ref/branch/tag for GitHub source]:git_ref' \\
            '--detail[Detail mode for package diagnostics]:detail_mode:(summary deep)' \\
            '--trace[Include registration traces in doctor deep diagnostics]' \\
            '--runtime-probe[Opt-in runtime activation probe for manage output]' \\
            '--fix-managed-state[Adopt unmanaged packages before diagnostics/update checks]' \\
            '--isolated[Run doctor against project-scope packages only]' \\
            '--ignore-global[Alias for --isolated]' \\
            '--strict-exit[Return non-zero exit when doctor warnings are present]' \\
            '--fail-on-warn[Alias for --strict-exit (doctor)]' \\
            '--dry-run[Plan upgrades without mutating]' \\
            '--cli-only[Upgrade only the pm CLI/SDK npm package]' \\
            '--packages-only[Upgrade only managed pm packages]' \\
            '--repair[Force npm global reinstall for the CLI/SDK]' \\
            '--tag[npm version or dist-tag for upgrades]:tag' \\
            '--package-name[Override the CLI package name]:package_name' \\
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
