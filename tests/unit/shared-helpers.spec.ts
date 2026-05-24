import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAuthor } from "../../src/core/shared/author.js";
import { isPathWithinDirectory } from "../../src/core/fs/path-utils.js";

describe("core/shared/author: resolveAuthor", () => {
  it("returns the candidate when provided", () => {
    expect(resolveAuthor("alice", "fallback")).toBe("alice");
  });

  it("returns trimmed candidate", () => {
    expect(resolveAuthor("  bob  ", "fallback")).toBe("bob");
  });

  it("falls back to PM_AUTHOR env when candidate is undefined", () => {
    const prev = process.env.PM_AUTHOR;
    try {
      process.env.PM_AUTHOR = "env-author";
      expect(resolveAuthor(undefined, "fallback")).toBe("env-author");
    } finally {
      if (prev === undefined) {
        delete process.env.PM_AUTHOR;
      } else {
        process.env.PM_AUTHOR = prev;
      }
    }
  });

  it("falls back to the fallback string when candidate and PM_AUTHOR are absent", () => {
    const prev = process.env.PM_AUTHOR;
    try {
      delete process.env.PM_AUTHOR;
      expect(resolveAuthor(undefined, "settings-author")).toBe("settings-author");
    } finally {
      if (prev !== undefined) {
        process.env.PM_AUTHOR = prev;
      }
    }
  });

  it("returns 'unknown' when all inputs resolve to an empty/whitespace string", () => {
    const prev = process.env.PM_AUTHOR;
    try {
      delete process.env.PM_AUTHOR;
      expect(resolveAuthor(undefined, "   ")).toBe("unknown");
      expect(resolveAuthor("  ", "  ")).toBe("unknown");
    } finally {
      if (prev !== undefined) {
        process.env.PM_AUTHOR = prev;
      }
    }
  });
});

describe("core/fs/path-utils: isPathWithinDirectory", () => {
  it("returns true when target equals directory", () => {
    const dir = "/some/dir";
    expect(isPathWithinDirectory(dir, dir)).toBe(true);
  });

  it("returns true when target is a subdirectory", () => {
    const dir = "/some/dir";
    const sub = path.join(dir, "nested", "file.txt");
    expect(isPathWithinDirectory(dir, sub)).toBe(true);
  });

  it("returns false when target escapes via ..", () => {
    const dir = "/some/dir";
    const outside = path.join(dir, "..", "other");
    expect(isPathWithinDirectory(dir, outside)).toBe(false);
  });

  it("returns false for an absolute path outside the directory", () => {
    expect(isPathWithinDirectory("/some/dir", "/other/path")).toBe(false);
  });
});
