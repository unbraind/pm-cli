import { describe, expect, it } from "vitest";
import {
  generateBashScript,
  generateZshScript,
  generateFishScript,
  runCompletion,
  type CompletionResult,
  type CompletionRuntimeConfig,
} from "../../src/cli/commands/completion.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("generateBashScript", () => {
  it("returns a string containing the compdef function", () => {
    const script = generateBashScript();
    expect(typeof script).toBe("string");
    expect(script).toContain("_pm_completion()");
    expect(script).toContain("complete -F _pm_completion pm");
  });

  it("includes all pm subcommands in the command list", () => {
    const script = generateBashScript();
    for (const cmd of [
      "init",
      "extension",
      "create",
      "get",
      "update",
      "list",
      "list-all",
      "list-open",
      "list-in-progress",
      "list-blocked",
      "list-closed",
      "list-canceled",
      "list-draft",
      "calendar",
      "cal",
      "context",
      "ctx",
      "search",
      "reindex",
      "history",
      "history-compact",
      "history-redact",
      "activity",
      "restore",
      "update-many",
      "normalize",
      "close",
      "delete",
      "append",
      "comments",
      "plan",
      "notes",
      "learnings",
      "files",
      "docs",
      "deps",
      "test",
      "test-all",
      "stats",
      "health",
      "validate",
      "gc",
      "contracts",
      "guide",
      "claim",
      "release",
      "start-task",
      "pause-task",
      "close-task",
      "completion",
      "config",
    ]) {
      expect(script).toContain(cmd);
    }
  });

  it("includes list filter flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--type");
    expect(script).toContain("--tag");
    expect(script).toContain("--priority");
    expect(script).toContain("--assignee");
    expect(script).toContain("--sprint");
    expect(script).toContain("--release");
    expect(script).toContain("--limit");
    expect(script).toContain("--offset");
    expect(script).toContain("--stream");
    expect(script).toContain("--include-body");
    expect(script).toContain("--deadline-before");
    expect(script).toContain("--deadline-after");
  });

  it("includes create-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--title");
    expect(script).toContain("--description");
    expect(script).toContain("--create-mode");
    expect(script).toContain("--schedule-preset");
    expect(script).toContain("--acceptance-criteria");
    expect(script).toContain("--dep");
    expect(script).toContain("--reminder");
    expect(script).toContain("--event");
    expect(script).toContain("--comment");
    expect(script).toContain("--note");
    expect(script).toContain("--learning");
  });

  it("includes update flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--body");
    expect(script).toContain("--close-reason");
    expect(script).toContain("--force");
    expect(script).toContain("--message");
    expect(script).toContain("--author");
    expect(script).toContain("--dep");
    expect(script).toContain("--dep-remove");
    expect(script).toContain("--replace-deps");
    expect(script).toContain("--replace-tests");
    expect(script).toContain("--comment");
    expect(script).toContain("--note");
    expect(script).toContain("--learning");
    expect(script).toContain("--file");
    expect(script).toContain("--test");
    expect(script).toContain("--doc");
    expect(script).toContain("--reminder");
    expect(script).toContain("--event");
  });

  it("includes init agent guidance flag across completion scripts", () => {
    const bashScript = generateBashScript();
    expect(bashScript).toContain("--agent-guidance");
    expect(bashScript).toContain("--defaults");
    expect(bashScript).toContain("--yes");
    expect(bashScript).toContain("-y");
    expect(bashScript).toContain("--verbose");
    expect(bashScript).toContain("--type-preset");

    const zshScript = generateZshScript();
    expect(zshScript).toContain("--agent-guidance[Agent guidance mode]");
    expect(zshScript).toContain("--type-preset[Register domain item types]");
    expect(zshScript).toContain("Alias for --defaults");
    expect(zshScript).toContain("--verbose[");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from init");
    expect(fishScript).toContain("-l agent-guidance");
    expect(fishScript).toContain("-l type-preset");
    expect(fishScript).toContain("-s y -l yes");
    expect(fishScript).toContain("-l verbose");
  });

  it("includes underscore metadata aliases in bash completion output", () => {
    const script = generateBashScript();
    expect(script).toContain("--acceptance_criteria");
    expect(script).toContain("--definition_of_ready");
    expect(script).toContain("--blocked_by");
    expect(script).toContain("--why_now");
    expect(script).toContain("--customer_impact");
  });

  it("includes update-many linked-array mutation flags across completion scripts", () => {
    const bashScript = generateBashScript();
    expect(bashScript).toContain("--replace-tests");
    expect(bashScript).toContain("--clear-files");
    expect(bashScript).toContain("--clear-events");

    const zshScript = generateZshScript();
    expect(zshScript).toContain("update-many)");
    expect(zshScript).toContain("--replace-tests[Atomically replace linked tests with provided --test values]");
    expect(zshScript).toContain("--clear-tests[Clear linked tests]");
    expect(zshScript).toContain("--dep[Dependency seed id=<id>,kind=<kind>,author=<author>,created_at=<timestamp>]");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from update-many");
    expect(fishScript).toContain("-l replace-tests");
    expect(fishScript).toContain("-l clear-docs");
    expect(fishScript).toContain("-l reminder");
  });

  it("includes normalize command flags across completion scripts", () => {
    const bashScript = generateBashScript();
    expect(bashScript).toContain("normalize)");
    expect(bashScript).toContain("--apply");
    expect(bashScript).toContain("--filter-status");

    const zshScript = generateZshScript();
    expect(zshScript).toContain("normalize)");
    expect(zshScript).toContain("--apply[Apply normalize changes]");
    expect(zshScript).toContain("--filter-status[Filter by status before planning or apply]");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from normalize");
    expect(fishScript).toContain("-l apply");
    expect(fishScript).toContain("-l filter-status");
  });

  it("includes append required --body flag from command contracts", () => {
    const bashScript = generateBashScript();
    expect(bashScript).toContain("append)");
    expect(bashScript).toContain("--body");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from append");
    expect(fishScript).toContain("-l body");
  });

  it("includes release audit handoff flag", () => {
    const script = generateBashScript();
    expect(script).toContain("--allow-audit-release");
  });

  it("includes deps ergonomics flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--format");
    expect(script).toContain("--max-depth");
    expect(script).toContain("--collapse");
    expect(script).toContain("--summary");
  });

  it("includes comments mutation metadata flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--add --stdin --file --limit --author --message --allow-audit-comment --force");
    expect(script).toContain("--stdin");
    expect(script).toContain("--file");
    expect(script).toContain("--allow-audit-comment");
    expect(script).toContain("--allow-audit-note");
    expect(script).toContain("--allow-audit-learning");
    expect(script).toContain(
      "--status --type --tag --priority --parent --sprint --release --assignee --assignee-filter --limit-items --limit --full-history --latest",
    );

    const zshScript = generateZshScript();
    expect(zshScript).toContain("--stdin[Read comment text from stdin (supports multiline markdown)]");
    expect(zshScript).toContain("--file[Read comment text from file (supports multiline markdown)]:path");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from comments");
    expect(fishScript).toContain("-l stdin -d 'Read comment text from stdin (supports multiline markdown)'");
    expect(fishScript).toContain("-l file -d 'Read comment text from file (supports multiline markdown)'");
  });

  it("includes notes/learnings audit alias flags in zsh and fish completion", () => {
    const zshScript = generateZshScript();
    expect(zshScript).toContain("--allow-audit-note");
    expect(zshScript).toContain("--allow-audit-learning");
    expect(zshScript).toContain("Backward-compatible alias for --allow-audit-note");
    expect(zshScript).toContain("Backward-compatible alias for --allow-audit-learning");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("-l allow-audit-note");
    expect(fishScript).toContain("-l allow-audit-learning");
    expect(fishScript).toContain("-l allow-audit-comment");
  });

  it("includes comments-audit --limit alias in zsh and fish completion", () => {
    const zshScript = generateZshScript();
    expect(zshScript).toContain("--limit[Alias for --limit-items]:number");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from comments-audit");
    expect(fishScript).toContain("-l limit -d 'Alias for --limit-items'");
  });

  it("includes files/docs add-glob flag in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--add");
    expect(script).toContain("--add-glob");
    expect(script).toContain("--remove");
    expect(script).toContain("--migrate");
    expect(script).toContain("--list");
    expect(script).toContain("--validate-paths");
    expect(script).toContain("--audit");
  });

  it("includes files append-stable flag in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--append-stable");
  });

  it("includes validate scan-mode flag in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain(
      "--check-metadata --metadata-profile --check-resolution --check-lifecycle --check-stale-blockers --dependency-cycle-severity --check-files --scan-mode --include-pm-internals --verbose-file-lists --verbose-diagnostics --strict-exit --fail-on-warn --fix-hints --check-history-drift --check-command-references",
    );
  });

  it("includes strict health flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain(
      "--strict-directories --strict-exit --fail-on-warn --check-only --check-telemetry --no-refresh --refresh-vectors --verbose-stale-items --brief --summary --skip-vectors --skip-integrity --skip-drift --full --json --quiet --no-changed-fields --path --no-extensions --no-pager --profile --help",
    );
  });

  it("includes extension doctor strict flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain(
      "--init --scaffold --install --uninstall --explore --manage --reload --watch --doctor --adopt --adopt-all --activate --deactivate --project --local --global --gh --github --ref --detail --trace --runtime-probe --fix-managed-state --strict-exit --fail-on-warn",
    );
  });

  it("includes fail-on-empty-test-run in bash test completions", () => {
    const script = generateBashScript();
    expect(script).toContain("--override-linked-pm-context");
    expect(script).toContain("--fail-on-skipped --fail-on-empty-test-run --require-assertions-for-pm");
    expect(script).toContain("--check-context --auto-pm-context");
  });

  it("includes test-all pagination flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--status --limit --offset --background --timeout --progress");
  });

  it("includes gc dry-run and scope flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("gc)");
    expect(script).toContain("--dry-run --scope");
  });

  it("includes delete dry-run across completion scripts", () => {
    const bashScript = generateBashScript();
    expect(bashScript).toContain("delete)");
    expect(bashScript).toContain("--dry-run --author --message --force");

    const zshScript = generateZshScript();
    expect(zshScript).toContain("delete)");
    expect(zshScript).toContain("--dry-run[Preview the item file that would be deleted without mutating]");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from delete");
    expect(fishScript).toContain("-l dry-run");
  });

  it("includes calendar-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("calendar|cal");
    expect(script).toContain("--view");
    expect(script).toContain("--from");
    expect(script).toContain("--to");
    expect(script).toContain("--past");
    expect(script).toContain("--full-period");
    expect(script).toContain("--include");
    expect(script).toContain("--occurrence-limit");
    expect(script).toContain("--format");
  });

  it("includes activity filtering and stream flags", () => {
    const script = generateBashScript();
    expect(script).toContain("activity)");
    expect(script).toContain("--id");
    expect(script).toContain("--op");
    expect(script).toContain("--author");
    expect(script).toContain("--from");
    expect(script).toContain("--to");
    expect(script).toContain("--stream");
  });

  it("includes history-compact flags across completion scripts", () => {
    const bashScript = generateBashScript();
    expect(bashScript).toContain("history-compact)");
    expect(bashScript).toContain("--before --dry-run --author --message --force");

    const zshScript = generateZshScript();
    expect(zshScript).toContain("history-compact)");
    expect(zshScript).toContain("--before[Compact entries strictly before this version number or ISO timestamp]:before");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from history-compact");
    expect(fishScript).toContain("-l before -d 'Compact entries strictly before this version number or ISO timestamp'");
  });

  it("includes get projection flags", () => {
    const bashScript = generateBashScript();
    expect(bashScript).toContain("get)");
    expect(bashScript).toContain("--depth --full --fields");

    const zshScript = generateZshScript();
    expect(zshScript).toContain("get)");
    expect(zshScript).toContain("--depth[Detail depth]:(brief standard deep full)");
    expect(zshScript).toContain("--full[Explicit full item read]");

    const fishScript = generateFishScript();
    expect(fishScript).toContain("__fish_seen_subcommand_from get");
    expect(fishScript).toContain("-l depth -d 'Detail depth' -r -a 'brief standard deep full'");
    expect(fishScript).toContain("-l full -d 'Explicit full item read'");
  });

  it("includes search-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--mode");
    expect(script).toContain("--semantic-weight");
    expect(script).toContain("--include-linked");
    expect(script).toContain("--title-exact");
    expect(script).toContain("--phrase-exact");
  });

  it("includes deterministic tag suggestions for --tag completion", () => {
    const script = generateBashScript(["Task"], ["beta", "alpha", "alpha"]);
    expect(script).toContain('"$prev" == "--tag"');
    expect(script).toContain('"alpha beta"');
  });

  it("uses lazy dynamic tag completion by default and supports eager mode", () => {
    const lazyBash = generateBashScript();
    expect(lazyBash).toContain("pm completion-tags");
    expect(lazyBash).toContain("pm completion-statuses");
    expect(lazyBash).toContain("pm completion-types");

    const eagerBash = generateBashScript(["Task"], [], true);
    expect(eagerBash).not.toContain("pm completion-tags");
    expect(eagerBash).toContain("pm completion-statuses");
    expect(eagerBash).not.toContain("pm completion-types");

    const lazyZsh = generateZshScript();
    expect(lazyZsh).toContain("_pm_tag_choices()");
    expect(lazyZsh).toContain("_pm_status_choices()");
    expect(lazyZsh).toContain("_pm_type_choices()");
    expect(lazyZsh).toContain("pm completion-tags");
    expect(lazyZsh).toContain("pm completion-statuses");
    expect(lazyZsh).toContain("pm completion-types");

    const lazyFish = generateFishScript();
    expect(lazyFish).toContain("function __pm_tag_choices");
    expect(lazyFish).toContain("function __pm_status_choices");
    expect(lazyFish).toContain("function __pm_type_choices");
    expect(lazyFish).toContain("pm completion-tags");
    expect(lazyFish).toContain("pm completion-statuses");
    expect(lazyFish).toContain("pm completion-types");
  });

  it("includes context-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("context|ctx");
    expect(script).toContain("--from");
    expect(script).toContain("--to");
    expect(script).toContain("--past");
    expect(script).toContain("--format");
  });

  it("includes guide topic flags and values", () => {
    const script = generateBashScript();
    expect(script).toContain("guide)");
    expect(script).toContain("--list --format --depth");
    expect(script).toContain("quickstart");
    expect(script).toContain("harnesses");
  });

  it("includes shell names for completion sub-completion", () => {
    const script = generateBashScript();
    expect(script).toContain("bash zsh fish");
  });

  it("uses valid bash syntax patterns", () => {
    const script = generateBashScript();
    expect(script).toContain("COMPREPLY=");
    expect(script).toContain("compgen -W");
    expect(script).toContain("case ");
    expect(script).toContain("esac");
  });

  it("includes bash shebang comment", () => {
    const script = generateBashScript();
    expect(script).toContain("# bash completion for pm");
    expect(script).toContain("eval");
  });

  it("does not contain literal JS template interpolation artifacts", () => {
    const script = generateBashScript();
    // The script should have real bash variable syntax, not escaped versions
    expect(script).toContain("${COMP_WORDS[COMP_CWORD]}");
    expect(script).toContain("${COMP_WORDS[1]}");
    expect(script).not.toContain("\\${COMP_WORDS");
  });
});

