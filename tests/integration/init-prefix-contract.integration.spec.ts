import { describe, expect, it } from "vitest";
import { PmClient } from "../../src/sdk/runtime.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("init id-prefix contract", () => {
  it("persists a create-safe canonical prefix across CLI and SDK-backed create", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({
        pmRoot: context.pmPath,
        noExtensions: true,
      });
      const sdkInitialized = await client.init("SDK natural prefix", {
        force: true,
        agentGuidance: "skip",
      });
      expect(sdkInitialized.settings.id_prefix).toBe("sdk-natural-prefix-");
      const sdkCreated = await client.create({
        title: "SDK task",
        type: "Task",
        status: "open",
        createMode: "progressive",
      });
      expect(sdkCreated.item.id).toMatch(/^sdk-natural-prefix-[a-z0-9]+$/u);

      const initialized = context.runCli(
        [
          "init",
          "packed extension acceptance",
          "--force",
          "--agent-guidance",
          "skip",
          "--json",
        ],
        { expectJson: true },
      ).json as { settings: { id_prefix: string } };

      expect(initialized.settings.id_prefix).toBe(
        "packed-extension-acceptance-",
      );
      const created = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "First task",
          "--type",
          "Task",
          "--status",
          "open",
          "--json",
        ],
        { expectJson: true },
      ).json as { item: { id: string } };
      expect(created.item.id).toMatch(/^packed-extension-acceptance-[a-z0-9]+$/u);
    });
  });
});
