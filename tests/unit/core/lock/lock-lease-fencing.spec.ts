import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveExtensionHooks,
  setActiveExtensionServices,
} from "../../../../src/core/extensions/index.js";
import {
  _testOnly as lockTestOnly,
  acquireLockLease,
  captureProcessIdentity,
} from "../../../../src/core/lock/lock.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { getHistoryPath, getLockPath } from "../../../../src/core/store/paths.js";
import { locateItem, mutateItem } from "../../../../src/core/store/item-store.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { distCliPath } from "../../../helpers/cliRunner.js";
import { withTempDir } from "../../../helpers/temp.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import type { TempPmContext } from "../../../helpers/withTempPmPath.js";

afterEach(() => {
  clearActiveExtensionHooks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createTask(context: TempPmContext, title: string): string {
  const result = context.runCli(["create", "--title", title, "--type", "Task", "--json"], { expectJson: true });
  expect(result.code, result.stderr).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

async function shortLeaseSettings(pmRoot: string) {
  const settings = await readSettings(pmRoot);
  settings.locks.ttl_seconds = 1;
  settings.governance.force_required_for_stale_lock = false;
  return settings;
}

async function readItemRaw(pmRoot: string, id: string): Promise<string> {
  const located = await locateItem(pmRoot, id, "pm-", "toon");
  if (!located) throw new Error(`missing ${id}`);
  return fs.readFile(located.itemPath, "utf8");
}

/**
 * Publish a fresh lock generation for `id` without going through acquisition.
 * Rename keeps the swap atomic, so a waiter never reads an empty lock file and
 * mistakes it for a reclaimable stale lock.
 */
async function publishGeneration(pmRoot: string, id: string, owner: string): Promise<void> {
  const payload = await lockTestOnly.buildLockPayload(id, owner, 60);
  const lockPath = getLockPath(pmRoot, id);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const tempPath = `${lockPath}.${payload.token}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.rename(tempPath, lockPath);
}

describe("lock lease fencing (GH-1549)", () => {
  it("refuses a stale commit after its expired lease is taken over and runs nothing", async () => {
    await withTempDir("pm-lease-takeover-", async (root) => {
      const stale = await acquireLockLease(root, "shared", 1, "stale-writer", false, false, 0);
      await sleep(1_150);
      const newer = await acquireLockLease(root, "shared", 1, "newer-writer", false, false, 0);
      const commit = vi.fn(async () => "written");
      await expect(stale.fence(commit)).rejects.toMatchObject({
        exitCode: EXIT_CODE.CONFLICT,
        code: "lock_lost",
        context: {
          reason: "lease_taken_over",
          lease: { owner: "stale-writer", ttl_seconds: 1 },
          current_owner: { owner: "newer-writer", pid: process.pid },
        },
      });
      expect(commit).not.toHaveBeenCalled();
      await expect(newer.fence(async () => "written")).resolves.toBe("written");
      await stale.release();
      // The stale writer's release must not remove the newer owner's lock.
      await expect(fs.stat(getLockPath(root, "shared"))).resolves.toBeDefined();
      await newer.release();
    });
  });

  it("refuses a commit whose lease was already released", async () => {
    await withTempDir("pm-lease-released-", async (root) => {
      const lease = await acquireLockLease(root, "shared", 60, "writer", false, false, 0);
      await fs.rm(getLockPath(root, "shared"));
      await expect(lease.fence(async () => "written")).rejects.toMatchObject({
        code: "lock_lost",
        context: { reason: "lease_released", current_owner: null },
      });
    });
  });

  it("waits for a contended commit gate and then commits", async () => {
    await withTempDir("pm-lease-gate-wait-", async (root) => {
      const lease = await acquireLockLease(root, "shared", 60, "writer", false, false, 0);
      const gatePath = `${getLockPath(root, "shared")}.stale-cleanup`;
      await fs.mkdir(gatePath);
      setTimeout(() => void fs.rm(gatePath, { recursive: true, force: true }), 150);
      await expect(lease.fence(async () => "written")).resolves.toBe("written");
      await lease.release();
    });
  });

  it("refuses with fence_gate_unavailable when the commit gate never frees", async () => {
    await withTempDir("pm-lease-gate-stuck-", async (root) => {
      const lease = await acquireLockLease(root, "shared", 60, "writer", false, false, 0);
      const gatePath = `${getLockPath(root, "shared")}.stale-cleanup`;
      await fs.mkdir(gatePath);
      // A live owner keeps the gate from being reclaimed as expired.
      await fs.writeFile(
        path.join(gatePath, "owner.json"),
        `${JSON.stringify({ ...(await captureProcessIdentity()), token: "live-gate-owner" })}\n`,
        "utf8",
      );
      const realNow = Date.now.bind(Date);
      let calls = 0;
      // Jump past the bounded gate wait after the first observation.
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + (calls++ === 0 ? 0 : 60_000));
      const commit = vi.fn(async () => "written");
      await expect(lease.fence(commit)).rejects.toMatchObject({
        code: "lock_lost",
        context: { reason: "fence_gate_unavailable", current_owner: { owner: "writer" } },
      });
      expect(commit).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await fs.rm(gatePath, { recursive: true, force: true });
      await lease.release();
    });
  });

  it("runs the commit unfenced when an extension owns the lock lifecycle", async () => {
    await withTempDir("pm-lease-override-", async (root) => {
      let released = false;
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "lock-acquire-override",
            service: "lock_acquire",
            run: () => () => {
              released = true;
            },
          },
        ],
      });
      const lease = await acquireLockLease(root, "shared", 60, "writer", false, false, 0);
      await expect(lease.fence(async () => "written")).resolves.toBe("written");
      await lease.release();
      expect(released).toBe(true);
      await expect(fs.stat(getLockPath(root, "shared"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("keeps the newer SDK write when a mutation callback outlives its lease", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Baseline");
      const settings = await shortLeaseSettings(context.pmPath);
      const stale = mutateItem({
        pmRoot: context.pmPath,
        settings,
        id,
        op: "update",
        author: "stale-writer",
        async mutate(document) {
          document.metadata.title = "Stale overwrite";
          await sleep(1_150);
          await mutateItem({
            pmRoot: context.pmPath,
            settings,
            id,
            op: "update",
            author: "newer-writer",
            mutate(newerDocument) {
              newerDocument.metadata.title = "Newer protected value";
              return { changedFields: ["title"] };
            },
          });
          return { changedFields: ["title"] };
        },
      });
      await expect(stale).rejects.toMatchObject({ exitCode: EXIT_CODE.CONFLICT, code: "lock_lost" });
      const raw = await readItemRaw(context.pmPath, id);
      expect(raw).toContain("Newer protected value");
      expect(raw).not.toContain("Stale overwrite");
      const history = await fs.readFile(getHistoryPath(context.pmPath, id), "utf8");
      expect(history).not.toContain("stale-writer");
      expect(history).toContain("newer-writer");
    });
  });

  it("refuses with stale_revision when the item changed under a still-held lease", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Baseline");
      const settings = await readSettings(context.pmPath);
      const located = await locateItem(context.pmPath, id, "pm-", "toon");
      if (!located) throw new Error("missing fixture");
      let edited = "";
      await expect(
        mutateItem({
          pmRoot: context.pmPath,
          settings,
          id,
          op: "update",
          author: "writer",
          async mutate(document) {
            const raw = await fs.readFile(located.itemPath, "utf8");
            edited = raw.replace("Baseline", "Unlocked edit");
            await fs.writeFile(located.itemPath, edited, "utf8");
            document.metadata.title = "Locked overwrite";
            return { changedFields: ["title"] };
          },
        }),
      ).rejects.toMatchObject({
        code: "stale_revision",
        context: { item_id: id, reason: "item_revision_changed" },
      });
      expect(await fs.readFile(located.itemPath, "utf8")).toBe(edited);
    });
  });
});

describe("item commit revision fence", () => {
  it("refuses with item_removed when the item file disappeared under the lease", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Baseline");
      const settings = await readSettings(context.pmPath);
      const located = await locateItem(context.pmPath, id, "pm-", "toon");
      if (!located) throw new Error("missing fixture");
      await expect(
        mutateItem({
          pmRoot: context.pmPath,
          settings,
          id,
          op: "update",
          author: "writer",
          async mutate(document) {
            await fs.rm(located.itemPath);
            document.metadata.title = "Resurrected";
            return { changedFields: ["title"] };
          },
        }),
      ).rejects.toMatchObject({ code: "stale_revision", context: { reason: "item_removed" } });
      await expect(fs.stat(located.itemPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("propagates an unreadable item at commit time without writing", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "Baseline");
      const settings = await readSettings(context.pmPath);
      const located = await locateItem(context.pmPath, id, "pm-", "toon");
      if (!located) throw new Error("missing fixture");
      const before = await fs.readFile(located.itemPath, "utf8");
      const realReadFile = fs.readFile.bind(fs);
      let armed = false;
      vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        if (armed && args[0] === located.itemPath) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realReadFile(...args);
      }) as typeof fs.readFile);
      await expect(
        mutateItem({
          pmRoot: context.pmPath,
          settings,
          id,
          op: "update",
          author: "writer",
          mutate(document) {
            armed = true;
            document.metadata.title = "Unwritten";
            return { changedFields: ["title"] };
          },
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
      vi.restoreAllMocks();
      expect(await fs.readFile(located.itemPath, "utf8")).toBe(before);
    });
  });
});

describe("progress-aware lock waiting (GH-1516)", () => {
  it("keeps waiting while the lock changes hands and acquires once it is free", async () => {
    await withTempDir("pm-lock-progress-", async (root) => {
      vi.stubEnv("PM_LOCK_WAIT_MS", "");
      await publishGeneration(root, "shared", "writer-0");
      const handoffs = (async () => {
        for (let index = 1; index <= 16; index += 1) {
          await sleep(120);
          await publishGeneration(root, "shared", `writer-${index}`);
        }
        await sleep(120);
        await fs.rm(getLockPath(root, "shared"));
      })();
      const startedAt = Date.now();
      // The 1 s window tolerates event-loop stalls between handoffs yet is far
      // shorter than the ~2 s queue, so a fixed deadline would refuse; each
      // observed handoff restarts the window.
      const lease = await acquireLockLease(root, "shared", 60, "waiter", false, false, 1_000, { waitPolicy: "progress" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_800);
      await handoffs;
      await lease.release();
    });
  });

  it("refuses after the window when the same owner makes no progress", async () => {
    await withTempDir("pm-lock-stalled-", async (root) => {
      vi.stubEnv("PM_LOCK_WAIT_MS", "");
      const holder = await acquireLockLease(root, "shared", 60, "holder", false, false, 0);
      try {
        const error = await acquireLockLease(root, "shared", 60, "waiter", false, false, 200, { waitPolicy: "progress" }).catch(
          (caught: unknown) => caught,
        );
        expect(error).toMatchObject({
          code: "lock_conflict",
          context: { recovery: { owner_handoffs: 0 } },
        });
        const waited = (error as { context: { recovery: { waited_ms: number } } }).context.recovery.waited_ms;
        expect(waited).toBeGreaterThanOrEqual(200);
        expect(waited).toBeLessThan(10_000);
      } finally {
        await holder.release();
      }
    });
  });

  it("honours an explicit maxWaitMs ceiling even while owners keep changing", async () => {
    await withTempDir("pm-lock-ceiling-", async (root) => {
      vi.stubEnv("PM_LOCK_WAIT_MS", "");
      await publishGeneration(root, "shared", "writer-0");
      let running = true;
      const handoffs = (async () => {
        for (let index = 1; running; index += 1) {
          await sleep(60);
          await publishGeneration(root, "shared", `writer-${index}`);
        }
      })();
      try {
        const error = await acquireLockLease(root, "shared", 60, "waiter", false, false, 200, { maxWaitMs: 400, waitPolicy: "progress" }).catch(
          (caught: unknown) => caught,
        );
        expect(error).toMatchObject({ code: "lock_conflict" });
        const recovery = (error as { context: { recovery: { waited_ms: number; owner_handoffs: number } } }).context.recovery;
        expect(recovery.owner_handoffs).toBeGreaterThan(0);
        expect(recovery.waited_ms).toBeLessThan(10_000);
      } finally {
        running = false;
        await handoffs;
      }
    });
  });

  it("keeps a fixed total budget by default even while owners keep changing", async () => {
    await withTempDir("pm-lock-total-", async (root) => {
      vi.stubEnv("PM_LOCK_WAIT_MS", "");
      await publishGeneration(root, "shared", "writer-0");
      let running = true;
      const handoffs = (async () => {
        for (let index = 1; running; index += 1) {
          await sleep(60);
          await publishGeneration(root, "shared", `writer-${index}`);
        }
      })();
      try {
        const error = await acquireLockLease(root, "shared", 60, "waiter", false, false, 300).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: "lock_conflict" });
        expect((error as { context: { recovery: { owner_handoffs: number } } }).context.recovery.owner_handoffs).toBeGreaterThan(0);
      } finally {
        running = false;
        await handoffs;
      }
    });
  });

  it("derives a stable generation key from the token, legacy identity or absence", () => {
    expect(lockTestOnly.lockGenerationKey(null)).toBe("released");
    const legacy = { id: "x", pid: 7, owner: "o", created_at: "t", ttl_seconds: 1 };
    expect(lockTestOnly.lockGenerationKey(legacy)).toBe("7:o:t");
    expect(lockTestOnly.lockGenerationKey({ ...legacy, token: "abc" })).toBe("abc");
  });
});

describe("concurrent writers on one plain-directory tracker (GH-1516 conformance)", () => {
  it("loses no appends or parented creates while the queue outlasts the wait window", async () => {
    await withTempPmPath(async (context) => {
      const parent = createTask(context, "Shared goal");
      const writers = 10;
      // A window far shorter than the queue: a fixed total deadline refuses most
      // writers here, while handoff-aware waiting lets the whole queue drain.
      const env = { ...context.env, PM_LOCK_WAIT_MS: "1000" };
      const run = (args: string[]) =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, [distCliPath(), ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
          child.on("close", (code) => resolve({ code, stderr }));
        });
      const results = await Promise.all(
        Array.from({ length: writers }, (_, index) => [
          run(["comments", parent, "--add", `progress from agent ${index}`]),
          run(["create", "--title", `Agent ${index} subtask`, "--type", "Task", "--parent", parent]),
        ]).flat(),
      );
      const failures = results.filter((result) => result.code !== 0);
      expect(failures.map((failure) => failure.stderr.slice(0, 300))).toEqual([]);
      const parentRaw = await readItemRaw(context.pmPath, parent);
      for (let index = 0; index < writers; index += 1) {
        expect(parentRaw).toContain(`progress from agent ${index}`);
      }
      const children = context.runCli(["list", "--parent", parent, "--json", "--limit", "100"], { expectJson: true });
      expect((children.json as { items: unknown[] }).items).toHaveLength(writers);
    });
  }, 180_000);
});
