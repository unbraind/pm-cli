import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireLock } from "../../../../src/core/lock/lock.js";
import {
  captureLockOwnerIdentity,
  inspectLockOwner,
  readLockHostIdentity,
} from "../../../../src/core/lock/lock-owner.js";
import {
  runLockGc,
  scanLockHealth,
} from "../../../../src/core/lock/lock-gc.js";
import { withTempDir } from "../../../helpers/temp.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("cannot prove process death from legacy, foreign, malformed or unavailable host coordinates", async () => {
  for (const identity of [
    null,
    {},
    { pid: 0 },
    { pid: -1 },
    { pid: 1.5 },
    { pid: process.pid },
    { pid: process.pid, host_identity: "foreign" },
    { pid: process.pid, host_identity: "foreign", process_start_identity: "1" },
    {
      pid: process.pid,
      host_identity: "foreign",
      process_start_identity: "invalid",
    },
  ]) {
    expect(await inspectLockOwner(identity)).toBe("unknown");
  }
  vi.spyOn(fs, "readlink").mockRejectedValue(
    new Error("Host identity unavailable"),
  );
  expect(await readLockHostIdentity()).toBeNull();
  expect(await captureLockOwnerIdentity()).toEqual({});
  expect(
    await inspectLockOwner({
      pid: process.pid,
      host_identity: "foreign",
      process_start_identity: "1",
    }),
  ).toBe("unknown");
});

it("rejects malformed boot and namespace observations instead of inventing a host identity", async () => {
  vi.spyOn(fs, "readFile").mockResolvedValue("invalid");
  vi.spyOn(fs, "readlink").mockResolvedValue("pid:[1]");
  expect(await readLockHostIdentity()).toBeNull();
  vi.mocked(fs.readFile).mockResolvedValue(
    "00000000-0000-0000-0000-000000000000\n",
  );
  vi.mocked(fs.readlink).mockResolvedValue("invalid");
  expect(await readLockHostIdentity()).toBeNull();
});

it.skipIf(process.platform !== "linux")(
  "distinguishes live owners, PID reuse, definite death and permission-denied probes",
  async () => {
    const identity = {
      pid: process.pid,
      ...(await captureLockOwnerIdentity()),
    };
    expect(await inspectLockOwner(identity)).toBe("alive");
    expect(
      await inspectLockOwner({ ...identity, process_start_identity: "0" }),
    ).toBe("dead");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(await inspectLockOwner(identity)).toBe("unknown");
    for (const failure of [null, "unavailable", new Error("Unavailable process probe")]) {
      kill.mockImplementation(() => { throw failure; });
      expect(await inspectLockOwner(identity)).toBe("unknown");
    }
    kill.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(await inspectLockOwner(identity)).toBe("dead");
    kill.mockRestore();
    const originalRead = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((...args) =>
      String(args[0]) === `/proc/${process.pid}/stat`
        ? Promise.reject(new Error("inaccessible"))
        : originalRead(...args),
    );
    expect(await inspectLockOwner(identity)).toBe("unknown");
    expect(await captureLockOwnerIdentity()).toEqual({});
  },
);

it.skipIf(process.platform !== "linux")(
  "allows exactly one early-recovery owner and retains audit provenance",
  async () => {
    await withTempDir("pm-dead-lock-", async (root) => {
      vi.stubEnv("PM_LOCK_WAIT_MS", "0");
      const oldRelease = await acquireLock(root, "shared", 3600, "old-owner");
      const lockPath = path.join(root, "locks/shared.lock");
      const receipt = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<
        string,
        unknown
      >;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ ...receipt, process_start_identity: "0" }),
      );
      const contenders = await Promise.allSettled([
        acquireLock(root, "shared", 3600, "first"),
        acquireLock(root, "shared", 3600, "second"),
      ]);
      const winners = contenders.filter(
        (outcome) => outcome.status === "fulfilled",
      );
      expect(winners).toHaveLength(1);
      expect(
        contenders.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(1);
      await oldRelease();
      expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
        owner: expect.stringMatching(/first|second/),
      });
      for (const winner of winners) await winner.value();
      const audits = await fs.readdir(path.join(root, "locks/recoveries"));
      expect(audits).toHaveLength(1);
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "GC and health share dead-owner proof, and GC records the prior owner",
  async () => {
    await withTempDir("pm-dead-lock-gc-", async (root) => {
      const release = await acquireLock(root, "shared", 3600, "original");
      const lockPath = path.join(root, "locks/shared.lock");
      expect(await scanLockHealth(root)).toMatchObject({
        active_lock_count: 1,
        stale_lock_count: 0,
      });
      expect((await runLockGc(root, { dryRun: true })).entries).toMatchObject([
        { owner_state: "alive", stale: false },
      ]);
      const receipt = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<
        string,
        unknown
      >;
      await fs.writeFile(
        lockPath,
        JSON.stringify({ ...receipt, process_start_identity: "0" }),
      );
      expect(await scanLockHealth(root)).toMatchObject({
        stale_lock_count: 1,
        active_lock_count: 0,
      });
      expect((await runLockGc(root, { dryRun: true })).entries).toMatchObject([
        { owner: "original", reason: "owner_dead", pid: process.pid },
      ]);
      expect((await runLockGc(root, { dryRun: false })).removed).toEqual([
        "locks/shared.lock",
      ]);
      await release();
      const audits = await fs.readdir(path.join(root, "locks/recoveries"));
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(root, "locks/recoveries", audits[0]!),
            "utf8",
          ),
        ),
      ).toMatchObject({ lock: { owner: "original" } });
    });
  },
);

