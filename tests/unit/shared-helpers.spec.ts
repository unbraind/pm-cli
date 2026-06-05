import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAuthor } from "../../src/core/shared/author.js";
import { isPathWithinDirectory } from "../../src/core/fs/path-utils.js";
import { createLazyModule } from "../../src/core/shared/lazy-module.js";
import { createSerialQueue } from "../../src/core/shared/serial-queue.js";

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
});
