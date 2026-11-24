import { describe, expect, it } from "vitest";

import {
  extractProvidedOptionFlags,
  normalizeLongFlag,
  normalizeLongOptionFlag,
  quoteCommandArg,
  redactSensitiveCommandArgs,
  renderPmCommand,
} from "../../../src/cli/argv-utils.js";
import {
  COMMAND_SHELL_ENV,
  quoteCmdCommandArg,
  quotePosixCommandArg,
  quotePowerShellCommandArg,
  resolveCommandShellDialect,
} from "../../../src/core/shared/command-line.js";

describe("argv-utils.normalizeLongOptionFlag", () => {
  it("normalizes long flags and accepts inline =value forms", () => {
    expect(normalizeLongOptionFlag("--dry_run")).toBe("--dry-run");
    expect(normalizeLongOptionFlag("--max-results=5")).toBe("--max-results");
  });

  it("returns undefined for tokens that are not long flags", () => {
    expect(normalizeLongOptionFlag("-x")).toBeUndefined();
    expect(normalizeLongOptionFlag("positional")).toBeUndefined();
  });
});

describe("argv-utils.redactSensitiveCommandArgs", () => {
  it("recognizes only the leading redaction command while preserving bootstrap prefixes", () => {
    for (const argv of [
      [],
      ["--json"],
      ["--", "history", "redact", "--literal", "ordinary-value"],
      ["create", "--title", "history", "--description", "redact", "--literal", "ordinary-value"],
      ["create", "--title", "history-redact", "--replacement=ordinary-value"],
      ["--pm-path", "history-redact", "create", "--regex", "ordinary-value"],
      ["history", "pm-example", "redact", "--literal", "ordinary-value"],
      ["history"],
      ["history", "--", "redact", "--literal", "ordinary-value"],
      ["history", "--author", "redact", "pm-example", "--literal", "ordinary-value"],
    ]) {
      expect(redactSensitiveCommandArgs(argv)).toEqual(argv);
    }
    for (const prefix of [
      ["history", "redact"],
      ["--json", "history-redact"],
      ["--pm-path", "history", "history", "--author", "redact", "redact"],
      ["--output-format=json", "history", "--quiet", "redact"],
      ["--unknown", "history", "--unknown", "redact"],
    ]) {
      expect(redactSensitiveCommandArgs([...prefix, "--literal", "private-canary"]))
        .toEqual([...prefix, "--literal", "[redacted]"]);
    }
  });

  it("preserves ordinary commands and redacts every history-redact input form", () => {
    expect(redactSensitiveCommandArgs(["get", "pm-example"])).toEqual([
      "get",
      "pm-example",
    ]);
    expect(
      redactSensitiveCommandArgs([
        "history-redact",
        "pm-example",
        "--literal",
        "literal-canary",
        "--regex=regex-canary",
        "--replacement",
        "replacement-canary",
        "--dry-run",
      ]),
    ).toEqual([
      "history-redact",
      "pm-example",
      "--literal",
      "[redacted]",
      "--regex=[redacted]",
      "--replacement",
      "[redacted]",
      "--dry-run",
    ]);
    expect(redactSensitiveCommandArgs(["history-redact", "--literal"])).toEqual(
      ["history-redact", "--literal"],
    );
    expect(
      redactSensitiveCommandArgs([
        "history-redact",
        "--literal",
        "--dry-run",
      ]),
    ).toEqual(["history-redact", "--literal", "[redacted]"]);
  });
});

describe("argv-utils.normalizeLongFlag", () => {
  it("normalizes camelCase and snake_case into canonical long flags", () => {
    expect(normalizeLongFlag("dryRun")).toBe("--dry-run");
    expect(normalizeLongFlag("--max_results")).toBe("--max-results");
  });
});

