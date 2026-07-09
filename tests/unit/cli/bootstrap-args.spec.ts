import { describe, expect, it } from "vitest";
import {
  _testOnly,
  parseBootstrapGlobalOptions,
  stripGlobalBootstrapTokens,
  parseBootstrapHelpRequest,
  parseBootstrapCommandName,
  normalizeLegacyExtensionActionSyntax,
  normalizeBootstrapInvocation,
  mergeLinkedTestTwoTokenEntries,
  coalesceRepeatedListFlags,
  parseBootstrapTypeValue,
  listAliasPluralKeys,
} from "../../../src/cli/bootstrap-args.js";

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

  it("parses preferred --pm-path with space-separated value", () => {
    const result = parseBootstrapGlobalOptions(["--pm-path", "/tmp/pm"]);
    expect(result.path).toBe("/tmp/pm");
  });

  it("parses --path= inline syntax", () => {
    const result = parseBootstrapGlobalOptions(["--path=/custom/dir"]);
    expect(result.path).toBe("/custom/dir");
  });

  it("parses preferred --pm-path= inline syntax", () => {
    const result = parseBootstrapGlobalOptions(["--pm-path=/custom/dir"]);
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

  it("prefers --pm-path over legacy --path regardless of argument order", () => {
    expect(parseBootstrapGlobalOptions(["--pm-path", "/preferred", "--path", "/legacy"]).path).toBe("/preferred");
    expect(parseBootstrapGlobalOptions(["--path", "/legacy", "--pm-path", "/preferred"]).path).toBe("/preferred");
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
      "--pm-path",
      "/tmp/pm",
    ]);
    expect(result).toEqual(["list"]);
  });

  it("strips --path= inline syntax", () => {
    const result = stripGlobalBootstrapTokens(["create", "--path=/foo", "--title", "hello"]);
    expect(result).toEqual(["create", "--title", "hello"]);
  });

  it("strips --pm-path= inline syntax", () => {
    const result = stripGlobalBootstrapTokens(["create", "--pm-path=/foo", "--title", "hello"]);
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
    expect(parseBootstrapCommandName(["--pm-path", "/foo", "search"])).toBe("search");
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

  it("rewrites an executable command alias (show -> get) before parse", () => {
    const normalized = normalizeBootstrapInvocation(["show", "pm-a1b2", "--fields", "id,title"]);
    expect(normalized.argv).toEqual(["get", "pm-a1b2", "--fields", "id,title"]);
    expect(normalized.commandName).toBe("get");
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "command_alias", from: "show", to: ["get"], confidence: "high" }),
      ]),
    );
  });

  it("rewrites comment -> comments and flag-aliases --comment to --add together", () => {
    const normalized = normalizeBootstrapInvocation(["comment", "pm-a1b2", "--comment", "hello"]);
    expect(normalized.argv).toEqual(["comments", "pm-a1b2", "--add", "hello"]);
    expect(normalized.commandName).toBe("comments");
  });

  it("rewrites a command alias even after global flags", () => {
    const normalized = normalizeBootstrapInvocation(["--json", "view", "pm-a1b2"]);
    expect(normalized.argv).toEqual(["--json", "get", "pm-a1b2"]);
  });

  it("does not rewrite an alias token that appears as an argument, not the command", () => {
    const normalized = normalizeBootstrapInvocation(["create", "Task", "show"]);
    expect(normalized.argv).toEqual(["create", "Task", "show"]);
    expect(normalized.trace.some((entry) => entry.reason === "command_alias")).toBe(false);
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

  it("treats list/search --tags as a declared alias for --tag (pm-6l17)", () => {
    const listNormalized = normalizeBootstrapInvocation(["list", "--tags", "agent-ux"]);
    expect(listNormalized.argv).toEqual(["list", "--tag", "agent-ux"]);
    expect(listNormalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "--tags",
          to: ["--tag"],
          reason: "flag_alias",
        }),
      ]),
    );

    const searchNormalized = normalizeBootstrapInvocation(["search", "agent", "--tags", "agent-ux"]);
    expect(searchNormalized.argv).toEqual(["search", "agent", "--tag", "agent-ux"]);
    expect(searchNormalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "--tags",
          to: ["--tag"],
          reason: "flag_alias",
        }),
      ]),
    );
  });

  it("preserves search inline filter tokens for the search parser (GH-485)", () => {
    const normalized = normalizeBootstrapInvocation(["search", "status:all", "scene", "grounding", "--limit", "5"]);
    expect(normalized.argv).toEqual(["search", "status:all", "scene", "grounding", "--limit", "5"]);
    expect(normalized.trace.filter((entry) => entry.reason === "bare_key_value")).toHaveLength(0);
  });

  it("preserves quoted search inline filters with residual keywords (GH-485)", () => {
    const normalized = normalizeBootstrapInvocation(["search", "status:all scene grounding", "--limit", "5"]);
    expect(normalized.argv).toEqual(["search", "status:all scene grounding", "--limit", "5"]);
    expect(normalized.trace.filter((entry) => entry.reason === "bare_key_value")).toHaveLength(0);
  });

  it("keeps truncated plural list flags in the typo path instead of aliasing them", () => {
    const normalized = normalizeBootstrapInvocation(["update", "pm-a1b2", "--statu", "closed"]);
    expect(normalized.argv).toEqual(["update", "pm-a1b2", "--status", "closed"]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "--statu",
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

  it("accumulates repeated singular --tag alias occurrences into one --tags token (pm-cf1u)", () => {
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

  it("accumulates repeated list-filter --ids occurrences", () => {
    const normalized = normalizeBootstrapInvocation(["list-open", "--ids", "pm-a", "--ids=pm-b,pm-c"]);
    expect(normalized.argv).toEqual(["list-open", "--ids=pm-a,pm-b,pm-c"]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "--ids (x2)", to: ["--ids=pm-a,pm-b,pm-c"], reason: "list_merge" }),
      ]),
    );
  });

  it("accumulates repeated --fields occurrences for get (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["get", "pm-1", "--fields", "id", "--fields", "title"]);
    expect(normalized.argv).toEqual(["get", "pm-1", "--fields=id,title"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(true);
  });

  it("accumulates repeated --fields occurrences for package catalog subcommands", () => {
    const normalized = normalizeBootstrapInvocation(["package", "catalog", "--fields", "alias", "--fields", "installed"]);
    expect(normalized.argv).toEqual(["package", "catalog", "--fields=alias,installed"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(true);
  });

  it("merges mixed space and inline list flag forms into one token (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--tags", "x", "--tags=y,z"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--tags=x,y,z"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(true);
  });

  it("accepts one create --tags occurrence with several adjacent values (GH-294)", () => {
    const normalized = normalizeBootstrapInvocation([
      "create",
      "--type",
      "Chore",
      "--title",
      "Tagged",
      "--tags",
      "alpha",
      "beta",
      "gamma",
      "--author",
      "agent",
    ]);
    expect(normalized.argv).toEqual([
      "create",
      "--type",
      "Chore",
      "--title",
      "Tagged",
      "--tags=alpha,beta,gamma",
      "--author",
      "agent",
    ]);
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "--tags (x1)", to: ["--tags=alpha,beta,gamma"], reason: "list_merge" }),
      ]),
    );
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
    // `--path` is normalized to `--pm-path`, but still accepts values starting
    // with "--"; coalescing must not treat the value as a list flag nor swallow
    // the following command token.
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
    expect(normalized.argv).toEqual(["--pm-path", "--tags", "create", "issue", "X", "--tags=a,b"]);
    expect(normalized.commandName).toBe("create");
  });

  it("does not reinterpret a --pm-path value beginning with -- as a list flag", () => {
    const normalized = normalizeBootstrapInvocation([
      "--pm-path",
      "--tags",
      "create",
      "issue",
      "X",
      "--tags",
      "a",
      "--tags",
      "b",
    ]);
    expect(normalized.argv).toEqual(["--pm-path", "--tags", "create", "issue", "X", "--tags=a,b"]);
    expect(normalized.commandName).toBe("create");
  });

  it("stops coalescing at a -- terminator (pm-cf1u)", () => {
    const normalized = normalizeBootstrapInvocation(["create", "issue", "X", "--tags", "a", "--", "--tags", "b"]);
    expect(normalized.argv).toEqual(["create", "issue", "X", "--tags", "a", "--", "--tags", "b"]);
    expect(normalized.trace.some((entry) => entry.reason === "list_merge")).toBe(false);
  });
});

