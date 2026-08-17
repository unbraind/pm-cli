import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("workspace snapshot CLI integration", () => {
  it("runs the complete snapshot lifecycle through the in-process CLI", async () => {
    await withTempPmPath(async (context) => {
      const empty = await context.runCliInProcess(
        ["workspace", "snapshot", "list", "--json"],
        { expectJson: true },
      );
      expect(empty.code).toBe(0);
      expect(empty.json).toEqual({ objects: [], references: [] });

      const unnamed = await context.runCliInProcess(
        ["workspace", "snapshot", "create", "--json"],
        { expectJson: true },
      );
      expect(unnamed.code).toBe(0);
      const fingerprint = (
        unnamed.json as { manifest: { fingerprint: string } }
      ).manifest.fingerprint;

      const named = await context.runCliInProcess(
        ["workspace", "snapshot", "create", "baseline", "--json"],
        { expectJson: true },
      );
      expect(named.code).toBe(0);
      expect(
        (named.json as { manifest: { fingerprint: string } }).manifest
          .fingerprint,
      ).toBe(fingerprint);

      const inspected = await context.runCliInProcess(
        ["workspace", "snapshot", "inspect", "baseline", "--json"],
        { expectJson: true },
      );
      expect((inspected.json as { fingerprint: string }).fingerprint).toBe(
        fingerprint,
      );

      const preview = await context.runCliInProcess(
        ["workspace", "snapshot", "restore", "baseline", "--dry-run", "--json"],
        { expectJson: true },
      );
      expect(preview.code).toBe(0);
      expect(
        (preview.json as { target_fingerprint: string }).target_fingerprint,
      ).toBe(fingerprint);

      const unconfirmed = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "restore",
        "baseline",
        "--json",
      ]);
      expect(unconfirmed.code).not.toBe(0);
      expect(unconfirmed.stderr).toContain("requires explicit force");

      const restored = await context.runCliInProcess(
        [
          "workspace",
          "snapshot",
          "restore",
          "baseline",
          "--force",
          "--author",
          "snapshot-cli-test",
          "--message",
          "CLI integration restore",
          "--json",
        ],
        { expectJson: true },
      );
      expect(restored.code).toBe(0);
      expect(
        (restored.json as { audit_operation: string }).audit_operation,
      ).toBe("workspace_snapshot_restore");
      const defaultAuthorRestore = await context.runCliInProcess(
        ["workspace", "snapshot", "restore", "baseline", "--force", "--json"],
        { expectJson: true },
      );
      expect(defaultAuthorRestore.code).toBe(0);

      const deletedReference = await context.runCliInProcess(
        ["workspace", "snapshot", "delete", "baseline", "--json"],
        { expectJson: true },
      );
      expect(deletedReference.json).toEqual({
        deleted: "reference",
        target: "baseline",
      });
      const deletedObject = await context.runCliInProcess(
        ["workspace", "snapshot", "delete", fingerprint, "--json"],
        { expectJson: true },
      );
      expect(deletedObject.code).toBe(0);
    });
  });

  it("reports actionable list and snapshot usage failures", async () => {
    await withTempPmPath(async (context) => {
      const allStatuses = await context.runCliInProcess(
        ["list", "--all", "--json"],
        { expectJson: true },
      );
      expect(allStatuses.code).toBe(0);
      expect(allStatuses.json).toMatchObject({
        count: 0,
        total: 0,
        filters: { status: "all" },
      });

      const missingTarget = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "inspect",
      ]);
      expect(missingTarget.code).not.toBe(0);
      expect(missingTarget.stderr).toContain("requires a snapshot name");

      const invalidTarget = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "inspect",
        "INVALID TARGET",
        "--json",
      ]);
      expect(invalidTarget.code).toBe(2);
      expect(JSON.parse(invalidTarget.stderr)).toMatchObject({
        code: "invalid_workspace_snapshot_target",
        exit_code: 2,
        recovery: {
          suggested_retry: "pm workspace snapshot list --json",
        },
      });

      const unknown = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "unknown",
        "baseline",
      ]);
      expect(unknown.code).not.toBe(0);
      expect(unknown.stderr).toContain("Unknown workspace snapshot action");

      const unknownWithoutTarget = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "unknown",
      ]);
      expect(unknownWithoutTarget.code).not.toBe(0);
      expect(unknownWithoutTarget.stderr).toContain(
        "Unknown workspace snapshot action",
      );

      const whitespace = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "   ",
        "--json",
      ]);
      expect(whitespace.code).toBe(2);
      expect(JSON.parse(whitespace.stderr)).toMatchObject({
        code: "unknown_subcommand",
        recovery: { attempted_command: 'pm workspace snapshot "<empty>"' },
      });
    });
  });
});