describe("argv-utils.extractProvidedOptionFlags", () => {
  it("collects long flags in first-seen order and dedupes repeated flags", () => {
    expect(
      extractProvidedOptionFlags([
        "create",
        "--type",
        "Task",
        "--tag",
        "a",
        "--tag",
        "b",
        "positional",
      ]),
    ).toEqual(["--type", "--tag"]);
  });
});

describe("argv-utils.quoteCommandArg / renderPmCommand", () => {
  it("leaves safe tokens bare and quotes/escapes unsafe tokens", () => {
    expect(quoteCommandArg("src/cli/main.ts", "linux")).toBe("src/cli/main.ts");
    expect(quoteCommandArg('a "b" $c', "linux")).toBe('"a \\"b\\" \\$c"');
  });

  it("renders a pm command line with per-token quoting", () => {
    expect(renderPmCommand(["create", "--title", "hello world"])).toBe(
      'pm create --title "hello world"',
    );
    expect(renderPmCommand([])).toBe("pm");
  });

  it("preserves native Windows path separators in copy-safe command hints", () => {
    expect(quoteCommandArg("C:\\workspace\\.agents\\pm", "win32", "cmd")).toBe(
      "C:\\workspace\\.agents\\pm",
    );
    expect(
      renderPmCommand(
        ["--pm-path", "C:\\project files\\.agents\\pm", "init"],
        "win32",
        "cmd",
      ),
    ).toBe('pm --pm-path "C:\\project files\\.agents\\pm" init');
    // A quote inside the argument would flip cmd.exe's quote state, so the cmd form caret-escapes it (GH-1774).
    expect(quoteCommandArg('title "quoted"', "win32", "cmd")).toBe(
      '^"title \\^"quoted\\^"^"',
    );
    expect(quoteCommandArg(`path${"\\"}"quoted`, "win32", "cmd")).toBe(
      `^"path${"\\".repeat(3)}^"quoted^"`,
    );
    expect(quoteCommandArg("C:\\Program Files\\pm\\", "win32", "cmd")).toBe(
      '"C:\\Program Files\\pm\\\\"',
    );
  });
});

