import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyLockContent, runLockGc, scanLockHealth } from "../../../../src/core/lock/lock-gc.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pm-lockgc-"));
}

function makeLockPayload(overrides: {
  id?: string;
  pid?: number;
  owner?: string;
  created_at?: string;
  ttl_seconds?: number;
}): string {
  return JSON.stringify(
    {
      id: overrides.id ?? "pm-test",
      pid: overrides.pid ?? 12345,
      owner: overrides.owner ?? "test-owner",
      created_at: overrides.created_at ?? new Date().toISOString(),
      ttl_seconds: overrides.ttl_seconds ?? 3600,
    },
    null,
    2,
  );
}

/** epoch-ms for a timestamp N seconds in the past */
function msAgo(seconds: number): number {
  return Date.now() - seconds * 1000;
}

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let locksDir: string;

beforeEach(async () => {
  tempDir = await makeTempDir();
  locksDir = path.join(tempDir, "locks");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLockGc — missing locks dir", () => {
  it("returns empty result when locks directory does not exist (ENOENT)", async () => {
    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result).toEqual({
      scanned: 0,
      removed: [],
      retained: [],
      warnings: [],
      entries: [],
    });
  });
});

describe("runLockGc — non-.lock files ignored", () => {
  it("skips files that do not end with .lock", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(path.join(locksDir, "pm-abc.json"), "{}");
    await fs.writeFile(path.join(locksDir, "README.txt"), "hello");
    await fs.writeFile(path.join(locksDir, "lockfile"), "{}");

    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result.scanned).toBe(0);
    expect(result.entries).toHaveLength(0);
  });
});

describe("runLockGc — active lock", () => {
  it("retains an active (non-expired) lock", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const created_at = new Date().toISOString();
    await fs.writeFile(
      path.join(locksDir, "pm-active.lock"),
      makeLockPayload({ id: "pm-active", created_at, ttl_seconds: 3600 }),
    );

    const result = await runLockGc(tempDir, { dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual(["locks/pm-active.lock"]);
    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.file).toBe("pm-active.lock");
    expect(entry.id).toBe("pm-active");
    expect(entry.owner).toBe("test-owner");
    expect(entry.reason).toBe("active");
    expect(entry.stale).toBe(false);
    expect(entry.age_seconds).toBeGreaterThanOrEqual(0);
    // file should still exist
    await expect(fs.access(path.join(locksDir, "pm-active.lock"))).resolves.toBeUndefined();
  });
});

describe("runLockGc — expired lock (real delete)", () => {
  it("removes an expired lock and reports it in removed[]", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString(); // 2h ago, ttl 1h
    await fs.writeFile(
      path.join(locksDir, "pm-stale.lock"),
      makeLockPayload({ id: "pm-stale", created_at: staleTs, ttl_seconds: 3600 }),
    );

    const result = await runLockGc(tempDir, { dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.removed).toEqual(["locks/pm-stale.lock"]);
    expect(result.retained).toEqual([]);
    expect(result.warnings).toEqual([]);
    const entry = result.entries[0];
    expect(entry.reason).toBe("expired");
    expect(entry.stale).toBe(true);
    expect(entry.age_seconds).toBeGreaterThanOrEqual(7200);
    // file must be gone
    await expect(fs.access(path.join(locksDir, "pm-stale.lock"))).rejects.toBeInstanceOf(Error);
  });

  it("uses injected `now` for deterministic staleness calculation", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const fixedCreatedAt = "2020-01-01T00:00:00.000Z";
    const createdMs = Date.parse(fixedCreatedAt);
    const ttl = 60; // 60 s
    // inject `now` = exactly ttl+1 seconds after created → stale
    const nowMs = createdMs + (ttl + 1) * 1000;

    await fs.writeFile(
      path.join(locksDir, "pm-det.lock"),
      makeLockPayload({ id: "pm-det", created_at: fixedCreatedAt, ttl_seconds: ttl }),
    );

    const result = await runLockGc(tempDir, { dryRun: false, now: nowMs });

    expect(result.removed).toEqual(["locks/pm-det.lock"]);
    expect(result.entries[0].age_seconds).toBe(ttl + 1);
  });

  it("retains an active lock when injected `now` is before expiry", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const fixedCreatedAt = "2020-01-01T00:00:00.000Z";
    const createdMs = Date.parse(fixedCreatedAt);
    const ttl = 3600;
    // inject `now` = 1 s after created → not stale
    const nowMs = createdMs + 1000;

    await fs.writeFile(
      path.join(locksDir, "pm-early.lock"),
      makeLockPayload({ id: "pm-early", created_at: fixedCreatedAt, ttl_seconds: ttl }),
    );

    const result = await runLockGc(tempDir, { dryRun: false, now: nowMs });
    expect(result.retained).toEqual(["locks/pm-early.lock"]);
    expect(result.removed).toEqual([]);
  });
});

