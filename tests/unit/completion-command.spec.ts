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
      "install",
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
      "search",
      "reindex",
      "history",
      "activity",
      "restore",
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
    expect(script).toContain("--deadline-before");
    expect(script).toContain("--deadline-after");
  });

  it("includes create-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--title");
    expect(script).toContain("--description");
    expect(script).toContain("--acceptance-criteria");
    expect(script).toContain("--dep");
    expect(script).toContain("--comment");
    expect(script).toContain("--note");
    expect(script).toContain("--learning");
  });

  it("includes update flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--force");
    expect(script).toContain("--message");
    expect(script).toContain("--author");
  });

  it("includes search-specific flags", () => {
    const script = generateBashScript();
    expect(script).toContain("--mode");
    expect(script).toContain("--include-linked");
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
    expect(script).toContain("install:Install supported integrations and extensions");
    expect(script).toContain("create:Create a new project management item");
    expect(script).toContain("completion:Generate shell completion");
    expect(script).toContain("beads:Built-in Beads extension commands");
    expect(script).toContain("todos:Built-in todos extension commands");
  });

  it("includes type completions for relevant flags", () => {
    const script = generateZshScript();
    expect(script).toContain("Epic Feature Task Chore Issue");
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

  it("includes beads and todos subcommand completion", () => {
    const script = generateZshScript();
    expect(script).toContain("import:Import Beads JSONL records");
    expect(script).toContain("import:Import todos markdown files");
    expect(script).toContain("export:Export todos markdown files");
  });

  it("includes zsh completion for list filters", () => {
    const script = generateZshScript();
    expect(script).toContain("--assignee");
    expect(script).toContain("--sprint");
    expect(script).toContain("--release");
    expect(script).toContain("--limit");
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
      ["install", "Install supported integrations and extensions"],
      ["create", "Create"],
      ["get", "Show item details"],
      ["search", "Search items"],
      ["completion", "Generate shell completion"],
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
    expect(script).toContain("-l deadline-before");
    expect(script).toContain("-l deadline-after");
  });

  it("includes type and status value completions", () => {
    const script = generateFishScript();
    expect(script).toContain("Epic Feature Task Chore Issue");
    expect(script).toContain("0 1 2 3 4");
  });

  it("includes search mode completions", () => {
    const script = generateFishScript();
    expect(script).toContain("keyword semantic hybrid");
  });

  it("includes completion shell argument completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from completion");
    expect(script).toContain("bash zsh fish");
  });

  it("includes install target and scope completions", () => {
    const script = generateFishScript();
    expect(script).toContain("__fish_seen_subcommand_from install");
    expect(script).toContain("Install pm Pi extension");
    expect(script).toContain("-l project");
    expect(script).toContain("-l global");
  });

  it("includes beads and todos subcommand completions", () => {
    const script = generateFishScript();
    expect(script).toContain("Import Beads JSONL records");
    expect(script).toContain("Import todos markdown files");
    expect(script).toContain("Export todos markdown files");
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
    expect(script).toContain("-l force");
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
