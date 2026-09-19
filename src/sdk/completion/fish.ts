/**
 * @module sdk/completion/fish
 * Renders Fish completion from shared command contracts and runtime schema.
 */
import {
  PM_NAMESPACED_COMMAND_ALIASES
} from "../cli-contracts.js";
import { SCAFFOLD_CAPABILITIES } from "../extension/scaffold.js";
import type { CompletionRuntimeConfig } from "./shared.js";
import { ALL_COMMANDS,ATTEST_INVOCATIONS,COMMAND_COMPLETION_DESCRIPTIONS,EXTENSION_LIFECYCLE_ACTIONS,GLOBAL_COMPLETION_INLINE_PATTERNS,GLOBAL_COMPLETION_SWITCH_PATTERNS,GLOBAL_COMPLETION_VALUE_PATTERNS,GUIDE_TOPIC_CHOICES,HIDDEN_COMMAND_ALIASES,NAMESPACE_NOUNS,NAMESPACE_PREFIXES,PACKAGE_LIFECYCLE_ACTIONS,RESTORE_INVOCATIONS,SCHEMA_SUBCOMMAND_CHOICES,completionNamespaceLeaves,completionStatusValues,completionTypeValues,joinCompletionValues,normalizeRuntimeCompletionFlags } from "./shared.js";