describe("generateZshScript", () => {
  it("returns a string with zsh compdef header", () => {
    const script = generateZshScript();
    expect(typeof script).toBe("string");
    expect(script).toContain("#compdef pm");
    expect(script).toContain("compdef _pm pm");
  });

  it("includes all pm subcommand descriptions", () => {
    const script = generateZshScript();
    expect(script).toContain("init:Initialize");
    expect(script).toContain("extension:Manage extension lifecycle operations");
    expect(script).toContain("create:Create a new project management item");
    expect(script).toContain("completion:Generate shell completion");
    expect(script).toContain("guide:Browse local progressive-disclosure guides");
    expect(script).toContain("normalize:Normalize lifecycle metadata with dry-run planning or apply mode");
    expect(script).toContain("contracts:Show machine-readable command and schema contracts");
    expect(script).toContain("start-task:Lifecycle alias to claim and set in_progress");
    expect(script).toContain("pause-task:Lifecycle alias to reopen and release claim");
    expect(script).toContain("close-task:Lifecycle alias to close and release claim");
    expect(script).toContain("calendar:Show calendar views for deadlines and reminders");
    expect(script).toContain("cal:Alias for calendar");
    expect(script).toContain("context:Show a token-efficient project context snapshot");
    expect(script).toContain("ctx:Alias for context");
    expect(script).toContain("history-compact:Compact history streams into a synthetic baseline + retained tail");
    expect(script).toContain("history-redact:Redact sensitive literals/patterns and recompute history hashes");
    expect(script).toContain("plan:Agent-optimized Plan item workflow");
    expect(script).toContain("notes:List or add notes for an item");
    expect(script).toContain("learnings:List or add learnings for an item");
    expect(script).toContain("deps:Show dependency relationships for an item");
    expect(script).toContain("validate:Run standalone validation checks");
  });

  it("includes type completions for relevant flags", () => {
    const script = generateZshScript();
    expect(script).toContain("Epic Feature Task Chore Issue Decision Event Reminder Milestone Meeting Plan");
    expect(script).toContain("0 1 2 3 4");
    expect(script).toContain("keyword semantic hybrid");
    expect(script).toContain("bash zsh fish");
  });

  it("includes global flag completions", () => {
    const script = generateZshScript();
    expect(script).toContain("--json");
    expect(script).toContain("--quiet");
    expect(script).toContain("--path");
    expect(script).toContain("--no-extensions");
    expect(script).toContain("--no-pager");
    expect(script).toContain("--profile");
    expect(script).toContain("--version");
    expect(script).toContain("--help");
  });

  it("includes zsh _arguments blocks", () => {
    const script = generateZshScript();
    expect(script).toContain("_arguments");
    expect(script).toContain("_describe");
    expect(script).toContain("_pm_commands");
  });

  it("includes zsh completion for list filters", () => {
    const script = generateZshScript();
    expect(script).toContain("--assignee");
    expect(script).toContain("--sprint");
    expect(script).toContain("--release");
    expect(script).toContain("--limit");
    expect(script).toContain("--include-body");
  });

  it("includes zsh calendar and reminder flags", () => {
    const script = generateZshScript();
    expect(script).toContain("calendar|cal");
    expect(script).toContain("--view");
    expect(script).toContain("--past");
    expect(script).toContain("--full-period");
    expect(script).toContain("all deadlines reminders events scheduled");
    expect(script).toContain("--format");
    expect(script).toContain("--reminder");
    expect(script).toContain("--event");
    expect(script).toContain("--include");
    expect(script).toContain("--recurrence-lookahead-days");
  });

  it("includes zsh context flags", () => {
    const script = generateZshScript();
    expect(script).toContain("context|ctx");
    expect(script).toContain("--from");
    expect(script).toContain("--to");
    expect(script).toContain("--past");
    expect(script).toContain("markdown toon json");
  });

  it("includes zsh guide flags", () => {
    const script = generateZshScript();
    expect(script).toContain("guide)");
    expect(script).toContain("--list[Show guide topic index]");
    expect(script).toContain("--depth[Guide detail depth]");
  });

  it("includes strict health flags in zsh completion", () => {
    const script = generateZshScript();
    expect(script).toContain("--strict-directories[Treat optional item-type directories as required failures]");
    expect(script).toContain("--verbose-stale-items[Include full stale vectorization ID lists in health output]");
    expect(script).toContain("--brief[Emit compact health details for low-token agent checks]");
    expect(script).toContain("--summary[Emit one-line-style health status with check names and warning count]");
    expect(script).toContain("--strict-exit[Return non-zero exit when health warnings are present]");
    expect(script).toContain("--fail-on-warn[Alias for --strict-exit]");
  });

  it("includes extension doctor strict flags in zsh completion", () => {
    const script = generateZshScript();
    expect(script).toContain("--trace[Include registration traces in doctor deep diagnostics]");
    expect(script).toContain("--runtime-probe[Opt-in runtime activation probe for manage output]");
    expect(script).toContain("--fix-managed-state[Adopt unmanaged extensions before diagnostics/update checks]");
    expect(script).toContain("--strict-exit[Return non-zero exit when doctor warnings are present]");
    expect(script).toContain("--fail-on-warn[Alias for --strict-exit (doctor)]");
  });

  it("includes fail-on-empty-test-run in zsh test completions", () => {
    const script = generateZshScript();
    expect(script).toContain("--override-linked-pm-context[Force run-level --pm-context over per-linked-test pm_context_mode metadata]");
    expect(script).toContain("--fail-on-empty-test-run[Treat empty linked-test selections as failures]");
  });

  it("includes test-all pagination flags in zsh completion", () => {
    const script = generateZshScript();
    expect(script).toContain("--limit[Limit matching items before running linked tests]:number");
    expect(script).toContain("--offset[Skip matching items before running linked tests]:number");
  });

  it("includes deterministic tag choices for zsh --tag flags", () => {
    const script = generateZshScript(["Task"], ["beta", "alpha", "alpha"]);
    expect(script).toContain("--tag[Filter by tag]:(alpha beta)");
  });

  it("includes zsh update close-reason completion", () => {
    const script = generateZshScript();
    expect(script).toContain("--close-reason");
  });
});