describe("runLockGc — dryRun preview", () => {
  it("classifies expired lock as removed in dryRun without deleting the file", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString();
    const lockFile = path.join(locksDir, "pm-dry.lock");
    await fs.writeFile(
      lockFile,
      makeLockPayload({ id: "pm-dry", created_at: staleTs, ttl_seconds: 3600 }),
    );

    const result = await runLockGc(tempDir, { dryRun: true });

    expect(result.removed).toEqual(["locks/pm-dry.lock"]);
    expect(result.retained).toEqual([]);
    expect(result.entries[0].stale).toBe(true);
    // file must still exist under dryRun
    await expect(fs.access(lockFile)).resolves.toBeUndefined();
  });
});

describe("runLockGc — unparseable JSON", () => {
  it("retains and warns for a lock file with invalid JSON", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(path.join(locksDir, "pm-badjson.lock"), "{not valid json");

    const result = await runLockGc(tempDir, { dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.retained).toEqual(["locks/pm-badjson.lock"]);
    expect(result.removed).toEqual([]);
    expect(result.warnings).toContain("lock_unparseable:pm-badjson.lock");
    const entry = result.entries[0];
    expect(entry.id).toBeNull();
    expect(entry.reason).toBe("unparseable");
    expect(entry.stale).toBe(false);
    // file still present
    await expect(fs.access(path.join(locksDir, "pm-badjson.lock"))).resolves.toBeUndefined();
  });
});

describe("runLockGc — invalid shape", () => {
  it("retains a lock with valid JSON but wrong shape (missing id)", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(
      path.join(locksDir, "pm-noid.lock"),
      JSON.stringify({ owner: "x", created_at: "2020-01-01T00:00:00Z", ttl_seconds: 60 }),
    );

    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result.retained).toEqual(["locks/pm-noid.lock"]);
    expect(result.warnings).toContain("lock_unparseable:pm-noid.lock");
    expect(result.entries[0].reason).toBe("unparseable");
  });

  it("retains a lock whose ttl_seconds is not a finite number", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(
      path.join(locksDir, "pm-badttl.lock"),
      JSON.stringify({ id: "pm-badttl", owner: "x", created_at: "2020-01-01T00:00:00Z", ttl_seconds: "oops" }),
    );

    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result.retained).toEqual(["locks/pm-badttl.lock"]);
    expect(result.warnings).toContain("lock_unparseable:pm-badttl.lock");
  });

  it("retains a lock whose ttl_seconds is Infinity", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    // JSON.stringify doesn't handle Infinity cleanly, so write raw
    await fs.writeFile(
      path.join(locksDir, "pm-inf.lock"),
      JSON.stringify({ id: "pm-inf", owner: "x", created_at: "2020-01-01T00:00:00Z", ttl_seconds: null }),
    );

    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result.retained).toEqual(["locks/pm-inf.lock"]);
    expect(result.warnings).toContain("lock_unparseable:pm-inf.lock");
  });

  it("retains a lock whose root JSON value is an array", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(path.join(locksDir, "pm-arr.lock"), "[]");

    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result.retained).toEqual(["locks/pm-arr.lock"]);
    expect(result.warnings).toContain("lock_unparseable:pm-arr.lock");
  });

  it("retains a lock whose root JSON value is a primitive", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(path.join(locksDir, "pm-prim.lock"), '"hello"');

    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result.retained).toEqual(["locks/pm-prim.lock"]);
    expect(result.warnings).toContain("lock_unparseable:pm-prim.lock");
  });
});

