import { describe, expect, it } from "vitest";

import {
  extractProvidedOptionFlags,
  normalizeLongFlag,
  normalizeLongOptionFlag,
  quoteCommandArg,
  redactSensitiveCommandArgs,
  renderPmCommand,
} from "../../../src/cli/argv-utils.js";

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
    ).toEqual(["history-redact", "--literal", "--dry-run"]);
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
    expect(quoteCommandArg("C:\\workspace\\.agents\\pm", "win32")).toBe(
      "C:\\workspace\\.agents\\pm",
    );
    expect(
      renderPmCommand(
        ["--pm-path", "C:\\project files\\.agents\\pm", "init"],
        "win32",
      ),
    ).toBe('pm --pm-path "C:\\project files\\.agents\\pm" init');
    expect(quoteCommandArg('title "quoted"', "win32")).toBe(
      '"title \\"quoted\\""',
    );
    expect(quoteCommandArg(`path${"\\"}"quoted`, "win32")).toBe(
      `"path${"\\".repeat(3)}"quoted"`,
    );
    expect(quoteCommandArg("C:\\Program Files\\pm\\", "win32")).toBe(
      '"C:\\Program Files\\pm\\\\"',
    );
  });
});
