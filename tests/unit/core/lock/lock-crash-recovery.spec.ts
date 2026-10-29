import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireLockLease,
  acquireStaleCleanupGate,
} from "../../../../src/core/lock/lock.js";
import * as lockOwner from "../../../../src/core/lock/lock-owner.js";
import { getLockPath } from "../../../../src/core/store/paths.js";
import { withTempDir } from "../../../helpers/temp.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("preserves a replacement when an aged unverifiable owner releases its gate", async () => {
  await withTempDir("pm-gate-release-race-", async (root) => {
    const lockPath = getLockPath(root, "shared");
    const gatePath = `${lockPath}.stale-cleanup`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    vi.spyOn(lockOwner, "captureProcessIdentity").mockResolvedValue({ pid: process.pid });
    const releaseOriginal = await acquireStaleCleanupGate(lockPath, "shared");
    expect(releaseOriginal).not.toBeNull();
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(gatePath, old, old);
    const rename = fs.rename.bind(fs);
    let observed!: () => void;
    const retirementObserved = new Promise<void>((resolve) => { observed = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (args[0] === gatePath) {
        observed();
        await resumed;
      }
      return rename(...args);
    });
    const recovering = acquireStaleCleanupGate(lockPath, "shared");
    let replacement: (() => Promise<void>) | null = null;
    let recovered: (() => Promise<void>) | null = null;
    try {
      // A safe refusal finishes immediately; the old implementation pauses
      // after token revalidation so a real release and replacement can win.
      await Promise.race([recovering, retirementObserved]);
      await releaseOriginal!();
      replacement = await acquireStaleCleanupGate(lockPath, "shared");
      expect(replacement).not.toBeNull();
      const replacementOwner = await fs.readFile(path.join(gatePath, "owner.json"), "utf8");
      resume();
      recovered = await recovering;
      expect(recovered).toBeNull();
      expect(await fs.readFile(path.join(gatePath, "owner.json"), "utf8")).toBe(replacementOwner);
    } finally {
      resume();
      recovered ??= await recovering;
      await recovered?.();
      await replacement?.();
      await releaseOriginal?.();
    }
  });
});

it.skipIf(process.platform !== "linux")("retains an aged foreign gate despite a different local PID identity", async () => {
  await withTempDir("pm-gate-foreign-aged-", async (root) => {
    const { lockPath, gatePath } = await deadGate(root);
    const receipt = JSON.stringify({
      pid: process.pid, process_start_identity: "0", host_identity: "foreign-host", token: "foreign-owner",
    });
    await fs.writeFile(path.join(gatePath, "owner.json"), receipt);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(gatePath, old, old);
    expect(await acquireStaleCleanupGate(lockPath, "shared")).toBeNull();
    expect(await fs.readFile(path.join(gatePath, "owner.json"), "utf8")).toBe(receipt);
  });
});

it.skipIf(process.platform !== "linux")(
  "refuses an uncertain owner while a proven-dead recoverer waits to retire it",
  async () => {
    await withTempDir("pm-gate-mixed-recovery-", async (root) => {
      const { lockPath, gatePath, receipt } = await deadGate(root);
      const old = new Date(Date.now() - 120_000);
      await fs.utimes(gatePath, old, old);
      vi.spyOn(lockOwner, "inspectLockOwner")
        .mockResolvedValueOnce("dead")
        .mockResolvedValue("unknown");
      const rename = fs.rename.bind(fs);
      let observed!: () => void;
      const firstObserved = new Promise<void>((resolve) => { observed = resolve; });
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => { resume = resolve; });
      let arrived = 0;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (args[0] === gatePath && ++arrived === 1) {
          observed();
          await resumed;
        }
        return rename(...args);
      });
      const first = acquireStaleCleanupGate(lockPath, "shared");
      await firstObserved;
      const results = await Promise.all([
        first, acquireStaleCleanupGate(lockPath, "shared").finally(resume),
      ]);
      const second = results[1];
      const held = results.filter((release) => release !== null);
      try {
        expect(held).toHaveLength(1);
        expect(second).toBeNull();
        expect(arrived).toBe(1);
        const entries = await fs.readdir(path.join(root, "locks", "recoveries"));
        expect(entries).toHaveLength(1);
        expect(await fs.readFile(path.join(root, "locks", "recoveries", entries[0]!, "owner.json"), "utf8")).toBe(receipt);
        expect(JSON.parse(await fs.readFile(path.join(gatePath, "owner.json"), "utf8")).token).not.toBe("dead-generation");
      } finally {
        for (const release of held) await release();
      }
    });
  },
);

