import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTagRemovals,
  collectTagFlagValues,
  createStdinTokenResolver,
  mergeAdditiveTags,
  parseCsvKv,
  parseOptionalNumber,
  parseTags,
} from "../../src/core/item/parse.js";
import { parseIntegerLimit, parseLimit, parsePriority, parseType } from "../../src/cli/shared-parsers.js";
import { PmCliError } from "../../src/core/shared/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core/item/parse", () => {
  it("normalizes tags and preserves literal none tag text", () => {
    expect(parseTags("BETA, alpha, alpha")).toEqual(["alpha", "beta"]);
    expect(parseTags(" none ")).toEqual(["none"]);
    expect(parseTags("   ")).toEqual([]);
  });

  it("accepts JSON-array shaped tag input so MCP/agent paste-through stays lossless", () => {
    expect(parseTags('["alpha","beta"]')).toEqual(["alpha", "beta"]);
    expect(parseTags(' [ "BETA" , "alpha" , "alpha" ] ')).toEqual(["alpha", "beta"]);
    expect(parseTags('["alpha", 7, true]')).toEqual(["7", "alpha", "true"]);
    expect(parseTags("[]")).toEqual([]);
    // Malformed JSON falls back to CSV semantics so we never regress legacy paths.
    expect(parseTags("[alpha,beta]")).toEqual(["[alpha", "beta]"]);
  });

  it("collectTagFlagValues normalizes repeated --add-tags / --remove-tags entries", () => {
    expect(collectTagFlagValues(["BETA", "alpha", " alpha,gamma "])).toEqual(["alpha", "beta", "gamma"]);
    expect(collectTagFlagValues(undefined)).toEqual([]);
    expect(collectTagFlagValues([])).toEqual([]);
    expect(collectTagFlagValues(['["x","y"]'])).toEqual(["x", "y"]);
    // Non-string entries (defensive against accidental coercion) are skipped.
    expect(collectTagFlagValues(["alpha", 7 as unknown as string])).toEqual(["alpha"]);
  });

  it("mergeAdditiveTags appends without losing existing entries and stays sorted/deduped", () => {
    expect(mergeAdditiveTags(["alpha", "beta"], ["beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
    expect(mergeAdditiveTags([], ["BETA", "alpha"])).toEqual(["alpha", "beta"]);
    // No-op when no additions provided.
    expect(mergeAdditiveTags(["alpha"], undefined)).toEqual(["alpha"]);
    expect(mergeAdditiveTags(["alpha"], [])).toEqual(["alpha"]);
    // Mixed-case existing tags (legacy/hand-edited .toon) are normalized so
    // additions dedupe case-insensitively instead of producing ["Beta","beta"].
    expect(mergeAdditiveTags(["Beta"], ["beta"])).toEqual(["beta"]);
    expect(mergeAdditiveTags(["Alpha", "beta"], undefined)).toEqual(["alpha", "beta"]);
    expect(mergeAdditiveTags([" Gamma "], ["alpha"])).toEqual(["alpha", "gamma"]);
  });

  it("applyTagRemovals filters tags by additive subtraction without touching others", () => {
    expect(applyTagRemovals(["alpha", "beta", "gamma"], ["beta"])).toEqual(["alpha", "gamma"]);
    expect(applyTagRemovals(["alpha"], ["beta"])).toEqual(["alpha"]);
    // Empty removal input is a no-op (preserves caller order).
    expect(applyTagRemovals(["alpha", "beta"], undefined)).toEqual(["alpha", "beta"]);
    expect(applyTagRemovals(["alpha", "beta"], [])).toEqual(["alpha", "beta"]);
    // CSV entries inside a single --remove-tags value are honoured.
    expect(applyTagRemovals(["alpha", "beta", "gamma"], ["alpha,gamma"])).toEqual(["beta"]);
    // Removal is case-insensitive: mixed-case existing tags are normalized so a
    // lowercase --remove-tags selector still prunes an uppercase stored tag.
    expect(applyTagRemovals(["Alpha", "Beta"], ["alpha"])).toEqual(["beta"]);
    expect(applyTagRemovals(["Alpha", "beta"], undefined)).toEqual(["alpha", "beta"]);
  });

  it("parses csv key-value values with quoted commas and escaped quotes", () => {
    const parsed = parseCsvKv(String.raw`path=README.md,scope=project,note="alpha, \"beta\""`, "--file");
    expect(parsed).toEqual({
      path: "README.md",
      scope: "project",
      note: 'alpha, "beta"',
    });
  });

  it("throws usage errors for empty and malformed csv key-value input", () => {
    expect(() => parseCsvKv("   ", "--file")).toThrow("--file cannot be empty");
    expect(() => parseCsvKv("path=README.md,malformed", "--file")).toThrow(
      'Invalid --file value "path=README.md,malformed". Expected key=value entries separated by commas.',
    );
  });

  it("adds recurrence delimiter guidance for malformed --event csv entries", () => {
    expect(() =>
      parseCsvKv("start=2026-04-01T09:00:00.000Z,recur_freq=weekly,recur_by_weekday=mon,tue", "--event"),
    ).toThrow('Recurrence list values must stay in one field and use "|" delimiters');
  });

  it("accepts trailing commas without creating empty key-value entries", () => {
    expect(parseCsvKv("path=README.md,", "--file")).toEqual({
      path: "README.md",
    });
  });

  it("parses colon-delimited and markdown-style key-value entries", () => {
    expect(parseCsvKv("path:README.md,scope:project,note:Alpha", "--file")).toEqual({
      path: "README.md",
      scope: "project",
      note: "Alpha",
    });
    expect(
      parseCsvKv(
        ["- path: README.md", "- scope: project", "- note: first line", "  second line"].join("\n"),
        "--file",
      ),
    ).toEqual({
      path: "README.md",
      scope: "project",
      note: "first line\nsecond line",
    });
  });

  it("parses fenced markdown key-value input and comma continuations", () => {
    const fenced = ["```", "path: README.md", "scope: project", "note: hello", "world", "```"].join("\n");
    expect(parseCsvKv(fenced, "--file")).toEqual({
      path: "README.md",
      scope: "project",
      note: "hello\nworld",
    });
    expect(parseCsvKv("path=README.md,note=alpha,beta", "--file")).toEqual({
      path: "README.md",
      note: "alpha,beta",
    });
  });

  it("includes stdin token guidance in malformed key-value errors", () => {
    expect(() => parseCsvKv("invalid", "--add")).toThrow('Use --add - to read piped stdin input.');
  });

  it("parses optional numbers including zero", () => {
    expect(parseOptionalNumber("0", "--estimate")).toBe(0);
    expect(parseOptionalNumber("15.5", "--estimate")).toBe(15.5);
  });

  it("rejects non-finite optional numbers", () => {
    expect(() => parseOptionalNumber("Infinity", "--estimate")).toThrow('Invalid --estimate value "Infinity"');
    expect(() => parseOptionalNumber("NaN", "--estimate")).toThrow('Invalid --estimate value "NaN"');
  });

  it("resolves stdin token values once and reuses payload for same option", async () => {
    const stdinStream = new PassThrough();
    stdinStream.end("alpha\nbeta");
    Object.defineProperty(stdinStream, "isTTY", { value: false, configurable: true });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as NodeJS.ReadStream & { fd: 0 });

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe("alpha\nbeta");
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe("alpha\nbeta");
    await expect(resolver.resolveValue("plain", "--body")).resolves.toBe("plain");
  });

  it("rejects duplicate stdin tokens and multiple option consumers", async () => {
    const stdinStream = new PassThrough();
    stdinStream.end("seed");
    Object.defineProperty(stdinStream, "isTTY", { value: false, configurable: true });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as NodeJS.ReadStream & { fd: 0 });

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveList(["-", "-"], "--add")).rejects.toThrow('accepts "-" stdin token at most once');
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe("seed");
    await expect(resolver.resolveValue("-", "--add")).rejects.toThrow('Already used by --body');
  });

  it("rejects stdin token usage when no piped input is available", async () => {
    const stdinStream = new PassThrough();
    Object.defineProperty(stdinStream, "isTTY", { value: true, configurable: true });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as NodeJS.ReadStream & { fd: 0 });

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveValue("-", "--body")).rejects.toThrow('requires piped stdin input');
    await expect(resolver.resolveValue("-", "--body")).rejects.toThrow("Ctrl+D");
  });
});

