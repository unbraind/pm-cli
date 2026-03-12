import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

export type CompletionShell = "bash" | "zsh" | "fish";

export interface CompletionResult {
  shell: CompletionShell;
  script: string;
  setup_hint: string;
}

const VALID_SHELLS: CompletionShell[] = ["bash", "zsh", "fish"];

const ALL_COMMANDS = [
  "init",
  "config",
  "install",
  "create",
  "list",
  "list-all",
  "list-draft",
  "list-open",
  "list-in-progress",
  "list-blocked",
  "list-closed",
  "list-canceled",
  "get",
  "search",
  "reindex",
  "history",
  "activity",
  "restore",
  "update",
  "close",
  "delete",
  "append",
  "comments",
  "files",
  "docs",
  "test",
  "test-all",
  "stats",
  "health",
  "gc",
  "claim",
  "release",
  "beads",
  "todos",
  "completion",
  "help",
];

const LIST_FLAGS =
  "--type --tag --priority --deadline-before --deadline-after --assignee --sprint --release --limit --json --quiet --path --no-extensions --profile --help";

const CREATE_FLAGS =
  "-t --title -d --description --type -s --status -p --priority --tags -b --body --deadline --estimate --estimated-minutes --acceptance-criteria --ac --author --message --assignee --parent --reviewer --risk --confidence --sprint --release --blocked-by --blocked-reason --unblock-note --reporter --severity --environment --repro-steps --resolution --expected-result --actual-result --affected-version --fixed-version --component --regression --customer-impact --definition-of-ready --order --rank --goal --objective --value --impact --outcome --why-now --dep --comment --note --learning --file --test --doc --json --quiet --path --no-extensions --profile --help";

const UPDATE_FLAGS =
  "-t --title -d --description -s --status -p --priority --type --tags --deadline --estimate --estimated-minutes --acceptance-criteria --ac --assignee --parent --reviewer --risk --confidence --sprint --release --blocked-by --blocked-reason --unblock-note --reporter --severity --environment --repro-steps --resolution --expected-result --actual-result --affected-version --fixed-version --component --regression --customer-impact --definition-of-ready --order --rank --goal --objective --value --impact --outcome --why-now --author --message --force --json --quiet --path --no-extensions --profile --help";

const SEARCH_FLAGS =
  "--mode --include-linked --limit --type --tag --priority --deadline-before --deadline-after --json --quiet --path --no-extensions --profile --help";

const MUTATION_FLAGS = "--author --message --force --json --quiet --path --no-extensions --profile --help";

const GLOBAL_FLAGS = "--json --quiet --path --no-extensions --profile --version --help";

