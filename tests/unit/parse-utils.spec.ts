import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdinTokenResolver, parseCsvKv, parseOptionalNumber, parseTags } from "../../src/core/item/parse.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core/item/parse", () => {
  it("normalizes tags with none-token and empty-input handling", () => {
    expect(parseTags("BETA, alpha, alpha")).toEqual(["alpha", "beta"]);
    expect(parseTags(" none ")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
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
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as NodeJS.ReadStream);

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe("alpha\nbeta");
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe("alpha\nbeta");
    await expect(resolver.resolveValue("plain", "--body")).resolves.toBe("plain");
  });

  it("rejects duplicate stdin tokens and multiple option consumers", async () => {
    const stdinStream = new PassThrough();
    stdinStream.end("seed");
    Object.defineProperty(stdinStream, "isTTY", { value: false, configurable: true });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as NodeJS.ReadStream);

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveList(["-", "-"], "--add")).rejects.toThrow('accepts "-" stdin token at most once');
    await expect(resolver.resolveValue("-", "--body")).resolves.toBe("seed");
    await expect(resolver.resolveValue("-", "--add")).rejects.toThrow('Already used by --body');
  });

  it("rejects stdin token usage when no piped input is available", async () => {
    const stdinStream = new PassThrough();
    Object.defineProperty(stdinStream, "isTTY", { value: true, configurable: true });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdinStream as unknown as NodeJS.ReadStream);

    const resolver = createStdinTokenResolver();
    await expect(resolver.resolveValue("-", "--body")).rejects.toThrow('requires piped stdin input');
  });
});