describe("runLockGc — invalid timestamp", () => {
  it("retains a lock with a non-parseable created_at string", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(
      path.join(locksDir, "pm-badts.lock"),
      JSON.stringify({ id: "pm-badts", pid: 1, owner: "x", created_at: "not-a-date", ttl_seconds: 60 }),
    );

    const result = await runLockGc(tempDir, { dryRun: false });
    expect(result.retained).toEqual(["locks/pm-badts.lock"]);
    expect(result.warnings).toContain("lock_invalid_timestamp:pm-badts.lock");
    const entry = result.entries[0];
    expect(entry.reason).toBe("unparseable");
    expect(entry.age_seconds).toBeNull();
    // id/owner/created_at/ttl_seconds are still populated (we parsed the shape OK)
    expect(entry.id).toBe("pm-badts");
    expect(entry.owner).toBe("x");
  });
});

describe("runLockGc — zero and negative ttl", () => {
  it("treats ttl_seconds=0 as immediately stale for any positive age", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    // 1 second old, ttl 0 → stale (1000ms > 0)
    const nowMs = Date.now();
    const createdAt = new Date(nowMs - 1000).toISOString();
    await fs.writeFile(
      path.join(locksDir, "pm-zero.lock"),
      makeLockPayload({ id: "pm-zero", created_at: createdAt, ttl_seconds: 0 }),
    );

    const result = await runLockGc(tempDir, { dryRun: false, now: nowMs });
    expect(result.removed).toEqual(["locks/pm-zero.lock"]);
    expect(result.entries[0].stale).toBe(true);
  });

  it("treats ttl_seconds negative as always stale (even age 0)", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    // Created exactly at `now` → age 0; ttl -1 → 0 > -1000 → stale
    const fixedNow = Date.now();
    const createdAt = new Date(fixedNow).toISOString();
    await fs.writeFile(
      path.join(locksDir, "pm-neg.lock"),
      makeLockPayload({ id: "pm-neg", created_at: createdAt, ttl_seconds: -1 }),
    );

    const result = await runLockGc(tempDir, { dryRun: false, now: fixedNow });
    expect(result.removed).toEqual(["locks/pm-neg.lock"]);
    expect(result.entries[0].stale).toBe(true);
  });
});

describe("runLockGc — hooks", () => {
  it("invokes onRead hook and surfaces its warnings", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const created_at = new Date().toISOString();
    const lockFile = path.join(locksDir, "pm-hook.lock");
    await fs.writeFile(lockFile, makeLockPayload({ id: "pm-hook", created_at, ttl_seconds: 3600 }));

    const readPaths: string[] = [];
    const result = await runLockGc(tempDir, {
      dryRun: false,
      hooks: {
        onRead: (p) => {
          readPaths.push(p);
          return ["onread-warning"];
        },
      },
    });

    expect(readPaths).toEqual([lockFile]);
    expect(result.warnings).toContain("onread-warning");
  });

  it("invokes onWrite hook after removing a stale lock and surfaces its warnings", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString();
    const lockFile = path.join(locksDir, "pm-wrhook.lock");
    await fs.writeFile(lockFile, makeLockPayload({ id: "pm-wrhook", created_at: staleTs, ttl_seconds: 3600 }));

    const writePaths: string[] = [];
    const result = await runLockGc(tempDir, {
      dryRun: false,
      hooks: {
        onWrite: async (p) => {
          writePaths.push(p);
          return ["onwrite-warning"];
        },
      },
    });

    expect(writePaths).toEqual([lockFile]);
    expect(result.removed).toEqual(["locks/pm-wrhook.lock"]);
    expect(result.warnings).toContain("onwrite-warning");
  });

  it("does NOT invoke onWrite hook under dryRun", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString();
    await fs.writeFile(
      path.join(locksDir, "pm-drywr.lock"),
      makeLockPayload({ id: "pm-drywr", created_at: staleTs, ttl_seconds: 3600 }),
    );

    const writePaths: string[] = [];
    await runLockGc(tempDir, {
      dryRun: true,
      hooks: {
        onWrite: (p) => {
          writePaths.push(p);
          return [];
        },
      },
    });

    expect(writePaths).toHaveLength(0);
  });

  it("invokes onRead hook for unparseable locks too and surfaces warnings", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    await fs.writeFile(path.join(locksDir, "pm-rdunp.lock"), "{bad json");

    const readPaths: string[] = [];
    const result = await runLockGc(tempDir, {
      dryRun: false,
      hooks: {
        onRead: (p) => {
          readPaths.push(p);
          return ["hook-warn-unp"];
        },
      },
    });

    expect(readPaths).toHaveLength(1);
    expect(result.warnings).toContain("hook-warn-unp");
    expect(result.warnings).toContain("lock_unparseable:pm-rdunp.lock");
  });
});

