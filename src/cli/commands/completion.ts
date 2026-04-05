import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  CALENDAR_FLAG_CONTRACTS,
  CONTEXT_FLAG_CONTRACTS,
  CREATE_FLAG_CONTRACTS,
  GLOBAL_FLAG_CONTRACTS,
  HEALTH_FLAG_CONTRACTS,
  LIST_FILTER_FLAG_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  SEARCH_FLAG_CONTRACTS,
  UPDATE_FLAG_CONTRACTS,
  toCompletionFlagString,
} from "../../sdk/cli-contracts.js";
import { BUILTIN_ITEM_TYPE_VALUES } from "../../types/index.js";

export type CompletionShell = "bash" | "zsh" | "fish";

export interface CompletionResult {
  shell: CompletionShell;
  script: string;
  setup_hint: string;
}

const VALID_SHELLS: CompletionShell[] = ["bash", "zsh", "fish"];
const DEFAULT_ITEM_TYPES = [...BUILTIN_ITEM_TYPE_VALUES];

const ALL_COMMANDS = [...PM_CORE_COMMAND_NAMES];
const LIST_FLAGS = toCompletionFlagString(LIST_FILTER_FLAG_CONTRACTS);
const CREATE_FLAGS = toCompletionFlagString(CREATE_FLAG_CONTRACTS);
const UPDATE_FLAGS = toCompletionFlagString(UPDATE_FLAG_CONTRACTS);
const CALENDAR_FLAGS = toCompletionFlagString(CALENDAR_FLAG_CONTRACTS);
const CONTEXT_FLAGS = toCompletionFlagString(CONTEXT_FLAG_CONTRACTS);
const SEARCH_FLAGS = toCompletionFlagString(SEARCH_FLAG_CONTRACTS);
const HEALTH_FLAGS = toCompletionFlagString(HEALTH_FLAG_CONTRACTS);

const MUTATION_FLAGS = "--author --message --force --json --quiet --path --no-extensions --profile --help";

const GLOBAL_FLAGS = GLOBAL_FLAG_CONTRACTS.flatMap((entry) => [entry.short, entry.flag])
  .filter((value): value is string => Boolean(value))
  .join(" ");

function joinCompletionValues(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right))
    .join(" ");
}

