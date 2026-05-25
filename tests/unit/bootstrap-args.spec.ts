import { describe, expect, it } from "vitest";
import {
  parseBootstrapGlobalOptions,
  stripGlobalBootstrapTokens,
  parseBootstrapHelpRequest,
  parseBootstrapCommandName,
  normalizeLegacyExtensionActionSyntax,
  normalizeBootstrapInvocation,
  coalesceRepeatedListFlags,
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

  it("normalizes the list --status typo now that it is in the filter contract (pm-fu5d U2)", () => {
    const normalized = normalizeBootstrapInvocation(["list", "--statuss", "open"]);
    expect(normalized.argv).toEqual(["list", "--status", "open"]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "--statuss",
          to: ["--status"],
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

  it("accumulates repeated singular --tag typo occurrences into one --tags token (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--tag", "a", "--tag", "b", "--tag", "c"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--tags=a,b,c"]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "--tags (x3)",
          to: ["--tags=a,b,c"],
          reason: "list_merge",
          confidence: "high",
        }),
      ]),
    );
  });

  it("accumulates repeated canonical plural --tags occurrences (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--tags", "a", "--tags", "b"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--tags=a,b"]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "--tags (x2)", to: ["--tags=a,b"], reason: "list_merge" }),
      ]),
    );
  });

  it("accumulates repeated list-filter --status occurrences (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["list", "--status", "open", "--status", "closed"]);
    expect(normalized.argv).toEqual(["list", "--status=open,closed"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(true);
  });

  it("accumulates repeated --fields occurrences for get (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["get", "pm-1", "--fields", "id", "--fields", "title"]);
    expect(normalized.argv).toEqual(["get", "pm-1", "--fields=id,title"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(true);
  });

  it("merges mixed space and inline list flag forms into one token (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--tags", "x", "--tags=y,z"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--tags=x,y,z"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(true);
  });

  it("leaves a single list flag occurrence unchanged with no list_merge event (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--tags", "only"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--tags", "only"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(false);
  });

  it("does not merge repeated non-list scalar flags such as --title (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--title", "A", "--title", "B"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--title", "A", "--title", "B"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(false);
  });

  it("does not reinterpret a --path value beginning with -- as a list flag (pm-cf1u, codex P2)", () => {
    // `--path` accepts values starting with "--"; coalescing must not treat the
    // value as a list flag nor swallow the following command token.
    const normalized = normalizeBootstrapInvocation([
      "--path",
      "--tags",
      "create",
      "issue",
      "X",
      "--tags",
      "a",
      "--tags",
      "b",
    ]);
    expect(normalized.argv).toEqual(["--path", "--tags", "create", "issue", "X", "--tags=a,b"]);
    expect(normalized.commandName).toBe("create");
  });

  it("stops coalescing at a -- terminator (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--tags", "a", "--", "--tags", "b"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--tags", "a", "--", "--tags", "b"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(false);
  });
});

describe("coalesceRepeatedListFlags", () => {
  it("returns argv unchanged when no list flags are configured", () => {
    const result = coalesceRepeatedListFlags(["--tags", "a", "--tags", "b"], new Set());
    expect(result.argv).toEqual(["--tags", "a", "--tags", "b"]);
    expect(result.events).toHaveLength(0);
  });

  it("merges multiple list flags independently in one pass", () => {
    const result = coalesceRepeatedListFlags(
      ["--tags", "a", "--status", "open", "--tags", "b", "--status", "closed"],
      new Set(["--tags", "--status"]),
    );
    expect(result.argv).toEqual(["--tags=a,b", "--status=open,closed"]);
    expect(result.events).toHaveLength(2);
    expect(result.events.every((entry) => entry.reason === "list_merge")).toBe(true);
  });

  it("preserves the relative order of the first occurrence", () => {
    const result = coalesceRepeatedListFlags(
      ["before", "--tags", "a", "middle", "--tags", "b", "after"],
      new Set(["--tags"]),
    );
    expect(result.argv).toEqual(["before", "--tags=a,b", "middle", "after"]);
  });

  it("leaves a value-less trailing list flag untouched", () => {
    const result = coalesceRepeatedListFlags(["--tags", "a", "--tags"], new Set(["--tags"]));
    expect(result.argv).toEqual(["--tags", "a", "--tags"]);
    expect(result.events).toHaveLength(0);
  });

  it("does not treat a following flag as a value", () => {
    const result = coalesceRepeatedListFlags(["--tags", "--full"], new Set(["--tags"]));
    expect(result.argv).toEqual(["--tags", "--full"]);
    expect(result.events).toHaveLength(0);
  });

  it("passes the remainder verbatim after a -- terminator", () => {
    const result = coalesceRepeatedListFlags(["--tags", "a", "--", "--tags", "b"], new Set(["--tags"]));
    expect(result.argv).toEqual(["--tags", "a", "--", "--tags", "b"]);
    expect(result.events).toHaveLength(0);
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