describe("generateFishScript", () => {
  it("returns a string with fish complete commands", () => {
    const script = generateFishScript();
    expect(typeof script).toBe("string");
    expect(script).toContain("# Fish shell completion for pm");
    expect(script).toContain("complete -c pm");
  });

  it("disables file completion by default", () => {
    const script = generateFishScript();
    expect(script).toContain("complete -c pm -f");
  });

  it("includes global flag completions", () => {
    const script = generateFishScript();
    expect(script).toContain("-l json");
    expect(script).toContain("-l quiet");
    expect(script).toContain("-l path");
    expect(script).toContain("-l no-extensions");
    expect(script).toContain("-l profile");
    expect(script).toContain("-l version");
    expect(script).toContain("-l help");
  });

  it("includes all pm subcommands with descriptions", () => {
    const script = generateFishScript();
    for (const [cmd, desc] of [
      ["init", "Initialize"],
      ["extension", "Manage extension lifecycle operations"],
      ["create", "Create"],
      ["calendar", "deadline/reminder calendar views"],
      ["context", "project context snapshot"],
      ["notes", "List or add notes for an item"],
      ["learnings", "List or add learnings for an item"],
      ["get", "Show item details"],
      ["search", "Search items"],
      ["completion", "Generate shell completion"],
      ["guide", "progressive-disclosure guides"],
      ["normalize", "Normalize lifecycle metadata"],
      ["contracts", "machine-readable command and schema contracts"],
      ["health", "project tracker health"],
      ["stats", "project tracker statistics"],
      ["history-compact", "synthetic baseline + retained tail"],
      ["history-redact", "Redact sensitive literals/patterns and recompute history hashes"],
      ["plan", "Agent-optimized Plan workflow"],
    ] as [string, string][]) {
      expect(script).toContain(`-a ${cmd}`);
      expect(script).toContain(desc);
    }
  });

  it("includes list filter flags for list commands", () => {
    const script = generateFishScript();
    expect(script).toContain("-l type");
    expect(script).toContain("-l assignee");
    expect(script).toContain("-l sprint");
    expect(script).toContain("-l release");
    expect(script).toContain("-l priority");
    expect(script).toContain("-l limit");
    expect(script).toContain("-l include-body");
    expect(script).toContain("-l deadline-before");
    expect(script).toContain("-l deadline-after");
  });

  it("includes type and status value completions", () => {
    const script = generateFishScript();
    expect(script).toContain("Epic Feature Task Chore Issue Decision Event Reminder Milestone Meeting Plan");
    expect(script).toContain("0 1 2 3 4");
  });

  it("includes search mode completions", () => {
    const script = generateFishScript();
    expect(script).toContain("keyword semantic hybrid");
  });

  it("includes contracts command flag completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from contracts");
    expect(script).toContain("-l action");
    expect(script).toContain("-l command");
    expect(script).toContain("-l schema-only");
    expect(script).toContain("-l flags-only");
    expect(script).toContain("-l availability-only");
    expect(script).toContain("-l runtime-only");
    expect(script).toContain("-l active-only");
  });

  it("includes completion shell argument completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from completion");
    expect(script).toContain("-l eager-tags");
    expect(script).toContain("bash zsh fish");
  });

  it("includes extension lifecycle completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from extension");
    expect(script).toContain("-l install");
    expect(script).toContain("-l uninstall");
    expect(script).toContain("-l explore");
    expect(script).toContain("-l manage");
    expect(script).toContain("-l doctor");
    expect(script).toContain("-l adopt");
    expect(script).toContain("-l adopt-all");
    expect(script).toContain("-l activate");
    expect(script).toContain("-l deactivate");
    expect(script).toContain("-l gh");
    expect(script).toContain("-l github");
    expect(script).toContain("-l ref");
    expect(script).toContain("-l detail");
    expect(script).toContain("-l trace");
    expect(script).toContain("-l runtime-probe");
    expect(script).toContain("-l fix-managed-state");
    expect(script).toContain("-l strict-exit");
    expect(script).toContain("-l fail-on-warn");
  });

  it("includes strict health flags in fish completion", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from health");
    expect(script).toContain("-l strict-directories");
    expect(script).toContain("-l verbose-stale-items");
    expect(script).toContain("-l brief");
    expect(script).toContain(
      "complete -c pm -n '__fish_seen_subcommand_from health' -l summary -d 'Emit one-line-style health status with check names and warning count'",
    );
    expect(script).toContain("-l strict-exit");
    expect(script).toContain("-l fail-on-warn");
  });

  it("includes fail-on-empty-test-run in fish test completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from test");
    expect(script).toContain("-l override-linked-pm-context");
    expect(script).toContain("-l fail-on-empty-test-run");
    expect(script).toContain("__fish_seen_subcommand_from test-all");
  });

  it("includes test-all pagination flags in fish completion", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from test-all");
    expect(script).toContain("-l limit -d 'Limit matching items before running linked tests'");
    expect(script).toContain("-l offset -d 'Skip matching items before running linked tests'");
  });

  it("includes __pm_no_subcommand helper function", () => {
    const script = generateFishScript();
    expect(script).toContain("function __pm_no_subcommand");
    expect(script).toContain("__fish_seen_subcommand_from");
  });

  it("includes create flag completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from create");
    expect(script).toContain("-l title");
    expect(script).toContain("-l description");
    expect(script).toContain("-l schedule-preset");
    expect(script).toContain("-l acceptance-criteria");
  });

  it("includes update-specific flag completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from update");
    expect(script).toContain("-l body");
    expect(script).toContain("-l close-reason");
    expect(script).toContain("-l force");
    expect(script).toContain("-l replace-tests");
    expect(script).toContain("-l reminder");
    expect(script).toContain("-l event");
  });

  it("includes fish calendar completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from calendar cal");
    expect(script).toContain("-l view");
    expect(script).toContain("-l past");
    expect(script).toContain("-l full-period");
    expect(script).toContain("-l include");
    expect(script).toContain("all deadlines reminders events scheduled");
    expect(script).toContain("-l occurrence-limit");
    expect(script).toContain("-l format");
  });

  it("includes fish context completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from context ctx");
    expect(script).toContain("-l from");
    expect(script).toContain("-l to");
    expect(script).toContain("-l past");
    expect(script).toContain("-l format");
  });

  it("includes fish guide completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from guide");
    expect(script).toContain("-l list");
    expect(script).toContain("-l depth");
  });

  it("includes deterministic tag choices for fish --tag flags", () => {
    const script = generateFishScript(["Task"], ["beta", "alpha", "alpha"]);
    expect(script).toContain("-l tag      -d 'Filter by tag' -r -a 'alpha beta'");
  });
});

