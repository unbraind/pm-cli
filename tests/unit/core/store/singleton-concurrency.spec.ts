import { mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeMutationCheckpoint } from "../../../../src/core/checkpoint/mutation-checkpoint.js";
import { inspectWorkspaceHistoryState } from "../../../../src/core/history/workspace-history.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { ensureRuntimeSchemaFileScaffold } from "../../../../src/core/schema/runtime-schema.js";
import {
  readSessionState,
  getSessionStatePath,
  recordClaimedWorkAttribution,
  semanticAttributionKey,
  setFocusedItem,
} from "../../../../src/core/session/session-state.js";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("workspace singleton concurrency", () => {
  it("advances a reused snapshot without replaying its earlier edits", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const first = await readSettings(pmPath);
      first.ids.token_length = 6;
      await writeSettings(pmPath, first);
      const peer = await readSettings(pmPath);
      peer.ids.token_length = 8;
      await writeSettings(pmPath, peer);
      first.context.activity_limit = 21;
      await writeSettings(pmPath, first);
      expect(await readSettings(pmPath)).toMatchObject({ ids: { token_length: 8 }, context: { activity_limit: 21 } });
      await writeSettings(pmPath, first);
      expect((await readSettings(pmPath)).ids.token_length).toBe(8);
    });
  });

  it("refuses to recreate a deleted settings document from a stale snapshot", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settings = await readSettings(pmPath);
      settings.ids.token_length = 6;
      await rm(path.join(pmPath, "settings.json"));
      await expect(writeSettings(pmPath, settings)).rejects.toMatchObject({ exitCode: EXIT_CODE.CONFLICT });
      expect(await readdir(path.join(pmPath, "locks"))).toEqual([]);
    });
  });

  it("recovers after refused session and checkpoint writes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const sessionPath = getSessionStatePath(pmPath);
      await mkdir(sessionPath, { recursive: true });
      await expect(setFocusedItem(pmPath, "pm-focus")).rejects.toThrow();
      const checkpointPath = path.join(pmPath, "checkpoints", "update-many", "collision.json");
      await mkdir(checkpointPath, { recursive: true });
      await expect(writeMutationCheckpoint(pmPath, "update-many", "collision", {})).rejects.toThrow();
      expect(await readdir(path.join(pmPath, "locks"))).toEqual([]);
      await rm(sessionPath, { recursive: true });
      await setFocusedItem(pmPath, "pm-recovered");
      expect((await readSessionState(pmPath)).focused_item).toBe("pm-recovered");
    });
  });

  it("publishes each schema seed once when several readers bootstrap together", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settings = await readSettings(pmPath);
      await rm(path.join(pmPath, "schema"), { recursive: true });
      const results = await Promise.all(Array.from({ length: 8 }, () =>
        ensureRuntimeSchemaFileScaffold(pmPath, settings.schema),
      ));
      const created = results.flatMap((result) => result.created_paths);
      expect(created).toHaveLength(4);
      expect(new Set(created).size).toBe(4);
    });
  });

  it("preserves disjoint settings changes made from the same before-state", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const [first, second] = await Promise.all([
        readSettings(pmPath), readSettings(pmPath),
      ]);
      first.locks.ttl_seconds = 120;
      second.locks.wait_ms = 5000;
      await Promise.all([writeSettings(pmPath, first), writeSettings(pmPath, second)]);
      expect((await readSettings(pmPath)).locks).toEqual({ ttl_seconds: 120, wait_ms: 5000 });
      expect((await inspectWorkspaceHistoryState(pmPath)).ok).toBe(true);
    });
  });

  it("refuses a stale overlapping change without overwriting the accepted value", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const first = await readSettings(pmPath);
      const second = await readSettings(pmPath);
      first.ids.token_length = 6;
      second.ids.token_length = 8;
      await writeSettings(pmPath, first);
      await expect(writeSettings(pmPath, second)).rejects.toMatchObject({ exitCode: EXIT_CODE.CONFLICT });
      expect((await readSettings(pmPath)).ids.token_length).toBe(6);
      expect((await inspectWorkspaceHistoryState(pmPath)).ok).toBe(true);
    });
  });

  it("keeps every simultaneous agent attribution and focus update", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const principals = Array.from({ length: 8 }, (_, index) => `agent-${index}`);
      await Promise.all([
        ...principals.map((principal) => recordClaimedWorkAttribution({
          pmRoot: pmPath, principal, itemId: `pm-${principal}`,
        })),
        setFocusedItem(pmPath, "pm-focus"),
      ]);
      const state = await readSessionState(pmPath);
      expect(state.focused_item).toBe("pm-focus");
      expect(Object.keys(state.semantic_attribution ?? {}).sort()).toEqual(
        principals.map(semanticAttributionKey).sort(),
      );
      expect(await readdir(path.join(pmPath, "locks"))).toEqual([]);
    });
  });

  it("cannot replace a checkpoint through an alias of the same workspace", async () => {
    await withTempPmPath(async ({ pmPath, tempRoot }) => {
      const alias = path.join(tempRoot, "tracker-alias");
      await symlink(pmPath, alias, "junction");
      const results = await Promise.allSettled([
        writeMutationCheckpoint(pmPath, "update-many", "alias-id", { value: 1 }),
        writeMutationCheckpoint(alias, "update-many", "alias-id", { value: 2 }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await readdir(path.join(pmPath, "locks"))).toEqual([]);
    });
  });

  it("refuses checkpoint-id collisions and accepts identical retries", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const results = await Promise.allSettled([
        writeMutationCheckpoint(pmPath, "update-many", "same-id", { value: 1 }),
        writeMutationCheckpoint(pmPath, "update-many", "same-id", { value: 2 }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const checkpointPath = path.join(pmPath, "checkpoints", "update-many", "same-id.json");
      const accepted: unknown = JSON.parse(await readFile(checkpointPath, "utf8"));
      await expect(writeMutationCheckpoint(pmPath, "update-many", "same-id", accepted)).resolves.toBe(checkpointPath);
      expect(await readdir(path.join(pmPath, "locks"))).toEqual([]);
    });
  });
});