/** Escape literal data inside a Fish single-quoted source argument. */
function escapeFishSource(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/** Protect static choices from completion-time expansion and source parsing. */
function escapeFishChoices(value: string): string {
  return escapeFishSource(value.replace(/([^a-zA-Z0-9_:./\s-])/gu, "\\$1"));
}

const FISH_COMMAND_DESCRIPTION_OVERRIDES = new Map<string, string>([
  ["calendar", "Show deadline/reminder calendar views"],
  ["schema", "Inspect and manage runtime schema"],
  [
    "profile",
    "List, show, apply, and lint project profiles (archetype bundles)",
  ],
  [
    "plan",
    "Agent-optimized Plan workflow (create/show/add-step/update-step/complete-step/link/approve/materialize)",
  ],
  ["start-task", "Lifecycle alias to claim and set in-progress"],
]);

/** Render visible Fish root commands with shell-specific descriptions and hidden-alias filtering. */
function renderFishCommandDescriptions(): string {
  return [...COMMAND_COMPLETION_DESCRIPTIONS, ["ops", "Workspace maintenance and diagnostics"] as const].filter(
    ([command]) => command !== "help" && !HIDDEN_COMMAND_ALIASES.has(command),
  )
    .map(([command, description]) => {
      const fishDescription =
        FISH_COMMAND_DESCRIPTION_OVERRIDES.get(command) ?? description;
      return `complete -c pm -n __pm_no_subcommand -a ${command.padEnd(16)} -d '${fishDescription}'`;
    })
    .join("\n");
}

/** Render schema field flags behind command predicates, isolating context snapshots from navigation leaves. */
function renderFishRuntimeFieldFlagSpecs(
  commands: string[],
  runtimeFlags: string[] | undefined,
): string {
  const normalizedFlags = normalizeRuntimeCompletionFlags(runtimeFlags).map(
    (flag) => flag.slice(2),
  );
  if (commands.length === 0 || normalizedFlags.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const command of commands) {
    const predicate = NAMESPACE_NOUNS.includes(command) || PM_NAMESPACED_COMMAND_ALIASES.some((entry) => entry.alias === command)
      ? "__pm_history_operation"
      : "__fish_seen_subcommand_from";
    for (const flag of normalizedFlags) {
      lines.push(
        `complete -c pm -n '${predicate} ${command}' -l '${escapeFishSource(flag)}' -d 'Runtime schema field flag' -r`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Emit a Fish status or type resolver with configurable cache lifetime and a literal fallback for unavailable helpers. */
function renderFishDynamicChoiceResolver(
  kind: "status" | "type",
  command: "completion-statuses" | "completion-types",
  fallback: string,
): string {
  const envKind = kind.toUpperCase();
  const escapedFallback = escapeFishSource(fallback);
  return `
function __pm_${kind}_choices
  set -l now (date +%s 2>/dev/null)
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
  set -l resolved (pm ${command} 2>/dev/null)
  if test (count $resolved) -eq 0
    set resolved '${escapedFallback}'
  end
  set -gx PM_COMPLETION_${envKind}_CACHE $resolved
  set -gx PM_COMPLETION_${envKind}_CACHE_TS $now
  printf '%s\\n' $resolved
end
`;
}

/** Render the optional cached tag resolver; eager scripts carry their tag values directly. */
function renderFishDynamicTagResolver(useEagerTagExpansion: boolean): string {
  return useEagerTagExpansion
    ? ""
    : `
function __pm_tag_choices
  set -l now (date +%s 2>/dev/null)
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
  set -l resolved (pm completion-tags 2>/dev/null)
  set -gx PM_COMPLETION_TAG_CACHE $resolved
  set -gx PM_COMPLETION_TAG_CACHE_TS $now
  printf '%s\n' $resolved
end
`;
}

/** Implements generate fish script for the public runtime surface of this module. */
export function generateFishScript(
  itemTypes: string[] = [],
  tags: string[] = [],
  eagerTagExpansion = false,
  runtime: CompletionRuntimeConfig = {},
): string {
  const namespaceLeaves = completionNamespaceLeaves(runtime);
  const listCommandNames = ALL_COMMANDS.filter(
    (command) => command === "list" || command.startsWith("list-"),
  );
  const listCmds = listCommandNames.join(" ");
  const noSubcommandList = ALL_COMMANDS.join(" ");
  const useDynamicTypeExpansion = itemTypes.length === 0;
  const typeFallbackChoices = completionTypeValues(itemTypes, runtime);
  const statusFallbackChoices = completionStatusValues(runtime);
  const typeChoices = useDynamicTypeExpansion
    ? "(__pm_type_choices)"
    : escapeFishChoices(typeFallbackChoices);
  const statusChoices = "(__pm_status_choices)";
  const guideTopicChoices = GUIDE_TOPIC_CHOICES;
  const tagChoices = joinCompletionValues(tags);
  const useEagerTagExpansion = eagerTagExpansion || tags.length > 0;
  const fishTagChoices = useEagerTagExpansion
    ? `'${escapeFishChoices(tagChoices)}'`
    : "'(__pm_tag_choices)'";
  const fishListRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(
    listCommandNames,
    runtime.command_flags?.list,
  );
  const fishCreateRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(
    ["create"],
    runtime.command_flags?.create,
  );
  const fishUpdateRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(
    ["update"],
    runtime.command_flags?.update,
  );
  const fishUpdateManyRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(
    ["update-many"],
    runtime.command_flags?.["update-many"],
  );
  const fishSearchRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(
    ["search"],
    runtime.command_flags?.search,
  );
  const fishCalendarRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(
    ["calendar", "cal"],
    runtime.command_flags?.calendar,
  );
  const fishContextRuntimeFieldFlags = renderFishRuntimeFieldFlagSpecs(
    ["context"],
    runtime.command_flags?.context,
  );
  return `# Fish shell completion for pm
# Save to ~/.config/fish/completions/pm.fish
# or run: pm completion fish > ~/.config/fish/completions/pm.fish

# Disable file completion by default
complete -c pm -f

# Global flags (available for all subcommands)
complete -c pm -l json -d 'Output JSON instead of TOON'
complete -c pm -l all -d 'Reveal every public command and compatibility alias'
complete -c pm -l quiet -d 'Suppress stdout output'
complete -c pm -l output-include -d 'Retain comma-separated read fields or sections' -r
complete -c pm -l output-limit -d 'Set the universal read row ceiling' -r
complete -c pm -l output-budget -d 'Set the universal estimated-token ceiling' -r
complete -c pm -l output-format -d 'Select the universal read encoding' -r -a 'toon json'
complete -c pm -l output-session -d 'Carry cross-call read budget and served-item state' -r
complete -c pm -l output-row-contract -d 'Include row schema metadata in read output'
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
${renderFishDynamicTagResolver(useEagerTagExpansion)}
${useDynamicTypeExpansion ? renderFishDynamicChoiceResolver("type", "completion-types", typeFallbackChoices) : ""}
${renderFishDynamicChoiceResolver("status", "completion-statuses", statusFallbackChoices)}

# Subcommands
${renderFishCommandDescriptions()}

# list* flags
for list_cmd in ${listCmds}
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l status   -d 'Filter by status' -r -a '${statusChoices}'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l all      -d 'Include every lifecycle status'
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
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l today -d 'Filter to items updated since local midnight today'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l recent -d 'Filter to items updated in the last 7 days'
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
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l filter-files-missing -d 'Alias for --no-files'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l has-docs             -d 'Select only items that have linked docs'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l no-docs              -d 'Select only items with no linked docs'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l filter-docs-missing  -d 'Alias for --no-docs'
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
complete -c pm -n '__pm_history_operation focus' -l clear -d 'Clear the focused item'

# update flags
complete -c pm -n '__pm_history_operation update' -s t -l title              -d 'Item title' -r
complete -c pm -n '__pm_history_operation update' -s d -l description        -d 'Item description' -r
complete -c pm -n '__pm_history_operation update' -s b -l body               -d 'Item body' -r
complete -c pm -n '__pm_history_operation update' -l body-file               -d 'Load the item body from a file' -r -F
complete -c pm -n '__pm_history_operation update' -s s -l status             -d 'Item status' -r -a '${statusChoices}'
complete -c pm -n '__pm_history_operation update' -l close-reason            -d 'Set close reason' -r
complete -c pm -n '__pm_history_operation update' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__pm_history_operation update' -l type                    -d 'Item type' -r -a '${typeChoices}'
complete -c pm -n '__pm_history_operation update' -l add-tags                -d 'Add tags additively without replacing existing' -r
complete -c pm -n '__pm_history_operation update' -l remove-tags             -d 'Remove tags from the existing list' -r
complete -c pm -n '__pm_history_operation update' -l add-ac                  -d 'Add one acceptance criterion without replacing existing' -r
complete -c pm -n '__pm_history_operation update' -l remove-ac               -d 'Remove one acceptance criterion by exact text' -r
complete -c pm -n '__pm_history_operation update' -l expected                -d 'Short alias for --expected-result' -r
complete -c pm -n '__pm_history_operation update' -l actual                  -d 'Short alias for --actual-result' -r
complete -c pm -n '__pm_history_operation update' -l comment                 -d 'Comment seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__pm_history_operation update' -l note                    -d 'Note seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__pm_history_operation update' -l learning                -d 'Learning seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__pm_history_operation update' -l file                    -d 'Linked file path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__pm_history_operation update' -l test                    -d 'Linked test command=<value>,path=<value>,scope=<project|global>' -r
complete -c pm -n '__pm_history_operation update' -l doc                     -d 'Linked doc path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__pm_history_operation update' -l reminder                -d 'Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>' -r
complete -c pm -n '__pm_history_operation update' -l event                   -d 'Event entry start=<iso|relative>,end=<iso|relative>,recur_*' -r
complete -c pm -n '__pm_history_operation update' -l type-option             -d 'Type option key=value or key=<name>,value=<value>' -r
complete -c pm -n '__pm_history_operation update' -l unset                   -d 'Clear scalar metadata field by name' -r
complete -c pm -n '__pm_history_operation update' -l replace-deps            -d 'Atomically replace dependencies with provided --dep values'
complete -c pm -n '__pm_history_operation update' -l replace-tests           -d 'Atomically replace linked tests with provided --test values'
complete -c pm -n '__pm_history_operation update' -l replace-files           -d 'Atomically replace linked files with provided --file values'
complete -c pm -n '__pm_history_operation update' -l replace-docs            -d 'Atomically replace linked docs with provided --doc values'
complete -c pm -n '__pm_history_operation update' -l clear-deps              -d 'Clear dependency entries'
complete -c pm -n '__pm_history_operation update' -l clear-comments          -d 'Clear comments'
complete -c pm -n '__pm_history_operation update' -l clear-notes             -d 'Clear notes'
complete -c pm -n '__pm_history_operation update' -l clear-learnings         -d 'Clear learnings'
complete -c pm -n '__pm_history_operation update' -l clear-files             -d 'Clear linked files'
complete -c pm -n '__pm_history_operation update' -l clear-tests             -d 'Clear linked tests'
complete -c pm -n '__pm_history_operation update' -l clear-docs              -d 'Clear linked docs'
complete -c pm -n '__pm_history_operation update' -l clear-reminders         -d 'Clear reminders'
complete -c pm -n '__pm_history_operation update' -l clear-events            -d 'Clear events'
complete -c pm -n '__pm_history_operation update' -l clear-type-options      -d 'Clear type options'
complete -c pm -n '__pm_history_operation update' -l author                  -d 'Mutation author' -r
complete -c pm -n '__pm_history_operation update' -l message                 -d 'History message' -r
complete -c pm -n '__pm_history_operation update' -l force                   -d 'Force override'
${fishUpdateRuntimeFieldFlags}

# update-many flags
complete -c pm -n '__pm_history_operation update-many' -l filter-status           -d 'Filter by status before applying updates' -r -a '${statusChoices}'
complete -c pm -n '__pm_history_operation update-many' -l filter-type             -d 'Filter by type before applying updates' -r -a '${typeChoices}'
complete -c pm -n '__pm_history_operation update-many' -l filter-tag              -d 'Filter by tag before applying updates' -r -a ${fishTagChoices}
complete -c pm -n '__pm_history_operation update-many' -l filter-priority         -d 'Filter by priority before applying updates' -r -a '0 1 2 3 4'
complete -c pm -n '__pm_history_operation update-many' -l filter-deadline-before  -d 'Filter by deadline upper bound' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-deadline-after   -d 'Filter by deadline lower bound' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-updated-after    -d 'Filter by updated_at lower bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-updated-before   -d 'Filter by updated_at upper bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-created-after    -d 'Filter by created_at lower bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-created-before   -d 'Filter by created_at upper bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-assignee         -d 'Filter by assignee before applying updates' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-assignee-filter  -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__pm_history_operation update-many' -l filter-parent           -d 'Filter by parent item ID' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-sprint           -d 'Filter by sprint before applying updates' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-release          -d 'Filter by release before applying updates' -r
complete -c pm -n '__pm_history_operation update-many' -l filter-ac-missing       -d 'Select only items missing acceptance_criteria'
complete -c pm -n '__pm_history_operation update-many' -l filter-estimates-missing -d 'Select only items missing estimated_minutes'
complete -c pm -n '__pm_history_operation update-many' -l filter-resolution-missing -d 'Select only terminal items missing resolution'
complete -c pm -n '__pm_history_operation update-many' -l filter-metadata-missing  -d 'Select only items missing any tracked metadata'
complete -c pm -n '__pm_history_operation update-many' -l filter-reviewer-missing   -d 'Select only items missing reviewer'
complete -c pm -n '__pm_history_operation update-many' -l filter-risk-missing       -d 'Select only items missing risk'
complete -c pm -n '__pm_history_operation update-many' -l filter-confidence-missing -d 'Select only items missing confidence'
complete -c pm -n '__pm_history_operation update-many' -l filter-sprint-missing     -d 'Select only items missing sprint'
complete -c pm -n '__pm_history_operation update-many' -l filter-release-missing    -d 'Select only items missing release'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-notes          -d 'Select only items that have notes'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-notes           -d 'Select only items with no notes'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-learnings      -d 'Select only items that have learnings'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-learnings       -d 'Select only items with no learnings'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-files          -d 'Select only items that have linked files'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-files           -d 'Select only items with no linked files'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-docs           -d 'Select only items that have linked docs'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-docs            -d 'Select only items with no linked docs'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-tests          -d 'Select only items that have linked tests'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-tests           -d 'Select only items with no linked tests'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-comments       -d 'Select only items that have comments'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-comments        -d 'Select only items with no comments'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-deps           -d 'Select only items that have dependencies'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-deps            -d 'Select only items with no dependencies'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-body           -d 'Select only items with non-empty body'
complete -c pm -n '__pm_history_operation update-many' -l filter-empty-body         -d 'Select only items with empty body'
complete -c pm -n '__pm_history_operation update-many' -l filter-has-linked-command -d 'Select only items that have a linked command'
complete -c pm -n '__pm_history_operation update-many' -l filter-no-linked-command  -d 'Select only items with no linked command'
complete -c pm -n '__pm_history_operation update-many' -l ids                     -d 'Explicit comma-separated ID allowlist' -r
complete -c pm -n '__pm_history_operation update-many' -l limit                   -d 'Limit matched item count' -r
complete -c pm -n '__pm_history_operation update-many' -l offset                  -d 'Skip first n matched rows' -r
complete -c pm -n '__pm_history_operation update-many' -l dry-run                 -d 'Preview updates without mutating'
complete -c pm -n '__pm_history_operation update-many' -l rollback                -d 'Rollback checkpoint ID' -r
complete -c pm -n '__pm_history_operation update-many' -l no-checkpoint           -d 'Disable checkpoint creation during apply mode'
complete -c pm -n '__pm_history_operation update-many' -s t -l title              -d 'Item title' -r
complete -c pm -n '__pm_history_operation update-many' -s d -l description        -d 'Item description' -r
complete -c pm -n '__pm_history_operation update-many' -s b -l body               -d 'Item body' -r
complete -c pm -n '__pm_history_operation update-many' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__pm_history_operation update-many' -l type                    -d 'Item type' -r -a '${typeChoices}'
complete -c pm -n '__pm_history_operation update-many' -l tags                    -d 'Comma-separated tags' -r
complete -c pm -n '__pm_history_operation update-many' -l add-tags                -d 'Add tags additively without replacing existing' -r
complete -c pm -n '__pm_history_operation update-many' -l remove-tags             -d 'Remove tags from the existing list' -r
complete -c pm -n '__pm_history_operation update-many' -l deadline                -d 'Deadline (ISO/date string or relative)' -r
complete -c pm -n '__pm_history_operation update-many' -l estimate                -d 'Estimated minutes' -r
complete -c pm -n '__pm_history_operation update-many' -l acceptance-criteria     -d 'Acceptance criteria' -r
complete -c pm -n '__pm_history_operation update-many' -l add-ac                  -d 'Add one acceptance criterion without replacing existing' -r
complete -c pm -n '__pm_history_operation update-many' -l remove-ac               -d 'Remove one acceptance criterion by exact text' -r
complete -c pm -n '__pm_history_operation update-many' -l definition-of-ready     -d 'Definition of ready' -r
complete -c pm -n '__pm_history_operation update-many' -l order                   -d 'Planning order/rank' -r
complete -c pm -n '__pm_history_operation update-many' -l goal                    -d 'Goal identifier' -r
complete -c pm -n '__pm_history_operation update-many' -l objective               -d 'Objective identifier' -r
complete -c pm -n '__pm_history_operation update-many' -l value                   -d 'Business value summary' -r
complete -c pm -n '__pm_history_operation update-many' -l impact                  -d 'Business impact summary' -r
complete -c pm -n '__pm_history_operation update-many' -l outcome                 -d 'Expected outcome summary' -r
complete -c pm -n '__pm_history_operation update-many' -l why-now                 -d 'Why-now rationale' -r
complete -c pm -n '__pm_history_operation update-many' -l reviewer                -d 'Reviewer' -r
complete -c pm -n '__pm_history_operation update-many' -l risk                    -d 'Risk level' -r
complete -c pm -n '__pm_history_operation update-many' -l confidence              -d 'Confidence level' -r
complete -c pm -n '__pm_history_operation update-many' -l sprint                  -d 'Sprint identifier' -r
complete -c pm -n '__pm_history_operation update-many' -l release                 -d 'Release identifier' -r
complete -c pm -n '__pm_history_operation update-many' -l reporter                -d 'Issue reporter' -r
complete -c pm -n '__pm_history_operation update-many' -l severity                -d 'Issue severity' -r
complete -c pm -n '__pm_history_operation update-many' -l environment             -d 'Issue environment context' -r
complete -c pm -n '__pm_history_operation update-many' -l repro-steps             -d 'Issue reproduction steps' -r
complete -c pm -n '__pm_history_operation update-many' -l resolution              -d 'Issue resolution summary' -r
complete -c pm -n '__pm_history_operation update-many' -l expected-result         -d 'Issue expected behavior' -r
complete -c pm -n '__pm_history_operation update-many' -l actual-result           -d 'Issue observed behavior' -r
complete -c pm -n '__pm_history_operation update-many' -l expected                 -d 'Short alias for --expected-result' -r
complete -c pm -n '__pm_history_operation update-many' -l actual                   -d 'Short alias for --actual-result' -r
complete -c pm -n '__pm_history_operation update-many' -l affected-version        -d 'Affected version identifier' -r
complete -c pm -n '__pm_history_operation update-many' -l fixed-version           -d 'Fixed version identifier' -r
complete -c pm -n '__pm_history_operation update-many' -l component               -d 'Issue component ownership' -r
complete -c pm -n '__pm_history_operation update-many' -l regression              -d 'Regression marker true|false|1|0' -r
complete -c pm -n '__pm_history_operation update-many' -l customer-impact         -d 'Customer impact summary' -r
complete -c pm -n '__pm_history_operation update-many' -l dep                     -d 'Dependency seed id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>' -r
complete -c pm -n '__pm_history_operation update-many' -l dep-remove              -d 'Dependency removal selector id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>' -r
complete -c pm -n '__pm_history_operation update-many' -l replace-deps            -d 'Atomically replace dependencies with provided --dep values'
complete -c pm -n '__pm_history_operation update-many' -l replace-tests           -d 'Atomically replace linked tests with provided --test values'
complete -c pm -n '__pm_history_operation update-many' -l replace-files           -d 'Atomically replace linked files with provided --file values'
complete -c pm -n '__pm_history_operation update-many' -l replace-docs            -d 'Atomically replace linked docs with provided --doc values'
complete -c pm -n '__pm_history_operation update-many' -l comment                 -d 'Comment seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__pm_history_operation update-many' -l note                    -d 'Note seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__pm_history_operation update-many' -l learning                -d 'Learning seed author=<value>,created_at=<iso|now>,text=<value>' -r
complete -c pm -n '__pm_history_operation update-many' -l file                    -d 'Linked file path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__pm_history_operation update-many' -l test                    -d 'Linked test command=<value>,path=<value>,scope=<project|global>' -r
complete -c pm -n '__pm_history_operation update-many' -l doc                     -d 'Linked doc path=<value>,scope=<project|global>,note=<text>' -r
complete -c pm -n '__pm_history_operation update-many' -l reminder                -d 'Reminder entry at=<iso|relative>|date=<iso|relative>,text=<text>|title=<text>' -r
complete -c pm -n '__pm_history_operation update-many' -l event                   -d 'Event entry start=<iso|relative>,end=<iso|relative>,recur_*' -r
complete -c pm -n '__pm_history_operation update-many' -l type-option             -d 'Type option key=value or key=<name>,value=<value>' -r
complete -c pm -n '__pm_history_operation update-many' -l unset                   -d 'Clear scalar metadata field by name' -r
complete -c pm -n '__pm_history_operation update-many' -l clear-deps              -d 'Clear dependency entries'
complete -c pm -n '__pm_history_operation update-many' -l clear-comments          -d 'Clear comments'
complete -c pm -n '__pm_history_operation update-many' -l clear-notes             -d 'Clear notes'
complete -c pm -n '__pm_history_operation update-many' -l clear-learnings         -d 'Clear learnings'
complete -c pm -n '__pm_history_operation update-many' -l clear-files             -d 'Clear linked files'
complete -c pm -n '__pm_history_operation update-many' -l clear-tests             -d 'Clear linked tests'
complete -c pm -n '__pm_history_operation update-many' -l clear-docs              -d 'Clear linked docs'
complete -c pm -n '__pm_history_operation update-many' -l clear-reminders         -d 'Clear reminders'
complete -c pm -n '__pm_history_operation update-many' -l clear-events            -d 'Clear events'
complete -c pm -n '__pm_history_operation update-many' -l clear-type-options      -d 'Clear type options'
complete -c pm -n '__pm_history_operation update-many' -l author                  -d 'Mutation author' -r
complete -c pm -n '__pm_history_operation update-many' -l message                 -d 'History message' -r
complete -c pm -n '__pm_history_operation update-many' -l force                   -d 'Force override'
${fishUpdateManyRuntimeFieldFlags}

# files flags
complete -c pm -n '__fish_seen_subcommand_from files' -a 'discover lookup' -d 'Linked-file subcommand'
complete -c pm -n '__fish_seen_subcommand_from files' -l add -d 'Add a linked file' -r
complete -c pm -n '__fish_seen_subcommand_from files' -l add-glob -d 'Add linked files matching a glob' -r
complete -c pm -n '__fish_seen_subcommand_from files' -l remove -d 'Remove a linked file' -r
complete -c pm -n '__fish_seen_subcommand_from files' -l migrate -d 'Migrate linked-file metadata'
complete -c pm -n '__fish_seen_subcommand_from files' -l list -d 'List linked files'
complete -c pm -n '__fish_seen_subcommand_from files' -l apply -d 'Apply discovered linked files'
complete -c pm -n '__fish_seen_subcommand_from files' -l note -d 'Linked-file note' -r
complete -c pm -n '__fish_seen_subcommand_from files' -l append-stable -d 'Preserve stable append ordering'
complete -c pm -n '__fish_seen_subcommand_from files' -l validate-paths -d 'Validate linked-file paths'
complete -c pm -n '__fish_seen_subcommand_from files' -l scope -d 'Filter lookup by evidence scope' -r -a 'project global'
complete -c pm -n '__fish_seen_subcommand_from files' -l limit -d 'Maximum lookup matches' -r
complete -c pm -n '__fish_seen_subcommand_from files' -l offset -d 'Skip the first lookup matches' -r
complete -c pm -n '__fish_seen_subcommand_from files' -l no-truncate -d 'Return every lookup match'
complete -c pm -n '__fish_seen_subcommand_from files' -l strict-read -d 'Require authoritative source reads'
complete -c pm -n '__fish_seen_subcommand_from files' -l explain -d 'Include ranked source-to-work rationale'
complete -c pm -n '__fish_seen_subcommand_from files' -l lines -d 'Attribute an inclusive source line range' -r
complete -c pm -n '__fish_seen_subcommand_from files' -l decision-depth -d 'Maximum governing-decision relationship depth' -r


# search flags
complete -c pm -n '__fish_seen_subcommand_from search' -l mode          -d 'Search mode' -r -a 'keyword semantic hybrid'
complete -c pm -n '__fish_seen_subcommand_from search' -l match-mode    -d 'Token match mode' -r -a 'and or exact'
complete -c pm -n '__fish_seen_subcommand_from search' -l min-score     -d 'Per-query minimum score threshold' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l count          -d 'Return only the match count'
complete -c pm -n '__fish_seen_subcommand_from search' -l include-linked -d 'Include linked content in scoring'
complete -c pm -n '__fish_seen_subcommand_from search' -l highlight      -d 'Emit per-field matched-text snippets on each hit'
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
complete -c pm -n '__fish_seen_subcommand_from search' -l filter-files-missing -d 'Alias for --no-files'
complete -c pm -n '__fish_seen_subcommand_from search' -l has-docs           -d 'Select only items that have linked docs'
complete -c pm -n '__fish_seen_subcommand_from search' -l no-docs            -d 'Select only items with no linked docs'
complete -c pm -n '__fish_seen_subcommand_from search' -l filter-docs-missing  -d 'Alias for --no-docs'
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
complete -c pm -n '__pm_history_operation context' -l date      -d 'Anchor date/time (ISO/date string or relative)' -r
complete -c pm -n '__pm_history_operation context' -l from      -d 'Agenda lower bound (ISO/date string or relative)' -r
complete -c pm -n '__pm_history_operation context' -l to        -d 'Agenda upper bound (ISO/date string or relative)' -r
complete -c pm -n '__pm_history_operation context' -l past      -d 'Include past entries in bounded windows'
complete -c pm -n '__pm_history_operation context' -l type      -d 'Filter by type' -r -a '${typeChoices}'
complete -c pm -n '__pm_history_operation context' -l tag       -d 'Filter by tag' -r -a ${fishTagChoices}
complete -c pm -n '__pm_history_operation context' -l priority  -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__pm_history_operation context' -l assignee  -d 'Filter by assignee' -r
complete -c pm -n '__pm_history_operation context' -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__pm_history_operation context' -l sprint    -d 'Filter by sprint' -r
complete -c pm -n '__pm_history_operation context' -l release   -d 'Filter by release' -r
complete -c pm -n '__pm_history_operation context' -l parent    -d 'Scope snapshot to one item subtree' -r
complete -c pm -n '__pm_history_operation context' -l limit     -d 'Limit focus and agenda rows per section' -r
complete -c pm -n '__pm_history_operation context' -l depth     -d 'Context depth' -r -a 'brief standard deep full'
complete -c pm -n '__pm_history_operation context' -l format    -d 'Output override' -r -a 'markdown toon json'
${fishContextRuntimeFieldFlags}

# next flags
complete -c pm -n '__pm_history_operation next' -l type           -d 'Filter candidates by type' -r -a '${typeChoices}'
complete -c pm -n '__pm_history_operation next' -l tag            -d 'Filter candidates by tag' -r -a ${fishTagChoices}
complete -c pm -n '__pm_history_operation next' -l priority       -d 'Filter candidates by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__pm_history_operation next' -l assignee       -d 'Filter candidates by assignee' -r
complete -c pm -n '__pm_history_operation next' -l assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__pm_history_operation next' -l sprint         -d 'Filter candidates by sprint' -r
complete -c pm -n '__pm_history_operation next' -l release        -d 'Filter candidates by release' -r
complete -c pm -n '__pm_history_operation next' -l parent         -d 'Scope to one item subtree' -r
complete -c pm -n '__pm_history_operation next' -l limit          -d 'Limit ready rows' -r
complete -c pm -n '__pm_history_operation next' -l blocked-limit  -d 'Limit blocked rows' -r
complete -c pm -n '__pm_history_operation next' -l ready-only     -d 'Omit the blocked companion list'
complete -c pm -n '__pm_history_operation next' -l format         -d 'Output override' -r -a 'markdown toon json'

# guide flags
complete -c pm -n '__fish_seen_subcommand_from guide' -l list      -d 'Show guide topic index'
complete -c pm -n '__fish_seen_subcommand_from guide' -l format    -d 'Output override' -r -a 'markdown toon json'
complete -c pm -n '__fish_seen_subcommand_from guide' -l depth     -d 'Guide detail depth' -r -a 'brief standard deep'
complete -c pm -n '__fish_seen_subcommand_from guide' -a '${guideTopicChoices}' -d 'Guide topic'

# reindex flags
complete -c pm -n '__pm_history_operation reindex' -l mode -d 'Reindex mode' -r -a 'keyword semantic hybrid'
complete -c pm -n '__pm_history_operation reindex' -l progress -d 'Emit progress updates to stderr'

# get flags
complete -c pm -n '__fish_seen_subcommand_from get' -l depth -d 'Detail depth' -r -a 'brief standard deep full'
complete -c pm -n '__fish_seen_subcommand_from get' -l full -d 'Explicit full item read'
complete -c pm -n '__fish_seen_subcommand_from get' -l fields -d 'Render custom comma-separated item fields' -r
complete -c pm -n '__fish_seen_subcommand_from get' -l tree -d 'Include descendant subtree in result payload'
complete -c pm -n '__fish_seen_subcommand_from get' -l tree-depth -d 'Cap subtree depth for --tree (0 = root only)' -r

# Read the first command positions after consuming recognized global options.
function __pm_history_tokens
  set -l tokens (commandline -opc)
  set -l skip_value 0
  set -l positions 0
  set -l command_path
  for token in $tokens[2..-1]
    if test $skip_value -eq 1
      set skip_value 0
      continue
    end
    switch (string replace -a _ - -- "$token")
      case ${GLOBAL_COMPLETION_VALUE_PATTERNS.replaceAll("|", " ")}
        set skip_value 1
        continue
      case ${GLOBAL_COMPLETION_INLINE_PATTERNS.split("|").map((pattern) => `'${pattern}'`).join(" ")} ${GLOBAL_COMPLETION_SWITCH_PATTERNS.replaceAll("|", " ")}
        continue
      case --
        printf '%s\\n' --
        return
    end
    if test $positions -eq 0; and test "$token" = ctx
      set token context
    end
    printf '%s\\n' "$token"
    set positions (math $positions + 1)
    set -a command_path "$token"
    if not contains -- (string join ' ' -- $command_path) ${NAMESPACE_PREFIXES.map((prefix) => `'${prefix}'`).join(" ")}
      return
    end
  end
  if test $skip_value -eq 1
    printf '%s\\n' --value
  end
end

# Match only the command positions, keeping item history separate from maintenance.
function __pm_history_operation
  set -l tokens (__pm_history_tokens)
  switch (string join ' ' -- $tokens)
${[...PM_NAMESPACED_COMMAND_ALIASES].sort((left, right) => right.canonical_argv.length - left.canonical_argv.length).map((entry) => `    case '${entry.canonical}' '${entry.canonical} *'\n      contains -- '${entry.alias}' $argv\n      return`).join("\n")}
  end
  contains -- "$tokens[1]" $argv
end
${Object.entries(namespaceLeaves).map(([noun, leaves]) => `complete -c pm -n 'test (string join " " -- (__pm_history_tokens)) = "${noun}"' -a '${leaves}' -d '${noun} operation'`).join("\n")}
${RESTORE_INVOCATIONS.map((flag) => `complete -c pm -n '__pm_history_operation restore restore' -l ${flag.flag.slice(2)}${flag.takes_value ? " -r" : ""}`).join("\n")}

${ATTEST_INVOCATIONS.map((flag) => `complete -c pm -n '__pm_history_operation history-attest' -l ${flag.flag.slice(2)}${flag.takes_value ? " -r" : ""}`).join("\n")}

# history / activity flags
complete -c pm -n '__pm_history_operation history'  -l limit -d 'Max history entries' -r
complete -c pm -n '__pm_history_operation history'  -l compact -d 'Condensed history projection'
complete -c pm -n '__pm_history_operation history'  -l full -d 'Show full history entries'
complete -c pm -n '__pm_history_operation history'  -l provenance -d 'Patch-free identity and agent provenance projection'
complete -c pm -n '__pm_history_operation history'  -l provenance-summary -d 'Include bounded provenance completeness counts'
complete -c pm -n '__pm_history_operation history'  -l harness -d 'Filter by recorded or vocabulary-resolved harness' -r
complete -c pm -n '__pm_history_operation history'  -l agent-instance -d 'Filter by privacy-safe agent instance' -r
complete -c pm -n '__pm_history_operation history'  -l provenance-filter -d 'Filter by exact declared provenance value' -r
complete -c pm -n '__pm_history_operation history'  -l diff -d 'Include per-entry field-level before/after value diffs'
complete -c pm -n '__pm_history_operation history'  -l field -d 'With --diff, show only entries that changed this field' -r
complete -c pm -n '__pm_history_operation history'  -l verify -d 'Verify history hash chain and replay integrity'
complete -c pm -n '__pm_history_operation events' -l since -d 'Resume after a cursor or from an ISO timestamp' -r
complete -c pm -n '__pm_history_operation events' -l type -d 'Filter by mutation operation' -r
complete -c pm -n '__pm_history_operation events' -l author -d 'Filter by mutation author' -r
complete -c pm -n '__pm_history_operation events' -l item -d 'Filter by item or workspace stream' -r
complete -c pm -n '__pm_history_operation events' -l limit -d 'Maximum events, up to 1000' -r
complete -c pm -n '__pm_history_operation events' -l full -d 'Include complete authoritative history entries'
complete -c pm -n '__pm_history_operation events' -l provenance -d 'Include patch-free identity and agent provenance'
complete -c pm -n '__pm_history_operation events' -l provenance-summary -d 'Include bounded provenance completeness counts'
complete -c pm -n '__pm_history_operation events' -l harness -d 'Filter by recorded or vocabulary-resolved harness' -r
complete -c pm -n '__pm_history_operation events' -l agent-instance -d 'Filter by privacy-safe agent instance' -r
complete -c pm -n '__pm_history_operation events' -l provenance-filter -d 'Filter by exact declared provenance value' -r
complete -c pm -n '__pm_history_operation events' -l follow -d 'Continue emitting committed events'
complete -c pm -n '__pm_history_operation events' -l interval-ms -d 'Empty-read delay while following' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l before -d 'Compact entries strictly before this version number or ISO timestamp' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l id -d 'Item ID (alternative to positional ID)' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l ids -d 'Bulk: compact an explicit comma-separated list of item ids' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l all-over -d 'Bulk: compact every stream with more than N entries' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l closed -d 'Bulk: compact only closed (terminal) items streams'
complete -c pm -n '__pm_history_operation history-compact compact' -l all-streams -d 'Bulk: compact every history stream regardless of lifecycle state'
complete -c pm -n '__pm_history_operation history-compact compact' -l min-entries -d 'Bulk: skip streams with at most N entries' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l dry-run -d 'Preview compaction impact without writing the history file'
complete -c pm -n '__pm_history_operation history-compact compact' -l author -d 'Mutation author' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l message -d 'Audit history message' -r
complete -c pm -n '__pm_history_operation history-compact compact' -l force -d 'Force ownership/lock override'
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l event -d 'Actionable unknown-author event' -r
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l all-actionable -d 'Select every currently actionable event'
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l dry-run -d 'Preview a deterministic source-bound plan'
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l plan-fingerprint -d 'Apply the exact dry-run plan' -r
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l limit -d 'Maximum coordinate rows returned in the plan' -r
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l attributed-author -d 'Principal attributed by maintainer review' -r
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l reviewer -d 'Reviewer recording the disposition' -r
complete -c pm -n '__fish_seen_subcommand_from history-author-acknowledge' -l reason -d 'Evidence-backed review rationale' -r
complete -c pm -n '__pm_history_operation history-redact redact' -l literal -d 'Literal string matcher to redact from history/item payloads' -r
complete -c pm -n '__pm_history_operation history-redact redact' -l id -d 'Item ID (alternative to positional ID)' -r
complete -c pm -n '__pm_history_operation history-redact redact' -l regex -d 'Regex matcher to redact (/pattern/flags or raw pattern)' -r
complete -c pm -n '__pm_history_operation history-redact redact' -l replacement -d 'Replacement text (defaults to [redacted])' -r
complete -c pm -n '__pm_history_operation history-redact redact' -l dry-run -d 'Preview redaction impact without writing files'
complete -c pm -n '__pm_history_operation history-redact redact' -l author -d 'Mutation author' -r
complete -c pm -n '__pm_history_operation history-redact redact' -l message -d 'Audit history message' -r
complete -c pm -n '__pm_history_operation history-redact redact' -l force -d 'Force ownership/lock override'
complete -c pm -n '__pm_history_operation history-repair repair' -l salvage-tail -d 'Recover an invalid suffix after a verified prefix'
complete -c pm -n '__pm_history_operation history-repair repair' -l id -d 'Item ID (alternative to positional ID)' -r
complete -c pm -n '__pm_history_operation history-repair repair' -l normalize-provenance -d 'Remove invalid provenance with aggregate evidence'
complete -c pm -n '__pm_history_operation history-repair repair' -l all -d 'Repair every drifted stream in one audited pass'
complete -c pm -n '__pm_history_operation history-repair repair' -l dry-run -d 'Preview the re-anchor impact without writing the history file'
complete -c pm -n '__pm_history_operation history-repair repair' -l author -d 'Mutation author' -r
complete -c pm -n '__pm_history_operation history-repair repair' -l message -d 'Audit history message' -r
complete -c pm -n '__pm_history_operation history-repair repair' -l force -d 'Force ownership/lock override'
complete -c pm -n '__fish_seen_subcommand_from schema' -a '${SCHEMA_SUBCOMMAND_CHOICES}' -d 'Schema subcommand'
complete -c pm -n '__fish_seen_subcommand_from schema; and __fish_seen_subcommand_from policy-mode' -a 'advise refuse' -d 'Policy enforcement'
complete -c pm -n '__fish_seen_subcommand_from schema' -l definition -d 'Policy definition or proposed fields JSON' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l policy -d 'Approval policy id' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l message -d 'History rationale' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l dry-run -d 'Preview schema changes'
complete -c pm -n '__fish_seen_subcommand_from schema' -l description -d 'Human description for the custom item type, status, or field' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l default-status -d 'Default status hint for the custom item type' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l folder -d 'Storage folder for items of this custom type' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l alias -d 'Alias for the custom type, status, or field flag (repeatable)' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l role -d 'Lifecycle role for a custom status (repeatable)' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l order -d 'Display/sort order for a custom status' -r
complete -c pm -n '__fish_seen_subcommand_from schema' -l type -d 'Value type for a custom field' -r -a 'string number boolean string_array array object'
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
complete -c pm -n '__fish_seen_subcommand_from profile' -a 'list show apply lint' -d 'Profile subcommand'
complete -c pm -n '__fish_seen_subcommand_from profile' -a 'agile ops research' -d 'Profile name'
complete -c pm -n '__fish_seen_subcommand_from profile' -l dry-run -d 'Preview the apply diff without writing any files'
complete -c pm -n '__fish_seen_subcommand_from profile' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from profile' -l force -d 'Force ownership/lock override'
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
complete -c pm -n '__pm_history_operation activity activity' -l id -d 'Filter by item ID' -r
complete -c pm -n '__pm_history_operation activity activity' -l op -d 'Filter by history operation' -r
complete -c pm -n '__pm_history_operation activity activity' -l author -d 'Filter by history author' -r
complete -c pm -n '__pm_history_operation activity activity' -l from -d 'Lower timestamp bound (ISO/date string or relative)' -r
complete -c pm -n '__pm_history_operation activity activity' -l to -d 'Upper timestamp bound (ISO/date string or relative)' -r
complete -c pm -n '__pm_history_operation activity activity' -l limit -d 'Max activity entries' -r
complete -c pm -n '__pm_history_operation activity activity' -l unbounded -d 'Return every matching activity entry'
complete -c pm -n '__pm_history_operation activity activity' -l compact -d 'Condensed activity projection'
complete -c pm -n '__pm_history_operation activity activity' -l raw -d 'Emit raw compact per-event activity output'
complete -c pm -n '__pm_history_operation activity activity' -l full -d 'Show full activity entries'
complete -c pm -n '__pm_history_operation activity activity' -l provenance -d 'Patch-free identity and agent provenance projection'
complete -c pm -n '__pm_history_operation activity activity' -l provenance-summary -d 'Include bounded provenance completeness counts'
complete -c pm -n '__pm_history_operation activity activity' -l harness -d 'Filter by recorded or vocabulary-resolved harness' -r
complete -c pm -n '__pm_history_operation activity activity' -l agent-instance -d 'Filter by privacy-safe agent instance' -r
complete -c pm -n '__pm_history_operation activity activity' -l provenance-filter -d 'Filter by exact declared provenance value' -r
complete -c pm -n '__pm_history_operation activity activity' -l stream -d 'Emit line-delimited JSON rows (requires --json)'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l action -d 'Filter schema by tool action' -r
complete -c pm -n '__fish_seen_subcommand_from contracts' -l command -d 'Scope output to one command (narrow-by-default)' -r
complete -c pm -n '__fish_seen_subcommand_from contracts' -l summary -d 'Return compact command intent summary'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l schema-only -d 'Return schema-only payload'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l flags-only -d 'Return command flag contracts only'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l availability-only -d 'Return action availability only'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l runtime-only -d 'Include only actions invocable in the current runtime'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l active-only -d 'Alias for --runtime-only'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l full -d 'Include complete command and schema contract details'
complete -c pm -n '__fish_seen_subcommand_from deps' -l format -d 'Output format' -r -a 'tree graph context'
complete -c pm -n '__fish_seen_subcommand_from deps' -l max-depth -d 'Maximum traversal depth (0 keeps root only)' -r
complete -c pm -n '__fish_seen_subcommand_from deps' -l collapse -d 'Collapse mode' -r -a 'none repeated'
complete -c pm -n '__fish_seen_subcommand_from deps' -l summary -d 'Return counts only without tree/graph payload'
complete -c pm -n '__fish_seen_subcommand_from deps' -l node-limit -d 'Maximum nodes in context output' -r
complete -c pm -n '__fish_seen_subcommand_from deps' -l edge-limit -d 'Maximum edges in context output' -r
complete -c pm -n '__fish_seen_subcommand_from deps' -l token-budget -d 'Maximum estimated tokens in context output' -r
complete -c pm -n '__fish_seen_subcommand_from deps' -l cursor -d 'Continue an equivalent context query' -r
complete -c pm -n '__fish_seen_subcommand_from deps' -l direction -d 'Context traversal direction' -r -a 'outgoing incoming both'
complete -c pm -n '__fish_seen_subcommand_from deps' -l kind -d 'Restrict context traversal to relationship kinds' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -a 'ancestors descendants predecessors successors paths impact analyze audit communities redundancy dominators slack centrality articulation plan index' -d 'Graph query'
complete -c pm -n '__fish_seen_subcommand_from graph' -l kind -d 'Restrict traversal to registered relationship kinds' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l max-depth -d 'Maximum traversal depth' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l limit -d 'Maximum returned rows per bounded collection' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l after -d 'Resume a traversal after this node id' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l direction -d 'Edge orientation for paths/impact' -r -a 'outgoing incoming both'
complete -c pm -n '__fish_seen_subcommand_from graph' -l max-paths -d 'Maximum enumerated paths' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l sample -d 'Maximum evidence sample entries per audit finding' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l exempt-isolate -d 'Item ids treated as explicitly valid isolates' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l exempt-isolate-type -d 'Item types whose active isolates are policy-valid' -r
complete -c pm -n '__fish_seen_subcommand_from graph' -l save-baseline -d 'Persist the audit census as the comparison baseline'
complete -c pm -n '__fish_seen_subcommand_from graph' -l rebuild -d 'Rebuild and warm the durable graph index'
complete -c pm -n '__fish_seen_subcommand_from graph' -l clear -d 'Delete the durable graph index'
complete -c pm -n '__fish_seen_subcommand_from graph' -l summary -d 'Return counts-first envelopes without row collections'

# comments / notes / learnings flags
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l add -d 'Add one entry (text=<value> or plain text)' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l text -d 'Alias for --add' -r
complete -c pm -n '__fish_seen_subcommand_from notes' -l add-json -d 'Append one validated JSON context event' -r
complete -c pm -n '__fish_seen_subcommand_from notes' -l since -d 'Return structured events at or after an ISO timestamp' -r
complete -c pm -n '__fish_seen_subcommand_from notes' -l event-type -d 'Return structured events with this top-level type' -r
complete -c pm -n '__fish_seen_subcommand_from notes' -l include-meta -d 'Include result counts and truncation metadata'
complete -c pm -n '__fish_seen_subcommand_from comments' -l stdin -d 'Read comment text from stdin (supports multiline markdown)'
complete -c pm -n '__fish_seen_subcommand_from comments' -l file -d 'Read comment text from file (supports multiline markdown)' -r
complete -c pm -n '__fish_seen_subcommand_from comments' -l edit -d 'Replace the comment at 1-based index (text from positional/--add/--stdin/--file)' -r
complete -c pm -n '__fish_seen_subcommand_from comments' -l delete -d 'Delete the comment at 1-based index' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l if-absent -d 'Append only when the resolved author and text are absent'
complete -c pm -n '__fish_seen_subcommand_from notes' -l stdin -d 'Read entry text from stdin'
complete -c pm -n '__fish_seen_subcommand_from notes' -l file -d 'Read entry text from file' -r
complete -c pm -n '__fish_seen_subcommand_from notes' -l edit -d 'Replace the entry at a 1-based index' -r
complete -c pm -n '__fish_seen_subcommand_from notes' -l delete -d 'Delete the entry at a 1-based index' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l limit -d 'Return only latest n entries' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l full-history -d 'Return complete post-mutation history'
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l author -d 'Entry author' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l force -d 'Force override'

# test flags
complete -c pm -n '__fish_seen_subcommand_from test' -l add -d 'Add linked test entry' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l add-json -d 'Add linked test entry from JSON object/array' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l remove -d 'Remove linked test entry' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l remove-index -d 'Remove linked test entry by 1-based index' -r
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
complete -c pm -n '__pm_history_operation test-all' -l status  -d 'Filter by status' -r -a 'open in_progress'
complete -c pm -n '__pm_history_operation test-all' -l limit -d 'Limit matching items before running linked tests' -r
complete -c pm -n '__pm_history_operation test-all' -l offset -d 'Skip matching items before running linked tests' -r
complete -c pm -n '__pm_history_operation test-all' -l background -d 'Run linked tests in managed background mode'
complete -c pm -n '__pm_history_operation test-all' -l timeout -d 'Default timeout seconds' -r
complete -c pm -n '__pm_history_operation test-all' -l progress -d 'Emit linked-test progress to stderr'
complete -c pm -n '__pm_history_operation test-all' -l env-set -d 'Set linked-test runtime environment values' -r
complete -c pm -n '__pm_history_operation test-all' -l env-clear -d 'Clear linked-test runtime environment values' -r
complete -c pm -n '__pm_history_operation test-all' -l shared-host-safe -d 'Apply shared-host-safe runtime defaults'
complete -c pm -n '__pm_history_operation test-all' -l pm-context -d 'PM linked-test context mode' -r -a 'schema tracker auto'
complete -c pm -n '__pm_history_operation test-all' -l override-linked-pm-context -d 'Force run-level --pm-context over per-linked-test metadata'
complete -c pm -n '__pm_history_operation test-all' -l fail-on-context-mismatch -d 'Fail when context item counts mismatch'
complete -c pm -n '__pm_history_operation test-all' -l fail-on-skipped -d 'Treat skipped linked tests as dependency failures'
complete -c pm -n '__pm_history_operation test-all' -l fail-on-empty-test-run -d 'Treat empty linked-test selections as failures'
complete -c pm -n '__pm_history_operation test-all' -l require-assertions-for-pm -d 'Require assertions for linked PM command tests'
complete -c pm -n '__pm_history_operation test-all' -l check-context -d 'Preflight linked PM command context diagnostics before execution'
complete -c pm -n '__pm_history_operation test-all' -l auto-pm-context -d 'Auto-remediate tracker-read context mismatches using tracker context'

# test-runs flags
complete -c pm -n '__fish_seen_subcommand_from test-runs' -a 'list status logs stop resume' -d 'test-runs subcommand'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l status -d 'Filter background runs by status' -r -a 'queued running passed failed stopped canceled'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l limit -d 'Limit returned runs' -r
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l stream -d 'Background log stream selector' -r -a 'stdout stderr both'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l tail -d 'Tail number of lines from logs' -r
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l force -d 'Force-stop run with SIGKILL'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l author -d 'Resume author' -r

# gc flags
complete -c pm -n '__pm_history_operation gc' -l dry-run -d 'Preview cleanup targets without deleting files'
complete -c pm -n '__pm_history_operation gc' -l scope -d 'Limit cleanup to index/embeddings/runtime/locks scopes' -r

# stats flags
complete -c pm -n '__pm_history_operation stats' -l include-empty -d 'Include registered zero-count type and status buckets'
complete -c pm -n '__pm_history_operation stats' -l storage -d 'Include aggregate history-stream storage metrics'
complete -c pm -n '__pm_history_operation stats' -l metadata-coverage -d 'Include metadata coverage percentages overall and by type'
complete -c pm -n '__pm_history_operation stats' -l field-utilization -d 'Include content-field utilization rates across all items'
complete -c pm -n '__pm_history_operation stats' -l by-assignee -d 'Lifecycle-bucketed breakdown grouped by assignee'
complete -c pm -n '__pm_history_operation stats' -l by-tag -d 'Lifecycle-bucketed breakdown grouped by tag'
complete -c pm -n '__pm_history_operation stats' -l by-priority -d 'Lifecycle-bucketed breakdown grouped by priority'
complete -c pm -n '__pm_history_operation stats' -l tag-prefix -d 'With --by-tag: only count tags with this prefix' -r
complete -c pm -n '__pm_history_operation stats' -l analytics -d 'Improvement ledger/history analytics JSON' -r

# append flags
complete -c pm -n '__fish_seen_subcommand_from append' -s b -l body -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from append' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from append' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from append' -l force -d 'Force override'

# close flags
complete -c pm -n '__pm_history_operation close' -l release-assignment -d 'Close and release assignment'
complete -c pm -n '__pm_history_operation release' -l pause -d 'Return to open and release ownership'
complete -c pm -n '__pm_history_operation claim' -l start -d 'Claim and start work'
complete -c pm -n '__pm_history_operation claim release start-task pause-task close close-task delete' -l author -d 'Mutation author' -r
complete -c pm -n '__pm_history_operation claim release start-task pause-task close close-task delete' -l message -d 'History message' -r
complete -c pm -n '__pm_history_operation claim release start-task pause-task close close-task delete' -l force -d 'Force override'
complete -c pm -n '__fish_seen_subcommand_from claim' -l if-available -d 'Skip work held by another author'
complete -c pm -n '__fish_seen_subcommand_from claim' -l next -d 'Atomically claim the next actionable item'
complete -c pm -n '__fish_seen_subcommand_from claim' -l token-budget -d 'Bound ranked candidate tokens' -r
complete -c pm -n '__fish_seen_subcommand_from claim' -l explain-ranking -d 'Include ranking provenance'
complete -c pm -n '__pm_history_operation close close-task' -l validate-close -d 'Validate closure metadata mode' -r -a 'off warn strict'
complete -c pm -n '__pm_history_operation close' -l reason -d 'Closure reason' -r
complete -c pm -n '__pm_history_operation close' -l close-reason -d 'Alias for --reason' -r
complete -c pm -n '__pm_history_operation close' -l resolution -d 'Closure resolution summary' -r
complete -c pm -n '__pm_history_operation close' -l expected-result -d 'Expected behavior note' -r
complete -c pm -n '__pm_history_operation close' -l actual-result -d 'Observed behavior note' -r
complete -c pm -n '__pm_history_operation close' -l expected -d 'Short alias for --expected-result' -r
complete -c pm -n '__pm_history_operation close' -l actual -d 'Short alias for --actual-result' -r
complete -c pm -n '__pm_history_operation delete' -l dry-run -d 'Preview the item file that would be deleted without mutating'

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
complete -c pm -n '__pm_history_operation close-many' -l filter-status          -d 'Filter by status before closing' -r -a '${statusChoices}'
complete -c pm -n '__pm_history_operation close-many' -l filter-type            -d 'Filter by type before closing' -r -a '${typeChoices}'
complete -c pm -n '__pm_history_operation close-many' -l filter-tag             -d 'Filter by tag before closing' -r -a ${fishTagChoices}
complete -c pm -n '__pm_history_operation close-many' -l filter-priority        -d 'Filter by priority before closing' -r -a '0 1 2 3 4'
complete -c pm -n '__pm_history_operation close-many' -l filter-deadline-before -d 'Filter by deadline upper bound' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-deadline-after  -d 'Filter by deadline lower bound' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-updated-after   -d 'Filter by updated_at lower bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-updated-before  -d 'Filter by updated_at upper bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-created-after   -d 'Filter by created_at lower bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-created-before  -d 'Filter by created_at upper bound (ISO/relative)' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-assignee        -d 'Filter by assignee before closing' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-assignee-filter -d 'Filter assignee presence' -r -a 'assigned unassigned'
complete -c pm -n '__pm_history_operation close-many' -l filter-parent          -d 'Filter by parent item ID' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-sprint          -d 'Filter by sprint before closing' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-release         -d 'Filter by release before closing' -r
complete -c pm -n '__pm_history_operation close-many' -l filter-reviewer-missing   -d 'Select only items missing reviewer'
complete -c pm -n '__pm_history_operation close-many' -l filter-risk-missing       -d 'Select only items missing risk'
complete -c pm -n '__pm_history_operation close-many' -l filter-confidence-missing -d 'Select only items missing confidence'
complete -c pm -n '__pm_history_operation close-many' -l filter-sprint-missing     -d 'Select only items missing sprint'
complete -c pm -n '__pm_history_operation close-many' -l filter-release-missing    -d 'Select only items missing release'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-notes          -d 'Select only items that have notes'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-notes           -d 'Select only items with no notes'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-learnings      -d 'Select only items that have learnings'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-learnings       -d 'Select only items with no learnings'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-files          -d 'Select only items that have linked files'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-files           -d 'Select only items with no linked files'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-docs           -d 'Select only items that have linked docs'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-docs            -d 'Select only items with no linked docs'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-tests          -d 'Select only items that have linked tests'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-tests           -d 'Select only items with no linked tests'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-comments       -d 'Select only items that have comments'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-comments        -d 'Select only items with no comments'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-deps           -d 'Select only items that have dependencies'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-deps            -d 'Select only items with no dependencies'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-body           -d 'Select only items with non-empty body'
complete -c pm -n '__pm_history_operation close-many' -l filter-empty-body         -d 'Select only items with empty body'
complete -c pm -n '__pm_history_operation close-many' -l filter-has-linked-command -d 'Select only items that have a linked command'
complete -c pm -n '__pm_history_operation close-many' -l filter-no-linked-command  -d 'Select only items with no linked command'
complete -c pm -n '__pm_history_operation close-many' -l ids                    -d 'Explicit comma-separated ID allowlist' -r
complete -c pm -n '__pm_history_operation close-many' -l limit                  -d 'Limit matched item count' -r
complete -c pm -n '__pm_history_operation close-many' -l offset                 -d 'Skip first n matched rows' -r
complete -c pm -n '__pm_history_operation close-many' -l reason                 -d 'Optional shared close reason applied to every matched item' -r
complete -c pm -n '__pm_history_operation close-many' -l resolution             -d 'Shared closure resolution' -r
complete -c pm -n '__pm_history_operation close-many' -l expected-result        -d 'Shared expected-result note' -r
complete -c pm -n '__pm_history_operation close-many' -l actual-result          -d 'Shared actual-result note' -r
complete -c pm -n '__pm_history_operation close-many' -l expected               -d 'Short alias for --expected-result' -r
complete -c pm -n '__pm_history_operation close-many' -l actual                 -d 'Short alias for --actual-result' -r
complete -c pm -n '__pm_history_operation close-many' -l validate-close         -d 'Validate closure metadata per item' -r -a 'off warn strict'
complete -c pm -n '__pm_history_operation close-many' -l author                 -d 'Mutation author' -r
complete -c pm -n '__pm_history_operation close-many' -l message                -d 'History message' -r
complete -c pm -n '__pm_history_operation close-many' -l force                  -d 'Re-close terminal matches and override ownership'
complete -c pm -n '__pm_history_operation close-many' -l dry-run                -d 'Preview matched items without mutating'
complete -c pm -n '__pm_history_operation close-many' -l rollback               -d 'Rollback checkpoint ID' -r
complete -c pm -n '__pm_history_operation close-many' -l no-checkpoint          -d 'Disable checkpoint creation during apply mode'

# validate flags
complete -c pm -n '__pm_history_operation validate' -l check-completeness -d 'Check declarative required fields'
complete -c pm -n '__pm_history_operation validate' -l check-metadata -d 'Run metadata completeness checks'
complete -c pm -n '__pm_history_operation validate' -l metadata-profile -d 'Select metadata validation profile for --check-metadata' -r -a 'core strict custom'
complete -c pm -n '__pm_history_operation validate' -l check-resolution -d 'Run closed-item resolution metadata checks'
complete -c pm -n '__pm_history_operation validate' -l check-lifecycle -d 'Run active-item lifecycle governance drift checks'
complete -c pm -n '__pm_history_operation validate' -l check-stale-blockers -d 'Include stale blocker-pattern diagnostics in lifecycle checks'
complete -c pm -n '__pm_history_operation validate' -l dependency-cycle-severity -d 'Set dependency-cycle warning policy for lifecycle checks' -r -a 'off warn error'
complete -c pm -n '__pm_history_operation validate' -l parent-cycle-severity -d 'Set parent-hierarchy cycle warning policy for lifecycle checks' -r -a 'off warn error'
complete -c pm -n '__pm_history_operation validate' -l check-files -d 'Run linked-file and orphaned-file checks'
complete -c pm -n '__pm_history_operation validate' -l scan-mode -d 'Select file candidate scan mode for --check-files' -r -a 'default tracked-all tracked-all-strict'
complete -c pm -n '__pm_history_operation validate' -l include-pm-internals -d 'Include PM storage internals in tracked-all candidate scans'
complete -c pm -n '__pm_history_operation validate' -l verbose-file-lists -d 'Include full file-path lists for validate --check-files details'
complete -c pm -n '__pm_history_operation validate' -l verbose-diagnostics -d 'Include full validate diagnostic ID lists instead of compact summaries'
complete -c pm -n '__pm_history_operation validate' -l all-affected-ids -d 'Emit complete missing_* affected-ID lists with no truncation (implied by --json)'
complete -c pm -n '__pm_history_operation validate' -l strict-exit -d 'Return non-zero exit when validation warnings are present'
complete -c pm -n '__pm_history_operation validate' -l fail-on-warn -d 'Alias for --strict-exit'
complete -c pm -n '__pm_history_operation validate' -l fix-hints -d 'Add a machine-executable fix_hints[] of pm commands to each failing check'
complete -c pm -n '__pm_history_operation validate' -l auto-fix -d 'Apply the safe, deterministic subset of fix-hint remediations automatically'
complete -c pm -n '__pm_history_operation validate' -l dry-run -d 'Preview planned --auto-fix/--prune-missing fixes without applying them'
complete -c pm -n '__pm_history_operation validate' -l fix-scope -d 'Grant --auto-fix scopes (estimates/timestamps/lifecycle require opt-in)' -r -a 'metadata resolution estimates timestamps lifecycle'
complete -c pm -n '__pm_history_operation validate' -l prune-missing -d 'Remove stale linked-file/doc links classified as deleted'
complete -c pm -n '__pm_history_operation validate' -l check-history-drift -d 'Run item/history hash drift checks'
complete -c pm -n '__pm_history_operation validate' -l check-command-references -d 'Run linked-command PM-ID reference checks'
complete -c pm -n '__fish_seen_subcommand_from init' -l preset -d 'Governance preset for new setups' -r -a 'minimal default strict'
complete -c pm -n '__fish_seen_subcommand_from init' -l id-prefix -d 'Set the item ID prefix' -r
complete -c pm -n '__fish_seen_subcommand_from init' -l prefix -d 'Alias for --id-prefix' -r
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
complete -c pm -n '__pm_history_operation health' -l strict-directories -d 'Treat optional item-type directories as required failures'
complete -c pm -n '__pm_history_operation health' -l check-only -d 'Run read-only health diagnostics without refreshing vectors'
complete -c pm -n '__pm_history_operation health' -l no-refresh -d 'Disable automatic vector refresh attempts during health checks'
complete -c pm -n '__pm_history_operation health' -l refresh-vectors -d 'Explicitly enable vector refresh attempts during health checks'
complete -c pm -n '__pm_history_operation health' -l verbose-stale-items -d 'Include full stale vectorization ID lists in health output'
complete -c pm -n '__pm_history_operation health' -l verbose-author-events -d 'Include complete actionable unknown-author coordinates'
complete -c pm -n '__pm_history_operation health' -l brief -d 'Emit compact health details for low-token agent checks'
complete -c pm -n '__pm_history_operation health' -l summary -d 'Emit one-line-style health status with check names and warning count'
complete -c pm -n '__pm_history_operation health' -l strict-exit -d 'Return non-zero exit when health warnings are present'
complete -c pm -n '__pm_history_operation health' -l fail-on-warn -d 'Alias for --strict-exit'

# completion shell argument
complete -c pm -n '__fish_seen_subcommand_from completion' -l eager-tags -d 'Embed current tracker tags directly in script output'
complete -c pm -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell type'

# templates subcommands
complete -c pm -n '__fish_seen_subcommand_from templates' -a 'save list show' -d 'Templates command'

# extension lifecycle flags
complete -c pm -n '__fish_seen_subcommand_from extension' -a '${EXTENSION_LIFECYCLE_ACTIONS}' -d 'Extension action subcommand'
complete -c pm -n '__fish_seen_subcommand_from extension' -l init -d 'Generate starter extension scaffold'
complete -c pm -n '__fish_seen_subcommand_from extension' -l scaffold -d 'Alias for --init'
complete -c pm -n '__fish_seen_subcommand_from extension' -l capability -d 'Capability the init scaffold targets' -r -a '${SCAFFOLD_CAPABILITIES.join(" ")}'
complete -c pm -n '__fish_seen_subcommand_from extension' -l install -d 'Install extension from local path or GitHub source'
complete -c pm -n '__fish_seen_subcommand_from extension' -l uninstall -d 'Uninstall extension by name'
complete -c pm -n '__fish_seen_subcommand_from extension' -l explore -d 'List discovered extensions for selected scope'
complete -c pm -n '__fish_seen_subcommand_from extension' -l manage -d 'List managed extensions with update metadata'
complete -c pm -n '__fish_seen_subcommand_from extension' -l describe -d 'Map every surface a loaded extension registers'
complete -c pm -n '__fish_seen_subcommand_from extension' -l markdown -d 'Render describe output as a Markdown reference document'
complete -c pm -n '__fish_seen_subcommand_from extension' -l output -d 'Write describe Markdown to a file' -r
complete -c pm -n '__fish_seen_subcommand_from extension' -l reload -d 'Reload extensions with cache-busted module imports'
complete -c pm -n '__fish_seen_subcommand_from extension' -l watch -d 'Enable watch mode with --reload'
complete -c pm -n '__fish_seen_subcommand_from extension' -l doctor -d 'Run consolidated extension diagnostics'
complete -c pm -n '__fish_seen_subcommand_from extension' -l catalog -d 'List bundled first-party package catalog entries'
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
complete -c pm -n '__fish_seen_subcommand_from extension' -l isolated -d 'Run doctor against project-scope extensions only'
complete -c pm -n '__fish_seen_subcommand_from extension' -l ignore-global -d 'Alias for --isolated'
complete -c pm -n '__fish_seen_subcommand_from extension' -l strict-exit -d 'Return non-zero exit when doctor warnings are present'
complete -c pm -n '__fish_seen_subcommand_from extension' -l fail-on-warn -d 'Alias for --strict-exit (doctor)'

# package lifecycle flags
for package_cmd in package packages
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -a '${PACKAGE_LIFECYCLE_ACTIONS}' -d 'Package action subcommand'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l init -d 'Generate starter package scaffold'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l scaffold -d 'Alias for --init'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l capability -d 'Capability the init scaffold targets' -r -a '${SCAFFOLD_CAPABILITIES.join(" ")}'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l declarative -d 'Generate a composeExtension blueprint starter'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l install -d 'Install package from local path, GitHub source, npm source, or bundled alias'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l uninstall -d 'Uninstall package by name'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l explore -d 'List discovered packages for selected scope'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l manage -d 'List managed packages with update metadata'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l describe -d 'Map every surface a loaded package registers'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l markdown -d 'Render describe output as a Markdown reference document'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l output -d 'Write describe Markdown to a file' -r
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l reload -d 'Reload packages with cache-busted module imports'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l watch -d 'Enable watch mode with --reload'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l doctor -d 'Run consolidated package diagnostics'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l catalog -d 'List bundled first-party package catalog entries'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l adopt -d 'Adopt an unmanaged package into managed metadata'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l adopt-all -d 'Adopt all unmanaged packages into managed metadata'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l activate -d 'Activate package in selected scope settings'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l deactivate -d 'Deactivate package in selected scope settings'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l project -d 'Use project package scope'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l local -d 'Alias for --project'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l global -d 'Use global package scope'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l gh -d 'GitHub shorthand owner/repo/path' -r
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l github -d 'Alias for --gh' -r
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l ref -d 'Git ref/branch/tag for GitHub source' -r
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l detail -d 'Detail mode for package diagnostics' -r -a 'summary deep'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l trace -d 'Include registration traces in doctor deep diagnostics'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l runtime-probe -d 'Opt-in runtime activation probe for manage output'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l fix-managed-state -d 'Adopt unmanaged packages before diagnostics/update checks'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l isolated -d 'Run doctor against project-scope packages only'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l ignore-global -d 'Alias for --isolated'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l strict-exit -d 'Return non-zero exit when doctor warnings are present'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l fail-on-warn -d 'Alias for --strict-exit (doctor)'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l dry-run -d 'Plan upgrades without mutating'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l cli-only -d 'Upgrade only the pm CLI/SDK npm package'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l packages-only -d 'Upgrade only managed pm packages'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l repair -d 'Force npm global reinstall for the CLI/SDK'
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l tag -d 'npm version or dist-tag for upgrades' -r
  complete -c pm -n "__fish_seen_subcommand_from $package_cmd" -l package-name -d 'Override the CLI package name' -r
end`;
}