/** Publish a fresh gate with verifiable local PID-reuse evidence. */
async function deadGate(root: string) {
  const lockPath = getLockPath(root, "shared");
  const gatePath = `${lockPath}.stale-cleanup`;
  await fs.mkdir(gatePath, { recursive: true });
  const receipt = JSON.stringify({
    ...(await lockOwner.captureLockOwnerIdentity()),
    pid: process.pid,
    process_start_identity: "0",
    token: "dead-generation",
  });
  await fs.writeFile(path.join(gatePath, "owner.json"), receipt);
  return { lockPath, gatePath, receipt };
}

it.skipIf(process.platform !== "linux")(
  "retires a proven dead gate once while two recoverers race a replacement owner",
  async () => {
    await withTempDir("pm-gate-race-", async (root) => {
      const { lockPath, gatePath, receipt } = await deadGate(root);
      const rename = fs.rename.bind(fs);
      const writeFile = fs.writeFile.bind(fs);
      let published!: () => void;
      const replacementPublished = new Promise<void>((resolve) => {
        published = resolve;
      });
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const result = await writeFile(...args);
        if (args[0] === path.join(gatePath, "owner.json")) published();
        return result;
      });
      let arrived = 0;
      let resume!: () => void;
      const bothObserved = new Promise<void>((resolve) => {
        resume = resolve;
      });
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (args[0] === gatePath) {
          const ordinal = ++arrived;
          if (ordinal === 2) resume();
          await bothObserved;
          if (ordinal === 2) await replacementPublished;
        }
        return rename(...args);
      });
      const results = await Promise.all([
        acquireStaleCleanupGate(lockPath, "shared"),
        acquireStaleCleanupGate(lockPath, "shared"),
      ]);
      expect(arrived).toBe(2);
      const held = results.filter((release) => release !== null);
      expect(held).toHaveLength(1);
      const entries = await fs.readdir(path.join(root, "locks", "recoveries"));
      expect(entries).toHaveLength(1);
      expect(
        await fs.readFile(
          path.join(root, "locks", "recoveries", entries[0]!, "owner.json"),
          "utf8",
        ),
      ).toBe(receipt);
      expect(
        JSON.parse(await fs.readFile(path.join(gatePath, "owner.json"), "utf8"))
          .token,
      ).not.toBe("dead-generation");
      await held[0]!();
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "leaves a dead gate untouched when its recovery evidence cannot be persisted",
  async () => {
    await withTempDir("pm-gate-evidence-", async (root) => {
      const { lockPath, gatePath, receipt } = await deadGate(root);
      await fs.writeFile(path.join(root, "locks", "recoveries"), "occupied");
      expect(await acquireStaleCleanupGate(lockPath, "shared")).toBeNull();
      expect(await fs.readFile(path.join(gatePath, "owner.json"), "utf8")).toBe(
        receipt,
      );
    });
  },
);

it.each(["live", "foreign", "legacy"])(
  "retains a fresh %s gate without proven original-owner death",
  async (kind) => {
    await withTempDir("pm-gate-retain-", async (root) => {
      const { lockPath, gatePath } = await deadGate(root);
      const identity = await lockOwner.captureLockOwnerIdentity();
      const receipt = JSON.stringify({
        ...(kind === "legacy" ? {} : identity),
        pid: process.pid,
        token: "protected",
        ...(kind === "foreign"
          ? { host_identity: "another-host", process_start_identity: "0" }
          : {}),
      });
      await fs.writeFile(path.join(gatePath, "owner.json"), receipt);
      expect(await acquireStaleCleanupGate(lockPath, "shared")).toBeNull();
      expect(await fs.readFile(path.join(gatePath, "owner.json"), "utf8")).toBe(
        receipt,
      );
    });
  },
);

