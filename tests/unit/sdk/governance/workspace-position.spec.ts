import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  _testOnlyWorkspacePosition,
  formatWorkspacePositionHuman,
  readWorkspacePosition,
  type WorkspacePositionResult,
} from "../../../../src/sdk/governance/workspace-position.js";
import { writeMergeReceipt } from "../../../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const cleanFence = {
  status: "ok" as const,
  missing_patterns: [],
  stale_patterns: [],
  schema_scope: "project" as const,
};
const cleanDrivers = {
  status: "ok" as const,
  missing_keys: [],
  drifted_keys: [],
};

describe("workspace position decision", () => {
  it("fails closed when a history-check provider returns malformed detail shapes", () => {
    expect(
      _testOnlyWorkspacePosition.normalizeWorkspaceHistoryDrift({
        counts: null,
        drifted_items: "pm-not-an-array",
        drifted_items_count: "one",
        drifted_items_truncated: false,
      }),
    ).toEqual({
      counts: {},
      drifted_item_count: 0,
      drifted_item_ids: [],
      drifted_item_ids_truncated: false,
    });
  });

  it("reads unprepared and installed workspace evidence through the public SDK", async () => {
    await withTempPmPath(async (context) => {
      const before = await readWorkspacePosition({ path: context.pmPath });
      expect(before).toMatchObject({
        ok: false,
        state: "merge_fence_unprepared",
        merge_fence: { clone_local_drivers: null },
        merge_receipts: {
          pending_decision_count: 0,
          invalid_evidence_count: 0,
        },
        history_drift: { drifted_item_count: 0 },
      });

      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const installed = context.runCli(["merge", "install", "--json"], {
        cwd: context.tempRoot,
        expectJson: true,
      });
      expect(installed.code, installed.stderr).toBe(0);
      const after = await readWorkspacePosition({ path: context.pmPath });
      expect(after).toMatchObject({
        ok: true,
        state: "ready",
        merge_fence: { clone_local_drivers: { status: "ok" } },
      });

      expect(
        context.runCli([
          "create",
          "--id",
          "pm-drift",
          "--title",
          "History drift fixture",
          "--description",
          "Exercise bounded workspace drift evidence",
          "--type",
          "Task",
          "--json",
        ]).code,
      ).toBe(0);
      await rm(path.join(context.pmPath, "history", "pm-drift.jsonl"));
      const taskDirectory = path.join(context.pmPath, "tasks");
      await Promise.all([
        writeFile(
          path.join(taskDirectory, "pm-bad-a.toon"),
          "not: [toon",
          "utf8",
        ),
        writeFile(
          path.join(taskDirectory, "pm-bad-b.toon"),
          "also: [bad",
          "utf8",
        ),
        ...Array.from({ length: 26 }, (_, index) =>
          writeMergeReceipt({
            cwd: context.tempRoot,
            itemPath: `.agents/pm/tasks/pm-receipt-${String(index).padStart(2, "0")}.toon`,
            preferred: "ours",
            fieldsFromTheirs: [],
            unionFields: [],
            decisions: [
              {
                field: "title",
                base: "base",
                ours: `ours-${index}`,
                theirs: `theirs-${index}`,
                retained: `ours-${index}`,
                discarded: `theirs-${index}`,
              },
            ],
          }),
        ),
      ]);
      const dirty = await readWorkspacePosition({ path: context.pmPath });
      expect(dirty).toMatchObject({
        ok: false,
        state: "merge_reconciliation_required",
        merge_receipts: {
          pending_decision_count: 26,
          pending_item_ids_truncated: true,
        },
        history_drift: {
          drifted_item_count: 1,
          drifted_item_ids: ["pm-drift"],
        },
      });
      expect(dirty.warnings.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("selects one deterministic recovery action by evidence priority", () => {
    const base = {
      invalidEvidenceCount: 0,
      pendingDecisionCount: 0,
      driftedItemCount: 0,
      fence: cleanFence,
      drivers: cleanDrivers,
    };
    const cases = [
      [
        { ...base, invalidEvidenceCount: 1 },
        "merge_evidence_invalid",
        "pm merge report",
      ],
      [
        { ...base, pendingDecisionCount: 1 },
        "merge_reconciliation_required",
        "pm merge reconcile",
      ],
      [
        { ...base, driftedItemCount: 1 },
        "history_repair_required",
        "pm history-repair --all",
      ],
      [
        { ...base, drivers: null },
        "merge_fence_unprepared",
        "pm merge install",
      ],
      [base, "ready", null],
    ] as const;
    for (const [input, expectedState, expectedCommand] of cases) {
      const state =
        _testOnlyWorkspacePosition.selectWorkspacePositionState(input);
      expect(state).toBe(expectedState);
      expect(
        _testOnlyWorkspacePosition.commandForWorkspacePositionState(
          state,
          "/tmp/inspected workspace/.agents/pm",
          "linux",
        ),
      ).toBe(
        expectedCommand === null
          ? null
          : `pm --pm-path "/tmp/inspected workspace/.agents/pm" ${expectedCommand.slice(3)}`,
      );
    }
  });

  it("shell-quotes the exact inspected tracker in every recovery action", () => {
    expect(
      _testOnlyWorkspacePosition.commandForWorkspacePositionState(
        "merge_fence_unprepared",
        "/tmp/review's tracker/.agents/pm",
        "linux",
      ),
    ).toBe(
      `pm --pm-path "/tmp/review's tracker/.agents/pm" merge install`,
    );
    expect(
      _testOnlyWorkspacePosition.commandForWorkspacePositionState(
        "merge_fence_unprepared",
        "C:\\review & tracker\\.agents\\pm",
        "win32",
      ),
    ).toBe(
      `pm --pm-path "C:\\review & tracker\\.agents\\pm" merge install`,
    );
  });

  it("treats committed-fence drift as unprepared", () => {
    expect(
      _testOnlyWorkspacePosition.selectWorkspacePositionState({
        invalidEvidenceCount: 0,
        pendingDecisionCount: 0,
        driftedItemCount: 0,
        fence: { ...cleanFence, status: "drift" },
        drivers: cleanDrivers,
      }),
    ).toBe("merge_fence_unprepared");
    expect(
      _testOnlyWorkspacePosition.selectWorkspacePositionState({
        invalidEvidenceCount: 0,
        pendingDecisionCount: 0,
        driftedItemCount: 0,
        fence: cleanFence,
        drivers: { ...cleanDrivers, status: "drift" },
      }),
    ).toBe("merge_fence_unprepared");
  });

  it("renders a concise human readiness summary", () => {
    const result: WorkspacePositionResult = {
      ok: true,
      state: "ready",
      merge_fence: {
        committed: cleanFence,
        clone_local_drivers: cleanDrivers,
      },
      merge_receipts: {
        pending_decision_count: 0,
        pending_item_ids: [],
        pending_item_ids_truncated: false,
        lossless_count: 0,
        invalid_evidence_count: 0,
      },
      history_drift: {
        drifted_item_count: 0,
        drifted_item_ids: [],
        drifted_item_ids_truncated: false,
        counts: {},
      },
      next_action: { command: null, reason: "ready" },
      warnings: [],
      generated_at: "2026-08-30T00:00:00.000Z",
    };
    expect(formatWorkspacePositionHuman(result)).toContain(
      "workspace_position: ready",
    );
    expect(
      formatWorkspacePositionHuman({
        ...result,
        ok: false,
        state: "merge_fence_unprepared",
        merge_fence: { ...result.merge_fence, clone_local_drivers: null },
        next_action: {
          command: "pm merge install",
          reason: "merge_fence_unprepared",
        },
      }),
    ).toContain("clone_local_drivers: unavailable");
  });
});
