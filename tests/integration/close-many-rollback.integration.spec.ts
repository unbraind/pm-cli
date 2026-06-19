import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface CloseManyApplyResult {
  mode: string;
  matched_count: number;
  closed_count: number;
  checkpoint: { id: string; rollback_command: string };
  ids: string[];
}

interface CloseManyRollbackResult {
  mode: string;
  restored_count: number;
  failed_count: number;
  rollback_checkpoint_id: string;
  ids: string[];
}

/**
 * End-to-end coverage for `pm close-many --rollback <checkpoint-id>` (pm-7p4w).
 * Unit tests assert that close-many emits a rollback checkpoint, but the restore
 * path — replaying the checkpoint to reopen the bulk-closed items — was only
 * exercisable through the integration boundary. This test drives the full
 * create -> close-many -> capture checkpoint -> rollback -> verify-restored
 * cycle against a sandboxed PM_PATH.
 */
describe("close-many rollback", () => {
  it("restores bulk-closed items to their pre-close state from the checkpoint", async () => {
    await withTempPmPath(async (context) => {
      const createIds = ["Alpha", "Bravo"].map((title) => {
        const created = context.runCli(["create", "Task", title, "--tags", "batch", "--json"], { expectJson: true });
        expect(created.code).toBe(0);
        return (created.json as { item: { id: string } }).item.id;
      });

      // A third item outside the filter must remain untouched throughout.
      const untouched = context.runCli(["create", "Task", "Charlie", "--tags", "other", "--json"], {
        expectJson: true,
      });
      expect(untouched.code).toBe(0);
      const untouchedId = (untouched.json as { item: { id: string } }).item.id;

      const apply = context.runCli(["close-many", "--filter-tag", "batch", "--reason", "batch done", "--json"], {
        expectJson: true,
      });
      expect(apply.code).toBe(0);
      const applyResult = apply.json as CloseManyApplyResult;
      expect(applyResult).toMatchObject({ mode: "apply", matched_count: 2, closed_count: 2 });
      expect(applyResult.ids.sort()).toEqual([...createIds].sort());
      const checkpointId = applyResult.checkpoint.id;
      expect(checkpointId).toMatch(/^close-many-/);
      expect(applyResult.checkpoint.rollback_command).toBe(`pm close-many --rollback ${checkpointId}`);

      for (const id of createIds) {
        const closed = context.runCli(["get", id, "--json"], { expectJson: true });
        expect(closed.code).toBe(0);
        expect((closed.json as { item: { status: string } }).item.status).toBe("closed");
      }

      const rollback = context.runCli(["close-many", "--rollback", checkpointId, "--json"], { expectJson: true });
      expect(rollback.code).toBe(0);
      const rollbackResult = rollback.json as CloseManyRollbackResult;
      expect(rollbackResult).toMatchObject({
        mode: "rollback",
        restored_count: 2,
        failed_count: 0,
        rollback_checkpoint_id: checkpointId,
      });
      expect(rollbackResult.ids.sort()).toEqual([...createIds].sort());

      for (const id of createIds) {
        const restored = context.runCli(["get", id, "--json"], { expectJson: true });
        expect(restored.code).toBe(0);
        expect((restored.json as { item: { status: string; close_reason?: string } }).item.status).toBe("open");
        expect((restored.json as { item: { close_reason?: string } }).item.close_reason).toBeUndefined();
      }

      const charlie = context.runCli(["get", untouchedId, "--json"], { expectJson: true });
      expect(charlie.code).toBe(0);
      expect((charlie.json as { item: { status: string } }).item.status).toBe("open");
    });
  });
});