describe("runCompletion", () => {
  it("returns bash completion result for bash shell", () => {
    const result: CompletionResult = runCompletion("bash");
    expect(result.shell).toBe("bash");
    expect(result.script).toContain("_pm_completion");
    expect(result.setup_hint).toContain("~/.bashrc");
    expect(result.setup_hint).toContain("eval");
  });

  it("returns zsh completion result for zsh shell", () => {
    const result: CompletionResult = runCompletion("zsh");
    expect(result.shell).toBe("zsh");
    expect(result.script).toContain("#compdef pm");
    expect(result.setup_hint).toContain("~/.zshrc");
  });

  it("returns fish completion result for fish shell", () => {
    const result: CompletionResult = runCompletion("fish");
    expect(result.shell).toBe("fish");
    expect(result.script).toContain("complete -c pm");
    expect(result.setup_hint).toContain("~/.config/fish/completions/pm.fish");
  });

  it("normalizes shell argument case", () => {
    expect(runCompletion("BASH").shell).toBe("bash");
    expect(runCompletion("ZSH").shell).toBe("zsh");
    expect(runCompletion("FISH").shell).toBe("fish");
    expect(runCompletion("Bash").shell).toBe("bash");
  });

  it("normalizes shell argument whitespace", () => {
    expect(runCompletion("  bash  ").shell).toBe("bash");
    expect(runCompletion("  zsh  ").shell).toBe("zsh");
  });

  it("throws PmCliError with exit code USAGE for unknown shell", () => {
    expect(() => runCompletion("powershell")).toThrow(PmCliError);
    try {
      runCompletion("powershell");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect((error as PmCliError).message).toContain("powershell");
      expect((error as PmCliError).message).toContain("bash");
      expect((error as PmCliError).message).toContain("zsh");
      expect((error as PmCliError).message).toContain("fish");
    }
  });

  it("throws PmCliError for empty string shell", () => {
    expect(() => runCompletion("")).toThrow(PmCliError);
    try {
      runCompletion("");
    } catch (error: unknown) {
      expect((error as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
    }
  });

  it("throws PmCliError for whitespace-only shell", () => {
    expect(() => runCompletion("   ")).toThrow(PmCliError);
  });

  it("all scripts are non-empty strings", () => {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const result = runCompletion(shell);
      expect(result.script.length).toBeGreaterThan(100);
    }
  });

  it("all setup_hints are non-empty strings", () => {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const result = runCompletion(shell);
      expect(result.setup_hint.length).toBeGreaterThan(10);
    }
  });

  it("applies runtime statuses, item types, and schema field flags for generated scripts", () => {
    const runtime = {
      item_types: ["Bug", "Task"],
      statuses: ["qa_review", "draft"],
      command_flags: {
        list: ["--customer_segment", "--alpha_segment"],
        search: ["--customer_segment"],
      },
    } satisfies CompletionRuntimeConfig;

    const bashResult = runCompletion("bash", [], [], false, runtime);
    expect(bashResult.script).toContain("pm completion-statuses");
    expect(bashResult.script).toContain("pm completion-types");
    expect(bashResult.script).toContain('resolved="Bug Task"');
    expect(bashResult.script).toContain('resolved="draft qa_review"');
    expect(bashResult.script).toContain('compgen -W "$(_pm_completion_status_choices)"');
    expect(bashResult.script).toContain('compgen -W "$(_pm_completion_type_choices)"');

    const zshResult = runCompletion("zsh", ["Task"], [], false, runtime);
    expect(zshResult.script).toContain("_pm_status_choices()");
    expect(zshResult.script).toContain("pm completion-statuses");
    expect(zshResult.script).toContain('resolved="draft qa_review"');
    expect(zshResult.script).toContain('--status[Filter by status]:(${(f)"$(_pm_status_choices)"})');
    expect(zshResult.script).not.toContain("_pm_type_choices()");
    const alphaFlagIndex = zshResult.script.indexOf("--alpha-segment[Runtime schema field flag]:value");
    const customerFlagIndex = zshResult.script.indexOf("--customer-segment[Runtime schema field flag]:value");
    expect(alphaFlagIndex).toBeGreaterThan(-1);
    expect(customerFlagIndex).toBeGreaterThan(-1);
    expect(alphaFlagIndex).toBeLessThan(customerFlagIndex);
    expect(zshResult.script).toContain("--customer-segment[Runtime schema field flag]:value");

    const fishResult = runCompletion("fish", ["Task"], [], false, runtime);
    expect(fishResult.script).toContain("function __pm_status_choices");
    expect(fishResult.script).toContain("pm completion-statuses");
    expect(fishResult.script).toContain("set resolved 'draft qa_review'");
    expect(fishResult.script).toContain("-l status -d 'Filter by status' -r -a '(__pm_status_choices)'");
    expect(fishResult.script).not.toContain("function __pm_type_choices");
    expect(fishResult.script).toContain("-l alpha-segment -d 'Runtime schema field flag' -r");
    expect(fishResult.script).toContain("-l customer-segment -d 'Runtime schema field flag' -r");
  });

  it("deduplicates runtime flags after underscore normalization", () => {
    const runtime = {
      command_flags: {
        search: ["  --customer_segment  ", "--customer-segment", "--"],
      },
    } satisfies CompletionRuntimeConfig;

    const zshResult = runCompletion("zsh", ["Task"], [], false, runtime);
    expect((zshResult.script.match(/--customer-segment\[Runtime schema field flag\]:value/g) ?? []).length).toBe(1);
    expect(zshResult.script).not.toContain("--[Runtime schema field flag]");

    const fishResult = runCompletion("fish", ["Task"], [], false, runtime);
    expect((fishResult.script.match(/-l customer-segment -d 'Runtime schema field flag' -r/g) ?? []).length).toBe(1);
  });
});

