import { describe, expect, it } from "vitest";
import {
  parseBootstrapGlobalOptions,
  stripGlobalBootstrapTokens,
  parseBootstrapHelpRequest,
  parseBootstrapCommandName,
  normalizeLegacyExtensionActionSyntax,
  normalizeBootstrapInvocation,
  parseBootstrapTypeValue,
} from "../../src/cli/bootstrap-args.js";

describe("parseBootstrapGlobalOptions", () => {
  it("returns defaults for empty argv", () => {
    const result = parseBootstrapGlobalOptions([]);
    expect(result).toEqual({
      path: undefined,
      noExtensions: false,
      noPager: false,
      json: false,
      quiet: false,
    });
  });

  it("parses --path with space-separated value", () => {
    const result = parseBootstrapGlobalOptions(["--path", "/tmp/pm"]);
    expect(result.path).toBe("/tmp/pm");
  });

  it("parses --path= inline syntax", () => {
    const result = parseBootstrapGlobalOptions(["--path=/custom/dir"]);
    expect(result.path).toBe("/custom/dir");
  });

  it("ignores --path with empty value", () => {
    const result = parseBootstrapGlobalOptions(["--path="]);
    expect(result.path).toBeUndefined();
  });

  it("parses all boolean flags", () => {
    const result = parseBootstrapGlobalOptions(["--no-extensions", "--no-pager", "--json", "--quiet"]);
    expect(result.noExtensions).toBe(true);
    expect(result.noPager).toBe(true);
    expect(result.json).toBe(true);
    expect(result.quiet).toBe(true);
  });

  it("stops parsing at -- sentinel", () => {
    const result = parseBootstrapGlobalOptions(["--json", "--", "--quiet"]);
    expect(result.json).toBe(true);
    expect(result.quiet).toBe(false);
  });

  it("handles mixed flags and command tokens", () => {
    const result = parseBootstrapGlobalOptions(["list", "--json", "--path", "/foo"]);
    expect(result.json).toBe(true);
    expect(result.path).toBe("/foo");
  });
});

describe("stripGlobalBootstrapTokens", () => {
  it("strips all known global tokens", () => {
    const result = stripGlobalBootstrapTokens([
      "list",
      "--json",
      "--quiet",
      "--no-extensions",
      "--no-pager",
      "--profile",
      "--explain",
      "--path",
      "/tmp",
    ]);
    expect(result).toEqual(["list"]);
  });

  it("strips --path= inline syntax", () => {
    const result = stripGlobalBootstrapTokens(["create", "--path=/foo", "--title", "hello"]);
    expect(result).toEqual(["create", "--title", "hello"]);
  });

  it("preserves non-global tokens", () => {
    const result = stripGlobalBootstrapTokens(["search", "query text", "--limit", "5"]);
    expect(result).toEqual(["search", "query text", "--limit", "5"]);
  });

  it("stops at -- sentinel", () => {
    const result = stripGlobalBootstrapTokens(["cmd", "--", "--json"]);
    expect(result).toEqual(["cmd"]);
  });
});

describe("parseBootstrapHelpRequest", () => {
  it("detects 'help' command prefix", () => {
    const result = parseBootstrapHelpRequest(["help", "create"]);
    expect(result.requested).toBe(true);
    expect(result.commandPathTokens).toEqual(["create"]);
  });

  it("detects --help flag", () => {
    const result = parseBootstrapHelpRequest(["list", "--help"]);
    expect(result.requested).toBe(true);
    expect(result.commandPathTokens).toEqual(["list"]);
  });

  it("detects -h flag", () => {
    const result = parseBootstrapHelpRequest(["calendar", "-h"]);
    expect(result.requested).toBe(true);
    expect(result.commandPathTokens).toEqual(["calendar"]);
  });

  it("returns not-requested for normal commands", () => {
    const result = parseBootstrapHelpRequest(["list", "--limit", "10"]);
    expect(result.requested).toBe(false);
    expect(result.commandPathTokens).toEqual([]);
  });

  it("collects multi-segment command path for help", () => {
    const result = parseBootstrapHelpRequest(["help", "templates", "save"]);
    expect(result.requested).toBe(true);
    expect(result.commandPathTokens).toEqual(["templates", "save"]);
  });

  it("stops collecting command tokens at flags in help subcommand", () => {
    const result = parseBootstrapHelpRequest(["help", "create", "--explain"]);
    expect(result.commandPathTokens).toEqual(["create"]);
  });
});