export function generateBashScript(): string {
  const cmds = ALL_COMMANDS.join(" ");
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
    "    search)",
    `      COMPREPLY=(${compgen(SEARCH_FLAGS)})`,
    "      ;;",
    "    reindex)",
    `      COMPREPLY=(${compgen("--mode --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    config)",
    `      COMPREPLY=(${compgen("--criterion --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    install)",
    `      COMPREPLY=(${compgen("pi --project --global --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    comments)",
    `      COMPREPLY=(${compgen("--add --limit --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    files|docs)",
    `      COMPREPLY=(${compgen("--add --remove --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    test)",
    `      COMPREPLY=(${compgen("--add --remove --run --timeout --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    test-all)",
    `      COMPREPLY=(${compgen("--status --timeout --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    history|activity)",
    `      COMPREPLY=(${compgen("--limit --json --quiet --path --no-extensions --profile --help")})`,
    "      ;;",
    "    claim|release|close|delete|append|restore)",
    `      COMPREPLY=(${compgen(MUTATION_FLAGS)})`,
    "      ;;",
    "    beads)",
    `      COMPREPLY=(${compgen("import")})`,
    "      ;;",
    "    todos)",
    `      COMPREPLY=(${compgen("import export")})`,
    "      ;;",
    "    completion)",
    `      COMPREPLY=(${compgen("bash zsh fish")})`,
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

export function generateZshScript(): string {
  const cmds = ALL_COMMANDS.map((c) => `'${c}'`).join(" ");
  return `#compdef pm
# zsh completion for pm
# Source this file or add 'eval "$(pm completion zsh)"' to ~/.zshrc

_pm_commands() {
  local -a commands
  commands=(
    'init:Initialize pm storage for the current workspace'
    'config:Read or update pm settings'
    'install:Install supported integrations and extensions'
    'create:Create a new project management item'
    'list:List active items with optional filters'
    'list-all:List all items with optional filters'
    'list-draft:List draft items with optional filters'
    'list-open:List open items with optional filters'
    'list-in-progress:List in-progress items with optional filters'
    'list-blocked:List blocked items with optional filters'
    'list-closed:List closed items with optional filters'
    'list-canceled:List canceled items with optional filters'
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
    'files:Manage linked files'
    'docs:Manage linked docs'
    'test:Manage linked tests and optionally run them'
    'test-all:Run linked tests across matching items'
    'stats:Show project tracker statistics'
    'health:Show project tracker health checks'
    'gc:Clean optional cache artifacts'
    'claim:Claim an item for active work'
    'release:Release the active claim for an item'
    'beads:Built-in Beads extension commands'
    'todos:Built-in todos extension commands'
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
            '--type[Filter by item type]:(Epic Feature Task Chore Issue)' \\
            '--tag[Filter by tag]:tag' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--deadline-before[Filter by deadline upper bound]:date' \\
            '--deadline-after[Filter by deadline lower bound]:date' \\
            '--assignee[Filter by assignee (use none for unassigned)]:assignee' \\
            '--sprint[Filter by sprint]:sprint' \\
            '--release[Filter by release]:release' \\
            '--limit[Limit returned item count]:number' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]' \\
            '--path[Override PM path]:path:_files -/'
          ;;
        create)
          _arguments \\
            '(-t --title)'{-t,--title}'[Item title]:title' \\
            '(-d --description)'{-d,--description}'[Item description]:description' \\
            '--type[Item type]:(Epic Feature Task Chore Issue)' \\
            '(-s --status)'{-s,--status}'[Item status]:(draft open in_progress blocked)' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '--tags[Comma-separated tags]:tags' \\
            '(-b --body)'{-b,--body}'[Item body]:body' \\
            '--deadline[Deadline (ISO or relative +1d/+2w)]:deadline' \\
            '--estimate[Estimated minutes]:minutes' \\
            '--acceptance-criteria[Acceptance criteria]:criteria' \\
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
            '(-s --status)'{-s,--status}'[Item status]:(draft open in_progress blocked canceled)' \\
            '(-p --priority)'{-p,--priority}'[Priority (0-4)]:(0 1 2 3 4)' \\
            '--type[Item type]:(Epic Feature Task Chore Issue)' \\
            '--tags[Comma-separated tags]:tags' \\
            '--author[Mutation author]:author' \\
            '--message[History message]:message' \\
            '--force[Force override]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        search)
          _arguments \\
            '--mode[Search mode]:(keyword semantic hybrid)' \\
            '--include-linked[Include linked content in scoring]' \\
            '--limit[Max results]:number' \\
            '--type[Filter by type]:(Epic Feature Task Chore Issue)' \\
            '--tag[Filter by tag]:tag' \\
            '--priority[Filter by priority]:(0 1 2 3 4)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        reindex)
          _arguments \\
            '--mode[Reindex mode]:(keyword semantic hybrid)' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        history|activity)
          _arguments \\
            '--limit[Max entries]:number' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        test-all)
          _arguments \\
            '--status[Filter by status]:(open in_progress)' \\
            '--timeout[Default timeout seconds]:seconds' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]'
          ;;
        install)
          _arguments \\
            '--project[Install Pi extension into current project .pi/extensions]' \\
            '--global[Install Pi extension into global PI_CODING_AGENT_DIR or ~/.pi/agent]' \\
            '--json[Output JSON]' \\
            '--quiet[Suppress stdout]' \\
            '1:target:(pi)'
          ;;
        completion)
          _arguments '1:shell:(bash zsh fish)'
          ;;
        beads)
          local -a beads_cmds
          beads_cmds=('import:Import Beads JSONL records')
          _describe 'beads command' beads_cmds
          ;;
        todos)
          local -a todos_cmds
          todos_cmds=('import:Import todos markdown files' 'export:Export todos markdown files')
          _describe 'todos command' todos_cmds
          ;;
      esac
      ;;
  esac
}

compdef _pm pm`;
}

export function generateFishScript(): string {
  const listCmds = [
    "list",
    "list-all",
    "list-draft",
    "list-open",
    "list-in-progress",
    "list-blocked",
    "list-closed",
    "list-canceled",
  ].join(" ");
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
  not __fish_seen_subcommand_from init config install create list list-all list-draft list-open list-in-progress list-blocked list-closed list-canceled get search reindex history activity restore update close delete append comments files docs test test-all stats health gc claim release beads todos completion help
end

# Subcommands
complete -c pm -n __pm_no_subcommand -a init          -d 'Initialize pm storage for the current workspace'
complete -c pm -n __pm_no_subcommand -a config        -d 'Read or update pm settings'
complete -c pm -n __pm_no_subcommand -a install       -d 'Install supported integrations and extensions'
complete -c pm -n __pm_no_subcommand -a create        -d 'Create a new project management item'
complete -c pm -n __pm_no_subcommand -a list          -d 'List active items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-all      -d 'List all items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-draft    -d 'List draft items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-open     -d 'List open items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-in-progress -d 'List in-progress items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-blocked  -d 'List blocked items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-closed   -d 'List closed items with optional filters'
complete -c pm -n __pm_no_subcommand -a list-canceled -d 'List canceled items with optional filters'
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
complete -c pm -n __pm_no_subcommand -a files         -d 'Manage linked files'
complete -c pm -n __pm_no_subcommand -a docs          -d 'Manage linked docs'
complete -c pm -n __pm_no_subcommand -a test          -d 'Manage linked tests and optionally run them'
complete -c pm -n __pm_no_subcommand -a test-all      -d 'Run linked tests across matching items'
complete -c pm -n __pm_no_subcommand -a stats         -d 'Show project tracker statistics'
complete -c pm -n __pm_no_subcommand -a health        -d 'Show project tracker health checks'
complete -c pm -n __pm_no_subcommand -a gc            -d 'Clean optional cache artifacts'
complete -c pm -n __pm_no_subcommand -a claim         -d 'Claim an item for active work'
complete -c pm -n __pm_no_subcommand -a release       -d 'Release the active claim for an item'
complete -c pm -n __pm_no_subcommand -a beads         -d 'Built-in Beads extension commands'
complete -c pm -n __pm_no_subcommand -a todos         -d 'Built-in todos extension commands'
complete -c pm -n __pm_no_subcommand -a completion    -d 'Generate shell completion'

# list* flags
for list_cmd in ${listCmds}
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l type     -d 'Filter by item type' -r -a 'Epic Feature Task Chore Issue'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l tag      -d 'Filter by tag' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l priority -d 'Filter by priority' -r -a '0 1 2 3 4'
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l assignee -d 'Filter by assignee (none for unassigned)' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l sprint   -d 'Filter by sprint' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l release  -d 'Filter by release' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l limit    -d 'Limit returned item count' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l deadline-before -d 'Filter by deadline upper bound' -r
  complete -c pm -n "__fish_seen_subcommand_from $list_cmd" -l deadline-after  -d 'Filter by deadline lower bound' -r
end

# create flags
complete -c pm -n '__fish_seen_subcommand_from create' -s t -l title              -d 'Item title' -r
complete -c pm -n '__fish_seen_subcommand_from create' -s d -l description        -d 'Item description' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l type                    -d 'Item type' -r -a 'Epic Feature Task Chore Issue'
complete -c pm -n '__fish_seen_subcommand_from create' -s s -l status             -d 'Item status' -r -a 'draft open in_progress blocked'
complete -c pm -n '__fish_seen_subcommand_from create' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from create' -l tags                    -d 'Comma-separated tags' -r
complete -c pm -n '__fish_seen_subcommand_from create' -s b -l body               -d 'Item body' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l deadline                -d 'Deadline (ISO or relative +1d/+2w)' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l estimate                -d 'Estimated minutes' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l acceptance-criteria     -d 'Acceptance criteria' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from create' -l assignee                -d 'Assignee (none to unset)' -r

# update flags
complete -c pm -n '__fish_seen_subcommand_from update' -s t -l title              -d 'Item title' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s d -l description        -d 'Item description' -r
complete -c pm -n '__fish_seen_subcommand_from update' -s s -l status             -d 'Item status' -r -a 'draft open in_progress blocked canceled'
complete -c pm -n '__fish_seen_subcommand_from update' -s p -l priority           -d 'Priority (0-4)' -r -a '0 1 2 3 4'
complete -c pm -n '__fish_seen_subcommand_from update' -l type                    -d 'Item type' -r -a 'Epic Feature Task Chore Issue'
complete -c pm -n '__fish_seen_subcommand_from update' -l author                  -d 'Mutation author' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l message                 -d 'History message' -r
complete -c pm -n '__fish_seen_subcommand_from update' -l force                   -d 'Force override'

# search flags
complete -c pm -n '__fish_seen_subcommand_from search' -l mode          -d 'Search mode' -r -a 'keyword semantic hybrid'
complete -c pm -n '__fish_seen_subcommand_from search' -l include-linked -d 'Include linked content in scoring'
complete -c pm -n '__fish_seen_subcommand_from search' -l limit          -d 'Max results' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l type           -d 'Filter by type' -r -a 'Epic Feature Task Chore Issue'
complete -c pm -n '__fish_seen_subcommand_from search' -l tag            -d 'Filter by tag' -r
complete -c pm -n '__fish_seen_subcommand_from search' -l priority       -d 'Filter by priority' -r -a '0 1 2 3 4'

# reindex flags
complete -c pm -n '__fish_seen_subcommand_from reindex' -l mode -d 'Reindex mode' -r -a 'keyword semantic hybrid'

# history / activity flags
complete -c pm -n '__fish_seen_subcommand_from history'  -l limit -d 'Max history entries' -r
complete -c pm -n '__fish_seen_subcommand_from activity' -l limit -d 'Max activity entries' -r

# test-all flags
complete -c pm -n '__fish_seen_subcommand_from test-all' -l status  -d 'Filter by status' -r -a 'open in_progress'
complete -c pm -n '__fish_seen_subcommand_from test-all' -l timeout -d 'Default timeout seconds' -r

# completion shell argument
complete -c pm -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell type'

# install target and flags
complete -c pm -n '__fish_seen_subcommand_from install' -a 'pi' -d 'Install pm Pi extension'
complete -c pm -n '__fish_seen_subcommand_from install' -l project -d 'Install into current project .pi/extensions'
complete -c pm -n '__fish_seen_subcommand_from install' -l global -d 'Install into PI_CODING_AGENT_DIR or ~/.pi/agent'

# beads subcommands
complete -c pm -n '__fish_seen_subcommand_from beads' -a import -d 'Import Beads JSONL records'

# todos subcommands
complete -c pm -n '__fish_seen_subcommand_from todos' -a import -d 'Import todos markdown files'
complete -c pm -n '__fish_seen_subcommand_from todos' -a export -d 'Export todos markdown files'`;
}

const SETUP_HINTS: Record<CompletionShell, string> = {
  bash: 'Add to ~/.bashrc or ~/.bash_profile: eval "$(pm completion bash)"',
  zsh: 'Add to ~/.zshrc: eval "$(pm completion zsh)"',
  fish: "Run: pm completion fish > ~/.config/fish/completions/pm.fish",
};

export function runCompletion(shell: string): CompletionResult {
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
    script = generateBashScript();
  } else if (validShell === "zsh") {
    script = generateZshScript();
  } else {
    script = generateFishScript();
  }
  return {
    shell: validShell,
    script,
    setup_hint: SETUP_HINTS[validShell],
  };
}