it("GC retains a receipt replaced after its observation and a lock whose publication gate is busy", async () => {
  await withTempDir("pm-lock-gc-revalidation-", async (root) => {
    const locks = path.join(root, "locks");
    await fs.mkdir(locks);
    const lockPath = path.join(locks, "shared.lock");
    const stale = JSON.stringify({
      id: "shared",
      owner: "old",
      created_at: "2000-01-01",
      ttl_seconds: 3600,
    });
    const fresh = JSON.stringify({
      id: "shared",
      owner: "new",
      created_at: new Date().toISOString(),
      ttl_seconds: 3600,
    });
    await fs.writeFile(lockPath, stale);
    const originalRead = fs.readFile.bind(fs);
    let replaced = false;
    const read = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args) => {
        if (args[0] === lockPath && !replaced) {
          replaced = true;
          await fs.writeFile(lockPath, fresh);
          return stale;
        }
        return originalRead(...args);
      });
    expect((await runLockGc(root, { dryRun: false })).retained).toEqual([
      "locks/shared.lock",
    ]);
    expect(await fs.readFile(lockPath, "utf8")).toBe(fresh);
    read.mockRestore();
    await fs.writeFile(lockPath, stale);
    await fs.mkdir(`${lockPath}.stale-cleanup`);
    expect((await runLockGc(root, { dryRun: false })).warnings).toContain(
      "lock_changed_or_busy:shared.lock",
    );
    expect(await fs.readFile(lockPath, "utf8")).toBe(stale);
  });
});

it.skipIf(process.platform !== "linux")(
  "keeps malformed timestamps behind explicit stale-lock policy even with matching process coordinates",
  async () => {
    await withTempDir("pm-invalid-lock-time-", async (root) => {
      const release = await acquireLock(root, "shared", 3600, "original");
      const lockPath = path.join(root, "locks/shared.lock");
      const receipt = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<
        string,
        unknown
      >;
      const malformed = JSON.stringify({
        ...receipt,
        process_start_identity: "0",
        created_at: "invalid",
      });
      await fs.writeFile(lockPath, malformed);
      await expect(acquireLock(root, "shared", 3600, "next")).rejects.toThrow(
        "lock is stale",
      );
      expect((await runLockGc(root, { dryRun: false })).retained).toEqual([
        "locks/shared.lock",
      ]);
      expect(await fs.readFile(lockPath, "utf8")).toBe(malformed);
      await release();
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "caps dead-owner health samples while counting the complete lock population",
  async () => {
    await withTempDir("pm-lock-health-samples-", async (root) => {
      const locks = path.join(root, "locks");
      await fs.mkdir(locks);
      const identity = await captureLockOwnerIdentity();
      for (let index = 0; index < 21; index += 1) {
        const id = `dead-${index}`;
        await fs.writeFile(
          path.join(locks, `${id}.lock`),
          JSON.stringify({
            ...identity,
            id,
            pid: process.pid,
            process_start_identity: "0",
            owner: "prior",
            created_at: new Date().toISOString(),
            ttl_seconds: 3600,
          }),
        );
      }
      const health = await scanLockHealth(root);
      expect(health.stale_lock_count).toBe(21);
      expect(health.owner_dead_lock_samples).toHaveLength(20);
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "retains the observed dead-owner lock when its recovery audit cannot be written",
  async () => {
    await withTempDir("pm-lock-audit-failure-", async (root) => {
      const release = await acquireLock(root, "shared", 3600, "original");
      const lockPath = path.join(root, "locks/shared.lock");
      const receipt = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<
        string,
        unknown
      >;
      const dead = JSON.stringify({ ...receipt, process_start_identity: "0" });
      await fs.writeFile(lockPath, dead);
      const write = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation((...args) =>
        String(args[0]).includes(`${path.sep}recoveries${path.sep}`)
          ? Promise.reject(
              Object.assign(new Error("Audit denied"), { code: "EACCES" }),
            )
          : write(...args),
      );
      await expect(acquireLock(root, "shared", 3600, "next")).rejects.toThrow(
        "Audit denied",
      );
      expect((await runLockGc(root, { dryRun: false })).retained).toEqual([
        "locks/shared.lock",
      ]);
      expect(await fs.readFile(lockPath, "utf8")).toBe(dead);
      await release();
    });
  },
);
