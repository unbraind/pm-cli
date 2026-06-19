import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheckpointGc } from "../../../../src/core/checkpoint/checkpoint-gc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let checkpointsDir: string;

const DAY_MS = 86_400_000;

async function writeCheckpoint(relPath: string, payload: unknown): Promise<void> {
  const abs = path.join(checkpointsDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pm-ckpt-gc-"));
  checkpointsDir = path.join(tempDir, "checkpoints");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCheckpointGc — missing checkpoints dir", () => {
  it("returns an empty result when checkpoints/ does not exist", async () => {
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 14 });
    expect(result).toEqual({ scanned: 0, removed: [], retained: [], warnings: [], entries: [] });
  });

  it("rethrows non-ENOENT readdir errors from the checkpoints root", async () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(error as never);
    await expect(runCheckpointGc(tempDir, { dryRun: false, retentionDays: 14 })).rejects.toThrow("denied");
  });
});

describe("runCheckpointGc — age classification", () => {
  it("prunes expired checkpoints and retains fresh ones, scanning nested and top-level files", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(40) });
    await writeCheckpoint("close-many/fresh.json", { created_at: isoDaysAgo(1) });
    await writeCheckpoint("top.json", { created_at: isoDaysAgo(40) });
    // Non-JSON siblings at both levels must be ignored entirely.
    await writeCheckpoint("update-many/notes.txt", "ignore me");
    await writeCheckpoint("readme.md", "ignore me too");

    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 7 });

    expect(result.scanned).toBe(3);
    expect(result.removed).toEqual(["checkpoints/top.json", "checkpoints/update-many/old.json"]);
    expect(result.retained).toEqual(["checkpoints/close-many/fresh.json"]);
    expect(result.warnings).toEqual([]);
    await expect(fs.access(path.join(checkpointsDir, "update-many/old.json"))).rejects.toThrow();
    await expect(fs.access(path.join(checkpointsDir, "close-many/fresh.json"))).resolves.toBeUndefined();
  });

  it("treats a future created_at as active (non-negative age window)", async () => {
    await writeCheckpoint("update-many/future.json", { created_at: isoDaysAgo(-5) });
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 7 });
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual(["checkpoints/update-many/future.json"]);
    expect(result.entries[0].reason).toBe("active");
  });

  it("clamps a negative retentionDays to zero so any aged checkpoint is pruned", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(1) });
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: -10 });
    expect(result.removed).toEqual(["checkpoints/update-many/old.json"]);
  });

  it("previews removals without deleting under dryRun", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(40) });
    const result = await runCheckpointGc(tempDir, { dryRun: true, retentionDays: 7 });
    expect(result.removed).toEqual(["checkpoints/update-many/old.json"]);
    await expect(fs.access(path.join(checkpointsDir, "update-many/old.json"))).resolves.toBeUndefined();
  });
});

