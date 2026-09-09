import { describe, expect, it } from "vitest";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("canonical bulk lifecycle commands", () => {
  it("selects native bulk updates from stdin and keeps unselected items untouched", async () => {
    await withTempPmPath(async (context) => {
      const selected = createTestItemId(context, { title: "stdin selected", createMode: "progressive", priority: 2 });
      const other = createTestItemId(context, { title: "stdin excluded", createMode: "progressive", priority: 3 });
      const changed = context.runCli(["--no-extensions", "update", "many", "--ids", "-", "--priority", "1", "--json"], { input: selected + "\n", expectJson: true });
      expect(changed.code, changed.stderr).toBe(0);
      expect(context.runCli(["get", selected, "--json"], { expectJson: true }).json).toMatchObject({ item: { priority: 1 } });
      expect(context.runCli(["get", other, "--json"], { expectJson: true }).json).toMatchObject({ item: { priority: 3 } });
    });
  });

  it("preserves dry-run parity, real updates, close evidence, and deletion recovery", async () => {
    await withTempPmPath(async (context) => {
      context.env.PM_CLOCK = "2026-09-09T00:00:00.000Z";
      context.env.PM_SEED = "bulk-lifecycle-acceptance";
      context.env.PM_CLOCK_TICK_MS = "0";
      const id = createTestItemId(context, { title: "Bulk lifecycle acceptance", priority: 2, createMode: "progressive" });
      for (const [noun, legacy, flags] of [
        ["update", "update-many", ["--priority", "1"]],
        ["close", "close-many", ["--reason", "Acceptance verified", "--validate-close", "warn"]],
      ] as const) {
        const args = ["--ids", id, ...flags, "--dry-run", "--json"];
        const native = context.runCli([noun, "many", ...args], { expectJson: true });
        const compatible = context.runCli([legacy, ...args], { expectJson: true });
        expect(native.code, native.stderr).toBe(0);
        expect(compatible.code, compatible.stderr).toBe(0);
        expect(native.json).toEqual(compatible.json);
        const changed = context.runCli([noun, "many", "--ids", id, ...flags, "--json"], { expectJson: true });
        expect(changed.code, JSON.stringify(changed)).toBe(0);
      }
      const closed = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(closed.json).toMatchObject({ item: { status: "closed", priority: 1, close_reason: "Acceptance verified" } });
      const preview = context.runCli(["close", "delete", id, "--dry-run", "--json"], { expectJson: true });
      expect(preview.code, preview.stderr).toBe(0);
      expect(context.runCli(["get", id, "--json"]).code).toBe(0);
      const deleted = context.runCli(["close", "delete", id, "--json"], { expectJson: true });
      expect(deleted.code, deleted.stderr).toBe(0);
      expect(deleted.json).toMatchObject({ deleted: true });
      const restored = context.runCli(["history", "restore", id, "1", "--json"]);
      expect(restored.code, restored.stderr).toBe(0);
      expect(context.runCli(["history", id, "--verify", "--strict-exit"]).code).toBe(0);
    });
  });
});