describe("cli/shared-parsers", () => {
  describe("parseLimit", () => {
    it("returns undefined for undefined input", () => {
      expect(parseLimit(undefined)).toBeUndefined();
    });

    it("parses valid integer limits", () => {
      expect(parseLimit("0")).toBe(0);
      expect(parseLimit("10")).toBe(10);
      expect(parseLimit("100")).toBe(100);
    });

    it("floors fractional limits", () => {
      expect(parseLimit("1.25")).toBe(1);
      expect(parseLimit("9.9")).toBe(9);
    });

    it("throws for negative values", () => {
      expect(() => parseLimit("-1")).toThrow(PmCliError);
    });

    it("throws for non-numeric values", () => {
      expect(() => parseLimit("abc")).toThrow(PmCliError);
      expect(() => parseLimit("NaN")).toThrow(PmCliError);
    });

    it("uses custom label in error messages", () => {
      expect(() => parseLimit("-1", "Calendar limit")).toThrow("Calendar limit");
    });
  });

  describe("parseIntegerLimit", () => {
    it("returns undefined for undefined input", () => {
      expect(parseIntegerLimit(undefined)).toBeUndefined();
    });

    it("accepts non-negative integers", () => {
      expect(parseIntegerLimit("0")).toBe(0);
      expect(parseIntegerLimit("10")).toBe(10);
    });

    it("rejects fractional values", () => {
      expect(() => parseIntegerLimit("1.25")).toThrow(PmCliError);
    });

    it("rejects negative values", () => {
      expect(() => parseIntegerLimit("-1")).toThrow(PmCliError);
    });

    it("uses custom label in error messages", () => {
      expect(() => parseIntegerLimit("1.5", "List limit")).toThrow("List limit");
    });
  });

  describe("parsePriority", () => {
    it("returns undefined for undefined input", () => {
      expect(parsePriority(undefined)).toBeUndefined();
    });

    it("accepts valid priorities 0-4", () => {
      for (let i = 0; i <= 4; i++) {
        expect(parsePriority(String(i))).toBe(i);
      }
    });

    it("rejects out-of-range values", () => {
      expect(() => parsePriority("5")).toThrow(PmCliError);
      expect(() => parsePriority("-1")).toThrow(PmCliError);
    });

    it("rejects non-integer values", () => {
      expect(() => parsePriority("1.5")).toThrow(PmCliError);
    });
  });

  describe("parseType", () => {
    const mockRegistry = {
      types: ["Task", "Issue", "Feature"] as string[],
      alias_to_type: { task: "Task", issue: "Issue", feature: "Feature" } as Record<string, string>,
    };

    it("returns undefined for undefined input", () => {
      expect(parseType(undefined, mockRegistry as never)).toBeUndefined();
    });

    it("throws for unknown type names", () => {
      expect(() => parseType("NotAType", mockRegistry as never)).toThrow(PmCliError);
      expect(() => parseType("NotAType", mockRegistry as never)).toThrow("Task|Issue|Feature");
    });
  });
});