export function generateBashScript(itemTypes: string[] = DEFAULT_ITEM_TYPES, tags: string[] = []): string {
  const cmds = ALL_COMMANDS.join(" ");
  const typeValues = itemTypes.join(" ");
  const tagValues = joinCompletionValues(tags);
  // Note: "${...}" inside regular (non-template) strings are literal characters,
  // not JS interpolation. Only backtick template literals interpolate ${...}.
  const compgen = (flags: string): string => `$(compgen -W "${flags}" -- "$cur")`;
  return [
    "# bash completion for pm",
    '# Source this file or add \'eval "$(pm completion bash)"\' to ~/.bashrc',
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
    `    COMPREPLY=(${compgen(typeValues)})`,
    "    return 0",
    "  fi",
    "",
    '  if [[ "$prev" == "--tag" ]]; then',
    `    COMPREPLY=(${compgen(tagValues)})`,
    "    return 0",
    "  fi",
    "",
    '  local cmd="${COMP_WORDS[1]}"',
    "",
    '  case "$cmd" in',
    "    list|list-all|list-draft|list-open|list-in-progress|list-blocked|list-closed|list-canceled)",
    `      COMPREPLY=(${compgen(LIST_FLAGS)})`,
    "      ;;",
    "    create)",
    `      COMPREPLY=(${compgen(CREATE_FLAGS)})`,
    "      ;;",
    "    update)",
    `      COMPREPLY=(${compgen(UPDATE_FLAGS)})`,
    "      ;;",
    "    calendar|cal)",
      `      COMPREPLY=(${compgen(CALENDAR_FLAGS)})`,
      "      ;;",
    "    context|ctx)",
    `      COMPREPLY=(${compgen(CONTEXT_FLAGS)})`,
    "      ;;",
    "    search)",
    `      COMPREPLY=(${compgen(SEARCH_FLAGS)})`,
    "      ;;",
    "    reindex)",
    `      COMPREPLY=(${compgen("--mode --progress --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    config)",
    `      COMPREPLY=(${compgen("--criterion --format --policy --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    extension)",
    `      COMPREPLY=(${compgen("--install --uninstall --explore --manage --doctor --adopt --activate --deactivate --project --local --global --gh --github --ref --detail --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    comments)",
    `      COMPREPLY=(${compgen("--add --limit --author --message --allow-audit-comment --force --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    comments-audit)",
    `      COMPREPLY=(${compgen("--status --type --assignee --limit-items --latest --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    notes|learnings)",
    `      COMPREPLY=(${compgen("--add --limit --author --message --force --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    files)",
    `      COMPREPLY=(${compgen("--add --add-glob --remove --migrate --append-stable --validate-paths --audit --author --message --force --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    docs)",
    `      COMPREPLY=(${compgen("--add --add-glob --remove --migrate --validate-paths --audit --author --message --force --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    deps)",
    `      COMPREPLY=(${compgen("--format --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    test)",
    `      COMPREPLY=(${compgen("--add --remove --run --background --timeout --progress --env-set --env-clear --shared-host-safe --pm-context --fail-on-context-mismatch --fail-on-skipped --require-assertions-for-pm --author --message --force --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    test-all)",
    `      COMPREPLY=(${compgen("--status --background --timeout --progress --env-set --env-clear --shared-host-safe --pm-context --fail-on-context-mismatch --fail-on-skipped --require-assertions-for-pm --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    test-runs)",
    `      COMPREPLY=(${compgen("list status logs stop resume --status --limit --stream --tail --force --author --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    validate)",
    `      COMPREPLY=(${compgen("--check-metadata --check-resolution --check-files --scan-mode --include-pm-internals --strict-exit --fail-on-warn --check-history-drift --check-command-references --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    health)",
    `      COMPREPLY=(${compgen(HEALTH_FLAGS)})`,
    "      ;;",
    "    history)",
    `      COMPREPLY=(${compgen("--limit --diff --verify --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    activity)",
    `      COMPREPLY=(${compgen("--limit --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    contracts)",
    `      COMPREPLY=(${compgen("--action --command --schema-only --runtime-only --active-only --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    close)",
    `      COMPREPLY=(${compgen("--author --message --validate-close --force --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    claim|release|delete|append|restore)",
    `      COMPREPLY=(${compgen(MUTATION_FLAGS)})`,
    "      ;;",
    "    completion)",
    `      COMPREPLY=(${compgen("bash zsh fish")})`,
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

export function generateZshScript(itemTypes: string[] = DEFAULT_ITEM_TYPES, tags: string[] = []): string {
  const cmds = ALL_COMMANDS.map((c) => `'${c}'`).join(" ");
  const typeChoices = itemTypes.join(" ");
  const tagChoices = joinCompletionValues(tags);
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
    'list:List active items with optional filters'
    'list-all:List all items with optional filters'
    'list-draft:List draft items with optional filters'
    'list-open:List open items with optional filters'
    'list-in-progress:List in-progress items with optional filters'
    'list-blocked:List blocked items with optional filters'
    'list-closed:List closed items with optional filters'
    'list-canceled:List canceled items with optional filters'
    'calendar:Show calendar views for deadlines and reminders'
    'cal:Alias for calendar'
    'context:Show a token-efficient project context snapshot'
    'ctx:Alias for context'
    'get:Show item details by ID'
    'search:Search items with keyword, semantic, or hybrid modes'
    'reindex:Rebuild search artifacts'
    'history:Show item history entries'
    'activity:Show recent activity across items'
    'restore:Restore an item to an earlier state'
    'update:Update item fields and metadata'
    'close:Close an item with a required reason'
    'delete:Delete an item and record the change'
    'append:Append text to an item body'
    'comments:List or add comments for an item'
    'comments-audit:Audit latest comments across filtered items'
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
    'templates:Manage reusable create templates'
    'completion:Generate shell completion'
    'help:Display help for a command'
  )
  _describe 'command' commands
}

_pm() {
  local context state line
  _arguments -C \\
    '--json[Output JSON instead of TOON]' \\
    '--quiet[Suppress stdout output]' \\
    '--path[Override PM path for this command]:path:_files -/' \\
    '--no-extensions[Disable extension loading]' \\
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
            '--tag[Filter by tag]:(${tagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--deadline-before[Filter by deadline upper bound (ISO/date string or relative)]:date' \\
            '--deadline-after[Filter by deadline lower bound (ISO/date string or relative)]:date' \\
            '--assignee[Filter by assignee (use none for unassigned)]:assignee' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--limit[Limit returned item count]:number' \\
            '--offset[Skip the first n matching rows before limit]:number' \\
            '--include-body[Include item body in each returned list row]' \\
            '--stream[Emit line-delimited JSON rows (requires --json)]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]' \\
            '--path[Override PM path]:path:_files -/'
          ;;
        create)
          _arguments \\
            '(-t --title)'{-t,--title}'[Item title]:title' \\
            '(-d --description)'{-d,--description}'[Item description]:description' \\
            '--type[Item type]:(${typeChoices})' \\
            '--create-mode[Create required-option policy mode]:(strict progressive)' \\
            '(-s --status)'{-s,--status}'[Item status]:(draft open in_progress blocked)' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '--tags[Comma-separated tags]:tags' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '--deadline[Deadline (ISO/date string or relative +6h/+1d/+2w/+6m)]:deadline' \\
            '--estimate[Estimated minutes]:minutes' \\
            '--acceptance-criteria[Acceptance criteria]:criteria' \\
            '--reminder[Reminder entry at=<iso|relative>,text=<text>]:reminder' \\
            '--event[Event entry start=<iso|relative>,end=<iso|relative>,recur_*]:event' \\
            '--type-option[Type option key=value or key=<name>,value=<value>]:type_option' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--assignee[Assignee (none to unset)]:assignee' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        update)
          _arguments \\
            '(-t --title)'{-t,--title}'[Item title]:title' \\
            '(-d --description)'{-d,--description}'[Item description]:description' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '(-s --status)'{-s,--status}'[Item status]:(draft open in_progress blocked canceled)' \\
            '--close-reason[Set close reason (none to clear)]:close_reason' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '--type[Item type]:(${typeChoices})' \\
            '--tags[Comma-separated tags]:tags' \\
            '--reminder[Reminder entry at=<iso|relative>,text=<text> (none to clear)]:reminder' \\
            '--event[Event entry start=<iso|relative>,end=<iso|relative>,recur_* (none to clear)]:event' \\
            '--type-option[Type option key=value or key=<name>,value=<value> (none to clear)]:type_option' \\
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
            '--type[Filter by type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${tagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--status[Filter by status]:(draft open in_progress blocked closed canceled)' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--include[Include event sources]:(all deadlines reminders events)' \\
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
            '--tag[Filter by tag]:(${tagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--assignee[Filter by assignee]:assignee' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--limit[Limit focus and agenda rows per section]:number' \\
            '--format[Output override]:(markdown toon json)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        search)
          _arguments \\
            '--mode[Search mode]:(keyword semantic hybrid)' \\
            '--include-linked[Include linked content in scoring]' \\
            '--limit[Max results]:number' \\
            '--type[Filter by type]:(${typeChoices})' \\
            '--tag[Filter by tag]:(${tagChoices})' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--json[Output JSON]' \\
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
            '--diff[Include changed-field patch summary]' \\
            '--verify[Verify history hash chain and replay integrity]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        activity)
          _arguments \\
            '--limit[Max entries]:number' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        contracts)
          _arguments \\
            '--action[Filter schema by tool action]:action' \\
            '--command[Filter command flag contracts]:command' \\
            '--schema-only[Return schema-only payload]' \\
            '--runtime-only[Include only actions invocable in the current runtime]' \\
            '--active-only[Alias for --runtime-only]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        comments)
          _arguments \\
            '--add[Add one entry (plain text, text=<value>, markdown pairs, or - for stdin)]:text' \\
            '--limit[Return only latest n entries]:number' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--allow-audit-comment[Allow non-owner append-only comment audits without requiring --force]' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        notes|learnings)
          _arguments \\
            '--add[Add one entry (plain text, text=<value>, markdown pairs, or - for stdin)]:text' \\
            '--limit[Return only latest n entries]:number' \\
            '--author[Entry author (falls back to PM_AUTHOR/settings)]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        deps)
          _arguments \\
            '--format[Output format]:(tree graph)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        test)
          _arguments \\
            '--add[Add linked test entry]:entry' \\
            '--remove[Remove linked test entry by command/path]:entry' \\
            '--run[Run linked tests]' \\
            '--background[Run linked tests in managed background mode]' \\
            '--timeout[Default timeout seconds]:seconds' \\
            '--progress[Emit linked-test progress to stderr]' \\
            '--env-set[Set linked-test runtime environment values]:entry' \\
            '--env-clear[Clear linked-test runtime environment values]:name' \\
            '--shared-host-safe[Apply shared-host-safe runtime defaults]' \\
            '--pm-context[PM linked-test context mode]:(schema tracker)' \\
            '--fail-on-context-mismatch[Fail when context item counts mismatch]' \\
            '--fail-on-skipped[Treat skipped linked tests as dependency failures]' \\
            '--require-assertions-for-pm[Require assertions for linked PM command tests]' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        test-all)
          _arguments \\
            '--status[Filter by status]:(open in_progress)' \\
            '--background[Run linked tests in managed background mode]' \\
            '--timeout[Default timeout seconds]:seconds' \\
            '--progress[Emit linked-test progress to stderr]' \\
            '--env-set[Set linked-test runtime environment values]:entry' \\
            '--env-clear[Clear linked-test runtime environment values]:name' \\
            '--shared-host-safe[Apply shared-host-safe runtime defaults]' \\
            '--pm-context[PM linked-test context mode]:(schema tracker)' \\
            '--fail-on-context-mismatch[Fail when context item counts mismatch]' \\
            '--fail-on-skipped[Treat skipped linked tests as dependency failures]' \\
            '--require-assertions-for-pm[Require assertions for linked PM command tests]' \\
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
        config)
          _arguments \\
            '--criterion[Definition-of-Done criterion (repeatable for set)]:criterion' \\
            '--format[Item format for item-format key]:format:(toon json_markdown)' \\
            '--policy[Policy value for supported policy keys]:policy' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        close)
          _arguments \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--validate-close[Validate closure metadata mode]:(warn strict)' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        validate)
          _arguments \\
            '--check-metadata[Run metadata completeness checks]' \\
            '--check-resolution[Run closed-item resolution metadata checks]' \\
            '--check-files[Run linked-file and orphaned-file checks]' \\
            '--scan-mode[Select file candidate scan mode for --check-files]:(default tracked-all tracked-all-strict)' \\
            '--include-pm-internals[Include PM storage internals in tracked-all candidate scans]' \\
            '--strict-exit[Return non-zero exit when validation warnings are present]' \\
            '--fail-on-warn[Alias for --strict-exit]' \\
            '--check-history-drift[Run item/history hash drift checks]' \\
            '--check-command-references[Run linked-command PM-ID reference checks]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        health)
          _arguments \\
            '--strict-directories[Treat optional item-type directories as required failures]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        comments-audit)
          _arguments \\
            '--status[Filter by item status]:status:(draft open in_progress blocked closed canceled)' \\
            '--type[Filter by item type]:(${typeChoices})' \\
            '--assignee[Filter by assignee (none for unassigned)]:assignee' \\
            '--limit-items[Limit returned item count]:number' \\
            '--latest[Return latest n comments per item]:number' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        extension)
          _arguments \\
            '--install[Install extension from local path or GitHub source]' \\
            '--uninstall[Uninstall extension by name]' \\
            '--explore[List discovered extensions for selected scope]' \\
            '--manage[List managed extensions with update metadata]' \\
            '--doctor[Run consolidated extension diagnostics (summary/deep)]' \\
            '--adopt[Adopt an unmanaged extension into managed metadata]' \\
            '--activate[Activate extension in selected scope settings]' \\
            '--deactivate[Deactivate extension in selected scope settings]' \\
            '--project[Use project extension scope (default)]' \\
            '--local[Alias for --project]' \\
            '--global[Use global extension scope]' \\
            '--gh[Install from GitHub shorthand owner/repo/path]:github_spec' \\
            '--github[Alias for --gh]:github_spec' \\
            '--ref[Git ref/branch/tag for GitHub source]:git_ref' \\
            '--detail[Detail mode for extension diagnostics]:detail_mode:(summary deep)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]' \\
            '*:target_or_name:_files -/'
          ;;
        completion)
          _arguments '1:shell:(bash zsh fish)'
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

export function generateFishScript(itemTypes: string[] = DEFAULT_ITEM_TYPES, tags: string[] = []): string {
  const listCmds = ALL_COMMANDS.filter((command) => command === "list" || command.startsWith("list-")).join(" ");
  const noSubcommandList = ALL_COMMANDS.join(" ");
  const typeChoices = itemTypes.join(" ");
  const tagChoices = joinCompletionValues(tags);
  return `# Fish shell completion for pm
# Save to ~/.config/fish/completions/pm.fish
# or run: pm completion fish > ~/.config/fish/completions/pm.fish

# Disable file completion by default
complete -c pm -f

# Global flags (available for all subcommands)
complete -c pm -l json -d 'Output JSON instead of TOON'
complete -c pm -l quiet -d 'Suppress stdout output'
complete -c pm -l path -d 'Override PM path for this command' -r
complete -c pm -l no-extensions -d 'Disable extension loading'
complete -c pm -l profile -d 'Print deterministic timing diagnostics'
complete -c pm -s V -l version -d 'Output the version number'
complete -c pm -s h -l help -d 'Display help'

# Helper: true when no subcommand has been given yet
function __pm_no_subcommand
  not __fish_seen_subcommand_from ${noSubcommandList}
end

# Subcommands
complete -c pm -n __pm_no_subcommand -a init          -d 'Initialize pm storage for the current workspace'
complete -c pm -n __pm_no_subcommand -a config        -d 'Read or update pm settings'
complete -c pm -n __pm_no_subcommand -a extension     -d 'Manage extension lifecycle operations'
complete -c pm -n __pm_no_subcommand -a create        -d 'Create a new project management item'
complete -c pm -n __pm_no_subcommand -a list          -d 'List active items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-all      -d 'List all items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-draft    -d 'List draft items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-open     -d 'List open items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-in-progress -d 'List in-progress items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-blocked  -d 'List blocked items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-closed   -d 'List closed items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-canceled -d 'List canceled items with optional filters'
complete -c pm -n __pm_no_subcommand -a calendar      -d 'Show deadline/reminder calendar views'
complete -c pm -n __pm_no_subcommand -a cal           -d 'Alias for calendar'
complete -c pm -n __pm_no_subcommand -a context       -d 'Show a token-efficient project context snapshot'
complete -c pm -n __pm_no_subcommand -a ctx           -d 'Alias for context'
complete -c pm -n __pm_no_subcommand -a get           -d 'Show item details by ID'
complete -c pm -n __pm_no_subcommand -a search        -d 'Search items with keyword, semantic, or hybrid modes'
complete -c pm -n __pm_no_subcommand -a reindex       -d 'Rebuild search artifacts'
complete -c pm -n __pm_no_subcommand -a history       -d 'Show item history entries'
complete -c pm -n __pm_no_subcommand -a activity      -d 'Show recent activity across items'
complete -c pm -n __pm_no_subcommand -a restore       -d 'Restore an item to an earlier state'
complete -c pm -n __pm_no_subcommand -a update        -d 'Update item fields and metadata'
complete -c pm -n __pm_no_subcommand -a close         -d 'Close an item with a required reason'
complete -c pm -n __pm_no_subcommand -a delete        -d 'Delete an item and record the change'
complete -c pm -n __pm_no_subcommand -a append        -d 'Append text to an item body'
complete -c pm -n __pm_no_subcommand -a comments      -d 'List or add comments for an item'
complete -c pm -n __pm_no_subcommand -a comments-audit -d 'Audit latest comments across filtered items'
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
complete -c pm -n __pm_no_subcommand -a templates     -d 'Manage reusable create templates'
complete -c pm -n __pm_no_subcommand -a completion    -d 'Generate shell completion'

# list* flags
for list_cmd in ${listCmds}
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l type     -d 'Filter by item type' -r -a '${typeChoices}'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l tag      -d 'Filter by tag' -r -a '${tagChoices}'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l priority -d 'Filter by priority' -r -a '0 1 2 3 4'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l assignee -d 'Filter by assignee (none for unassigned)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l sprint   -d 'Filter by sprint' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l release  -d 'Filter by release' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l limit    -d 'Limit returned item count' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l offset   -d 'Skip the first n matching rows before limit' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l include-body -d 'Include item body in each returned list row'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l stream -d 'Emit line-delimited JSON rows (requires --json)'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l deadline-before -d 'Filter by deadline upper bound (ISO/date string or relative)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l deadline-after  -d 'Filter by deadline lower bound (ISO/date string or relative)' -r
end

# create flags
complete -c pm -n '__fish_seen_subcommand_from create' -s t -l title              -d 'Item title' -r
complete -c pm -n '__fish_seen_subcommand_from create' -s d -l description        -d 'Item description' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l type                    -d 'Item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from create' -l create-mode             -d 'Create required-option policy mode' -r -a 'strict progressive'
complete -c pm -n '__fish_seen_subcommand_from create' -s s -l status             -d 'Item status' -r -a 'draft open in_progress blocked'
complete -c pm -n '__fish_seen_subcommand_from create' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from create' -l tags                    -d 'Comma-separated tags' -r
complete -c pm -n '__fish_seen_subcommand_from create' -s b -l body               -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l deadline                -d 'Deadline (ISO/date string or relative +6h/+1d/+2w/+6m)' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l estimate                -d 'Estimated minutes' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l acceptance-criteria     -d 'Acceptance criteria' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l reminder                -d 'Reminder entry at=<iso|relative>,text=<text>' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l event                   -d 'Event entry start=<iso|relative>,end=<iso|relative>,recur_*' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l type-option             -d 'Type option key=value or key=<name>,value=<value>' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l assignee                -d 'Assignee (none to unset)' -r

# update flags
complete -c pm -n '__fish_seen_subcommand_from update' -s t -l title              -d 'Item title' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s d -l description        -d 'Item description' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s b -l body               -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s s -l status             -d 'Item status' -r -a 'draft open in_progress blocked canceled'
complete -c pm -n '__fish_seen_subcommand_from update' -l close-reason            -d 'Set close reason (none to clear)' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from update' -l type                    -d 'Item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from update' -l reminder                -d 'Reminder entry at=<iso|relative>,text=<text> (none to clear)' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l event                   -d 'Event entry start=<iso|relative>,end=<iso|relative>,recur_* (none to clear)' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l type-option             -d 'Type option key=value or key=<name>,value=<value> (none to clear)' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l force                   -d 'Force override'

# search flags
complete -c pm -n '__fish_seen_subcommand_from search' -l mode          -d 'Search mode' -r -a 'keyword semantic hybrid'
complete -c pm -n '__fish_seen_subcommand_from search' -l include-linked -d 'Include linked content in scoring'
complete -c pm -n '__fish_seen_subcommand_from search' -l limit          -d 'Max results' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l type           -d 'Filter by type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from search' -l tag            -d 'Filter by tag' -r -a '${tagChoices}'
complete -c pm -n '__fish_seen_subcommand_from search' -l priority       -d 'Filter by priority' -r -a '0 1 2 3 4'

# calendar flags
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l view      -d 'Calendar view' -r -a 'agenda day week month'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l date      -d 'Anchor date/time (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l from      -d 'Agenda lower bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l to        -d 'Agenda upper bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l past      -d 'Include past entries'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l type      -d 'Filter by type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l tag       -d 'Filter by tag' -r -a '${tagChoices}'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l priority  -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l status    -d 'Filter by status' -r -a 'draft open in_progress blocked closed canceled'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l assignee  -d 'Filter by assignee (none for unassigned)' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l sprint    -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l release   -d 'Filter by release' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l include   -d 'Include event sources' -r -a 'all deadlines reminders events'
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l recurrence-lookahead-days -d 'Bound open-ended recurrence lookahead' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l recurrence-lookback-days -d 'Bound open-ended recurrence lookback' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l occurrence-limit -d 'Cap occurrences per recurring event' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l limit     -d 'Limit returned events' -r
complete -c pm -n '__fish_seen_subcommand_from calendar cal' -l format    -d 'Output override' -r -a 'markdown toon json'

# context flags
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l date      -d 'Anchor date/time (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l from      -d 'Agenda lower bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l to        -d 'Agenda upper bound (ISO/date string or relative)' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l past      -d 'Include past entries in bounded windows'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l type      -d 'Filter by type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l tag       -d 'Filter by tag' -r -a '${tagChoices}'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l priority  -d 'Filter by priority' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l assignee  -d 'Filter by assignee (none for unassigned)' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l sprint    -d 'Filter by sprint' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l release   -d 'Filter by release' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l limit     -d 'Limit focus and agenda rows per section' -r
complete -c pm -n '__fish_seen_subcommand_from context ctx' -l format    -d 'Output override' -r -a 'markdown toon json'

# reindex flags
complete -c pm -n '__fish_seen_subcommand_from reindex' -l mode -d 'Reindex mode' -r -a 'keyword semantic hybrid'
complete -c pm -n '__fish_seen_subcommand_from reindex' -l progress -d 'Emit progress updates to stderr'

# history / activity flags
complete -c pm -n '__fish_seen_subcommand_from history'  -l limit -d 'Max history entries' -r
complete -c pm -n '__fish_seen_subcommand_from history'  -l diff -d 'Include changed-field patch summary'
complete -c pm -n '__fish_seen_subcommand_from history'  -l verify -d 'Verify history hash chain and replay integrity'
complete -c pm -n '__fish_seen_subcommand_from activity' -l limit -d 'Max activity entries' -r
complete -c pm -n '__fish_seen_subcommand_from contracts' -l action -d 'Filter schema by tool action' -r
complete -c pm -n '__fish_seen_subcommand_from contracts' -l command -d 'Filter command flag contracts' -r
complete -c pm -n '__fish_seen_subcommand_from contracts' -l schema-only -d 'Return schema-only payload'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l runtime-only -d 'Include only actions invocable in the current runtime'
complete -c pm -n '__fish_seen_subcommand_from contracts' -l active-only -d 'Alias for --runtime-only'
complete -c pm -n '__fish_seen_subcommand_from deps' -l format -d 'Output format' -r -a 'tree graph'

# comments / notes / learnings flags
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l add -d 'Add one entry (text=<value> or plain text)' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l limit -d 'Return only latest n entries' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l author -d 'Entry author' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from comments notes learnings' -l force -d 'Force override'
complete -c pm -n '__fish_seen_subcommand_from comments' -l allow-audit-comment -d 'Allow non-owner append-only comment audits without requiring --force'

# test flags
complete -c pm -n '__fish_seen_subcommand_from test' -l add -d 'Add linked test entry' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l remove -d 'Remove linked test entry' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l run -d 'Run linked tests'
complete -c pm -n '__fish_seen_subcommand_from test' -l background -d 'Run linked tests in managed background mode'
complete -c pm -n '__fish_seen_subcommand_from test' -l timeout -d 'Default timeout seconds' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l progress -d 'Emit linked-test progress to stderr'
complete -c pm -n '__fish_seen_subcommand_from test' -l env-set -d 'Set linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l env-clear -d 'Clear linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l shared-host-safe -d 'Apply shared-host-safe runtime defaults'
complete -c pm -n '__fish_seen_subcommand_from test' -l pm-context -d 'PM linked-test context mode' -r -a 'schema tracker'
complete -c pm -n '__fish_seen_subcommand_from test' -l fail-on-context-mismatch -d 'Fail when context item counts mismatch'
complete -c pm -n '__fish_seen_subcommand_from test' -l fail-on-skipped -d 'Treat skipped linked tests as dependency failures'
complete -c pm -n '__fish_seen_subcommand_from test' -l require-assertions-for-pm -d 'Require assertions for linked PM command tests'
complete -c pm -n '__fish_seen_subcommand_from test' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from test' -l force -d 'Force override'

# test-all flags
complete -c pm -n '__fish_seen_subcommand_from test-all' -l status  -d 'Filter by status' -r -a 'open in_progress'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l background -d 'Run linked tests in managed background mode'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l timeout -d 'Default timeout seconds' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l progress -d 'Emit linked-test progress to stderr'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l env-set -d 'Set linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l env-clear -d 'Clear linked-test runtime environment values' -r
complete -c pm -n '__fish_seen_subcommand_from test-all' -l shared-host-safe -d 'Apply shared-host-safe runtime defaults'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l pm-context -d 'PM linked-test context mode' -r -a 'schema tracker'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l fail-on-context-mismatch -d 'Fail when context item counts mismatch'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l fail-on-skipped -d 'Treat skipped linked tests as dependency failures'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l require-assertions-for-pm -d 'Require assertions for linked PM command tests'

# test-runs flags
complete -c pm -n '__fish_seen_subcommand_from test-runs' -a 'list status logs stop resume' -d 'test-runs subcommand'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l status -d 'Filter background runs by status' -r -a 'queued running passed failed stopped canceled'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l limit -d 'Limit returned runs' -r
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l stream -d 'Background log stream selector' -r -a 'stdout stderr both'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l tail -d 'Tail number of lines from logs' -r
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l force -d 'Force-stop run with SIGKILL'
complete -c pm -n '__fish_seen_subcommand_from test-runs' -l author -d 'Resume author' -r

# close flags
complete -c pm -n '__fish_seen_subcommand_from close' -l author -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l message -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from close' -l validate-close -d 'Validate closure metadata mode' -r -a 'warn strict'
complete -c pm -n '__fish_seen_subcommand_from close' -l force -d 'Force override'

# validate flags
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-metadata -d 'Run metadata completeness checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-resolution -d 'Run closed-item resolution metadata checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-files -d 'Run linked-file and orphaned-file checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l scan-mode -d 'Select file candidate scan mode for --check-files' -r -a 'default tracked-all tracked-all-strict'
complete -c pm -n '__fish_seen_subcommand_from validate' -l include-pm-internals -d 'Include PM storage internals in tracked-all candidate scans'
complete -c pm -n '__fish_seen_subcommand_from validate' -l strict-exit -d 'Return non-zero exit when validation warnings are present'
complete -c pm -n '__fish_seen_subcommand_from validate' -l fail-on-warn -d 'Alias for --strict-exit'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-history-drift -d 'Run item/history hash drift checks'
complete -c pm -n '__fish_seen_subcommand_from validate' -l check-command-references -d 'Run linked-command PM-ID reference checks'
complete -c pm -n '__fish_seen_subcommand_from config' -l criterion -d 'Definition-of-Done criterion (repeatable for set)' -r
complete -c pm -n '__fish_seen_subcommand_from config' -l format -d 'Item format for item-format key' -r -a 'toon json_markdown'
complete -c pm -n '__fish_seen_subcommand_from config' -l policy -d 'Policy value for supported policy keys' -r
complete -c pm -n '__fish_seen_subcommand_from health' -l strict-directories -d 'Treat optional item-type directories as required failures'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l status -d 'Filter by item status' -r -a 'draft open in_progress blocked closed canceled'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l type -d 'Filter by item type' -r -a '${typeChoices}'
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l assignee -d 'Filter by assignee (none for unassigned)' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l limit-items -d 'Limit returned item count' -r
complete -c pm -n '__fish_seen_subcommand_from comments-audit' -l latest -d 'Return latest n comments per item' -r

# completion shell argument
complete -c pm -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell type'

# templates subcommands
complete -c pm -n '__fish_seen_subcommand_from templates' -a 'save list show' -d 'Templates command'

# extension lifecycle flags
complete -c pm -n '__fish_seen_subcommand_from extension' -l install -d 'Install extension from local path or GitHub source'
complete -c pm -n '__fish_seen_subcommand_from extension' -l uninstall -d 'Uninstall extension by name'
complete -c pm -n '__fish_seen_subcommand_from extension' -l explore -d 'List discovered extensions for selected scope'
complete -c pm -n '__fish_seen_subcommand_from extension' -l manage -d 'List managed extensions with update metadata'
complete -c pm -n '__fish_seen_subcommand_from extension' -l doctor -d 'Run consolidated extension diagnostics'
complete -c pm -n '__fish_seen_subcommand_from extension' -l adopt -d 'Adopt an unmanaged extension into managed metadata'
complete -c pm -n '__fish_seen_subcommand_from extension' -l activate -d 'Activate extension in selected scope settings'
complete -c pm -n '__fish_seen_subcommand_from extension' -l deactivate -d 'Deactivate extension in selected scope settings'
complete -c pm -n '__fish_seen_subcommand_from extension' -l project -d 'Use project extension scope'
complete -c pm -n '__fish_seen_subcommand_from extension' -l local -d 'Alias for --project'
complete -c pm -n '__fish_seen_subcommand_from extension' -l global -d 'Use global extension scope'
complete -c pm -n '__fish_seen_subcommand_from extension' -l gh -d 'GitHub shorthand owner/repo/path' -r
complete -c pm -n '__fish_seen_subcommand_from extension' -l github -d 'Alias for --gh' -r
complete -c pm -n '__fish_seen_subcommand_from extension' -l ref -d 'Git ref/branch/tag for GitHub source' -r
complete -c pm -n '__fish_seen_subcommand_from extension' -l detail -d 'Detail mode for extension diagnostics' -r -a 'summary deep'`;
}

const SETUP_HINTS: Record<CompletionShell, string> = {
  bash: 'Add to ~/.bashrc or ~/.bash_profile: eval "$(pm completion bash)"',
  zsh: 'Add to ~/.zshrc: eval "$(pm completion zsh)"',
  fish: "Run: pm completion fish > ~/.config/fish/completions/pm.fish",
};

export function runCompletion(shell: string, itemTypes: string[] = DEFAULT_ITEM_TYPES, tags: string[] = []): CompletionResult {
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
    script = generateBashScript(itemTypes, tags);
  } else if (validShell === "zsh") {
    script = generateZshScript(itemTypes, tags);
  } else {
    script = generateFishScript(itemTypes, tags);
  }
  return {
    shell: validShell,
    script,
    setup_hint: SETUP_HINTS[validShell],
  };
}
