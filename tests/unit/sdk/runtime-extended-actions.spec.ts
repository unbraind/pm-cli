import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorkspaceSnapshot: vi.fn(),
  deleteWorkspaceSnapshot: vi.fn(),
  inspectWorkspaceSnapshot: vi.fn(),
  listMutationEvents: vi.fn(),
  listWorkspaceSnapshots: vi.fn(),
  planWorkspaceSnapshotRestore: vi.fn(),
  restoreWorkspaceSnapshotWithRecovery: vi.fn(),
  runEval: vi.fn(),
  runEvent: vi.fn(),
  runMeet: vi.fn(),
  runMergeDriver: vi.fn(),
  runMergeInstall: vi.fn(),
  runMergeReceiptReport: vi.fn(),
  runMergeReconcile: vi.fn(),
  runRemind: vi.fn(),
}));

vi.mock("../../../src/sdk/eval.js", () => ({ runEval: mocks.runEval }));
vi.mock("../../../src/sdk/mutation-events.js", () => ({
  listMutationEvents: mocks.listMutationEvents,
}));
vi.mock("../../../src/sdk/merge/driver.js", () => ({
  runMergeDriver: mocks.runMergeDriver,
}));
vi.mock("../../../src/sdk/merge/install.js", () => ({
  runMergeInstall: mocks.runMergeInstall,
}));
vi.mock("../../../src/sdk/merge/reconcile.js", () => ({
  runMergeReconcile: mocks.runMergeReconcile,
}));
vi.mock("../../../src/sdk/merge/receipts.js", () => ({
  runMergeReceiptReport: mocks.runMergeReceiptReport,
}));
vi.mock("../../../src/sdk/scheduling-shortcuts.js", () => ({
  runEvent: mocks.runEvent,
  runMeet: mocks.runMeet,
  runRemind: mocks.runRemind,
}));
vi.mock("../../../src/sdk/workspace-snapshot.js", () => ({
  createWorkspaceSnapshot: mocks.createWorkspaceSnapshot,
  deleteWorkspaceSnapshot: mocks.deleteWorkspaceSnapshot,
  inspectWorkspaceSnapshot: mocks.inspectWorkspaceSnapshot,
  listWorkspaceSnapshots: mocks.listWorkspaceSnapshots,
  planWorkspaceSnapshotRestore: mocks.planWorkspaceSnapshotRestore,
  restoreWorkspaceSnapshotWithRecovery:
    mocks.restoreWorkspaceSnapshotWithRecovery,
}));

import {
  runRuntimeEvalAction,
  runRuntimeEventsAction,
  runRuntimeMergeAction,
  runRuntimeSchedulingAction,
  runRuntimeWorkspaceAction,
  type RuntimeExtendedActionContext,
} from "../../../src/sdk/runtime-extended-actions.js";

function context(
  action: string,
  args: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
): RuntimeExtendedActionContext {
  return {
    action,
    args,
    options,
    global: { path: "/tmp/runtime-extended-actions/.agents/pm" },
  };
}

