import {
  access,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_SCHEMA,
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  inspectWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot,
} from "../../../src/sdk/index.js";
import {
  publishWorkspaceSnapshotObject,
  swapWorkspaceSnapshotRoot,
} from "../../../src/sdk/workspace-snapshot.js";
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

  it("rejects non-file filesystem entries in authoritative state", async () => {
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
    });
  });

  it("deduplicates authoritative state and excludes clone-local runtime data", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await mkdir(path.join(pmPath, "search"), { recursive: true });
      await writeFile(path.join(pmPath, "search", "index.json"), "cache", "utf8");
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
      await writeFile(path.join(pmPath, "locks", "stale.lock"), "stale", "utf8");

      const restored = await restoreWorkspaceSnapshot(pmPath, "clean");
      expect(await readFile(settingsPath)).toEqual(originalSettings);
      await expect(access(path.join(pmPath, "locks", "stale.lock"))).rejects.toThrow();
      expect(
        await inspectWorkspaceSnapshot(pmPath, restored.fingerprint),
      ).toEqual(restored);
    });
  });

  it("deletes references before their immutable objects and rejects unsafe names", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const created = await createWorkspaceSnapshot(pmPath, { name: "temporary" });
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
      await expect(createWorkspaceSnapshot(pmPath, { name: "../escape" })).rejects.toThrow(
        "must use lowercase",
      );
      await expect(
        createWorkspaceSnapshot(pmPath, { name: "a".repeat(64) }),
      ).rejects.toThrow("must not be 64-character");
      await expect(inspectWorkspaceSnapshot(pmPath, "missing")).rejects.toThrow(
        "Unknown workspace snapshot: missing",
      );
      await expect(
        inspectWorkspaceSnapshot(pmPath, "c".repeat(64)),
      ).rejects.toThrow(`Unknown workspace snapshot: ${"c".repeat(64)}`);
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
      await expect(inspectWorkspaceSnapshot(pmPath, "malformed")).rejects.toThrow(
        SyntaxError,
      );
      const directoryRef = path.join(
        pmPath,
        "runtime",
        "workspace-snapshots",
        "refs",
        "directory.json",
      );
      await mkdir(directoryRef);
      await expect(deleteWorkspaceSnapshot(pmPath, "directory")).rejects.toThrow();
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
});
