import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAuthor } from "../../../../src/core/shared/author.js";
import { findFirstMergeConflictMarker, findMergeConflictMarkers } from "../../../../src/core/shared/conflict-markers.js";
import { isPathWithinDirectory } from "../../../../src/core/fs/path-utils.js";
import { createLazyModule } from "../../../../src/core/shared/lazy-module.js";
import { createSerialQueue } from "../../../../src/core/shared/serial-queue.js";
import {
  jaccardSimilarity,
  normalizeLowercaseWhitespace,
  tokenizeAlphaNumeric,
} from "../../../../src/core/shared/text-normalization.js";
import {
  _testOnly as timeTestOnly,
  compareTimestampStrings,
  isTimestampLiteral,
  nowIso,
  resolveIsoOrRelative,
} from "../../../../src/core/shared/time.js";

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

describe("core/shared/lazy-module: createLazyModule", () => {
  it("calls the importer on first access and returns the module", async () => {
    let callCount = 0;
    const sentinel = { value: 42 };
    const load = createLazyModule(async () => {
      callCount++;
      return sentinel;
    });
    const result = await load();
    expect(result).toBe(sentinel);
    expect(callCount).toBe(1);
  });

  it("returns the same promise on subsequent calls without re-importing", async () => {
    let callCount = 0;
    const load = createLazyModule(async () => {
      callCount++;
      return { value: callCount };
    });
    const p1 = load();
    const p2 = load();
    expect(p1).toBe(p2);
    await p1;
    expect(callCount).toBe(1);
    await load();
    expect(callCount).toBe(1);
  });
});

describe("core/shared/serial-queue: createSerialQueue (pm-3puw)", () => {
  it("runs tasks strictly one-at-a-time in arrival order", async () => {
    const queue = createSerialQueue();
    const events: string[] = [];
    const makeTask = (label: string, delayMs: number) => async () => {
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push(`end:${label}`);
      return label;
    };

    // Enqueue a slow task first, then a fast one. With true serialization the
    // fast task must not start until the slow task has fully settled.
    const slow = queue.enqueue(makeTask("slow", 20));
    const fast = queue.enqueue(makeTask("fast", 0));
    await Promise.all([slow, fast]);

    expect(events).toEqual(["start:slow", "end:slow", "start:fast", "end:fast"]);
  });

  it("resolves enqueue() with the task's return value", async () => {
    const queue = createSerialQueue();
    await expect(queue.enqueue(() => 7)).resolves.toBe(7);
    await expect(queue.enqueue(async () => "async-result")).resolves.toBe("async-result");
  });

  it("isolates a rejecting task: its promise rejects but later tasks still run in order", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];

    const first = queue.enqueue(async () => {
      order.push("first");
      throw new Error("boom");
    });
    const second = queue.enqueue(async () => {
      order.push("second");
      return "ok";
    });

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("idle() resolves only once the queue has drained", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("task");
    });
    await queue.idle();
    expect(order).toEqual(["task"]);
  });

  it("idle() resolves immediately when the queue is already empty", async () => {
    const queue = createSerialQueue();
    await expect(queue.idle()).resolves.toBeUndefined();
  });

  it("idle() waits for tasks enqueued while the queue is still active", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];

    queue.enqueue(async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first:end");
    });
    const idle = queue.idle().then(() => {
      order.push("idle");
    });
    queue.enqueue(() => {
      order.push("second");
    });

    await idle;
    expect(order).toEqual(["first:start", "first:end", "second", "idle"]);
  });
});