describe("runCheckpointGc — safety-first retention of unreasonable files", () => {
  it("retains checkpoints with invalid JSON, missing created_at, or unparseable timestamps", async () => {
    await writeCheckpoint("update-many/broken.json", "}{ not json");
    await writeCheckpoint("update-many/no-created.json", { id: "x" });
    await writeCheckpoint("update-many/array.json", []);
    await writeCheckpoint("update-many/bad-ts.json", { created_at: "not-a-date" });

    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 0 });

    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([
      "checkpoints/update-many/array.json",
      "checkpoints/update-many/bad-ts.json",
      "checkpoints/update-many/broken.json",
      "checkpoints/update-many/no-created.json",
    ]);
    expect(result.warnings).toEqual([
      "checkpoint_unparseable:update-many/array.json",
      "checkpoint_unparseable:update-many/bad-ts.json",
      "checkpoint_unparseable:update-many/broken.json",
      "checkpoint_unparseable:update-many/no-created.json",
    ]);
    expect(result.entries.every((entry) => entry.reason === "unparseable")).toBe(true);
  });

  it("retains a checkpoint that becomes unreadable (EISDIR) and warns", async () => {
    // A directory named like a checkpoint file: readFile rejects with EISDIR.
    await fs.mkdir(path.join(checkpointsDir, "update-many", "dir.json"), { recursive: true });
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 0 });
    expect(result.warnings).toEqual(["checkpoint_unreadable:update-many/dir.json"]);
    expect(result.retained).toEqual(["checkpoints/update-many/dir.json"]);
  });

  it("warns and continues when a checkpoint subdirectory is unreadable", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(40) });
    const realReaddir = fs.readdir.bind(fs) as typeof fs.readdir;
    const subdirSuffix = path.join("checkpoints", "update-many");
    vi.spyOn(fs, "readdir").mockImplementation(((target: Parameters<typeof fs.readdir>[0], options?: unknown) => {
      if (typeof target === "string" && target.endsWith(subdirSuffix)) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return (realReaddir as (...args: unknown[]) => unknown)(target, options);
    }) as never);
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 7 });
    expect(result.warnings).toEqual(["checkpoint_subdir_unreadable:update-many"]);
    expect(result.scanned).toBe(0);
    expect(result.removed).toEqual([]);
  });

  it("skips a checkpoint subdirectory that vanishes during the scan (ENOENT, no warning)", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(40) });
    const realReaddir = fs.readdir.bind(fs) as typeof fs.readdir;
    const subdirSuffix = path.join("checkpoints", "update-many");
    vi.spyOn(fs, "readdir").mockImplementation(((target: Parameters<typeof fs.readdir>[0], options?: unknown) => {
      if (typeof target === "string" && target.endsWith(subdirSuffix)) {
        return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
      }
      return (realReaddir as (...args: unknown[]) => unknown)(target, options);
    }) as never);
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 7 });
    expect(result.warnings).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  it("disables pruning when retentionDays is non-finite (bad input never deletes)", async () => {
    await writeCheckpoint("update-many/ancient.json", { created_at: isoDaysAgo(9999) });
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: Number.POSITIVE_INFINITY });
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual(["checkpoints/update-many/ancient.json"]);
  });

  it("skips a checkpoint that vanishes between scan and read (ghost)", async () => {
    await writeCheckpoint("update-many/ghost.json", { created_at: isoDaysAgo(40) });
    const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(enoent as never);
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 7 });
    expect(result.scanned).toBe(0);
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([]);
  });
});

describe("runCheckpointGc — unlink races and failures", () => {
  it("treats an ENOENT during unlink as already removed", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(40) });
    const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(enoent as never);
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 7 });
    expect(result.removed).toEqual(["checkpoints/update-many/old.json"]);
    expect(result.warnings).toEqual([]);
  });

  it("retains and warns when unlink fails for a non-ENOENT reason", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(40) });
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(eacces as never);
    const result = await runCheckpointGc(tempDir, { dryRun: false, retentionDays: 7 });
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual(["checkpoints/update-many/old.json"]);
    expect(result.warnings).toEqual(["checkpoint_remove_failed:update-many/old.json"]);
  });
});

describe("runCheckpointGc — extension hooks", () => {
  it("collects onRead warnings for every scanned file and onWrite warnings after removal", async () => {
    await writeCheckpoint("update-many/old.json", { created_at: isoDaysAgo(40) });
    await writeCheckpoint("close-many/fresh.json", { created_at: isoDaysAgo(1) });
    const result = await runCheckpointGc(tempDir, {
      dryRun: false,
      retentionDays: 7,
      hooks: {
        onRead: (checkpointPath) => [`read:${path.basename(checkpointPath)}`],
        onWrite: (checkpointPath) => [`write:${path.basename(checkpointPath)}`],
      },
    });
    expect(result.warnings).toEqual(["read:fresh.json", "read:old.json", "write:old.json"]);
  });
});
