/** @module Verify installed completion helpers preserve their shell word protocol. */
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("installed completion helper protocol", () => {
  it("emits plain words for both command paths and retains explicit JSON", async () => {
    await withTempPmPath(async (context) => {
      expect(context.runCli(["package", "install", "guide-shell", "--project"]).code).toBe(0);
      expect(context.runCli(["create", "--title", "Completion data", "--type", "Task", "--status", "open", "--tags", "wire-🚀"]).code).toBe(0);
      for (const [noun, required] of [["types", "Task"], ["statuses", "open"], ["tags", "wire-🚀"]]) {
        for (const command of [["completion", noun], [`completion-${noun}`]]) {
          const words = context.runCli(command);
          expect(words.code).toBe(0);
          expect(words.stdout.trim().split(/\s+/u)).toContain(required);
          expect(words.stdout).not.toContain("count:");
          const json = context.runCli([...command, "--json"], { expectJson: true });
          expect(json.code).toBe(0);
          expect(json.json).toMatchObject({ [noun]: expect.arrayContaining([required]) });
        }
      }
    });
  });
});
