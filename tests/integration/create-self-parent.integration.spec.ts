import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectJsonErrorEnvelope } from "../helpers/jsonErrorEnvelope.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("self-parent guard", () => {
  it("rejects explicit-id self-parent writes through the built CLI", async () => {
    await withTempPmPath(async (context) => {
      const result = context.runCli([
        "create",
        "--json",
        "--id",
        "cli-self-parent",
        "--parent",
        "CLI-SELF-PARENT",
        "--title",
        "self-parent should fail",
        "--type",
        "Task",
        "--create-mode",
        "progressive",
      ]);

      expect(result.code).toBe(2);
      const envelope = expectJsonErrorEnvelope(result.stderr, {
        type: "urn:pm-cli:error:command_failed",
        code: "command_failed",
        exit_code: 2,
      });
      expect(envelope.detail).toContain('Parent item "pm-cli-self-parent" cannot be the same as item');

      const taskFiles = await readdir(path.join(context.pmPath, "tasks"));
      expect(taskFiles.some((fileName) => fileName.includes("pm-cli-self-parent"))).toBe(false);
    });
  });

  it("rejects update self-parent writes through the built CLI", async () => {
    await withTempPmPath(async (context) => {
      const parent = context.runCli(
        [
          "create",
          "--json",
          "--id",
          "cli-update-parent",
          "--title",
          "parent",
          "--type",
          "Task",
          "--create-mode",
          "progressive",
        ],
        { expectJson: true },
      );
      expect(parent.code).toBe(0);

      const child = context.runCli(
        [
          "create",
          "--json",
          "--id",
          "cli-update-child",
          "--parent",
          "cli-update-parent",
          "--title",
          "child",
          "--type",
          "Task",
          "--create-mode",
          "progressive",
        ],
        { expectJson: true },
      );
      expect(child.code).toBe(0);

      const result = context.runCli(["update", "pm-cli-update-child", "--json", "--parent", "CLI-UPDATE-CHILD"]);

      expect(result.code).toBe(2);
      const envelope = expectJsonErrorEnvelope(result.stderr, {
        type: "urn:pm-cli:error:command_failed",
        code: "command_failed",
        exit_code: 2,
      });
      expect(envelope.detail).toContain('Parent item "pm-cli-update-child" cannot be the same as item');

      const loaded = context.runCli(["get", "pm-cli-update-child", "--json"], { expectJson: true });
      expect(loaded.code).toBe(0);
      const payload = JSON.parse(loaded.stdout) as { item?: { parent?: string } };
      expect(payload.item?.parent).toBe("cli-update-parent");
    });
  });
});
