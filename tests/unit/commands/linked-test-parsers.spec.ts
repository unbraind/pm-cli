import { describe, expect, it } from "vitest";

import {
  _testOnlyLinkedTestParsers,
  LINKED_TEST_ENV_NAME_PATTERN,
  LINKED_TEST_PM_CONTEXT_MODE_VALUES,
  LINKED_TEST_PROTECTED_ENV_KEYS,
  parseLinkedTestAssertionEqualsMap,
  parseLinkedTestAssertionGteMap,
  parseLinkedTestBoolean,
  parseLinkedTestContextMode,
  parseLinkedTestEnvClear,
  parseLinkedTestEnvSet,
  parseLinkedTestJsonEntries,
  parseLinkedTestMinLines,
  parseLinkedTestRegexList,
  parseLinkedTestStringList,
} from "../../../src/cli/commands/linked-test-parsers.js";

describe("linked-test constants", () => {
  it("exposes the protected keys, name pattern, and context modes", () => {
    expect(LINKED_TEST_PROTECTED_ENV_KEYS.has("PM_PATH")).toBe(true);
    expect(LINKED_TEST_ENV_NAME_PATTERN.test("PORT")).toBe(true);
    expect(LINKED_TEST_ENV_NAME_PATTERN.test("1BAD")).toBe(false);
    expect([...LINKED_TEST_PM_CONTEXT_MODE_VALUES]).toEqual([
      "schema",
      "tracker",
      "auto",
    ]);
  });
});

describe("parseLinkedTestEnvSet", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestEnvSet(undefined, "--test")).toBeUndefined();
    expect(parseLinkedTestEnvSet("", "--test")).toBeUndefined();
  });

  it("parses KEY=VALUE assignments", () => {
    const parsed = parseLinkedTestEnvSet("PORT=0;BASE=http://x", "--test");
    expect(parsed).toEqual({ PORT: "0", BASE: "http://x" });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it("throws when only delimiters are provided", () => {
    expect(() => parseLinkedTestEnvSet(";;", "--test")).toThrow(
      /at least one KEY=VALUE/,
    );
  });

  it("throws on missing separator", () => {
    expect(() => parseLinkedTestEnvSet("PORT", "--test")).toThrow(
      /must use KEY=VALUE/,
    );
  });

  it("throws on invalid key name", () => {
    expect(() => parseLinkedTestEnvSet("1BAD=1", "--test")).toThrow(
      /is invalid/,
    );
  });

  it("throws on protected key", () => {
    expect(() => parseLinkedTestEnvSet("pm_path=x", "--test")).toThrow(
      /reserved for sandbox safety/,
    );
  });
});

describe("parseLinkedTestEnvClear", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestEnvClear(undefined, "--test")).toBeUndefined();
  });

  it("dedupes and returns keys", () => {
    expect(parseLinkedTestEnvClear("A;B,A", "--test")).toEqual(["A", "B"]);
  });

  it("throws when only delimiters are provided", () => {
    expect(() => parseLinkedTestEnvClear(";,", "--test")).toThrow(
      /at least one environment variable/,
    );
  });

  it("throws on invalid key", () => {
    expect(() => parseLinkedTestEnvClear("1BAD", "--test")).toThrow(
      /is invalid/,
    );
  });

  it("throws on protected key", () => {
    expect(() => parseLinkedTestEnvClear("FORCE_COLOR", "--test")).toThrow(
      /reserved for sandbox safety/,
    );
  });
});

describe("parseLinkedTestBoolean", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestBoolean(undefined, "--test", "flag")).toBeUndefined();
  });

  it("parses truthy and falsy spellings", () => {
    expect(parseLinkedTestBoolean("TRUE", "--test", "flag")).toBe(true);
    expect(parseLinkedTestBoolean("1", "--test", "flag")).toBe(true);
    expect(parseLinkedTestBoolean("yes", "--test", "flag")).toBe(true);
    expect(parseLinkedTestBoolean("false", "--test", "flag")).toBe(false);
    expect(parseLinkedTestBoolean("0", "--test", "flag")).toBe(false);
    expect(parseLinkedTestBoolean("no", "--test", "flag")).toBe(false);
  });

  it("throws on invalid value", () => {
    expect(() => parseLinkedTestBoolean("maybe", "--test", "flag")).toThrow(
      /must be one of true\|false/,
    );
  });
});

