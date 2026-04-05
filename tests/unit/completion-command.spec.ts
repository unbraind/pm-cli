import { describe, expect, it } from "vitest";
import {
  generateBashScript,
  generateZshScript,
  generateFishScript,
  runCompletion,
  type CompletionResult,
} from "../../src/cli/commands/completion.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
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
      "activity",
      "restore",
      "close",
      "delete",
      "append",
      "comments",
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
      "claim",
      "release",
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
    expect(script).toContain("--comment");
    expect(script).toContain("--note");
    expect(script).toContain("--learning");
    expect(script).toContain("--file");
    expect(script).toContain("--test");
    expect(script).toContain("--doc");
    expect(script).toContain("--reminder");
    expect(script).toContain("--event");
  });

  it("includes comments mutation metadata flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--add --limit --author --message --force");
    expect(script).toContain("--allow-audit-comment");
    expect(script).toContain("--status --type --assignee --limit-items --full-history --latest");
  });

  it("includes files/docs add-glob flag in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--add --add-glob --remove --migrate --validate-paths --audit");
  });

  it("includes files append-stable flag in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--append-stable");
  });

  it("includes validate scan-mode flag in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain(
      "--check-metadata --metadata-profile --check-resolution --check-files --scan-mode --include-pm-internals --strict-exit --fail-on-warn --check-history-drift --check-command-references",
    );
  });

  it("includes strict health flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain("--strict-directories --strict-exit --fail-on-warn --json --quiet --path --no-extensions --profile --help");
  });

  it("includes extension doctor strict flags in bash completion", () => {
    const script = generateBashScript();
    expect(script).toContain(
      "--doctor --adopt --adopt-all --activate --deactivate --project --local --global --gh --github --ref --detail --trace --runtime-probe --fix-managed-state --strict-exit --fail-on-warn",
    );
  });

  it("includes fail-on-empty-test-run in bash test completions", () => {
    const script = generateBashScript();
    expect(script).toContain("--fail-on-skipped --fail-on-empty-test-run --require-assertions-for-pm");
  });

  it("includes calendar-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("calendar|cal");
    expect(script).toContain("--view");
    expect(script).toContain("--from");
    expect(script).toContain("--to");
    expect(script).toContain("--past");
    expect(script).toContain("--include");
    expect(script).toContain("--occurrence-limit");
    expect(script).toContain("--format");
  });

  it("includes search-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--mode");
    expect(script).toContain("--include-linked");
  });

  it("includes deterministic tag suggestions for --tag completion", () => {
    const script = generateBashScript(["Task"], ["beta", "alpha", "alpha"]);
    expect(script).toContain('"$prev" == "--tag"');
    expect(script).toContain('"alpha beta"');
  });

  it("includes context-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("context|ctx");
    expect(script).toContain("--from");
    expect(script).toContain("--to");
    expect(script).toContain("--past");
    expect(script).toContain("--format");
  });

  it("includes shell names for completion sub-completion", () => {
    const script = generateBashScript();
    expect(script).toContain('"bash zsh fish"');
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
    expect(script).toContain("contracts:Show machine-readable command and schema contracts");
    expect(script).toContain("calendar:Show calendar views for deadlines and reminders");
    expect(script).toContain("cal:Alias for calendar");
    expect(script).toContain("context:Show a token-efficient project context snapshot");
    expect(script).toContain("ctx:Alias for context");
    expect(script).toContain("notes:List or add notes for an item");
    expect(script).toContain("learnings:List or add learnings for an item");
    expect(script).toContain("deps:Show dependency relationships for an item");
    expect(script).toContain("validate:Run standalone validation checks");
  });

  it("includes type completions for relevant flags", () => {
    const script = generateZshScript();
    expect(script).toContain("Epic Feature Task Chore Issue Event Reminder Milestone Meeting");
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

  it("includes strict health flags in zsh completion", () => {
    const script = generateZshScript();
    expect(script).toContain("--strict-directories[Treat optional item-type directories as required failures]");
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
    expect(script).toContain("--fail-on-empty-test-run[Treat empty linked-test selections as failures]");
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
      ["contracts", "machine-readable command and schema contracts"],
      ["health", "project tracker health"],
      ["stats", "project tracker statistics"],
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
    expect(script).toContain("Epic Feature Task Chore Issue Event Reminder Milestone Meeting");
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
    expect(script).toContain("-l runtime-only");
    expect(script).toContain("-l active-only");
  });

  it("includes completion shell argument completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from completion");
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
    expect(script).toContain("-l strict-exit");
    expect(script).toContain("-l fail-on-warn");
  });

  it("includes fail-on-empty-test-run in fish test completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from test");
    expect(script).toContain("-l fail-on-empty-test-run");
    expect(script).toContain("__fish_seen_subcommand_from test-all");
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
    expect(script).toContain("-l acceptance-criteria");
  });

  it("includes update-specific flag completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from update");
    expect(script).toContain("-l body");
    expect(script).toContain("-l close-reason");
    expect(script).toContain("-l force");
    expect(script).toContain("-l reminder");
    expect(script).toContain("-l event");
  });

  it("includes fish calendar completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from calendar cal");
    expect(script).toContain("-l view");
    expect(script).toContain("-l past");
    expect(script).toContain("-l include");
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
});

describe("pm completion CLI command", () => {
  it("outputs raw script to stdout without --json", async () => {
    await withTempPmPath(async (context) => {
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
      const result = context.runCli(["completion", "bash", "--json"], { expectJson: true });
      expect(result.code).toBe(0);
      const json = result.json as CompletionResult;
      expect(json.shell).toBe("bash");
      expect(typeof json.script).toBe("string");
      expect(json.script.length).toBeGreaterThan(100);
      expect(typeof json.setup_hint).toBe("string");
    });
  });

  it("outputs zsh script to stdout", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["completion", "zsh"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("#compdef pm");
      expect(result.stdout).toContain("compdef _pm pm");
    });
  });

  it("outputs fish script to stdout", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["completion", "fish"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("complete -c pm");
      expect(result.stdout).toContain("__pm_no_subcommand");
    });
  });

  it("returns exit code 2 for unknown shell", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["completion", "powershell"]);
      expect(result.code).toBe(EXIT_CODE.USAGE);
      expect(result.stderr).toContain("powershell");
    });
  });

  it("produces no output with --quiet", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli(["completion", "bash", "--quiet"]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });
  });

  it("completion command appears in --help output", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("completion");
    });
  });

  it("completion --help describes the shell argument", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["completion", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("shell");
      expect(help.stdout).toContain("bash");
    });
  });
});