describe("pm completion CLI command", () => {
  function installGuideShellPackage(
    context: {
      runCli: (args: string[], options?: { expectJson?: boolean; cwd?: string }) => {
        code: number | null;
      };
    },
  ): void {
    const install = context.runCli(["install", "guide-shell", "--project", "--json"], { expectJson: true });
    expect(install.code).toBe(0);
  }

  it("outputs raw script to stdout without --json", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const result = context.runCli(["completion", "bash"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("_pm_completion");
      expect(result.stdout).toContain("complete -F _pm_completion pm");
      // Should NOT contain JSON wrapper
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  it("outputs JSON object with --json", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const result = context.runCli(["completion", "bash", "--json"], { expectJson: true });
      expect(result.code).toBe(0);
      const json = result.json as CompletionResult;
      expect(json.shell).toBe("bash");
      expect(typeof json.script).toBe("string");
      expect(json.script.length).toBeGreaterThan(100);
      expect(typeof json.setup_hint).toBe("string");
    });
  });

  it("emits runtime field completion flags using canonical dashed CLI tokens", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const settings = await readSettings(context.pmPath);
      settings.schema.fields = [
        ...(settings.schema.fields ?? []),
        {
          key: "customer_segment",
          type: "string",
          commands: ["list", "create", "update", "search"],
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");

      const result = context.runCli(["completion", "bash"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--customer-segment");
      expect(result.stdout).not.toContain("--customersegment");

      const zshResult = context.runCli(["completion", "zsh"]);
      expect(zshResult.code).toBe(0);
      expect(zshResult.stdout).toContain("--customer-segment[Runtime schema field flag]:value");

      const fishResult = context.runCli(["completion", "fish"]);
      expect(fishResult.code).toBe(0);
      expect(fishResult.stdout).toContain("-l customer-segment -d 'Runtime schema field flag' -r");
    });
  });

  it("resolves status and type helper commands from runtime config", async () => {
    await withTempPmPath(async (context) => {
      context.env.PM_CLI_PACKAGE_ROOT = process.cwd();
      installGuideShellPackage(context);
      const settings = await readSettings(context.pmPath);
      settings.schema.statuses = [
        ...(settings.schema.statuses ?? []),
        {
          id: "qa_review",
          roles: ["active"],
        },
      ];
      settings.item_types.definitions = [
        ...(settings.item_types.definitions ?? []),
        {
          name: "Bug",
        },
      ];
      await writeSettings(context.pmPath, settings, "settings:write");

      const statuses = context.runCli(["completion-statuses"]);
      expect(statuses.code).toBe(0);
      expect(statuses.stdout).toContain("qa_review");
      expect(statuses.stdout).toContain("open");

      const types = context.runCli(["completion-types"]);
      expect(types.code).toBe(0);
      expect(types.stdout).toContain("Bug");
      expect(types.stdout).toContain("Task");

      const bashResult = context.runCli(["completion", "bash"]);
      expect(bashResult.code).toBe(0);
      expect(bashResult.stdout).toContain("pm completion-statuses");
      expect(bashResult.stdout).toContain("pm completion-types");
      expect(bashResult.stdout).toContain("qa_review");
      expect(bashResult.stdout).toContain("Bug");

      const zshResult = context.runCli(["completion", "zsh"]);
      expect(zshResult.code).toBe(0);
      expect(zshResult.stdout).toContain('--status[Filter by status]:(${(f)"$(_pm_status_choices)"})');
      expect(zshResult.stdout).toContain('--type[Filter by item type]:(${(f)"$(_pm_type_choices)"})');

      const fishResult = context.runCli(["completion", "fish"]);
      expect(fishResult.code).toBe(0);
      expect(fishResult.stdout).toContain("-l status -d 'Filter by status' -r -a '(__pm_status_choices)'");
      expect(fishResult.stdout).toContain("-l type     -d 'Filter by item type' -r -a '(__pm_type_choices)'");
    });
  });

  it("outputs zsh script to stdout", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const result = context.runCli(["completion", "zsh"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("#compdef pm");
      expect(result.stdout).toContain("compdef _pm pm");
    });
  });

  it("outputs fish script to stdout", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const result = context.runCli(["completion", "fish"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("complete -c pm");
      expect(result.stdout).toContain("__pm_no_subcommand");
    });
  });

  it("returns non-zero for unknown shell", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const result = context.runCli(["completion", "powershell"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("powershell");
    });
  });

  it("produces no output with --quiet", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const result = context.runCli(["completion", "bash", "--quiet"]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });
  });

  it("completion command appears in --help output", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("completion");
    });
  });

  it("completion --help describes the shell argument", async () => {
    await withTempPmPath(async (context) => {
      installGuideShellPackage(context);
      const help = context.runCli(["completion", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("shell");
      expect(help.stdout).toContain("bash");
    });
  });
});