it("bounds acquisition on a frozen wall clock and preserves the live holder", async () => {
  await withTempDir("pm-lock-monotonic-", async (root) => {
    vi.stubEnv("PM_LOCK_WAIT_MS", "");
    const lease = await acquireLockLease(root, "shared", 60, "holder");
    const lockPath = getLockPath(root, "shared");
    const before = await fs.readFile(lockPath, "utf8");
    const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    // Restore the clock even against the old implementation so regression failure
    // settles the pending writer instead of leaking it past fixture cleanup.
    const watchdog = setTimeout(() => frozen.mockRestore(), 1_500);
    const started = performance.now();
    try {
      await expect(
        acquireLockLease(root, "shared", 60, "waiter", false, false, 100),
      ).rejects.toMatchObject({ code: "lock_conflict" });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(await fs.readFile(lockPath, "utf8")).toBe(before);
    } finally {
      clearTimeout(watchdog);
      frozen.mockRestore();
      await lease.release();
    }
  });
});

it.skipIf(process.platform !== "linux").each(["replacement", "removed"])(
  "does not retire a gate %s after the dead-owner observation",
  async (change) => {
    await withTempDir("pm-gate-replaced-", async (root) => {
      const { lockPath, gatePath } = await deadGate(root);
      const mkdir = fs.mkdir.bind(fs);
      const replacement = JSON.stringify({
        ...(await lockOwner.captureLockOwnerIdentity()),
        pid: process.pid,
        token: "live-replacement",
      });
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (args[0] === path.join(root, "locks", "recoveries")) {
          await fs.rm(gatePath, { recursive: true });
          if (change === "replacement") {
            await mkdir(gatePath);
            await fs.writeFile(path.join(gatePath, "owner.json"), replacement);
          }
        }
        return mkdir(...args);
      });
      expect(await acquireStaleCleanupGate(lockPath, "shared")).toBeNull();
      if (change === "replacement")
        expect(
          await fs.readFile(path.join(gatePath, "owner.json"), "utf8"),
        ).toBe(replacement);
      else
        await expect(fs.stat(gatePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
    });
  },
);

it.each(["EACCES", "EBUSY"])(
  "releases its gate after a transient owner read failure: %s",
  async (code) => {
    await withTempDir("pm-gate-release-retry-", async (root) => {
      const lockPath = getLockPath(root, "shared");
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const release = await acquireStaleCleanupGate(lockPath, "shared");
      expect(release).not.toBeNull();
      const gatePath = `${lockPath}.stale-cleanup`;
      const ownerPath = path.join(gatePath, "owner.json");
      const readFile = fs.readFile.bind(fs);
      let transientFailure = true;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (args[0] === ownerPath && transientFailure) {
          transientFailure = false;
          throw Object.assign(new Error("Owner temporarily unreadable"), { code });
        }
        return readFile(...args);
      });
      await release!();
      await expect(fs.stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
      const nextRelease = await acquireStaleCleanupGate(lockPath, "shared");
      expect(nextRelease).not.toBeNull();
      await nextRelease!();
    });
  },
);

it.each(["EACCES", "EBUSY"])(
  "retains an unreadable live gate during recovery and release: %s",
  async (code) => {
    await withTempDir("pm-gate-unreadable-", async (root) => {
      const lockPath = getLockPath(root, "shared");
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const release = await acquireStaleCleanupGate(lockPath, "shared");
      expect(release).not.toBeNull();
      const gatePath = `${lockPath}.stale-cleanup`;
      const ownerPath = path.join(gatePath, "owner.json");
      const before = await fs.readFile(ownerPath, "utf8");
      const old = new Date(Date.now() - 120_000);
      await fs.utimes(gatePath, old, old);
      const readFile = fs.readFile.bind(fs);
      const fault = vi
        .spyOn(fs, "readFile")
        .mockImplementation(async (...args) => {
          if (args[0] === ownerPath)
            throw Object.assign(new Error("Owner temporarily unreadable"), {
              code,
            });
          return readFile(...args);
        });
      try {
        expect(await acquireStaleCleanupGate(lockPath, "shared")).toBeNull();
        await release!();
        expect(await readFile(ownerPath, "utf8")).toBe(before);
      } finally {
        fault.mockRestore();
        await release!();
      }
      await expect(fs.stat(gatePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
