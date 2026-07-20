import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly as parseTestOnly,
  applyAcceptanceCriteriaMutations,
  applyTagRemovals,
  assertNoUnknownCsvKeys,
  collectTagFlagValues,
  createStdinTokenResolver,
  looksLikeGenericKeyValueEntry,
  mergeAdditiveTags,
  parseCsvKv,
  parseOptionalNonNegativeInteger,
  parseOptionalNumber,
  parseTags,
  splitAcceptanceCriteria,
} from "../../../../src/core/item/parse.js";
import { resolveEventEndAt } from "../../../../src/cli/commands/event-validation-messages.js";
import {
  parseIntegerLimit,
  parseLimit,
  parsePriority,
  parseType,
} from "../../../../src/cli/shared-parsers.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core/item/parse", () => {
  it("parses non-negative integer options without accepting fractional or negative values", () => {
    expect(parseOptionalNonNegativeInteger("0", "--estimate")).toBe(0);
    expect(parseOptionalNonNegativeInteger("42", "--estimate")).toBe(42);
    expect(parseOptionalNonNegativeInteger(" 42 ", "--estimate")).toBe(42);
    expect(() => parseOptionalNonNegativeInteger("   ", "--estimate")).toThrow(
      PmCliError,
    );
    expect(() => parseOptionalNonNegativeInteger("1.5", "--estimate")).toThrow(
      PmCliError,
    );
    expect(() => parseOptionalNonNegativeInteger("-1", "--estimate")).toThrow(
      PmCliError,
    );
  });

  it("normalizes tags and preserves literal none tag text", () => {
    expect(parseTags("BETA, alpha, alpha")).toEqual(["alpha", "beta"]);
    expect(parseTags(" none ")).toEqual(["none"]);
    expect(parseTags("   ")).toEqual([]);
  });

  it("accepts JSON-array shaped tag input so MCP/agent paste-through stays lossless", () => {
    expect(parseTags('["alpha","beta"]')).toEqual(["alpha", "beta"]);
    expect(parseTags(' [ "BETA" , "alpha" , "alpha" ] ')).toEqual([
      "alpha",
      "beta",
    ]);
    expect(parseTags('["alpha", 7, true]')).toEqual(["7", "alpha", "true"]);
    expect(parseTags("[]")).toEqual([]);
    expect(parseTestOnly.coerceJsonTagArray('{"not":"array"}')).toBeNull();
    // Malformed JSON falls back to CSV semantics so we never regress legacy paths.
    expect(parseTags("[alpha,beta]")).toEqual(["[alpha", "beta]"]);
  });

  it("collectTagFlagValues normalizes repeated --add-tags / --remove-tags entries", () => {
    expect(collectTagFlagValues(["BETA", "alpha", " alpha,gamma "])).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(collectTagFlagValues(undefined)).toEqual([]);
    expect(collectTagFlagValues([])).toEqual([]);
    expect(collectTagFlagValues(['["x","y"]'])).toEqual(["x", "y"]);
    // Non-string entries (defensive against accidental coercion) are skipped.
    expect(collectTagFlagValues(["alpha", 7 as unknown as string])).toEqual([
      "alpha",
    ]);
  });

  it("mergeAdditiveTags appends without losing existing entries and stays sorted/deduped", () => {
    expect(mergeAdditiveTags(["alpha", "beta"], ["beta", "gamma"])).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(mergeAdditiveTags([], ["BETA", "alpha"])).toEqual(["alpha", "beta"]);
    // No-op when no additions provided.
    expect(mergeAdditiveTags(["alpha"], undefined)).toEqual(["alpha"]);
    expect(mergeAdditiveTags(["alpha"], [])).toEqual(["alpha"]);
    // Mixed-case existing tags (legacy/hand-edited .toon) are normalized so
    // additions dedupe case-insensitively instead of producing ["Beta","beta"].
    expect(mergeAdditiveTags(["Beta"], ["beta"])).toEqual(["beta"]);
    expect(mergeAdditiveTags(["Alpha", "beta"], undefined)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(mergeAdditiveTags([" Gamma "], ["alpha"])).toEqual([
      "alpha",
      "gamma",
    ]);
    // Defensive: a non-array base (corrupted metadata / external SDK caller)
    // must not throw — it is treated as an empty base.
    expect(
      mergeAdditiveTags(undefined as unknown as string[], ["alpha"]),
    ).toEqual(["alpha"]);
    expect(
      applyTagRemovals(undefined as unknown as string[], ["alpha"]),
    ).toEqual([]);
    expect(applyTagRemovals(["alpha"], [7 as unknown as string])).toEqual([
      "alpha",
    ]);
  });

  it("applyTagRemovals filters tags by additive subtraction without touching others", () => {
    expect(applyTagRemovals(["alpha", "beta", "gamma"], ["beta"])).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(applyTagRemovals(["alpha"], ["beta"])).toEqual(["alpha"]);
    // Empty removal input is a no-op (preserves caller order).
    expect(applyTagRemovals(["alpha", "beta"], undefined)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(applyTagRemovals(["alpha", "beta"], [])).toEqual(["alpha", "beta"]);
    // CSV entries inside a single --remove-tags value are honoured.
    expect(
      applyTagRemovals(["alpha", "beta", "gamma"], ["alpha,gamma"]),
    ).toEqual(["beta"]);
    // Removal is case-insensitive: mixed-case existing tags are normalized so a
    // lowercase --remove-tags selector still prunes an uppercase stored tag.
    expect(applyTagRemovals(["Alpha", "Beta"], ["alpha"])).toEqual(["beta"]);
    expect(applyTagRemovals(["Alpha", "beta"], undefined)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("parses csv key-value values with quoted commas and escaped quotes", () => {
    const parsed = parseCsvKv(
      String.raw`path=README.md,scope=project,note="alpha, \"beta\""`,
      "--file",
    );
    expect(parsed).toEqual({
      path: "README.md",
      scope: "project",
      note: 'alpha, "beta"',
    });
    expect(parseCsvKv(String.raw`note="legacy \q"`, "--file")).toEqual({
      note: String.raw`legacy \q`,
    });
    expect(
      parseCsvKv(
        String.raw`text="first line\nsecond \"quoted\" line",author=agent`,
        "--comment",
      ),
    ).toEqual({
      text: 'first line\nsecond "quoted" line',
      author: "agent",
    });
  });

  it("assertNoUnknownCsvKeys accepts known keys and is case-insensitive (GH-258)", () => {
    expect(() =>
      assertNoUnknownCsvKeys({ path: "a", scope: "project" }, "--add", [
        "path",
        "scope",
        "note",
      ]),
    ).not.toThrow();
    // Case-insensitive: a key the downstream reader accepts must never be falsely rejected.
    expect(() =>
      assertNoUnknownCsvKeys({ Path: "a" }, "--add", ["path", "scope", "note"]),
    ).not.toThrow();
    expect(() => assertNoUnknownCsvKeys({}, "--add", ["path"])).not.toThrow();
  });

  it("assertNoUnknownCsvKeys rejects unknown keys with the test --add message format (GH-258)", () => {
    expect(() =>
      assertNoUnknownCsvKeys({ path: "a", boguskey: "v" }, "--add", [
        "path",
        "scope",
        "note",
      ]),
    ).toThrow(
      '--add does not recognize key "boguskey". Allowed keys: path, scope, note.',
    );
    expect(() =>
      assertNoUnknownCsvKeys({ label: "m", boguskey: "v" }, "--add", [
        "path",
        "scope",
        "note",
      ]),
    ).toThrow(
      '--add does not recognize keys "label", "boguskey". Allowed keys: path, scope, note.',
    );
    try {
      assertNoUnknownCsvKeys({ zzz: "1" }, "--migrate", ["from", "to"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PmCliError);
      expect((error as PmCliError).exitCode).toBe(2);
    }
  });

  it("assertNoUnknownCsvKeys normalizes recognized keys to lowercase so downstream reads work (GH-258)", () => {
    // Mixed-case recognized key is rewritten in place to its lowercase canonical form.
    const kv: Record<string, string> = { Path: "README.md", scope: "project" };
    assertNoUnknownCsvKeys(kv, "--add", ["path", "scope", "note"]);
    expect(kv).toEqual({ path: "README.md", scope: "project" });
    // A key that collides with another only after normalization is rejected.
    expect(() =>
      assertNoUnknownCsvKeys({ path: "a", Path: "b" }, "--add", [
        "path",
        "scope",
      ]),
    ).toThrow(
      '--add provides key "Path" more than once after case normalization.',
    );
  });

  it("looksLikeGenericKeyValueEntry detects first-key typos but not bare/Windows paths (GH-258)", () => {
    // Generic `key=` opener (even an unknown key) is structured so it gets validated.
    expect(looksLikeGenericKeyValueEntry("boguskey=x,path=README.md")).toBe(
      true,
    );
    expect(looksLikeGenericKeyValueEntry("- lable: ignored")).toBe(false); // colon form is handled by known-key/markdown paths
    expect(looksLikeGenericKeyValueEntry("path=README.md")).toBe(true);
    // Bare paths (no leading key=) stay bare.
    expect(looksLikeGenericKeyValueEntry("docs/plain.md")).toBe(false);
    expect(looksLikeGenericKeyValueEntry("README.md")).toBe(false);
    // Windows absolute paths must never be misread as a `C=…` entry.
    expect(looksLikeGenericKeyValueEntry("C:\\Users\\readme.md")).toBe(false);
    expect(looksLikeGenericKeyValueEntry("d:/projects/notes.md")).toBe(false);
  });

  it("covers parse helper rejection edges", () => {
    expect(parseTestOnly.stripCodeFenceEnvelope("```unterminated")).toBe(
      "```unterminated",
    );
    expect(
      parseTestOnly.stripCodeFenceEnvelope("```toon\nid: pm-test\n``"),
    ).toBe("```toon\nid: pm-test\n``");
    expect(() => parseCsvKv("=value", "--file")).toThrow(PmCliError);
    expect(() => parseCsvKv("", "--file")).toThrow(PmCliError);
  });

  it("throws usage errors for empty and malformed csv key-value input", () => {
    expect(() => parseCsvKv("   ", "--file")).toThrow("--file cannot be empty");
    expect(() => parseCsvKv("path=README.md,malformed", "--file")).toThrow(
      'Invalid --file value "path=README.md,malformed". Expected key=value entries separated by commas.',
    );
    expect(() => parseCsvKv(",", "--file")).toThrow('Invalid --file value ","');
    expect(() => parseCsvKv(" =value", "--file")).toThrow(
      'Invalid --file value "=value"',
    );
    expect(() => parseCsvKv("path=README.md, =value", "--file")).toThrow(
      'Invalid --file value "path=README.md, =value"',
    );
    expect(() => parseCsvKv("```", "--file")).toThrow(
      'Invalid --file value "```"',
    );
    expect(
      parseCsvKv(
        ["scope: project", "unexpected continuation"].join("\n"),
        "--file",
      ),
    ).toEqual({
      scope: "project\nunexpected continuation",
    });
    expect(parseTestOnly.coerceJsonTagArray('{"not":"array"}')).toBeNull();
    expect(parseTestOnly.stripCodeFenceEnvelope("```json")).toBe("```json");
    expect(
      parseTestOnly.stripCodeFenceEnvelope('```json\n{"ok":true}\nnot-closed'),
    ).toBe('```json\n{"ok":true}\nnot-closed');
    expect(parseTestOnly.parseMarkdownKeyValueLines("malformed")).toBeNull();
    expect(() => parseCsvKv(":value", "--file")).toThrow(
      'Invalid --file value ":value"',
    );
    expect(() => parseCsvKv("alpha", "--file")).toThrow(
      'Invalid --file value "alpha"',
    );
  });

  it("adds recurrence delimiter guidance for malformed --event csv entries", () => {
    expect(() =>
      parseCsvKv(
        "start=2026-04-01T09:00:00.000Z,recur_freq=weekly,recur_by_weekday=mon,tue",
        "--event",
      ),
    ).toThrow(
      'Recurrence list values must stay in one field and use "|" delimiters',
    );
    expect(() => parseCsvKv("recur_byweekday=mon,tue", "--event")).toThrow(
      "Use recur_by_weekday (with underscores)",
    );
    expect(() => parseCsvKv("malformed", "--event")).toThrow(
      'Invalid --event value "malformed". Expected key=value entries separated by commas.',
    );
  });

  it("rejects negative event durations using shared event end validation", () => {
    expect(() =>
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "-1h",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toThrow("--event end must be strictly after start");
  });

  it("accepts minute-aware event duration forms without changing global relative parsing", () => {
    expect(
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "30min",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toBe("2026-04-01T09:30:00.000Z");

    expect(
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "PT30M",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toBe("2026-04-01T09:30:00.000Z");
  });

  it("keeps bare m duration tokens as months for backward compatibility", () => {
    expect(
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "45m",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toBe("2030-01-01T09:00:00.000Z");
  });

  it("covers ISO duration edge branches and negative minute durations", () => {
    expect(
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "PT1H",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toBe("2026-04-01T10:00:00.000Z");

    expect(() =>
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "-30min",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toThrow("--event end must be strictly after start");

    expect(() =>
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "-PT30M",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toThrow("--event end must be strictly after start");

    expect(() =>
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "PT",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toThrow("Invalid event.duration value");

    expect(() =>
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "P1D",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toThrow("Invalid event.duration value");

    expect(() =>
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "999999999999999999999min",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toThrow("Duration is out of supported timestamp range");

    expect(() =>
      resolveEventEndAt(
        "2026-04-01T09:00:00.000Z",
        undefined,
        "PT999999999999999999999H",
        new Date("2026-04-01T08:00:00.000Z"),
      ),
    ).toThrow("Duration is out of supported timestamp range");
  });

  it("adds path and preview guidance for malformed key-value input", () => {
    expect(() => parseCsvKv("README.md", "--add")).toThrow(
      "For file/doc paths use: path=<file-path>",
    );
    const longValue = "x".repeat(200);
    expect(() => parseCsvKv(longValue, "--add")).toThrow(
      `${"x".repeat(157)}...`,
    );
  });

  it("accepts trailing commas without creating empty key-value entries", () => {
    expect(parseCsvKv("path=README.md,", "--file")).toEqual({
      path: "README.md",
    });
  });

  it("parses colon-delimited and markdown-style key-value entries", () => {
    expect(
      parseCsvKv("path:README.md,scope:project,note:Alpha", "--file"),
    ).toEqual({
      path: "README.md",
      scope: "project",
      note: "Alpha",
    });
    expect(
      parseCsvKv(
        [
          "- path: README.md",
          "- scope: project",
          "- note: first line",
          "  second line",
        ].join("\n"),
        "--file",
      ),
    ).toEqual({
      path: "README.md",
      scope: "project",
      note: "first line\nsecond line",
    });
  });

  it("parses fenced markdown key-value input and comma continuations", () => {
    const fenced = [
      "```",
      "path: README.md",
      "scope: project",
      "note: hello",
      "world",
      "```",
    ].join("\n");
    expect(parseCsvKv(fenced, "--file")).toEqual({
      path: "README.md",
      scope: "project",
      note: "hello\nworld",
    });
    expect(parseCsvKv("```kv\npath: README.md\n```", "--file")).toEqual({
      path: "README.md",
    });
    expect(parseCsvKv("```\npath: README.md", "--file")).toEqual({
      "```\npath": "README.md",
    });
    expect(parseCsvKv("path=README.md,note=alpha,beta", "--file")).toEqual({
      path: "README.md",
      note: "alpha,beta",
    });
  });

  it("exposes pure parser helpers for defensive branch coverage", () => {
    expect(parseTestOnly.coerceJsonTagArray('{"not":"array"}')).toBeNull();
    expect(parseTestOnly.coerceJsonTagArray("[{}]")).toBe("");
    expect(parseTestOnly.stripCodeFenceEnvelope("```")).toBe("```");
    expect(parseTestOnly.stripCodeFenceEnvelope("```kv\npath: README.md")).toBe(
      "```kv\npath: README.md",
    );
    expect(parseTestOnly.parseMarkdownKeyValueLines("")).toBeNull();
    expect(
      parseTestOnly.parseMarkdownKeyValueLines(
        ["scope: project", "unexpected continuation"].join("\n"),
      ),
    ).toBeNull();
  });

  it("includes stdin token guidance in malformed key-value errors", () => {
    expect(() => parseCsvKv("invalid", "--add")).toThrow(
      "Use --add - to read piped stdin input.",
    );
  });

  it("parses optional numbers including zero", () => {
    expect(parseOptionalNumber("0", "--estimate")).toBe(0);
    expect(parseOptionalNumber("15.5", "--estimate")).toBe(15.5);
  });

  it("rejects non-finite optional numbers", () => {
    expect(() => parseOptionalNumber("Infinity", "--estimate")).toThrow(
      'Invalid --estimate value "Infinity"',
    );
    expect(() => parseOptionalNumber("NaN", "--estimate")).toThrow(
      'Invalid --estimate value "NaN"',
    );
  });

  it("resolves stdin token values once and reuses payload for same option", async () => {
    const stdinStream = new PassThrough();
    stdinStream.end("alpha\nbeta");
    Object.defineProperty(stdinStream, "isTTY", {
      value: false,
      configurable: true,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdinStream as unknown as NodeJS.ReadStream & { fd: 0 },
    );

    const resolver = createStdinTokenResolver();
    await expect(
      resolver.resolveValue(undefined, "--body"),
    ).resolves.toBeUndefined();
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe(
      "alpha\nbeta",
    );
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe(
      "alpha\nbeta",
    );
    await expect(resolver.resolveValue("plain", "--body")).resolves.toBe(
      "plain",
    );
    await expect(
      resolver.resolveList(undefined, "--add"),
    ).resolves.toBeUndefined();
    await expect(resolver.resolveList(["plain"], "--add")).resolves.toEqual([
      "plain",
    ]);
  });

  it("replaces a single stdin token inside list values", async () => {
    const stdinStream = new PassThrough();
    stdinStream.end("from stdin");
    Object.defineProperty(stdinStream, "isTTY", {
      value: false,
      configurable: true,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdinStream as unknown as NodeJS.ReadStream & { fd: 0 },
    );

    const resolver = createStdinTokenResolver();
    await expect(
      resolver.resolveList(["alpha", "-", "omega"], "--add"),
    ).resolves.toEqual(["alpha", "from stdin", "omega"]);
  });

  it("propagates stdin stream errors", async () => {
    const stdinStream = new PassThrough();
    Object.defineProperty(stdinStream, "isTTY", {
      value: false,
      configurable: true,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdinStream as unknown as NodeJS.ReadStream & { fd: 0 },
    );

    const resolver = createStdinTokenResolver();
    const resolved = expect(
      resolver.resolveValue("-", "--body"),
    ).rejects.toThrow("stdin broke");
    stdinStream.emit("error", new Error("stdin broke"));
    await resolved;
  });

  it("rejects duplicate stdin tokens and multiple option consumers", async () => {
    const stdinStream = new PassThrough();
    stdinStream.end("seed");
    Object.defineProperty(stdinStream, "isTTY", {
      value: false,
      configurable: true,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdinStream as unknown as NodeJS.ReadStream & { fd: 0 },
    );

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveList(["-", "-"], "--add")).rejects.toThrow(
      'accepts "-" stdin token at most once',
    );
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe("seed");
    await expect(resolver.resolveValue("-", "--add")).rejects.toThrow(
      "Already used by --body",
    );
  });

  it("rejects stdin token usage when no piped input is available", async () => {
    const stdinStream = new PassThrough();
    Object.defineProperty(stdinStream, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdinStream as unknown as NodeJS.ReadStream & { fd: 0 },
    );

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveValue("-", "--body")).rejects.toThrow(
      "requires piped stdin input",
    );
    await expect(resolver.resolveValue("-", "--body")).rejects.toThrow(
      "Ctrl+D",
    );
  });

  describe("acceptance-criteria helpers (GH-612)", () => {
    it("splits stored criteria and normalizes non-string values to empty", () => {
      expect(splitAcceptanceCriteria("a; b ;; c")).toEqual(["a", "b", "c"]);
      expect(splitAcceptanceCriteria(undefined)).toEqual([]);
      expect(splitAcceptanceCriteria(42)).toEqual([]);
      expect(splitAcceptanceCriteria("")).toEqual([]);
    });

    it("applies additive and subtractive criterion mutations with unmatched reporting", () => {
      const mutated = applyAcceptanceCriteriaMutations(
        ["first", " second ", ""],
        ["second", "third", "  ", "third"],
        ["first", "ghost", "   "],
      );
      expect(mutated.criteria).toEqual(["second", "third"]);
      expect(mutated.unmatchedRemovals).toEqual(["ghost"]);
      expect(
        applyAcceptanceCriteriaMutations([], undefined, undefined).criteria,
      ).toEqual([]);
      expect(() =>
        applyAcceptanceCriteriaMutations([], ["first; second"], undefined),
      ).toThrow(
        'Acceptance criteria added with --add-ac cannot contain ";"',
      );
    });
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
      expect(() => parseLimit("-1", "Calendar limit")).toThrow(
        "Calendar limit",
      );
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

    it("rejects blank values instead of coercing them to zero", () => {
      expect(() => parseIntegerLimit("   ")).toThrow(PmCliError);
    });

    it("uses custom label in error messages", () => {
      expect(() => parseIntegerLimit("1.5", "List limit")).toThrow(
        "List limit",
      );
    });
  });

  describe("parsePriority", () => {
    it("returns undefined for undefined input", () => {
      expect(parsePriority(undefined)).toBeUndefined();
    });

    it("rejects blank values instead of coercing them to zero", () => {
      expect(() => parsePriority("   ")).toThrow(PmCliError);
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
      alias_to_type: {
        task: "Task",
        issue: "Issue",
        feature: "Feature",
      } as Record<string, string>,
    };

    it("returns undefined for undefined input", () => {
      expect(parseType(undefined, mockRegistry as never)).toBeUndefined();
    });

    it("throws for unknown type names", () => {
      expect(() => parseType("NotAType", mockRegistry as never)).toThrow(
        PmCliError,
      );
      expect(() => parseType("NotAType", mockRegistry as never)).toThrow(
        "Task|Issue|Feature",
      );
    });
  });
});