describe("listAliasPluralKeys", () => {
  it("covers simple s and y-to-ies list alias candidates", () => {
    expect(listAliasPluralKeys("tag")).toEqual(["tags"]);
    expect(listAliasPluralKeys("category")).toEqual(["categorys", "categories"]);
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

  it("greedily merges configured multi-value list flags only", () => {
    const greedy = coalesceRepeatedListFlags(
      ["--tags", "alpha", "beta", "gamma", "--author", "agent"],
      new Set(["--tags"]),
      new Set(),
      new Set(["--tags"]),
    );
    expect(greedy.argv).toEqual(["--tags=alpha,beta,gamma", "--author", "agent"]);
    expect(greedy.events).toEqual([
      { from: "--tags (x1)", to: ["--tags=alpha,beta,gamma"], reason: "list_merge", confidence: "high" },
    ]);

    const normal = coalesceRepeatedListFlags(["--tags", "alpha", "beta"], new Set(["--tags"]));
    expect(normal.argv).toEqual(["--tags", "alpha", "beta"]);
    expect(normal.events).toEqual([]);
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

describe("mergeLinkedTestTwoTokenEntries (GH-191 two-token linked-test form)", () => {
  const trace = () => [] as Parameters<typeof mergeLinkedTestTwoTokenEntries>[2];

  it("merges the quoted two-token --add command form into command=<value>", () => {
    const events = trace();
    const merged = mergeLinkedTestTwoTokenEntries(
      ["test", "pm-a1b2", "--add", "command", "npm test -- parser"],
      "test",
      events,
    );
    expect(merged).toEqual(["test", "pm-a1b2", "--add", "command=npm test -- parser"]);
    expect(events).toEqual([
      {
        from: "--add command npm test -- parser",
        to: ["--add", "command=npm test -- parser"],
        reason: "bare_key_value",
        confidence: "high",
      },
    ]);
  });

  it("merges the cmd alias and path keys for --add", () => {
    const events = trace();
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--add", "cmd", "echo q -- z"], "test", events)).toEqual([
      "test",
      "pm-a1b2",
      "--add",
      "cmd=echo q -- z",
    ]);
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--add", "path", "tests/foo.spec.ts"], "test", events)).toEqual([
      "test",
      "pm-a1b2",
      "--add",
      "path=tests/foo.spec.ts",
    ]);
  });

  it("merges the two-token --remove command form but not the cmd alias", () => {
    const events = trace();
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--remove", "command", "echo a -- b"], "test", events)).toEqual([
      "test",
      "pm-a1b2",
      "--remove",
      "command=echo a -- b",
    ]);
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--remove", "cmd", "echo a -- b"], "test", events)).toEqual([
      "test",
      "pm-a1b2",
      "--remove",
      "cmd",
      "echo a -- b",
    ]);
  });

  it("merges when a flag follows the single quoted value", () => {
    const merged = mergeLinkedTestTwoTokenEntries(
      ["test", "pm-a1b2", "--add", "command", "echo a -- b", "--run"],
      "test",
      trace(),
    );
    expect(merged).toEqual(["test", "pm-a1b2", "--add", "command=echo a -- b", "--run"]);
  });

  it("does not merge for commands other than test", () => {
    const argv = ["comments", "pm-a1b2", "--add", "command", "value"];
    expect(mergeLinkedTestTwoTokenEntries(argv, "comments", trace())).toBe(argv);
    expect(mergeLinkedTestTwoTokenEntries(argv, undefined, trace())).toBe(argv);
  });

  it("does not merge an unquoted multi-token value (ambiguous; routed to guidance)", () => {
    const events = trace();
    const argv = ["test", "pm-a1b2", "--add", "command", "npm", "test", "--", "parser"];
    expect(mergeLinkedTestTwoTokenEntries(argv, "test", events)).toEqual(argv);
    expect(events).toHaveLength(0);
  });

  it("does not merge when the bare key has no value or a flag follows it", () => {
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--add", "command"], "test", trace())).toEqual([
      "test",
      "pm-a1b2",
      "--add",
      "command",
    ]);
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--add", "command", "--run"], "test", trace())).toEqual([
      "test",
      "pm-a1b2",
      "--add",
      "command",
      "--run",
    ]);
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--add"], "test", trace())).toEqual([
      "test",
      "pm-a1b2",
      "--add",
    ]);
  });

  it("does not merge unknown keys or inline key=value tokens", () => {
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--add", "scope", "project"], "test", trace())).toEqual([
      "test",
      "pm-a1b2",
      "--add",
      "scope",
      "project",
    ]);
    expect(mergeLinkedTestTwoTokenEntries(["test", "pm-a1b2", "--add", "command=echo x"], "test", trace())).toEqual([
      "test",
      "pm-a1b2",
      "--add",
      "command=echo x",
    ]);
  });

  it("passes the remainder verbatim after a -- terminator", () => {
    const argv = ["test", "pm-a1b2", "--", "--add", "command", "value"];
    expect(mergeLinkedTestTwoTokenEntries(argv, "test", trace())).toEqual(argv);
  });

  it("merges repeated two-token pairs independently", () => {
    const merged = mergeLinkedTestTwoTokenEntries(
      ["test", "pm-a1b2", "--add", "command", "echo a -- b", "--add", "command=echo c"],
      "test",
      trace(),
    );
    expect(merged).toEqual(["test", "pm-a1b2", "--add", "command=echo a -- b", "--add", "command=echo c"]);
  });
});

