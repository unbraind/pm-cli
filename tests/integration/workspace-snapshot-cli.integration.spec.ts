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
        (named.json as { manifest: { fingerprint: string } }).manifest.fingerprint,
      ).toBe(fingerprint);

      const inspected = await context.runCliInProcess(
        ["workspace", "snapshot", "inspect", "baseline", "--json"],
        { expectJson: true },
      );
      expect(
        (inspected.json as { fingerprint: string }).fingerprint,
      ).toBe(fingerprint);

      const restored = await context.runCliInProcess(
        ["workspace", "snapshot", "restore", "baseline", "--json"],
        { expectJson: true },
      );
      expect(restored.code).toBe(0);

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
      const ambiguous = await context.runCliInProcess(["list", "--all"]);
      expect(ambiguous.code).not.toBe(0);
      expect(ambiguous.stderr).toContain("list --status all --no-truncate");

      const missingTarget = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "inspect",
      ]);
      expect(missingTarget.code).not.toBe(0);
      expect(missingTarget.stderr).toContain("requires a snapshot name");

      const unknown = await context.runCliInProcess([
        "workspace",
        "snapshot",
        "unknown",
        "baseline",
      ]);
      expect(unknown.code).not.toBe(0);
      expect(unknown.stderr).toContain("Unknown workspace snapshot action");
    });
  });
});