describe("parseLinkedTestContextMode", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestContextMode(undefined, "--test")).toBeUndefined();
  });

  it("parses a valid mode", () => {
    expect(parseLinkedTestContextMode("AUTO", "--test")).toBe("auto");
  });

  it("throws on invalid mode", () => {
    expect(() => parseLinkedTestContextMode("bogus", "--test")).toThrow(
      /pm_context_mode must be one of/,
    );
  });
});

describe("parseLinkedTestStringList", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestStringList(undefined)).toBeUndefined();
  });

  it("returns undefined when only delimiters are provided", () => {
    expect(parseLinkedTestStringList(";;")).toBeUndefined();
  });

  it("dedupes entries", () => {
    expect(parseLinkedTestStringList("a;b\na")).toEqual(["a", "b"]);
  });
});

describe("parseLinkedTestRegexList", () => {
  it("returns undefined for empty list", () => {
    expect(
      parseLinkedTestRegexList(undefined, "--test", "assert_stdout_regex"),
    ).toBeUndefined();
    expect(
      parseLinkedTestRegexList(";;", "--test", "assert_stdout_regex"),
    ).toBeUndefined();
  });

  it("returns validated patterns", () => {
    expect(
      parseLinkedTestRegexList("^a$;b+", "--test", "assert_stdout_regex"),
    ).toEqual(["^a$", "b+"]);
  });

  it("throws on invalid regex", () => {
    expect(() =>
      parseLinkedTestRegexList("(", "--test", "assert_stdout_regex"),
    ).toThrow(/includes invalid regex/);
  });
});

describe("parseLinkedTestMinLines", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestMinLines(undefined, "--test")).toBeUndefined();
  });

  it("parses non-negative integers", () => {
    expect(parseLinkedTestMinLines("3", "--test")).toBe(3);
    expect(parseLinkedTestMinLines("0", "--test")).toBe(0);
  });

  it("throws for non-integer or negative values", () => {
    expect(() => parseLinkedTestMinLines("1.5", "--test")).toThrow(
      /integer >= 0/,
    );
    expect(() => parseLinkedTestMinLines("-1", "--test")).toThrow(
      /integer >= 0/,
    );
  });
});

describe("parseLinkedTestAssertionEqualsMap", () => {
  it("returns undefined for falsy input", () => {
    expect(
      parseLinkedTestAssertionEqualsMap(undefined, "--test"),
    ).toBeUndefined();
  });

  it("parses path=value pairs", () => {
    const parsed = parseLinkedTestAssertionEqualsMap("a=1;b=2", "--test");
    expect(parsed).toEqual({ a: "1", b: "2" });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it("throws when only delimiters are provided", () => {
    expect(() => parseLinkedTestAssertionEqualsMap(";;", "--test")).toThrow(
      /at least one path=value/,
    );
  });

  it("throws on missing separator", () => {
    expect(() => parseLinkedTestAssertionEqualsMap("a", "--test")).toThrow(
      /must use path=value/,
    );
  });

  it("throws on empty path or value", () => {
    expect(() => parseLinkedTestAssertionEqualsMap("a=", "--test")).toThrow(
      /non-empty path and value/,
    );
  });
});

describe("parseLinkedTestAssertionGteMap", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestAssertionGteMap(undefined, "--test")).toBeUndefined();
  });

  it("parses numeric path=value pairs", () => {
    const parsed = parseLinkedTestAssertionGteMap("a=1;b=2.5", "--test");
    expect(parsed).toEqual({ a: 1, b: 2.5 });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it("throws when only delimiters are provided", () => {
    expect(() => parseLinkedTestAssertionGteMap(";;", "--test")).toThrow(
      /at least one path=value/,
    );
  });

  it("throws on missing separator", () => {
    expect(() => parseLinkedTestAssertionGteMap("a", "--test")).toThrow(
      /must use path=value/,
    );
  });

  it("throws on empty path or value", () => {
    expect(() => parseLinkedTestAssertionGteMap("a=", "--test")).toThrow(
      /non-empty path and value/,
    );
  });

  it("throws on non-numeric value", () => {
    expect(() => parseLinkedTestAssertionGteMap("a=x", "--test")).toThrow(
      /must be numeric/,
    );
    expect(() => parseLinkedTestAssertionGteMap("a=10oops", "--test")).toThrow(
      /must be numeric/,
    );
  });
});