describe("runLockGc — unlink failure path", () => {
  it("surfaces lock_unreadable warning for a lock file that cannot be read (non-ENOENT)", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    // A directory named "pm-eisdir.lock" makes fs.readFile fail with EISDIR (not ENOENT),
    // which exercises the read-failure (lock_unreadable) branch.
    const dirLock = path.join(locksDir, "pm-eisdir.lock");
    await fs.mkdir(dirLock);

    const result = await runLockGc(tempDir, { dryRun: false });

    expect(result.warnings).toContain("lock_unreadable:pm-eisdir.lock");
    expect(result.retained).toContain("locks/pm-eisdir.lock");
    expect(result.entries[0].reason).toBe("unparseable");
  });

  it("retains the lock and pushes lock_remove_failed warning when unlink fails with a non-ENOENT error", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString();
    const lockFile = path.join(locksDir, "pm-rmfail.lock");
    await fs.writeFile(lockFile, makeLockPayload({ id: "pm-rmfail", created_at: staleTs, ttl_seconds: 3600 }));

    // Spy on fs.unlink to throw EPERM for this specific path
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementationOnce(async (p) => {
      if (String(p) === lockFile) {
        throw Object.assign(new Error("unlink denied"), { code: "EPERM" });
      }
    });
    let result;
    try {
      result = await runLockGc(tempDir, { dryRun: false });
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(result.warnings).toContain("lock_remove_failed:pm-rmfail.lock");
    expect(result.retained).toContain("locks/pm-rmfail.lock");
    expect(result.removed).toEqual([]);
    // entry should still be classified as expired/stale
    expect(result.entries[0].reason).toBe("expired");
    expect(result.entries[0].stale).toBe(true);
  });
});

describe("runLockGc — sorted entries and multiple files", () => {
  it("returns entries sorted by file name ascending", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString();
    const activeTs = new Date().toISOString();
    const files = ["pm-zzz.lock", "pm-aaa.lock", "pm-mmm.lock"];
    for (const f of files) {
      const isStale = f === "pm-zzz.lock";
      await fs.writeFile(
        path.join(locksDir, f),
        makeLockPayload({
          id: f.replace(".lock", ""),
          created_at: isStale ? staleTs : activeTs,
          ttl_seconds: 3600,
        }),
      );
    }

    const result = await runLockGc(tempDir, { dryRun: true });

    expect(result.entries.map((e) => e.file)).toEqual(["pm-aaa.lock", "pm-mmm.lock", "pm-zzz.lock"]);
    expect(result.removed).toEqual(["locks/pm-zzz.lock"]);
    expect(result.retained).toEqual(["locks/pm-aaa.lock", "locks/pm-mmm.lock"]);
  });

  it("mixes stale+active+unparseable and reports each correctly", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString();
    const activeTs = new Date().toISOString();

    await fs.writeFile(
      path.join(locksDir, "pm-act.lock"),
      makeLockPayload({ id: "pm-act", created_at: activeTs, ttl_seconds: 3600 }),
    );
    await fs.writeFile(
      path.join(locksDir, "pm-exp.lock"),
      makeLockPayload({ id: "pm-exp", created_at: staleTs, ttl_seconds: 3600 }),
    );
    await fs.writeFile(path.join(locksDir, "pm-bad.lock"), "garbage");

    const result = await runLockGc(tempDir, { dryRun: false });

    expect(result.scanned).toBe(3);
    expect(result.removed).toEqual(["locks/pm-exp.lock"]);
    expect(result.retained).toEqual(expect.arrayContaining(["locks/pm-act.lock", "locks/pm-bad.lock"]));
    expect(result.warnings).toContain("lock_unparseable:pm-bad.lock");

    const reasons = Object.fromEntries(result.entries.map((e) => [e.file, e.reason]));
    expect(reasons["pm-act.lock"]).toBe("active");
    expect(reasons["pm-exp.lock"]).toBe("expired");
    expect(reasons["pm-bad.lock"]).toBe("unparseable");
  });
});