describe("parseBootstrapCommandName", () => {
  it("extracts command name skipping global flags", () => {
    expect(parseBootstrapCommandName(["--json", "list"])).toBe("list");
    expect(parseBootstrapCommandName(["--path", "/foo", "search"])).toBe("search");
    expect(parseBootstrapCommandName(["create"])).toBe("create");
  });

  it("returns undefined when no command token is found", () => {
    expect(parseBootstrapCommandName(["--json", "--quiet"])).toBeUndefined();
    expect(parseBootstrapCommandName([])).toBeUndefined();
  });

  it("normalizes to lowercase", () => {
    expect(parseBootstrapCommandName(["LIST"])).toBe("list");
  });

  it("stops at -- sentinel", () => {
    expect(parseBootstrapCommandName(["--", "list"])).toBeUndefined();
  });
});

describe("normalizeLegacyExtensionActionSyntax", () => {
  it("converts 'extension install' to 'extension --install'", () => {
    const result = normalizeLegacyExtensionActionSyntax(["extension", "install", "my-ext"]);
    expect(result).toEqual(["extension", "--install", "my-ext"]);
  });

  it("passes through non-extension commands unchanged", () => {
    const input = ["list", "--json"];
    const result = normalizeLegacyExtensionActionSyntax(input);
    expect(result).toEqual(["list", "--json"]);
  });

  it("does not transform when --help is present", () => {
    const result = normalizeLegacyExtensionActionSyntax(["extension", "install", "--help"]);
    expect(result).toEqual(["extension", "install", "--help"]);
  });

  it("does not transform unknown action tokens", () => {
    const result = normalizeLegacyExtensionActionSyntax(["extension", "unknown-action"]);
    expect(result).toEqual(["extension", "unknown-action"]);
  });

  it("handles all known extension actions", () => {
    const actions = ["install", "uninstall", "explore", "manage", "doctor", "adopt", "adopt-all", "activate", "deactivate"];
    for (const action of actions) {
      const result = normalizeLegacyExtensionActionSyntax(["extension", action]);
      expect(result).toEqual(["extension", `--${action}`]);
    }
  });
});

describe("normalizeBootstrapInvocation", () => {
  it("normalizes legacy extension action syntax before parse", () => {
    const normalized = normalizeBootstrapInvocation(["extension", "install", "my-ext"]);
    expect(normalized.argv).toEqual(["extension", "--install", "my-ext"]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "legacy_extension_action",
          confidence: "high",
        }),
      ]),
    );
  });

  it("normalizes long-option aliases and camel/underscore variants", () => {
    const normalized = normalizeBootstrapInvocation([
      "create",
      "--estimated_minutes",
      "15",
      "--acceptanceCriteria",
      "Ship",
      "--customer_impact",
      "high",
    ]);
    expect(normalized.argv).toEqual([
      "create",
      "--estimated-minutes",
      "15",
      "--acceptance-criteria",
      "Ship",
      "--customer-impact",
      "high",
    ]);
    expect(normalized.trace.some((entry) => entry.reason === "flag_alias")).toBe(true);
  });

  it("normalizes minor long-option typos when unambiguous", () => {
    const normalized = normalizeBootstrapInvocation(["create", "--descriptin", "B", "--title", "A", "--type", "Task"]);
    expect(normalized.argv).toEqual(["create", "--description", "B", "--title", "A", "--type", "Task"]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "--descriptin",
          to: ["--description"],
          reason: "flag_typo",
        }),
      ]),
    );
  });

  it("promotes bare key=value and key:value tokens to canonical flags", () => {
    const normalized = normalizeBootstrapInvocation(["create", "title=Hello", "description:World", "type=Task"]);
    expect(normalized.argv).toEqual(["create", "--title", "Hello", "--description", "World", "--type", "Task"]);
    expect(normalized.trace.filter((entry) => entry.reason === "bare_key_value")).toHaveLength(3);
  });

  it("does not reinterpret key=value tokens when they are values for an explicit option", () => {
    const normalized = normalizeBootstrapInvocation(["comments", "pm-a1b2", "--add", "text=should stay literal"]);
    expect(normalized.argv).toEqual(["comments", "pm-a1b2", "--add", "text=should stay literal"]);
    expect(normalized.trace).toHaveLength(0);
  });
});

describe("parseBootstrapTypeValue", () => {
  it("extracts --type with space-separated value", () => {
    expect(parseBootstrapTypeValue(["create", "--type", "Task"])).toBe("Task");
  });

  it("extracts --type= inline syntax", () => {
    expect(parseBootstrapTypeValue(["create", "--type=Issue"])).toBe("Issue");
  });

  it("returns undefined when no --type is present", () => {
    expect(parseBootstrapTypeValue(["list", "--limit", "5"])).toBeUndefined();
  });

  it("returns undefined for empty --type value", () => {
    expect(parseBootstrapTypeValue(["create", "--type="])).toBeUndefined();
    expect(parseBootstrapTypeValue(["create", "--type", "  "])).toBeUndefined();
  });
});