describe("argv-utils shell dialects (pm-kjoudp, GH-1774)", () => {
  it("resolves the declared shell from PM_COMMAND_SHELL, defaulting to cmd on Windows and posix elsewhere", () => {
    expect(resolveCommandShellDialect("win32", {})).toBe("cmd");
    expect(resolveCommandShellDialect("linux", {})).toBe("posix");
    expect(resolveCommandShellDialect("darwin", { PM_COMMAND_SHELL: "" })).toBe("posix");
    expect(resolveCommandShellDialect("win32", { PM_COMMAND_SHELL: " PowerShell " })).toBe("powershell");
    expect(resolveCommandShellDialect("win32", { PM_COMMAND_SHELL: "pwsh" })).toBe("powershell");
    expect(resolveCommandShellDialect("win32", { PM_COMMAND_SHELL: "bash" })).toBe("posix");
    expect(resolveCommandShellDialect("linux", { PM_COMMAND_SHELL: "cmd.exe" })).toBe("cmd");
    // An unrecognized value never selects a dialect the caller did not choose.
    expect(resolveCommandShellDialect("win32", { PM_COMMAND_SHELL: "fish" })).toBe("cmd");
    expect(resolveCommandShellDialect("linux", { PM_COMMAND_SHELL: "constructor" })).toBe("posix");
    expect(COMMAND_SHELL_ENV).toBe("PM_COMMAND_SHELL");
  });

  it("renders a %VAR% tracker path that cmd.exe cannot expand", () => {
    expect(renderPmCommand(["--pm-path", "C:\\repo\\%TRACKER%\\pm", "get", "item-1"], "win32", "cmd")).toBe(
      'pm --pm-path ^"C:\\repo\\%^TRACKER%^\\pm^" get item-1',
    );
    // Every percent sign is followed by a caret, so no %name% or %name:modifier% text names a defined variable.
    for (const arg of ["C:\\x\\%PATH:a=b%", "100%", "%%", "50% & 25%", 'say "%OS%"']) {
      const rendered = quoteCmdCommandArg(arg);
      expect(rendered).toMatch(/^\^"/u);
      expect(rendered.match(/%(?!\^)/gu)).toBeNull();
    }
    expect(quoteCmdCommandArg("%%")).toBe('^"%^%^"');
    expect(quoteCmdCommandArg("100%")).toBe('^"100%^"');
    // A quote and a later & stay escaped; plain quoting still covers metacharacters without % or ".
    expect(quoteCmdCommandArg('a"b & calc')).toBe('^"a\\^"b ^& calc^"');
    expect(quoteCmdCommandArg("a & b | (c) <d> ^e !f")).toBe('"a & b | (c) <d> ^e !f"');
  });

  it("leaves $, $(...) and backticks inert inside cmd.exe quotes and PowerShell literal strings", () => {
    const path = "C:\\trackers\\$(Start-Process calc)\\`tick";
    expect(quoteCommandArg(path, "win32", "cmd")).toBe('"C:\\trackers\\$(Start-Process calc)\\`tick"');
    expect(quoteCommandArg(path, "win32", "powershell")).toBe("'C:\\trackers\\$(Start-Process calc)\\`tick'");
    expect(quoteCommandArg("C:\\repo\\%TRACKER%\\pm", "win32", "powershell")).toBe("'C:\\repo\\%TRACKER%\\pm'");
    expect(renderPmCommand(["--pm-path", path, "get", "item-1"], "win32", "powershell")).toBe(
      "pm --pm-path 'C:\\trackers\\$(Start-Process calc)\\`tick' get item-1",
    );
  });

  it("doubles every PowerShell single quote and quotes tokens PowerShell would reinterpret", () => {
    expect(quotePowerShellCommandArg("it's")).toBe("'it''s'");
    expect(quotePowerShellCommandArg("smart\u2019s \u2018q\u2019 \u201Alow\u201B")).toBe("'smart\u2019\u2019s \u2018\u2018q\u2019\u2019 \u201A\u201Alow\u201B\u201B'");
    expect(quoteCommandArg("@splat", "win32", "powershell")).toBe("'@splat'");
    expect(quoteCommandArg("--", "win32", "powershell")).toBe("'--'");
    expect(quoteCommandArg("--fields", "win32", "powershell")).toBe("--fields");
    expect(quoteCommandArg("a,b", "win32", "powershell")).toBe("'a,b'");
    expect(quoteCommandArg("user@host", "win32", "powershell")).toBe("user@host");
    expect(quoteCommandArg("C:\\repo\\pm", "linux", "powershell")).toBe("C:\\repo\\pm");
    expect(quoteCommandArg("", "win32", "powershell")).toBe("''");
  });

  it("single-quotes a POSIX argument holding ! so interactive bash and zsh cannot history-expand it (pm-oq893h)", () => {
    expect(quoteCommandArg("literal !!", "linux")).toBe("'literal !!'");
    expect(quotePosixCommandArg("it's !$")).toBe("'it'\\''s !$'");
    expect(quoteCommandArg("no bang $HOME", "linux")).toBe('"no bang \\$HOME"');
  });

  it("follows PM_COMMAND_SHELL when no dialect is passed", () => {
    const previous = process.env.PM_COMMAND_SHELL;
    try {
      process.env.PM_COMMAND_SHELL = "powershell";
      expect(renderPmCommand(["get", "it's"], "win32")).toBe("pm get 'it''s'");
      process.env.PM_COMMAND_SHELL = "posix";
      expect(renderPmCommand(["--pm-path", "C:\\repo", "get"], "win32")).toBe('pm --pm-path "C:\\\\repo" get');
    } finally {
      if (previous === undefined) delete process.env.PM_COMMAND_SHELL;
      else process.env.PM_COMMAND_SHELL = previous;
    }
  });
});