describe("core/shared/time", () => {
  const base = new Date("2026-01-31T12:00:00.000Z");

  it("normalizes now, relative tokens, and compact timestamp variants", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resolveIsoOrRelative(" now ", base)).toBe("2026-01-31T12:00:00.000Z");
    expect(resolveIsoOrRelative("+2h", base)).toBe("2026-01-31T14:00:00.000Z");
    expect(resolveIsoOrRelative("-1d", base)).toBe("2026-01-30T12:00:00.000Z");
    expect(resolveIsoOrRelative("+2w", base)).toBe("2026-02-14T12:00:00.000Z");
    expect(resolveIsoOrRelative("+1m", base)).toBe("2026-02-28T12:00:00.000Z");
    expect(resolveIsoOrRelative("-2m", base)).toBe("2025-11-30T12:00:00.000Z");
    expect(resolveIsoOrRelative("20260203", base)).toBe("2026-02-03T00:00:00.000Z");
    expect(resolveIsoOrRelative("20260203T0405Z", base)).toBe("2026-02-03T04:05:00.000Z");
    expect(resolveIsoOrRelative("2026-02-03 04-05-06,7+0100", base)).toBe("2026-02-03T03:05:06.700Z");
    expect(resolveIsoOrRelative("2026-02-03 040506.78-0130", base)).toBe("2026-02-03T05:35:06.780Z");
    expect(resolveIsoOrRelative("2026-02-03 \t 04:05:06Z", base)).toBe("2026-02-03T04:05:06.000Z");
    expect(resolveIsoOrRelative("20260203T040506Z", base)).toBe("2026-02-03T04:05:06.000Z");
    expect(resolveIsoOrRelative("20260203T040506+01:00", base)).toBe("2026-02-03T03:05:06.000Z");
    expect(resolveIsoOrRelative("2026-02-03 04-05+0100", base)).toBe("2026-02-03T03:05:00.000Z");
    expect(resolveIsoOrRelative("2026-02-03 0405Z", base)).toBe("2026-02-03T04:05:00.000Z");
    expect(resolveIsoOrRelative("2026-02-03\f04:05:06Z", base)).toBe("2026-02-03T04:05:06.000Z");
    expect(resolveIsoOrRelative("2026-02-03\v04:05:06Z", base)).toBe("2026-02-03T04:05:06.000Z");
  });

  it("exposes pure timestamp fallback helpers for defensive branch coverage", () => {
    expect(timeTestOnly.normalizeOffset(undefined)).toBe("");
    const candidates = ["already"];
    timeTestOnly.pushTimestampCandidate(candidates, "input", undefined);
    timeTestOnly.pushTimestampCandidate(candidates, "input", "input");
    timeTestOnly.pushTimestampCandidate(candidates, "input", "already");
    timeTestOnly.pushTimestampCandidate(candidates, "input", "next");
    expect(candidates).toEqual(["already", "next"]);
    expect(timeTestOnly.normalizeTimestampCandidates("20260203T040506+01:00")).toEqual([
      "2026-02-03T04:05:06+01:00",
    ]);
    expect(timeTestOnly.normalizeTimestampCandidates("2026-02-03T04:05:06Z")).toEqual(["2026-02-03TT04:05:06Z"]);
    expect(timeTestOnly.normalizeTimestampCandidates("2026-02-03")).toEqual([]);
    expect(Number.isNaN(timeTestOnly.parseTimestampWithFallbacks("2026-02-03 bad"))).toBe(true);
    expect(Number.isNaN(timeTestOnly.parseTimestampWithFallbacks("not-a-date"))).toBe(true);
    expect(timeTestOnly.isWhitespaceCharacter(undefined)).toBe(false);
  });

  it("rejects impossible calendar dates and unsupported relative compounds with clear labels", () => {
    expect(resolveIsoOrRelative("2026-02-03T04:05:06Z", base, "")).toBe("2026-02-03T04:05:06.000Z");
    expect(() => resolveIsoOrRelative("2026-13-01", base, "due date")).toThrow(
      'Invalid due date value "2026-13-01". Month "13" is out of range',
    );
    expect(() => resolveIsoOrRelative("2026-02-30T10:00:00Z", base, "due date")).toThrow(
      "February 2026 has 28 days",
    );
    expect(() => resolveIsoOrRelative("20260230", base, "due date")).toThrow(
      "day \"30\" does not exist",
    );
    expect(() => resolveIsoOrRelative("+3d+1h", base, " ")).toThrow(
      "Invalid deadline value \"+3d+1h\". Compound relative expressions",
    );
    expect(() => resolveIsoOrRelative("not-a-date", base, "closed at")).toThrow(
      'Invalid closed at value "not-a-date". Use ISO/date string input',
    );
  });

  it("compares parseable timestamps by instant and falls back to lexical order", () => {
    expect(isTimestampLiteral("2026-02-03T04:05:06Z")).toBe(true);
    expect(isTimestampLiteral("not-a-date")).toBe(false);
    expect(compareTimestampStrings("2026-02-03T04:05:07Z", "2026-02-03T04:05:06Z")).toBeGreaterThan(0);
    expect(compareTimestampStrings("same", "same")).toBe(0);
    expect(compareTimestampStrings("alpha", "beta")).toBeLessThan(0);
    // Memoized parses must return identical results on repeat comparisons.
    expect(compareTimestampStrings("2026-02-03T04:05:07Z", "2026-02-03T04:05:06Z")).toBeGreaterThan(0);
  });

  it("keeps comparing correctly after the timestamp parse memo hits its size cap", () => {
    // Overflow the memo with unique parseable timestamps to force the wholesale
    // clear branch, then verify ordering is still computed correctly.
    for (let index = 0; index < 10_001; index += 1) {
      const millis = String(index % 1000).padStart(3, "0");
      const seconds = String(Math.floor(index / 1000) % 60).padStart(2, "0");
      const minutes = String(Math.floor(index / 60_000)).padStart(2, "0");
      compareTimestampStrings(`2026-01-01T00:${minutes}:${seconds}.${millis}Z`, "2026-01-01T00:00:00.000Z");
    }
    expect(compareTimestampStrings("2026-02-03T04:05:07Z", "2026-02-03T04:05:06Z")).toBeGreaterThan(0);
    expect(compareTimestampStrings("2026-02-03T04:05:06Z", "2026-02-03T04:05:07Z")).toBeLessThan(0);
  });
});

