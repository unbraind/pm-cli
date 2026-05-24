import { describe, expect, it } from "vitest";

import {
  LINKED_TEST_ENV_NAME_PATTERN,
  LINKED_TEST_PM_CONTEXT_MODE_VALUES,
  LINKED_TEST_PROTECTED_ENV_KEYS,
  parseLinkedTestAssertionEqualsMap,
  parseLinkedTestAssertionGteMap,
  parseLinkedTestBoolean,
  parseLinkedTestContextMode,
  parseLinkedTestEnvClear,
  parseLinkedTestEnvSet,
  parseLinkedTestMinLines,
  parseLinkedTestRegexList,
  parseLinkedTestStringList,
} from "../../src/cli/commands/linked-test-parsers.js";

describe("linked-test constants", () => {
  it("exposes the protected keys, name pattern, and context modes", () => {
    expect(LINKED_TEST_PROTECTED_ENV_KEYS.has("PM_PATH")).toBe(true);
    expect(LINKED_TEST_ENV_NAME_PATTERN.test("PORT")).toBe(true);
    expect(LINKED_TEST_ENV_NAME_PATTERN.test("1BAD")).toBe(false);
    expect([...LINKED_TEST_PM_CONTEXT_MODE_VALUES]).toEqual(["schema", "tracker", "auto"]);
  });
});

describe("parseLinkedTestEnvSet", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestEnvSet(undefined, "--test")).toBeUndefined();
    expect(parseLinkedTestEnvSet("", "--test")).toBeUndefined();
  });

  it("parses KEY=VALUE assignments", () => {
    expect(parseLinkedTestEnvSet("PORT=0;BASE=http://x", "--test")).toEqual({ PORT: "0", BASE: "http://x" });
  });

  it("throws when only delimiters are provided", () => {
    expect(() => parseLinkedTestEnvSet(";;", "--test")).toThrow(/at least one KEY=VALUE/);
  });

  it("throws on missing separator", () => {
    expect(() => parseLinkedTestEnvSet("PORT", "--test")).toThrow(/must use KEY=VALUE/);
  });

  it("throws on invalid key name", () => {
    expect(() => parseLinkedTestEnvSet("1BAD=1", "--test")).toThrow(/is invalid/);
  });

  it("throws on protected key", () => {
    expect(() => parseLinkedTestEnvSet("pm_path=x", "--test")).toThrow(/reserved for sandbox safety/);
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
    expect(() => parseLinkedTestEnvClear(";,", "--test")).toThrow(/at least one environment variable/);
  });

  it("throws on invalid key", () => {
    expect(() => parseLinkedTestEnvClear("1BAD", "--test")).toThrow(/is invalid/);
  });

  it("throws on protected key", () => {
    expect(() => parseLinkedTestEnvClear("FORCE_COLOR", "--test")).toThrow(/reserved for sandbox safety/);
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
    expect(() => parseLinkedTestBoolean("maybe", "--test", "flag")).toThrow(/must be one of true\|false/);
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
    expect(() => parseLinkedTestContextMode("bogus", "--test")).toThrow(/pm_context_mode must be one of/);
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
    expect(parseLinkedTestRegexList(undefined, "--test", "assert_stdout_regex")).toBeUndefined();
    expect(parseLinkedTestRegexList(";;", "--test", "assert_stdout_regex")).toBeUndefined();
  });

  it("returns validated patterns", () => {
    expect(parseLinkedTestRegexList("^a$;b+", "--test", "assert_stdout_regex")).toEqual(["^a$", "b+"]);
  });

  it("throws on invalid regex", () => {
    expect(() => parseLinkedTestRegexList("(", "--test", "assert_stdout_regex")).toThrow(/includes invalid regex/);
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
    expect(() => parseLinkedTestMinLines("1.5", "--test")).toThrow(/integer >= 0/);
    expect(() => parseLinkedTestMinLines("-1", "--test")).toThrow(/integer >= 0/);
  });
});

describe("parseLinkedTestAssertionEqualsMap", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestAssertionEqualsMap(undefined, "--test")).toBeUndefined();
  });

  it("parses path=value pairs", () => {
    expect(parseLinkedTestAssertionEqualsMap("a=1;b=2", "--test")).toEqual({ a: "1", b: "2" });
  });

  it("throws when only delimiters are provided", () => {
    expect(() => parseLinkedTestAssertionEqualsMap(";;", "--test")).toThrow(/at least one path=value/);
  });

  it("throws on missing separator", () => {
    expect(() => parseLinkedTestAssertionEqualsMap("a", "--test")).toThrow(/must use path=value/);
  });

  it("throws on empty path or value", () => {
    expect(() => parseLinkedTestAssertionEqualsMap("a=", "--test")).toThrow(/non-empty path and value/);
  });
});

describe("parseLinkedTestAssertionGteMap", () => {
  it("returns undefined for falsy input", () => {
    expect(parseLinkedTestAssertionGteMap(undefined, "--test")).toBeUndefined();
  });

  it("parses numeric path=value pairs", () => {
    expect(parseLinkedTestAssertionGteMap("a=1;b=2.5", "--test")).toEqual({ a: 1, b: 2.5 });
  });

  it("throws when only delimiters are provided", () => {
    expect(() => parseLinkedTestAssertionGteMap(";;", "--test")).toThrow(/at least one path=value/);
  });

  it("throws on missing separator", () => {
    expect(() => parseLinkedTestAssertionGteMap("a", "--test")).toThrow(/must use path=value/);
  });

  it("throws on empty path or value", () => {
    expect(() => parseLinkedTestAssertionGteMap("a=", "--test")).toThrow(/non-empty path and value/);
  });

  it("throws on non-numeric value", () => {
    expect(() => parseLinkedTestAssertionGteMap("a=x", "--test")).toThrow(/must be numeric/);
  });
});