describe("normalizeBootstrapInvocation linked-test two-token form (GH-191)", () => {
  it("normalizes pm test <id> --add command \"... -- ...\" end to end", () => {
    const normalized = normalizeBootstrapInvocation(["test", "pm-a1b2", "--add", "command", "npm test -- parser"]);
    expect(normalized.argv).toEqual(["test", "pm-a1b2", "--add", "command=npm test -- parser"]);
    expect(normalized.commandName).toBe("test");
    expect(normalized.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "bare_key_value", to: ["--add", "command=npm test -- parser"], confidence: "high" }),
      ]),
    );
  });

  it("leaves the unquoted multi-token form untouched for guidance", () => {
    const normalized = normalizeBootstrapInvocation(["test", "pm-a1b2", "--add", "command", "npm", "test", "--", "parser"]);
    expect(normalized.argv).toEqual(["test", "pm-a1b2", "--add", "command", "npm", "test", "--", "parser"]);
  });

  it("preserves sandbox-safe values starting with env assignments instead of promoting PM_PATH= to --pm-path", () => {
    const value = "PM_PATH=/tmp/pm-x PM_GLOBAL_PATH=/tmp/pm-x-g vitest run -- parser";
    const normalized = normalizeBootstrapInvocation(["test", "pm-a1b2", "--add", "command", value]);
    expect(normalized.argv).toEqual(["test", "pm-a1b2", "--add", `command=${value}`]);
    expect(normalized.trace.some((entry) => entry.to.includes("--pm-path"))).toBe(false);
  });

  it("still promotes bare key=value tokens on pm test outside the two-token value position", () => {
    const normalized = normalizeBootstrapInvocation(["test", "pm-a1b2", "--add", "command", "echo ok", "match=parser"]);
    expect(normalized.argv).toEqual(["test", "pm-a1b2", "--add", "command=echo ok", "--match", "parser"]);
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

describe("bootstrap-args helper edge branches", () => {
  it("covers defensive flag candidate and conflict normalization paths", () => {
    const candidates = _testOnly.collectLongFlagCandidates({
      flag: "--title",
      aliases: [undefined, "-t", "--headline"] as unknown as string[],
    } as never);
    expect(candidates).toEqual(["--title", "--headline"]);

    const map = new Map<string, string | null>();
    _testOnly.markUnambiguousFlag(map, "title", "--title");
    _testOnly.markUnambiguousFlag(map, "title", "--subject");
    expect(map.get("title")).toBeNull();

    const lookup = _testOnly.buildFlagLookup(undefined, [
      { flag: "-x", aliases: ["-y"] } as unknown as never,
    ]);
    expect(lookup.canonicalComparables).toEqual([]);
  });

  it("returns null for tied typo candidates and marks distance-2 typo confidence as medium", () => {
    const tieLookup = {
      canonicalByNormalized: new Map<string, string | null>(),
      canonicalByCompact: new Map<string, string | null>(),
      canonicalComparables: [
        { canonicalFlag: "--ac", comparable: "ac" },
        { canonicalFlag: "--ad", comparable: "ad" },
      ],
      listCanonicalFlags: new Set<string>(),
    };
    expect(_testOnly.resolveCanonicalFlag("--ab", tieLookup)).toBeNull();

    const mediumLookup = {
      canonicalByNormalized: new Map<string, string | null>(),
      canonicalByCompact: new Map<string, string | null>(),
      canonicalComparables: [{ canonicalFlag: "--abcdefghij", comparable: "abcdefghij" }],
      listCanonicalFlags: new Set<string>(),
    };
    expect(_testOnly.resolveCanonicalFlag("--abcdzzghij", mediumLookup)).toMatchObject({
      flag: "--abcdefghij",
      reason: "flag_typo",
      confidence: "medium",
    });

    const directTypoLookup = {
      canonicalByNormalized: new Map<string, string | null>(),
      canonicalByCompact: new Map<string, string | null>(),
      canonicalComparables: [{ canonicalFlag: "--status", comparable: "status" }],
      listCanonicalFlags: new Set<string>(),
    };
    expect(_testOnly.resolveCanonicalFlag("--statuz", directTypoLookup)).toMatchObject({
      flag: "--status",
      reason: "flag_typo",
      confidence: "high",
    });

    const sameCanonicalTieLookup = {
      canonicalByNormalized: new Map<string, string | null>(),
      canonicalByCompact: new Map<string, string | null>(),
      canonicalComparables: [
        { canonicalFlag: "--title", comparable: "titel" },
        { canonicalFlag: "--title", comparable: "titel" },
      ],
      listCanonicalFlags: new Set<string>(),
    };
    expect(_testOnly.resolveCanonicalFlag("--tital", sameCanonicalTieLookup)).toMatchObject({
      flag: "--title",
      reason: "flag_typo",
      confidence: "high",
    });
  });

  it("keeps non-option tokens and trailing value-consuming globals unchanged", () => {
    const lookup = _testOnly.buildFlagLookup(undefined, []);
    expect(_testOnly.normalizeLongOptionToken("plain-token", lookup)).toEqual({ tokens: ["plain-token"] });

    const coalesced = coalesceRepeatedListFlags(["--pm-path"], new Set(["--tags"]), new Set(["--pm-path"]));
    expect(coalesced).toEqual({ argv: ["--pm-path"], events: [] });
  });
});