describe("runLockGc — ENOENT on unlink (race)", () => {
  it("treats ENOENT on unlink as already-removed without error", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const staleTs = new Date(Date.now() - 7200 * 1000).toISOString();
    const lockFile = path.join(locksDir, "pm-race.lock");
    await fs.writeFile(lockFile, makeLockPayload({ id: "pm-race", created_at: staleTs, ttl_seconds: 3600 }));

    // Simulate a race condition: fs.unlink throws ENOENT (another process already deleted the lock).
    // readFile still succeeds (file was present when we read it), then unlink sees ENOENT.
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementationOnce(async (p) => {
      if (String(p) === lockFile) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
    });
    let result;
    try {
      result = await runLockGc(tempDir, { dryRun: false });
    } finally {
      unlinkSpy.mockRestore();
    }

    // ENOENT on unlink is treated as already removed — no warnings, counted as removed
    expect(result.removed).toEqual(["locks/pm-race.lock"]);
    expect(result.retained).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("skips a lock file that disappears between readdir and readFile (ghost ENOENT)", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const lockFile = path.join(locksDir, "pm-ghost.lock");
    const activeTs = new Date().toISOString();
    await fs.writeFile(lockFile, makeLockPayload({ id: "pm-ghost", created_at: activeTs, ttl_seconds: 3600 }));

    // Spy on readFile: when called for this specific path, throw ENOENT (file disappeared after readdir)
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementationOnce(async (p, _enc) => {
      if (String(p) === lockFile) {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      // fallback (shouldn't happen in this test)
      return fs.readFile(p, _enc as BufferEncoding);
    });
    let result;
    try {
      result = await runLockGc(tempDir, { dryRun: false });
    } finally {
      readFileSpy.mockRestore();
    }

    // Ghost file is silently skipped; scanned count is 0
    expect(result.scanned).toBe(0);
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(0);
  });
});

describe("runLockGc — readdir non-ENOENT error", () => {
  it("re-throws when readdir fails with a non-ENOENT error", async () => {
    await fs.mkdir(locksDir, { recursive: true });

    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    try {
      await expect(runLockGc(tempDir, { dryRun: false })).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      readdirSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// classifyLockContent — pure classification shared by gc and pm health
// ---------------------------------------------------------------------------

describe("classifyLockContent", () => {
  const createdAt = "2020-01-01T00:00:00.000Z";
  const createdMs = Date.parse(createdAt);

  it("classifies a fresh lock as active", () => {
    const raw = makeLockPayload({ id: "pm-a", created_at: createdAt, ttl_seconds: 60 });
    const { detail, entry } = classifyLockContent("pm-a.lock", raw, createdMs + 1000);
    expect(detail).toBe("active");
    expect(entry).toMatchObject({
      file: "pm-a.lock",
      id: "pm-a",
      owner: "test-owner",
      created_at: createdAt,
      ttl_seconds: 60,
      age_seconds: 1,
      stale: false,
      reason: "active",
    });
  });

  it("treats age exactly at ttl as still active (staleness requires strictly elapsed ttl)", () => {
    const raw = makeLockPayload({ id: "pm-b", created_at: createdAt, ttl_seconds: 60 });
    const { detail } = classifyLockContent("pm-b.lock", raw, createdMs + 60_000);
    expect(detail).toBe("active");
  });

  it("classifies an elapsed-ttl lock as expired/stale", () => {
    const raw = makeLockPayload({ id: "pm-c", created_at: createdAt, ttl_seconds: 60 });
    const { detail, entry } = classifyLockContent("pm-c.lock", raw, createdMs + 61_000);
    expect(detail).toBe("expired");
    expect(entry).toMatchObject({ stale: true, reason: "expired", age_seconds: 61 });
  });

  it("classifies invalid JSON as unparseable_json with a null-field entry", () => {
    const { detail, entry } = classifyLockContent("pm-d.lock", "{nope", Date.now());
    expect(detail).toBe("unparseable_json");
    expect(entry).toEqual({
      file: "pm-d.lock",
      id: null,
      owner: null,
      created_at: null,
      ttl_seconds: null,
      age_seconds: null,
      stale: false,
      reason: "unparseable",
    });
  });

  it("classifies an unparseable created_at as invalid_timestamp but preserves lock fields", () => {
    const raw = makeLockPayload({ id: "pm-e", created_at: "not-a-date", ttl_seconds: 60 });
    const { detail, entry } = classifyLockContent("pm-e.lock", raw, Date.now());
    expect(detail).toBe("invalid_timestamp");
    expect(entry).toMatchObject({
      id: "pm-e",
      owner: "test-owner",
      created_at: "not-a-date",
      ttl_seconds: 60,
      age_seconds: null,
      stale: false,
      reason: "unparseable",
    });
  });
});

// ---------------------------------------------------------------------------
// scanLockHealth — read-only scan for the pm health locks check
// ---------------------------------------------------------------------------

describe("scanLockHealth", () => {
  it("returns an all-zero scan when the locks directory does not exist", async () => {
    const scan = await scanLockHealth(tempDir);
    expect(scan).toEqual({
      scanned: 0,
      active_lock_count: 0,
      stale_lock_count: 0,
      unreadable_lock_count: 0,
      unparseable_lock_count: 0,
    });
  });

  it("counts active/stale/unparseable locks with injected now and ignores non-.lock files", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const createdAt = "2020-01-01T00:00:00.000Z";
    const nowMs = Date.parse(createdAt) + 120_000;
    await fs.writeFile(
      path.join(locksDir, "pm-active.lock"),
      makeLockPayload({ id: "pm-active", created_at: createdAt, ttl_seconds: 3600 }),
    );
    await fs.writeFile(
      path.join(locksDir, "pm-stale.lock"),
      makeLockPayload({ id: "pm-stale", created_at: createdAt, ttl_seconds: 60 }),
    );
    await fs.writeFile(path.join(locksDir, "pm-badjson.lock"), "{not json");
    await fs.writeFile(
      path.join(locksDir, "pm-badts.lock"),
      makeLockPayload({ id: "pm-badts", created_at: "not-a-date", ttl_seconds: 60 }),
    );
    await fs.writeFile(path.join(locksDir, "README.txt"), "ignored");

    const scan = await scanLockHealth(tempDir, nowMs);
    expect(scan).toEqual({
      scanned: 4,
      active_lock_count: 1,
      stale_lock_count: 1,
      unreadable_lock_count: 0,
      // invalid JSON and invalid timestamp both roll up into unparseable
      unparseable_lock_count: 2,
    });

    // Read-only contract: every lock file is still present after the scan.
    const remaining = await fs.readdir(locksDir);
    expect(remaining.sort()).toEqual(["README.txt", "pm-active.lock", "pm-badjson.lock", "pm-badts.lock", "pm-stale.lock"]);
  });

  it("counts a lock whose content cannot be read as unreadable", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    // A directory with a .lock name makes readFile fail deterministically (EISDIR).
    await fs.mkdir(path.join(locksDir, "pm-dir.lock"), { recursive: true });
    await fs.writeFile(
      path.join(locksDir, "pm-active.lock"),
      makeLockPayload({ id: "pm-active", created_at: new Date().toISOString(), ttl_seconds: 3600 }),
    );

    const scan = await scanLockHealth(tempDir);
    expect(scan).toEqual({
      scanned: 2,
      active_lock_count: 1,
      stale_lock_count: 0,
      unreadable_lock_count: 1,
      unparseable_lock_count: 0,
    });
  });

  it("skips a lock that disappears between readdir and readFile (ghost ENOENT)", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const lockFile = path.join(locksDir, "pm-ghost.lock");
    await fs.writeFile(lockFile, makeLockPayload({ id: "pm-ghost", created_at: new Date().toISOString() }));

    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    });
    let scan;
    try {
      scan = await scanLockHealth(tempDir);
    } finally {
      readFileSpy.mockRestore();
    }
    expect(scan).toEqual({
      scanned: 0,
      active_lock_count: 0,
      stale_lock_count: 0,
      unreadable_lock_count: 0,
      unparseable_lock_count: 0,
    });
  });

  it("re-throws when readdir fails with a non-ENOENT error", async () => {
    await fs.mkdir(locksDir, { recursive: true });
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    try {
      await expect(scanLockHealth(tempDir)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      readdirSpy.mockRestore();
    }
  });
});
