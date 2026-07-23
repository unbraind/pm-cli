import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import { verifyHistoryChain } from "../../../../src/core/history/replay.js";
import {
  appendWorkspaceHistoryChange,
  getWorkspaceHistoryPath,
  writeWorkspaceJsonWithHistory,
  WORKSPACE_HISTORY_ID,
} from "../../../../src/core/history/workspace-history.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { runHistory } from "../../../../src/cli/commands/history.js";
import { runActivity } from "../../../../src/cli/commands/activity.js";
import { scanHistoryDrift } from "../../../../src/core/history/drift-scan.js";
import {
  readSettings,
  writeSettings,
} from "../../../../src/core/store/settings.js";
import { runExtension } from "../../../../src/cli/commands/extension.js";

describe("workspace history", () => {
  it("chains multiple singleton documents and deduplicates retry keys", async () => {
    await withTempPmPath(async (context) => {
      const common = {
        pmRoot: context.pmPath,
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await appendWorkspaceHistoryChange({
        ...common,
        documentPath: "settings.json",
        before: { enabled: false },
        after: { enabled: true },
        op: "config_set",
      });
      const schema = {
        ...common,
        documentPath: "schema/types.json",
        before: { definitions: [] },
        after: { definitions: [{ name: "Spike" }] },
        op: "schema_add_type",
        idempotencyKey: "spike-v1",
      };
      await appendWorkspaceHistoryChange(schema);
      await appendWorkspaceHistoryChange(schema);

      const entries = await readHistoryEntries(
        getWorkspaceHistoryPath(context.pmPath),
        WORKSPACE_HISTORY_ID,
      );
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.op)).toEqual([
        "config_set",
        "schema_add_type:spike-v1",
      ]);
      expect(verifyHistoryChain(entries)).toEqual({ ok: true, errors: [] });
      const history = await runHistory(
        WORKSPACE_HISTORY_ID,
        { verify: true },
        { path: context.pmPath },
      );
      expect(history.verification).toMatchObject({ ok: true, entries: 2 });
      const activity = await runActivity(
        { id: WORKSPACE_HISTORY_ID },
        { path: context.pmPath },
      );
      expect(activity.activity).toHaveLength(2);
    });
  });

  it("refuses drifted streams and out-of-band singleton state", async () => {
    await withTempPmPath(async (context) => {
      const common = {
        pmRoot: context.pmPath,
        documentPath: "settings.json",
        op: "config_set",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await appendWorkspaceHistoryChange({
        ...common,
        before: { enabled: false },
        after: { enabled: true },
      });
      await expect(
        appendWorkspaceHistoryChange({
          ...common,
          before: { enabled: false },
          after: { enabled: "again" },
        }),
      ).rejects.toThrow("changed outside the audited mutation path");

      await appendFile(
        getWorkspaceHistoryPath(context.pmPath),
        '{"ts":"broken"}\n',
      );
      expect(
        (await scanHistoryDrift(context.pmPath, [])).driftedItems,
      ).toContain(WORKSPACE_HISTORY_ID);
      await expect(
        appendWorkspaceHistoryChange({
          ...common,
          before: { enabled: true },
          after: { enabled: false },
        }),
      ).rejects.toThrow("Workspace history verification failed");
    });
  });

  it("rolls settings back when its workspace audit append fails", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, {
        ...settings,
        author_default: "before-audit-failure",
      });
      const settingsPath = `${context.pmPath}/settings.json`;
      const beforeRaw = await readFile(settingsPath, "utf8");
      await appendFile(
        getWorkspaceHistoryPath(context.pmPath),
        '{"ts":"broken"}\n',
      );

      await expect(
        writeSettings(context.pmPath, {
          ...(await readSettings(context.pmPath)),
          author_default: "must-roll-back",
        }),
      ).rejects.toThrow("Workspace history verification failed");
      expect(await readFile(settingsPath, "utf8")).toBe(beforeRaw);
    });
  });

  it("atomically writes, deduplicates, restores, and removes audited JSON documents", async () => {
    await withTempPmPath(async (context) => {
      const filePath = path.join(context.pmPath, "custom-state.json");
      const firstRaw = '{"enabled":true}\n';
      const common = {
        pmRoot: context.pmPath,
        filePath,
        op: "custom_state",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await expect(
        writeWorkspaceJsonWithHistory({ ...common, raw: firstRaw }),
      ).resolves.toBe(true);
      await expect(
        writeWorkspaceJsonWithHistory({ ...common, raw: firstRaw }),
      ).resolves.toBe(false);

      await appendFile(
        getWorkspaceHistoryPath(context.pmPath),
        '{"ts":"broken"}\n',
      );
      await expect(
        writeWorkspaceJsonWithHistory({
          ...common,
          raw: '{"enabled":false}\n',
        }),
      ).rejects.toThrow("Workspace history verification failed");
      expect(await readFile(filePath, "utf8")).toBe(firstRaw);

      const newPath = path.join(context.pmPath, "new-state.json");
      await expect(
        writeWorkspaceJsonWithHistory({
          ...common,
          filePath: newPath,
          raw: '{"new":true}\n',
        }),
      ).rejects.toThrow("Workspace history verification failed");
      await expect(readFile(newPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("classifies a valid-JSON hash mismatch as workspace chain drift", async () => {
    await withTempPmPath(async (context) => {
      await appendWorkspaceHistoryChange({
        pmRoot: context.pmPath,
        documentPath: "settings.json",
        before: { enabled: false },
        after: { enabled: true },
        op: "config_set",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      });
      const historyPath = getWorkspaceHistoryPath(context.pmPath);
      const entry = JSON.parse(await readFile(historyPath, "utf8")) as {
        after_hash: string;
      };
      entry.after_hash = "0".repeat(64);
      await writeFile(historyPath, `${JSON.stringify(entry)}\n`);
      const drift = await scanHistoryDrift(context.pmPath, []);
      expect(drift.chainMismatches).toContain(WORKSPACE_HISTORY_ID);
      expect(drift.driftedItems).toContain(WORKSPACE_HISTORY_ID);
    });
  });

  it("audits project package activation and deactivation state changes", async () => {
    await withTempPmPath(async (context) => {
      await runExtension(
        "beads",
        { install: true, project: true },
        { path: context.pmPath },
      );
      await runExtension(
        "beads",
        { deactivate: true, project: true },
        { path: context.pmPath },
      );
      await runExtension(
        "beads",
        { activate: true, project: true },
        { path: context.pmPath },
      );

      const entries = await readHistoryEntries(
        getWorkspaceHistoryPath(context.pmPath),
        WORKSPACE_HISTORY_ID,
      );
      expect(entries.map((entry) => entry.op)).toEqual([
        "settings:write",
        "settings:write",
      ]);
      expect(verifyHistoryChain(entries)).toEqual({ ok: true, errors: [] });
    });
  });
});
