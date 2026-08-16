import { describe, expect, it } from "vitest";
import {
  looksLikeStructuredPathEntry,
  parseAddEntries,
} from "../../../src/sdk/linked-artifacts.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";

describe("linked artifact assignment contract", () => {
  it("preserves bare paths and remote references only when they contain no assignment", () => {
    expect(parseAddEntries(["docs/architecture.md"], "doc")).toEqual([
      { path: "docs/architecture.md", scope: "project", note: undefined },
    ]);
    expect(parseAddEntries(["https://example.com/docs"], "doc")).toEqual([
      {
        path: "https://example.com/docs",
        scope: "project",
        note: undefined,
      },
    ]);
    expect(parseAddEntries(["C:\\docs\\release=final.md"], "file")).toEqual([
      {
        path: "C:\\docs\\release=final.md",
        scope: "project",
        note: undefined,
      },
    ]);
    expect(
      parseAddEntries(["https://example.com/docs?view=full"], "doc"),
    ).toEqual([
      {
        path: "https://example.com/docs?view=full",
        scope: "project",
        note: undefined,
      },
    ]);
    expect(parseAddEntries(["[]()"], "doc")).toEqual([
      { path: "[]()", scope: "project", note: undefined },
    ]);
    expect(
      parseAddEntries(["[broken](https://example.com/a)b()"], "doc"),
    ).toEqual([
      {
        path: "[broken](https://example.com/a)b()",
        scope: "project",
        note: undefined,
      },
    ]);
  });

  it("routes every assignment-like value through the shared key allowlist", () => {
    expect(looksLikeStructuredPathEntry("release=final.md")).toBe(true);
    expect(() => parseAddEntries(["release=final.md"], "file")).toThrowError(
      expect.objectContaining({
        exitCode: EXIT_CODE.USAGE,
        message:
          '--add does not recognize key "release". Allowed keys: path, scope, note.',
      }),
    );
    expect(() =>
      parseAddEntries(["owner=https://example.com/docs?view=full"], "doc"),
    ).toThrowError(
      expect.objectContaining({
        exitCode: EXIT_CODE.USAGE,
        message:
          '--add does not recognize key "owner". Allowed keys: path, scope, note.',
      }),
    );
    expect(() =>
      parseAddEntries(["https://example.com/x=some note"], "doc"),
    ).toThrowError(
      expect.objectContaining({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("does not recognize key"),
      }),
    );
  });

  it("keeps structured file and doc entries transport-neutral", () => {
    const entry = "path=docs/context.md,scope=project,note=decision evidence";
    expect(parseAddEntries([entry], "file")).toEqual(
      parseAddEntries([entry], "doc"),
    );
  });
});
