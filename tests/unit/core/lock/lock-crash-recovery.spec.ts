import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireLockLease,
  acquireStaleCleanupGate,
} from "../../../../src/core/lock/lock.js";
import { captureLockOwnerIdentity } from "../../../../src/core/lock/lock-owner.js";
import { getLockPath } from "../../../../src/core/store/paths.js";
import { withTempDir } from "../../../helpers/temp.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Publish a fresh gate with verifiable local PID-reuse evidence. */
async function deadGate(root: string) {
  const lockPath = getLockPath(root, "shared");
  const gatePath = `${lockPath}.stale-cleanup`;
  await fs.mkdir(gatePath, { recursive: true });
  const receipt = JSON.stringify({
    ...(await captureLockOwnerIdentity()),
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
      let arrived = 0;
      let resume!: () => void;
      const bothObserved = new Promise<void>((resolve) => {
        resume = resolve;
      });
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (args[0] === gatePath) {
          if (++arrived === 2) resume();
          await bothObserved;
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
      const identity = await captureLockOwnerIdentity();
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