describe("runtime extended action adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mocks))
      mock.mockResolvedValue({ ok: true });
  });

  it("merges eval and bounded event inputs", async () => {
    await runRuntimeEvalAction(
      context("eval", { mode: "keyword", k: 5 }, { k: 10 }),
    );
    expect(mocks.runEval).toHaveBeenCalledWith(
      { mode: "keyword", k: 10 },
      expect.objectContaining({ path: expect.any(String) }),
    );

    await runRuntimeEventsAction(
      context(
        "events",
        { cwd: "/tmp/project", path: "/tmp/project/.agents/pm" },
        {
          since: "2026-08-01T00:00:00.000Z",
          type: ["create", "update"],
          author: "agent",
          item: ["pm-a"],
          limit: 12,
          full: true,
        },
      ),
    );
    expect(mocks.listMutationEvents).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      pmRoot: "/tmp/project/.agents/pm",
      since: "2026-08-01T00:00:00.000Z",
      type: ["create", "update"],
      author: ["agent"],
      item: ["pm-a"],
      limit: 12,
      full: true,
    });
  });

  it("dispatches every merge subcommand and rejects unknown or incomplete input", async () => {
    await runRuntimeMergeAction(
      context("merge", {}, { subcommand: "install", dryRun: true }),
    );
    expect(mocks.runMergeInstall).toHaveBeenCalledWith(
      { dryRun: true },
      expect.any(Object),
    );

    await runRuntimeMergeAction(
      context(
        "merge",
        {},
        {
          subcommand: "reconcile",
          author: "agent",
          message: "repair",
          force: true,
        },
      ),
    );
    expect(mocks.runMergeReconcile).toHaveBeenCalledWith(
      {
        dryRun: false,
        author: "agent",
        message: "repair",
        force: true,
      },
      expect.any(Object),
    );

    await runRuntimeMergeAction(
      context(
        "merge",
        {},
        {
          subcommand: "report",
          includeReconciled: true,
          cwd: "/tmp/project",
        },
      ),
    );
    expect(mocks.runMergeReceiptReport).toHaveBeenCalledWith({
      includeReconciled: true,
      cwd: "/tmp/project",
    });

    await runRuntimeMergeAction(
      context(
        "merge",
        {},
        {
          subcommand: "driver",
          artifact: "item",
          basePath: "base",
          oursPath: "ours",
          theirsPath: "theirs",
          output: "merged",
          itemPath: "item.toon",
          prefer: "theirs",
        },
      ),
    );
    expect(mocks.runMergeDriver).toHaveBeenCalledWith(
      {
        artifact: "item",
        basePath: "base",
        oursPath: "ours",
        theirsPath: "theirs",
        outputPath: "merged",
        itemPath: "item.toon",
        prefer: "theirs",
      },
      expect.any(Object),
    );

    expect(() =>
      runRuntimeMergeAction(context("merge", {}, { subcommand: "unknown" })),
    ).toThrow(expect.objectContaining({ code: "unknown_subcommand" }));
    expect(() => runRuntimeMergeAction(context("merge"))).toThrow(
      "Missing required parameter: subcommand",
    );
  });

  it("dispatches every workspace snapshot action with guarded restore controls", async () => {
    await runRuntimeWorkspaceAction(
      context(
        "workspace",
        {},
        {
          subcommand: "snapshot",
          snapshot_action: "create",
          name: "proof",
        },
      ),
    );
    expect(mocks.createWorkspaceSnapshot).toHaveBeenCalledWith(
      expect.stringContaining("runtime-extended-actions/.agents/pm"),
      { name: "proof" },
    );

    await runRuntimeWorkspaceAction(
      context(
        "workspace",
        {},
        {
          subcommand: "snapshot",
          snapshotAction: "list",
        },
      ),
    );
    expect(mocks.listWorkspaceSnapshots).toHaveBeenCalledOnce();

    for (const [snapshotAction, mock] of [
      ["inspect", mocks.inspectWorkspaceSnapshot],
      ["delete", mocks.deleteWorkspaceSnapshot],
    ] as const) {
      await runRuntimeWorkspaceAction(
        context(
          "workspace",
          {},
          {
            subcommand: "snapshot",
            snapshotAction,
            target: "proof",
          },
        ),
      );
      expect(mock).toHaveBeenCalledWith(expect.any(String), "proof");
    }

    await runRuntimeWorkspaceAction(
      context(
        "workspace",
        {},
        {
          subcommand: "snapshot",
          snapshotAction: "restore",
          target: "proof",
          dryRun: true,
        },
      ),
    );
    expect(mocks.planWorkspaceSnapshotRestore).toHaveBeenCalledOnce();

    await runRuntimeWorkspaceAction(
      context(
        "workspace",
        {},
        {
          subcommand: "snapshot",
          snapshotAction: "restore",
          target: "proof",
          force: true,
          author: "agent",
          message: "restore",
          lockTtlSeconds: "30",
          lockWaitMs: 500,
        },
      ),
    );
    expect(mocks.restoreWorkspaceSnapshotWithRecovery).toHaveBeenCalledWith(
      expect.any(String),
      "proof",
      {
        force: true,
        author: "agent",
        message: "restore",
        lockTtlSeconds: 30,
        lockWaitMs: 500,
      },
    );

    expect(() =>
      runRuntimeWorkspaceAction(
        context("workspace", {}, { subcommand: "unknown" }),
      ),
    ).toThrow(expect.objectContaining({ code: "unknown_subcommand" }));
    expect(() =>
      runRuntimeWorkspaceAction(
        context(
          "workspace",
          {},
          {
            subcommand: "snapshot",
            snapshotAction: "unknown",
            target: "proof",
          },
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "unknown_subcommand" }));
  });

  it("dispatches every SDK-owned scheduling shortcut", async () => {
    await runRuntimeSchedulingAction(
      context("meet", { title: "Meeting" }, { start: "now" }),
    );
    expect(mocks.runMeet).toHaveBeenCalledWith(
      "Meeting",
      { title: "Meeting", start: "now" },
      expect.any(Object),
    );

    await runRuntimeSchedulingAction(
      context("event", { title: "Event" }, { duration: "1h" }),
    );
    expect(mocks.runEvent).toHaveBeenCalledOnce();

    await runRuntimeSchedulingAction(
      context("remind", { title: "Reminder" }, { at: "+1d" }),
    );
    expect(mocks.runRemind).toHaveBeenCalledOnce();

    expect(() => runRuntimeSchedulingAction(context("meet"))).toThrow(
      "Missing required parameter: title",
    );
  });
});