describe("parseLinkedTestJsonEntries", () => {
  it("preserves complex command strings and parses linked-test metadata", () => {
    const command =
      "node scripts/run-tests.mjs test -- tests/unit/output.spec.ts --reporter='dot,verbose'";
    expect(
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command,
          scope: "project",
          timeout_seconds: "240",
          env_set: { PORT: "0" },
          env_clear: ["NODE_OPTIONS"],
          shared_host_safe: true,
          assert_stdout_contains: ["ok"],
          assert_json_field_equals: { "items[0].status": "passed" },
          assert_json_field_gte: { count: 1 },
          note: "focused run",
        }),
        "--add-json",
      ),
    ).toEqual([
      {
        command,
        scope: "project",
        timeout_seconds: 240,
        env_set: { PORT: "0" },
        env_clear: ["NODE_OPTIONS"],
        shared_host_safe: true,
        assert_stdout_contains: ["ok"],
        assert_json_field_equals: { "items[0].status": "passed" },
        assert_json_field_gte: { count: 1 },
        note: "focused run",
      },
    ]);
  });

  it("accepts arrays and cmd alias", () => {
    expect(
      parseLinkedTestJsonEntries(
        JSON.stringify([
          { cmd: "node --version" },
          { command: "pnpm build", timeout: 120 },
        ]),
        "--add-json",
      ).map((entry) => ({
        command: entry.command,
        timeout_seconds: entry.timeout_seconds,
        scope: entry.scope,
      })),
    ).toEqual([
      {
        command: "node --version",
        timeout_seconds: undefined,
        scope: "project",
      },
      { command: "pnpm build", timeout_seconds: 120, scope: "project" },
    ]);
  });

  it("rejects invalid JSON, unknown keys, unsafe env, and conflicting aliases", () => {
    expect(() => parseLinkedTestJsonEntries("{", "--add-json")).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", bogus: 1 }),
        "--add-json",
      ),
    ).toThrow(/does not recognize key/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          env_set: { PM_PATH: "/tmp/unsafe" },
        }),
        "--add-json",
      ),
    ).toThrow(/reserved for sandbox safety/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", cmd: "node --help" }),
        "--add-json",
      ),
    ).toThrow(/command and cmd must match/);
  });

  it("treats an empty path string as undefined and pluralizes multiple unknown keys", () => {
    const [entry] = parseLinkedTestJsonEntries(
      JSON.stringify({ command: "node --version", path: "" }),
      "--add-json",
    );
    expect(entry.path).toBeUndefined();
    const [withPath] = parseLinkedTestJsonEntries(
      JSON.stringify({
        command: "node --version",
        path: "tests/unit/linked-test-parsers.spec.ts",
      }),
      "--add-json",
    );
    expect(withPath.path).toBe("tests/unit/linked-test-parsers.spec.ts");
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", bogus: 1, other: 2 }),
        "--add-json",
      ),
    ).toThrow(/does not recognize keys "bogus", "other"/);
  });

  it("rejects empty numeric strings and non-positive or fractional timeouts", () => {
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_stdout_min_lines: "",
        }),
        "--add-json",
      ),
    ).toThrow(/finite number/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", timeout_seconds: 0 }),
        "--add-json",
      ),
    ).toThrow(/positive integer/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", timeout_seconds: 1.5 }),
        "--add-json",
      ),
    ).toThrow(/positive integer/);
  });

  it("validates JSON entry shapes and normalized key collisions", () => {
    expect(() => parseLinkedTestJsonEntries("[]", "--add-json")).toThrow(
      /array must include at least one/,
    );
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify(["node --version"]),
        "--add-json",
      ),
    ).toThrow(/must be a JSON object/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          COMMAND: "node --version",
        }),
        "--add-json",
      ),
    ).toThrow(/more than once after case normalization/);
    expect(() =>
      parseLinkedTestJsonEntries(JSON.stringify({ command: "" }), "--add-json"),
    ).toThrow(/requires a non-empty "command"/);
    expect(() =>
      parseLinkedTestJsonEntries(JSON.stringify({ command: 42 }), "--add-json"),
    ).toThrow(/field "command" must be a JSON string/);
  });

  it("validates JSON scalar aliases and assertion fields", () => {
    expect(
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          cmd: "node --version",
          path: "",
          timeout: "120",
          timeout_seconds: 120,
          note: "  ",
        }),
        "--add-json",
      ),
    ).toEqual([
      { command: "node --version", scope: "project", timeout_seconds: 120 },
    ]);

    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          timeout: 120,
          timeout_seconds: 121,
        }),
        "--add-json",
      ),
    ).toThrow(/timeout and timeout_seconds must match/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", scope: "team" }),
        "--add-json",
      ),
    ).toThrow(/field "scope" must be one of/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          pm_context_mode: "manual",
        }),
        "--add-json",
      ),
    ).toThrow(/field "pm_context_mode" must be one of/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", shared_host_safe: "yes" }),
        "--add-json",
      ),
    ).toThrow(/field "shared_host_safe" must be a JSON boolean/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_stdout_contains: [1],
        }),
        "--add-json",
      ),
    ).toThrow(
      /field "assert_stdout_contains" must be a string or an array of strings/,
    );
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", assert_stdout_regex: "(" }),
        "--add-json",
      ),
    ).toThrow(/includes invalid regex/);
  });

  it("validates JSON env maps and numeric assertion maps", () => {
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", env_set: "PORT=0" }),
        "--add-json",
      ),
    ).toThrow(/field "env_set" must be a JSON object/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", env_set: { PORT: 0 } }),
        "--add-json",
      ),
    ).toThrow(/value for "PORT" must be a string/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", env_set: { "1BAD": "0" } }),
        "--add-json",
      ),
    ).toThrow(/key "1BAD" is invalid/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          env_clear: "PM_GLOBAL_PATH",
        }),
        "--add-json",
      ),
    ).toThrow(/reserved for sandbox safety/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_json_field_equals: { " ": "bad" },
        }),
        "--add-json",
      ),
    ).toThrow(/keys must be non-empty/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_json_field_equals: { ok: { nested: true } },
        }),
        "--add-json",
      ),
    ).toThrow(/value for "ok" must be a string, number, or boolean/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_json_field_gte: { count: false },
        }),
        "--add-json",
      ),
    ).toThrow(/must be a finite number/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_json_field_gte: { " ": 1 },
        }),
        "--add-json",
      ),
    ).toThrow(/keys must be non-empty/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_json_field_equals: [],
        }),
        "--add-json",
      ),
    ).toThrow(/field "assert_json_field_equals" must be a JSON object/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_json_field_gte: [],
        }),
        "--add-json",
      ),
    ).toThrow(/field "assert_json_field_gte" must be a JSON object/);
  });

  it("rejects blank JSON text and accepts JSON min-line assertions", () => {
    expect(() => parseLinkedTestJsonEntries("   ", "--add-json")).toThrow(
      /requires a JSON object or array/,
    );
    expect(
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_stdout_min_lines: 2,
          assert_stdout_regex: "^v",
        }),
        "--add-json",
      )[0]?.assert_stdout_min_lines,
    ).toBe(2);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({ command: "node --version", env_clear: "1BAD" }),
        "--add-json",
      ),
    ).toThrow(/field "env_clear" key "1BAD" is invalid/);
    expect(() =>
      parseLinkedTestJsonEntries(
        JSON.stringify({
          command: "node --version",
          assert_stdout_min_lines: -1,
        }),
        "--add-json",
      ),
    ).toThrow(/integer >= 0/);
  });

  it("covers defensive undefined values in pre-normalized JSON entries", () => {
    const parsed = _testOnlyLinkedTestParsers.parseLinkedTestJsonEntry(
      {
        command: "node --version",
        path: undefined,
        scope: undefined,
        timeout: undefined,
        timeout_seconds: undefined,
        env_set: undefined,
        env_clear: undefined,
        shared_host_safe: undefined,
        assert_stdout_contains: undefined,
        assert_stdout_regex: undefined,
        assert_stderr_contains: undefined,
        assert_stderr_regex: undefined,
        assert_stdout_min_lines: undefined,
        assert_json_field_equals: undefined,
        assert_json_field_gte: undefined,
        note: undefined,
      },
      "entry",
      "--add-json",
    );

    expect(parsed).toEqual({ command: "node --version", scope: "project" });
  });

  it("returns undefined for empty JSON env and assertion maps", () => {
    const parsed = _testOnlyLinkedTestParsers.parseLinkedTestJsonEntry(
      {
        command: "node --version",
        env_set: {},
        assert_json_field_equals: {},
        assert_json_field_gte: {},
        assert_stdout_contains: [],
      },
      "entry",
      "--add-json",
    );

    expect(parsed).toEqual({ command: "node --version", scope: "project" });
  });

  it("retains direct JSON path values when non-empty", () => {
    const parsed = _testOnlyLinkedTestParsers.parseLinkedTestJsonEntry(
      {
        command: "node --version",
        path: "tests/unit/linked-test-parsers.spec.ts",
      },
      "entry",
      "--add-json",
    );

    expect(parsed.path).toBe("tests/unit/linked-test-parsers.spec.ts");
  });
});