describe("core/shared/text-normalization", () => {
  it("normalizes whitespace and tokenizes alphanumeric text", () => {
    expect(normalizeLowercaseWhitespace("  Hello\tPM\nCLI  ")).toBe("hello pm cli");
    expect(tokenizeAlphaNumeric("PM-CLI issue #123: Done.")).toEqual(["pm", "cli", "issue", "123", "done"]);
  });

  it("computes jaccard similarity including empty and duplicate token cases", () => {
    expect(jaccardSimilarity([], [])).toBe(1);
    expect(jaccardSimilarity(["pm"], [])).toBe(0);
    expect(jaccardSimilarity(["pm", "pm", "cli"], ["pm", "test"])).toBeCloseTo(1 / 3);
    expect(jaccardSimilarity(["left"], ["right"])).toBe(0);
  });
});

describe("core/shared/conflict-markers", () => {
  it("finds merge conflict markers with line numbers and preserves text", () => {
    const content = ["safe", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> branch"].join("\n");
    expect(findMergeConflictMarkers(content)).toEqual([
      { line: 2, marker: "<<<<<<<", text: "<<<<<<< HEAD" },
      { line: 4, marker: "=======", text: "=======" },
      { line: 6, marker: ">>>>>>>", text: ">>>>>>> branch" },
    ]);
    expect(findFirstMergeConflictMarker(content)).toEqual({ line: 2, marker: "<<<<<<<", text: "<<<<<<< HEAD" });
  });

  it("returns no markers for empty content or marker-like inline text", () => {
    expect(findMergeConflictMarkers("")).toEqual([]);
    expect(findFirstMergeConflictMarker("prefix <<<<<<< HEAD")).toBeUndefined();
  });

  it("tolerates sparse split results defensively", () => {
    const originalSplit = String.prototype.split;
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (
      this: string,
      separator: string | RegExp,
      limit?: number,
    ): string[] {
      if (this === "sparse-conflict-input") {
        const sparse = [] as string[];
        sparse.length = 2;
        sparse[1] = ">>>>>>> branch";
        return sparse;
      }
      return originalSplit.call(this, separator, limit);
    });

    try {
      expect(findMergeConflictMarkers("sparse-conflict-input")).toEqual([
        { line: 2, marker: ">>>>>>>", text: ">>>>>>> branch" },
      ]);
    } finally {
      splitSpy.mockRestore();
    }
  });
});
