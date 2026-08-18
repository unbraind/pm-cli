import {
  access,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_SCHEMA,
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  inspectWorkspaceSnapshot,
  listWorkspaceSnapshots,
  planWorkspaceSnapshotRestore,
  restoreWorkspaceSnapshot,
  restoreWorkspaceSnapshotWithRecovery,
} from "../../../src/sdk/index.js";
import {
  _testOnlyWorkspaceSnapshot,
  publishWorkspaceSnapshotObject,
  swapWorkspaceSnapshotRoot,
} from "../../../src/sdk/workspace-snapshot.js";
import { acquireLock } from "../../../src/core/lock/lock.js";
import { getLockPath } from "../../../src/core/store/paths.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("workspace snapshots", () => {
  it("lists an empty store and rejects symbolic links in authoritative state", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      expect(await listWorkspaceSnapshots(pmPath)).toEqual({
        objects: [],
        references: [],
      });
      await symlink(
        path.join(pmPath, "settings.json"),
        path.join(pmPath, "linked-settings.json"),
      );
      await expect(createWorkspaceSnapshot(pmPath)).rejects.toThrow(
        "reject symbolic links",
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects non-file filesystem entries in authoritative state",
    async () => {
      await withTempPmPath(async ({ pmPath }) => {
        const socketPath = path.join(pmPath, "local.socket");
        const server = createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
          });
          await expect(createWorkspaceSnapshot(pmPath)).rejects.toThrow(
            "unsupported filesystem entries",
          );
        } finally {
          if (server.listening) {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error === undefined) {
                  resolve();
                } else {
                  reject(error);
                }
              });
            });
          }
        }
      });
    },
  );

  it("deduplicates authoritative state and excludes clone-local runtime data", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await mkdir(path.join(pmPath, "search"), { recursive: true });
      await writeFile(
        path.join(pmPath, "search", "index.json"),
        "cache",
        "utf8",
      );
      const first = await createWorkspaceSnapshot(pmPath, { name: "baseline" });
      const second = await createWorkspaceSnapshot(pmPath);

      expect(second.manifest.fingerprint).toBe(first.manifest.fingerprint);
      expect(first.manifest.schema).toBe(SNAPSHOT_SCHEMA);
      expect(second.deduplicated).toBe(true);
      expect(first.manifest.files).not.toContain("search/index.json");
      expect(await inspectWorkspaceSnapshot(pmPath, "baseline")).toEqual(
        first.manifest,
      );
      const listed = await listWorkspaceSnapshots(pmPath);
      expect(listed.objects).toEqual([first.manifest]);
      expect(listed.references).toEqual([
        { name: "baseline", fingerprint: first.manifest.fingerprint },
      ]);
    });
  });

  it("atomically restores authoritative files without reviving caches or locks", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settingsPath = path.join(pmPath, "settings.json");
      const originalSettings = await readFile(settingsPath);
      await createWorkspaceSnapshot(pmPath, { name: "clean" });
      await writeFile(settingsPath, '{"changed":true}\n', "utf8");
      await mkdir(path.join(pmPath, "locks"), { recursive: true });
      await writeFile(
        path.join(pmPath, "locks", "stale.lock"),
        "stale",
        "utf8",
      );

      const restored = await restoreWorkspaceSnapshotWithRecovery(
        pmPath,
        "clean",
        {
          force: true,
          author: "snapshot-test",
        },
      );
      expect(await readFile(settingsPath)).toEqual(originalSettings);
      await expect(
        access(path.join(pmPath, "locks", "stale.lock")),
      ).rejects.toThrow();
      expect(
        await inspectWorkspaceSnapshot(pmPath, restored.manifest.fingerprint),
      ).toEqual(restored.manifest);
      expect(restored.recovery_fingerprint).not.toBe(
        restored.manifest.fingerprint,
      );
      expect(restored.audit_operation).toBe("workspace_snapshot_restore");
      expect(restored.audit_history_path).toBe("history/_workspace.jsonl");
    });
  });

  it("plans history loss, requires confirmation, and restores the recovery snapshot", async () => {
    await withTempPmPath(async (context) => {
      await createWorkspaceSnapshot(context.pmPath, { name: "baseline" });
      const created = await context.runCliInProcess(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Post-snapshot work",
          "--type",
          "Task",
          "--status",
          "open",
          "--json",
        ],
        { expectJson: true },
      );
      const itemId = (created.json as { item: { id: string } }).item.id;
      const secondCreated = await context.runCliInProcess(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Second post-snapshot work",
          "--type",
          "Task",
          "--status",
          "open",
          "--json",
        ],
        { expectJson: true },
      );
      const secondItemId = (secondCreated.json as { item: { id: string } }).item
        .id;
      const plan = await planWorkspaceSnapshotRestore(
        context.pmPath,
        "baseline",
      );
      expect(plan).toMatchObject({
        removed_item_count: 2,
        affected_history_stream_count: 2,
        removed_history_entry_count: 2,
        changes_authoritative_state: true,
      });
      expect(plan.affected_history_streams.map((entry) => entry.path)).toEqual(
        [`history/${itemId}.jsonl`, `history/${secondItemId}.jsonl`].sort(),
      );
      await expect(
        restoreWorkspaceSnapshotWithRecovery(context.pmPath, "baseline"),
      ).rejects.toThrow("requires explicit force confirmation");

      const restored = await restoreWorkspaceSnapshotWithRecovery(
        context.pmPath,
        "baseline",
        {
          force: true,
          author: "snapshot-round-trip",
          message: "Exercise reversible restore",
        },
      );
      expect(restored.plan).toEqual(plan);
      expect(restored.audit_history_path).toBe("history/_workspace.jsonl");
      const workspaceHistory = (
        await readFile(
          path.join(context.pmPath, "history", "_workspace.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { op: string; context?: unknown });
      expect(workspaceHistory.at(-1)).toMatchObject({
        op: "workspace_snapshot_restore",
        context: {
          target_fingerprint: restored.manifest.fingerprint,
          pre_restore_fingerprint: restored.recovery_fingerprint,
          removed_item_count: 2,
          removed_history_entry_count: 2,
        },
      });
      const missing = await context.runCliInProcess(["get", itemId, "--json"]);
      expect(missing.code).not.toBe(0);

      const compatibilityManifest = await restoreWorkspaceSnapshot(
        context.pmPath,
        restored.recovery_fingerprint,
      );
      expect(compatibilityManifest.fingerprint).toBe(
        restored.recovery_fingerprint,
      );
      const recovered = await context.runCliInProcess(
        ["get", itemId, "--json"],
        { expectJson: true },
      );
      expect(recovered.code).toBe(0);
    });
  });

  it("renews the writer lease beyond its TTL and removes failed staging", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const release = await acquireLock(
        pmPath,
        "sdk-workspace-transaction",
        0.03,
        "lease-holder",
        false,
        false,
        0,
      );
      const heartbeat = new _testOnlyWorkspaceSnapshot.WorkspaceLockHeartbeat(
        getLockPath(pmPath, "sdk-workspace-transaction"),
        "lease-holder",
        0.03,
      );
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        const lockPath = getLockPath(pmPath, "sdk-workspace-transaction");
        const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<
          string,
          unknown
        >;
        const expiredCreatedAt = "2000-01-01T00:00:00.000Z";
        await writeFile(
          lockPath,
          `${JSON.stringify({ ...lock, created_at: expiredCreatedAt }, null, 2)}\n`,
          "utf8",
        );
        const unrenewedLock = JSON.parse(
          await readFile(lockPath, "utf8"),
        ) as Record<string, unknown>;
        expect(typeof unrenewedLock.created_at).toBe("string");
        expect(
          Date.parse(unrenewedLock.created_at as string),
        ).not.toBeGreaterThan(Date.parse(expiredCreatedAt));
        await heartbeat.refreshNow();
        const renewedLock = JSON.parse(
          await readFile(lockPath, "utf8"),
        ) as Record<string, unknown>;
        expect(typeof renewedLock.created_at).toBe("string");
        expect(Date.parse(renewedLock.created_at as string)).toBeGreaterThan(
          Date.parse(expiredCreatedAt),
        );
        expect(renewedLock).toMatchObject({
          id: lock.id,
          owner: lock.owner,
          pid: lock.pid,
          ttl_seconds: lock.ttl_seconds,
        });
        await writeFile(
          lockPath,
          `${JSON.stringify({ ...renewedLock, created_at: expiredCreatedAt }, null, 2)}\n`,
          "utf8",
        );
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(10);
        await heartbeat.refreshNow();
        const scheduledRenewal = JSON.parse(
          await readFile(lockPath, "utf8"),
        ) as Record<string, unknown>;
        expect(typeof scheduledRenewal.created_at).toBe("string");
        expect(
          Date.parse(scheduledRenewal.created_at as string),
        ).toBeGreaterThan(Date.parse(expiredCreatedAt));
      } finally {
        try {
          await heartbeat.stop();
        } finally {
          vi.useRealTimers();
          await release();
        }
      }
    });

    await withTempPmPath(async ({ pmPath }) => {
      const malformedAuditPath = path.join(
        pmPath,
        "history",
        "_workspace.jsonl",
      );
      await mkdir(malformedAuditPath);
      await writeFile(
        path.join(malformedAuditPath, "nested"),
        "not an audit stream",
        "utf8",
      );
      await createWorkspaceSnapshot(pmPath, { name: "invalid-audit-target" });
      await writeFile(
        path.join(pmPath, "settings.json"),
        '{"changed":true}\n',
        "utf8",
      );
      const parent = path.dirname(pmPath);
      const stagingPrefix = `.${path.basename(pmPath)}.restore-`;
      await expect(
        restoreWorkspaceSnapshotWithRecovery(pmPath, "invalid-audit-target", {
          force: true,
          author: "cleanup-test",
        }),
      ).rejects.toThrow();
      expect(
        (await readdir(parent)).filter((entry) =>
          entry.startsWith(stagingPrefix),
        ),
      ).toEqual([]);
    });
  });

  it("fails closed when heartbeat lock structure or ownership changes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const heartbeatPath = path.join(pmPath, "heartbeat.lock");
      const invalidLocks = [
        "null\n",
        "[]\n",
        `${JSON.stringify({
          id: "wrong-id",
          owner: "heartbeat-owner",
          pid: process.pid,
        })}\n`,
        `${JSON.stringify({
          id: "sdk-workspace-transaction",
          owner: "wrong-owner",
          pid: process.pid,
        })}\n`,
        `${JSON.stringify({
          id: "sdk-workspace-transaction",
          owner: "heartbeat-owner",
          pid: process.pid + 1,
        })}\n`,
      ];
      for (const invalidLock of invalidLocks) {
        await writeFile(heartbeatPath, invalidLock, "utf8");
        const heartbeat = new _testOnlyWorkspaceSnapshot.WorkspaceLockHeartbeat(
          heartbeatPath,
          "heartbeat-owner",
          0.03,
        );
        heartbeat.start();
        await expect(heartbeat.refreshNow()).rejects.toThrow(
          "lost its writer lock",
        );
        await expect(heartbeat.stop()).rejects.toThrow("lost its writer lock");
      }

      const idleHeartbeat =
        new _testOnlyWorkspaceSnapshot.WorkspaceLockHeartbeat(
          heartbeatPath,
          "heartbeat-owner",
          1,
        );
      await expect(idleHeartbeat.stop()).resolves.toBeUndefined();
    });
  });

  it("deletes references before their immutable objects and rejects unsafe names", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const created = await createWorkspaceSnapshot(pmPath, {
        name: "temporary",
      });
      await expect(
        deleteWorkspaceSnapshot(pmPath, created.manifest.fingerprint),
      ).rejects.toThrow("still referenced");
      expect(await deleteWorkspaceSnapshot(pmPath, "temporary")).toEqual({
        deleted: "reference",
        target: "temporary",
      });
      expect(
        await deleteWorkspaceSnapshot(pmPath, created.manifest.fingerprint),
      ).toEqual({
        deleted: "object",
        target: created.manifest.fingerprint,
      });
      // An invalid snapshot name is a correct refusal, not a production fault.
      // It must carry a declared usage contract so error reporting classifies
      // it as expected instead of raising a high Sentry issue that blocks
      // releases until it ages out of the reliability window.
      const invalidName = await createWorkspaceSnapshot(pmPath, {
        name: "../escape",
      }).catch((error: unknown) => error as PmCliError);
      expect(invalidName).toBeInstanceOf(PmCliError);
      expect(invalidName.message).toContain("must use lowercase");
      expect(invalidName.code).toBe("invalid_workspace_snapshot_target");
      expect(invalidName.exitCode).toBe(2);
      await expect(
        createWorkspaceSnapshot(pmPath, { name: "a".repeat(64) }),
      ).rejects.toThrow("must not be 64-character");
      await expect(inspectWorkspaceSnapshot(pmPath, "missing")).rejects.toThrow(
        "Unknown workspace snapshot: missing",
      );
      await expect(
        inspectWorkspaceSnapshot(pmPath, "c".repeat(64)),
      ).rejects.toThrow(`Unknown workspace snapshot: ${"c".repeat(64)}`);
      await expect(
        restoreWorkspaceSnapshotWithRecovery(pmPath, "missing", {
          force: true,
        }),
      ).rejects.toThrow("Unknown workspace snapshot: missing");
      await expect(deleteWorkspaceSnapshot(pmPath, "missing")).rejects.toThrow(
        "Unknown workspace snapshot: missing",
      );
      await expect(
        deleteWorkspaceSnapshot(pmPath, "b".repeat(64)),
      ).rejects.toThrow(`Unknown workspace snapshot: ${"b".repeat(64)}`);
      const malformedRef = path.join(
        pmPath,
        "runtime",
        "workspace-snapshots",
        "refs",
        "malformed.json",
      );
      await mkdir(path.dirname(malformedRef), { recursive: true });
      await writeFile(malformedRef, "{", "utf8");
      await expect(
        inspectWorkspaceSnapshot(pmPath, "malformed"),
      ).rejects.toThrow(SyntaxError);
      const directoryRef = path.join(
        pmPath,
        "runtime",
        "workspace-snapshots",
        "refs",
        "directory.json",
      );
      await mkdir(directoryRef);
      await expect(
        deleteWorkspaceSnapshot(pmPath, "directory"),
      ).rejects.toThrow();
    });
  });

  it("rejects corrupt manifests and propagates unreadable store failures", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const created = await createWorkspaceSnapshot(pmPath);
      const store = path.join(pmPath, "runtime", "workspace-snapshots");
      const manifestPath = path.join(
        store,
        "objects",
        created.manifest.fingerprint,
        "manifest.json",
      );
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...created.manifest, fingerprint: "0".repeat(64) })}\n`,
        "utf8",
      );
      await expect(
        inspectWorkspaceSnapshot(pmPath, created.manifest.fingerprint),
      ).rejects.toThrow("identity mismatch");
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...created.manifest, schema: "unsupported" })}\n`,
        "utf8",
      );
      await expect(
        inspectWorkspaceSnapshot(pmPath, created.manifest.fingerprint),
      ).rejects.toThrow("identity mismatch");
    });

    await withTempPmPath(async ({ pmPath }) => {
      const store = path.join(pmPath, "runtime", "workspace-snapshots");
      await mkdir(store, { recursive: true });
      await writeFile(path.join(store, "objects"), "not a directory", "utf8");
      await expect(listWorkspaceSnapshots(pmPath)).rejects.toThrow();
      await expect(createWorkspaceSnapshot(pmPath)).rejects.toThrow();
    });

    await withTempPmPath(async ({ pmPath }) => {
      const store = path.join(pmPath, "runtime", "workspace-snapshots");
      await mkdir(path.join(store, "objects"), { recursive: true });
      await writeFile(path.join(store, "refs"), "not a directory", "utf8");
      await expect(listWorkspaceSnapshots(pmPath)).rejects.toThrow();
    });
  });

  it("deduplicates a concurrent object publish and rolls back a failed restore swap", async () => {
    const removed: string[] = [];
    for (const code of ["EEXIST", "ENOTEMPTY"]) {
      await expect(
        publishWorkspaceSnapshotObject(`temporary-${code}`, "object", {
          renameEntry: async () => {
            throw Object.assign(new Error("concurrent publish"), { code });
          },
          removeEntry: async (target) => {
            removed.push(target);
          },
        }),
      ).resolves.toBe(true);
    }
    expect(removed).toEqual(["temporary-EEXIST", "temporary-ENOTEMPTY"]);
    await expect(
      publishWorkspaceSnapshotObject("temporary", "object", {
        renameEntry: async () => {
          throw new Error("unrelated failure");
        },
        removeEntry: async () => undefined,
      }),
    ).rejects.toThrow("unrelated failure");

    const calls: string[] = [];
    await expect(
      swapWorkspaceSnapshotRoot("staging", "root", "backup", {
        renameEntry: async (source, target) => {
          calls.push(`${source}->${target}`);
          if (source === "staging") {
            throw new Error("injected activation failure");
          }
        },
        removeEntry: async (target) => {
          calls.push(`remove:${target}`);
        },
      }),
    ).rejects.toThrow("injected activation failure");
    expect(calls).toEqual([
      "root->backup",
      "staging->root",
      "backup->root",
      "remove:staging",
    ]);

    const cleanupCalls: string[] = [];
    await expect(
      swapWorkspaceSnapshotRoot("staging", "root", "backup", {
        renameEntry: async (source, target) => {
          cleanupCalls.push(`${source}->${target}`);
        },
        removeEntry: async (target) => {
          cleanupCalls.push(`remove:${target}`);
          throw new Error("injected cleanup failure");
        },
      }),
    ).rejects.toThrow("injected cleanup failure");
    expect(cleanupCalls).toEqual([
      "root->backup",
      "staging->root",
      "remove:backup",
    ]);
  });

  // Untyped, these escape as raw Node errors: captured as unactionable
  // production exceptions that name a scrubbed `copyfile` frame and nothing an
  // operator can act on.
  it("converts host storage and permission faults into declared, path-free refusals", async () => {
    const { withSnapshotFilesystemGuard } = _testOnlyWorkspaceSnapshot;
    const secretPath = ["/home", "someone", "private-project"].join("/");

    const exhausted = await withSnapshotFilesystemGuard(
      "restore_stage",
      async () => {
        throw Object.assign(
          new Error(
            `ENOSPC: no space left on device, copyfile '${secretPath}/a' -> '${secretPath}/b'`,
          ),
          { code: "ENOSPC" },
        );
      },
    ).catch((error: unknown) => error as PmCliError);

    expect(exhausted).toBeInstanceOf(PmCliError);
    expect(exhausted.code).toBe("workspace_snapshot_storage_exhausted");
    expect(exhausted.context.reason).toBe("ENOSPC");
    expect(exhausted.message).toContain("restore_stage");
    // The bounded operation label is reported; workspace topology is not.
    expect(exhausted.message).not.toContain(secretPath);
    expect(JSON.stringify(exhausted.context)).not.toContain(secretPath);
    expect(exhausted.context.nextSteps?.length).toBeGreaterThan(0);
    expect(exhausted.context.recovery?.suggested_retry).toBe("pm gc --json");

    const resourceExhausted = await withSnapshotFilesystemGuard(
      "create_object",
      async () => {
        throw Object.assign(new Error("EMFILE: too many open files"), {
          code: "EMFILE",
        });
      },
    ).catch((error: unknown) => error as PmCliError);
    expect(resourceExhausted.code).toBe(
      "workspace_snapshot_resource_exhausted",
    );

    const denied = await withSnapshotFilesystemGuard(
      "create_object",
      async () => {
        throw Object.assign(new Error("EROFS: read-only file system"), {
          code: "EROFS",
        });
      },
    ).catch((error: unknown) => error as PmCliError);
    expect(denied.code).toBe("workspace_snapshot_permission_denied");
    expect(denied.message).toContain("create_object");

    // A fault that is not a host environment condition stays untouched, so real
    // defects are still reported as defects.
    await expect(
      withSnapshotFilesystemGuard("create_object", async () => {
        throw new Error("genuine defect");
      }),
    ).rejects.toThrow("genuine defect");

    await expect(
      withSnapshotFilesystemGuard("create_object", async () => "ok"),
    ).resolves.toBe("ok");
  });
});
