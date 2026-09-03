import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as historyModule from "../../../../src/core/history/history.js";
import * as workspaceHistoryModule from "../../../../src/core/history/workspace-history.js";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import {
  cloneEmptyReplayDocument,
  tryApplyReplayPatch,
  verifyHistoryChain,
} from "../../../../src/core/history/replay.js";
import {
  appendWorkspaceHistoryChange,
  appendWorkspaceAuditEvent,
  getWorkspaceHistoryPath,
  inspectWorkspaceHistoryState,
  reconcileWorkspaceJsonHistory,
  restoreWorkspaceJsonFromHistory,
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
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { parseJsonErrorEnvelope } from "../../../helpers/jsonErrorEnvelope.js";
import { runWithReproducibleExecution } from "../../../../src/core/reproducibility/context.js";

describe("workspace history", () => {
  it("uses the reproducible clock for every audited workspace history path", async () => {
    await withTempPmPath(async (context) => {
      const clock = "2026-09-02T12:34:56.789Z";
      const filePath = path.join(context.pmPath, "governance.json");
      const common = {
        pmRoot: context.pmPath,
        filePath,
        op: "governance_put",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await runWithReproducibleExecution(
        { clock, seed: "workspace-history-clock", tickMs: 0 },
        async () => {
          await writeWorkspaceJsonWithHistory({
            ...common,
            raw: '{"floor":10}\n',
          });
          await appendWorkspaceAuditEvent({
            ...common,
            op: "workspace_review",
            context: { reviewed: true },
            message: "Record deterministic audit evidence.",
          });
          await writeFile(filePath, '{"floor":8}\n');
          await reconcileWorkspaceJsonHistory({
            ...common,
            op: "workspace_state_reconcile",
            authorizationDecision: "pm-decision",
          });
          await restoreWorkspaceJsonFromHistory({
            ...common,
            op: "workspace_state_restore",
            targetVersion: 1,
          });
        },
      );

      const entries = await readHistoryEntries(
        getWorkspaceHistoryPath(context.pmPath),
        WORKSPACE_HISTORY_ID,
      );
      expect(entries.map((entry) => entry.ts)).toEqual([
        clock,
        clock,
        clock,
        clock,
      ]);
    });
  });

  it("starts an audit-only workspace stream without changing state", async () => {
    await withTempPmPath(async (context) => {
      await expect(
        appendWorkspaceAuditEvent({
          pmRoot: context.pmPath,
          op: "review",
          author: "workspace-history-test",
          context: { reviewed: true },
          message: "Record an initial state-neutral review.",
          lockTtlSeconds: 30,
          lockWaitMs: 1000,
        }),
      ).resolves.toMatchObject({
        historyPath: getWorkspaceHistoryPath(context.pmPath),
      });
      const entries = await readHistoryEntries(
        getWorkspaceHistoryPath(context.pmPath),
        WORKSPACE_HISTORY_ID,
      );
      expect(entries).toHaveLength(1);
      expect(verifyHistoryChain(entries)).toEqual({ ok: true, errors: [] });
    });
  });

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
        documentPath: "custom-settings.json",
        before: { enabled: false },
        after: { enabled: true },
        op: "config_set",
      });
      const schema = {
        ...common,
        documentPath: "custom-schema.json",
        before: { definitions: [] },
        after: { definitions: [{ name: "Spike" }] },
        op: "schema_add_type",
        idempotencyKey: "spike-v1",
      };
      await appendWorkspaceHistoryChange(schema);
      await appendWorkspaceHistoryChange(schema);
      await writeFile(
        path.join(context.pmPath, "custom-settings.json"),
        '{"enabled":true}\n',
      );
      await writeFile(
        path.join(context.pmPath, "custom-schema.json"),
        '{"definitions":[{"name":"Spike"}]}\n',
      );

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
        { id: WORKSPACE_HISTORY_ID, raw: true, compact: false },
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
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_state_conflict",
        context: {
          reason: "out_of_band_workspace_state",
          recovery: {
            next_best_command: "pm history _workspace --verify",
          },
        },
      });

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
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
        context: {
          reason: "workspace_history_chain_verification_failed",
          verification_errors: expect.arrayContaining([
            "verify_failed:before_hash_mismatch:entry_2",
          ]),
          recovery: {
            next_best_command: "pm history _workspace --verify --json",
          },
        },
      });
    });
  });

  it("returns a structured CLI conflict for a corrupt workspace chain", async () => {
    await withTempPmPath(async (context) => {
      expect(
        context.runCli(
          ["config", "project", "set", "author_default", "before", "--json"],
          { expectJson: true },
        ).code,
      ).toBe(0);
      const historyPath = getWorkspaceHistoryPath(context.pmPath);
      const rows = (await readFile(historyPath, "utf8")).trimEnd().split("\n");
      const first = JSON.parse(rows[0]) as { before_hash: string };
      first.before_hash = "0".repeat(64);
      rows[0] = JSON.stringify(first);
      await writeFile(historyPath, `${rows.join("\n")}\n`);

      const refusal = context.runCli(
        ["config", "project", "set", "author_default", "after", "--json"],
        { expectJson: true },
      );
      expect(refusal.code).toBe(EXIT_CODE.CONFLICT);
      expect(parseJsonErrorEnvelope(refusal.stderr)).toMatchObject({
        type: "urn:pm-cli:error:workspace_history_chain_invalid",
        code: "workspace_history_chain_invalid",
        exit_code: EXIT_CODE.CONFLICT,
        verification_errors: ["verify_failed:record_hash_mismatch:entry_1"],
        recovery: {
          next_best_command: "pm history _workspace --verify --json",
        },
      });
    });
  });

  it("detects, reconciles, and restores singleton state through append-only history", async () => {
    await withTempPmPath(async (context) => {
      const filePath = path.join(context.pmPath, "governance.json");
      const common = {
        pmRoot: context.pmPath,
        filePath,
        op: "governance_put",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await writeWorkspaceJsonWithHistory({
        ...common,
        raw: '{"floor":10}\n',
      });
      await writeWorkspaceJsonWithHistory({
        ...common,
        raw: '{"floor":12}\n',
      });
      await writeFile(filePath, '{"floor":8}\n');

      await expect(
        inspectWorkspaceHistoryState(context.pmPath),
      ).resolves.toMatchObject({
        ok: false,
        document_count: 1,
        matching_documents: [],
        mismatched_documents: ["governance.json"],
        missing_documents: [],
        unreadable_documents: [],
      });
      const drift = await scanHistoryDrift(context.pmPath, []);
      expect(drift.workspaceStateMismatches).toEqual(["governance.json"]);
      expect(drift.driftedItems).toContain(WORKSPACE_HISTORY_ID);
      const history = await runHistory(
        WORKSPACE_HISTORY_ID,
        { verify: true },
        { path: context.pmPath },
      );
      expect(history.verification).toMatchObject({
        ok: false,
        workspace_state_matches_latest: false,
        workspace_state_mismatches: ["governance.json"],
      });

      await reconcileWorkspaceJsonHistory({
        ...common,
        op: "workspace_state_reconcile",
        message: "Accept the intended governance bound after review.",
        authorizationDecision: "pm-decision",
      });
      await expect(
        inspectWorkspaceHistoryState(context.pmPath),
      ).resolves.toMatchObject({
        ok: true,
        matching_documents: ["governance.json"],
      });

      const restored = await restoreWorkspaceJsonFromHistory({
        ...common,
        targetVersion: 1,
        message: "Restore the first recorded governance bound.",
      });
      expect(restored).toMatchObject({
        document_path: "governance.json",
        restored_from_version: 1,
        changed: true,
      });
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
        floor: 10,
      });
      await expect(
        restoreWorkspaceJsonFromHistory({
          ...common,
          targetVersion: 1,
          message: "Confirm the restored document is already current.",
        }),
      ).resolves.toMatchObject({
        changed: false,
        restored_from_version: 1,
      });
      expect(
        verifyHistoryChain(
          await readHistoryEntries(
            getWorkspaceHistoryPath(context.pmPath),
            WORKSPACE_HISTORY_ID,
          ),
        ),
      ).toEqual({ ok: true, errors: [] });
      await expect(
        inspectWorkspaceHistoryState(context.pmPath),
      ).resolves.toMatchObject({
        ok: true,
        matching_documents: ["governance.json"],
      });
    });
  });

  it("compensates both existing and absent documents when restore history append fails", async () => {
    await withTempPmPath(async (context) => {
      const filePath = path.join(context.pmPath, "governance.json");
      const common = {
        pmRoot: context.pmPath,
        filePath,
        op: "workspace_state_restore",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
        targetVersion: 1,
        message: "Exercise restore compensation.",
      };
      await writeWorkspaceJsonWithHistory({
        ...common,
        op: "governance_put",
        raw: '{"floor":10}\n',
      });

      const appendSpy = vi.spyOn(historyModule, "appendHistoryEntry");
      try {
        const outOfBandRaw = '{"floor":8}\n';
        await writeFile(filePath, outOfBandRaw);
        appendSpy.mockRejectedValueOnce(new Error("restore-append-failed"));
        await expect(restoreWorkspaceJsonFromHistory(common)).rejects.toThrow(
          "restore-append-failed",
        );
        expect(await readFile(filePath, "utf8")).toBe(outOfBandRaw);

        await rm(filePath);
        appendSpy.mockRejectedValueOnce(new Error("restore-append-failed"));
        await expect(restoreWorkspaceJsonFromHistory(common)).rejects.toThrow(
          "restore-append-failed",
        );
        await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        appendSpy.mockRestore();
      }
    });
  });

  it("classifies a workspace-state inspection failure as an unreadable stream", async () => {
    await withTempPmPath(async (context) => {
      await appendWorkspaceHistoryChange({
        pmRoot: context.pmPath,
        documentPath: "governance.json",
        before: { enabled: false },
        after: { enabled: true },
        op: "inspection_failure_fixture",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      });
      await writeFile(
        path.join(context.pmPath, "governance.json"),
        '{"enabled":true}\n',
      );

      const inspectSpy = vi
        .spyOn(workspaceHistoryModule, "inspectWorkspaceHistoryState")
        .mockRejectedValueOnce(new Error("singleton-read-failed"));
      try {
        const drift = await scanHistoryDrift(context.pmPath, []);
        expect(drift.unreadableStreams).toContain(WORKSPACE_HISTORY_ID);
        expect(drift.driftedItems).toContain(WORKSPACE_HISTORY_ID);
      } finally {
        inspectSpy.mockRestore();
      }
    });
  });

  it("refuses unauthorized reconciliation and invalid restore targets", async () => {
    await withTempPmPath(async (context) => {
      const filePath = path.join(context.pmPath, "governance.json");
      const common = {
        pmRoot: context.pmPath,
        filePath,
        op: "governance_put",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await writeWorkspaceJsonWithHistory({
        ...common,
        raw: '{"floor":10}\n',
      });
      await writeFile(filePath, '{"floor":8}\n');
      await expect(
        reconcileWorkspaceJsonHistory({
          ...common,
          op: "workspace_state_reconcile",
          message: "Missing an authorization decision.",
          authorizationDecision: " ",
        }),
      ).rejects.toThrow("authorization decision");
      await expect(
        restoreWorkspaceJsonFromHistory({
          ...common,
          targetVersion: 2,
          message: "Invalid future restore.",
        }),
      ).rejects.toThrow("target version");
      await expect(
        restoreWorkspaceJsonFromHistory({
          ...common,
          targetVersion: 1,
          message: "Reject the out-of-band value and restore verified state.",
        }),
      ).resolves.toMatchObject({ changed: true, restored_from_version: 1 });
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
        floor: 10,
      });
      await expect(
        inspectWorkspaceHistoryState(context.pmPath),
      ).resolves.toMatchObject({
        ok: true,
        matching_documents: ["governance.json"],
      });
      await writeFile(filePath, "not-json");
      await expect(
        inspectWorkspaceHistoryState(context.pmPath),
      ).resolves.toMatchObject({
        ok: false,
        unreadable_documents: ["governance.json"],
      });
    });
  });

  it("fails closed for missing, ungoverned, and unverifiable reconciliation or restore state", async () => {
    await withTempPmPath(async (context) => {
      const filePath = path.join(context.pmPath, "governance.json");
      const common = {
        pmRoot: context.pmPath,
        filePath,
        op: "workspace_state_reconcile",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await writeWorkspaceJsonWithHistory({
        ...common,
        op: "governance_put",
        raw: '{"floor":10}\n',
      });
      await expect(
        reconcileWorkspaceJsonHistory({
          ...common,
          authorizationDecision: "pm-decision",
        }),
      ).resolves.toMatchObject({ changed: false });

      await rm(filePath);
      await expect(
        reconcileWorkspaceJsonHistory({
          ...common,
          authorizationDecision: "pm-decision",
        }),
      ).rejects.toThrow("document is missing");

      const ungovernedPath = path.join(context.pmPath, "ungoverned.json");
      await writeFile(ungovernedPath, "{}\n");
      await expect(
        reconcileWorkspaceJsonHistory({
          ...common,
          filePath: ungovernedPath,
          authorizationDecision: "pm-decision",
        }),
      ).rejects.toThrow("does not govern document");
      const outsidePath = path.join(
        path.dirname(context.pmPath),
        "outside.json",
      );
      await writeFile(outsidePath, "{}\n");
      await expect(
        reconcileWorkspaceJsonHistory({
          ...common,
          filePath: outsidePath,
          authorizationDecision: "pm-decision",
        }),
      ).rejects.toThrow("must stay inside the tracker root");

      await appendFile(
        getWorkspaceHistoryPath(context.pmPath),
        '{"ts":"broken"}\n',
      );
      await expect(
        inspectWorkspaceHistoryState(context.pmPath),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
      });
      await expect(
        reconcileWorkspaceJsonHistory({
          ...common,
          authorizationDecision: "pm-decision",
        }),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
      });
      await expect(
        restoreWorkspaceJsonFromHistory({
          ...common,
          targetVersion: 999,
        }),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
      });
    });

    await withTempPmPath(async (context) => {
      await appendWorkspaceAuditEvent({
        pmRoot: context.pmPath,
        op: "review",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      });
      const filePath = path.join(context.pmPath, "governance.json");
      const common = {
        pmRoot: context.pmPath,
        filePath,
        op: "governance_put",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      };
      await writeWorkspaceJsonWithHistory({
        ...common,
        raw: '{"floor":10}\n',
      });
      await expect(
        restoreWorkspaceJsonFromHistory({
          ...common,
          targetVersion: 1,
        }),
      ).rejects.toThrow("does not contain governance.json");
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
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
      });
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

      const competingRaw = ['{"enabled":"alpha"}\n', '{"enabled":"beta"}\n'];
      await expect(
        Promise.all(
          competingRaw.map((raw) =>
            writeWorkspaceJsonWithHistory({ ...common, raw }),
          ),
        ),
      ).resolves.toEqual([true, true]);
      const concurrentEntries = await readHistoryEntries(
        getWorkspaceHistoryPath(context.pmPath),
        WORKSPACE_HISTORY_ID,
      );
      expect(concurrentEntries).toHaveLength(3);
      expect(verifyHistoryChain(concurrentEntries)).toEqual({
        ok: true,
        errors: [],
      });
      let replay = cloneEmptyReplayDocument();
      for (const entry of concurrentEntries) {
        const applied = tryApplyReplayPatch(replay, entry.patch);
        if (!applied.ok) throw applied.error;
        replay = applied.document;
      }
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(
        (replay.metadata.documents as Record<string, unknown>)[
          "custom-state.json"
        ],
      );
      const beforeFailureRaw = await readFile(filePath, "utf8");

      await appendFile(
        getWorkspaceHistoryPath(context.pmPath),
        '{"ts":"broken"}\n',
      );
      await expect(
        writeWorkspaceJsonWithHistory({
          ...common,
          raw: '{"enabled":false}\n',
        }),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
      });
      expect(await readFile(filePath, "utf8")).toBe(beforeFailureRaw);

      const newPath = path.join(context.pmPath, "new-state.json");
      await expect(
        writeWorkspaceJsonWithHistory({
          ...common,
          filePath: newPath,
          raw: '{"new":true}\n',
        }),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
      });
      await expect(readFile(newPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("serializes competing settings snapshots with their audit entries", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, {
        ...settings,
        author_default: "settings-baseline",
      });
      await expect(
        Promise.all([
          writeSettings(context.pmPath, {
            ...settings,
            author_default: "settings-alpha",
          }),
          writeSettings(context.pmPath, {
            ...settings,
            author_default: "settings-beta",
          }),
        ]),
      ).resolves.toEqual([undefined, undefined]);

      const persisted = await readSettings(context.pmPath);
      expect(["settings-alpha", "settings-beta"]).toContain(
        persisted.author_default,
      );
      const entries = await readHistoryEntries(
        getWorkspaceHistoryPath(context.pmPath),
        WORKSPACE_HISTORY_ID,
      );
      expect(entries).toHaveLength(3);
      expect(verifyHistoryChain(entries)).toEqual({ ok: true, errors: [] });
    });
  });

  it("persists and refreshes workspace stream verification through the drift cache", async () => {
    await withTempPmPath(async (context) => {
      await appendWorkspaceHistoryChange({
        pmRoot: context.pmPath,
        documentPath: "custom-state.json",
        before: { enabled: false },
        after: { enabled: true },
        op: "config_set",
        author: "workspace-history-test",
        lockTtlSeconds: 30,
        lockWaitMs: 1000,
      });
      await writeFile(
        path.join(context.pmPath, "custom-state.json"),
        '{"enabled":true}\n',
      );
      expect(
        await scanHistoryDrift(context.pmPath, [], {
          cacheHitVerification: "metadata",
        }),
      ).toMatchObject({ driftedItems: [] });
      const cachePath = path.join(
        context.pmPath,
        "runtime",
        "history-drift-cache.json",
      );
      const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
        entries: Record<string, { chain_ok: boolean }>;
      };
      expect(cache.entries[WORKSPACE_HISTORY_ID]?.chain_ok).toBe(true);

      await appendFile(
        getWorkspaceHistoryPath(context.pmPath),
        '{"ts":"broken"}\n',
      );
      expect(
        (
          await scanHistoryDrift(context.pmPath, [], {
            cacheHitVerification: "metadata",
          })
        ).unreadableStreams,
      ).toContain(WORKSPACE_HISTORY_ID);
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
      await expect(
        appendWorkspaceAuditEvent({
          pmRoot: context.pmPath,
          op: "review",
          author: "workspace-history-test",
          context: { reviewed: true },
          message: "Must reject drifted audit stream",
          lockTtlSeconds: 30,
          lockWaitMs: 1000,
        }),
      ).rejects.toMatchObject({
        name: "PmCliError",
        exitCode: EXIT_CODE.CONFLICT,
        code: "workspace_history_chain_invalid",
        context: {
          reason: "workspace_history_chain_verification_failed",
          verification_errors: ["verify_failed:record_hash_mismatch:entry_1"],
        },
      });
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
