import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("deprecated command alias usage", () => {
  it("counts a resolved alias locally and leaves canonical invocations uncounted", async () => {
    await withTempPmPath(async (context) => {
      const globalRoot = context.env.PM_GLOBAL_PATH!;
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = true;
      settings.telemetry.endpoint = "";
      await writeSettings(globalRoot, settings, "test:alias_usage");
      Object.assign(context.env, {
        PM_TELEMETRY_DISABLED: "0",
        PM_NO_TELEMETRY: "0",
        DO_NOT_TRACK: "0",
        PM_TELEMETRY_SEND_TEST_EVENTS: "1",
      });

      const deprecated = context.runCli(["list-open", "--json"], { expectJson: true });
      expect(deprecated.code).toBe(0);
      const canonical = context.runCli(["list", "--status", "open", "--json"], { expectJson: true });
      expect(canonical.code).toBe(0);
      const permanent = context.runCli(["extension", "list", "--json"], { expectJson: true });
      expect(permanent.code).toBe(0);
      context.env.PM_TELEMETRY_DISABLED = "1";
      expect(context.runCli(["list-open", "--json"], { expectJson: true }).code).toBe(0);
      context.env.PM_TELEMETRY_DISABLED = "0";

      const stats = context.runCli(["telemetry", "stats", "--json"], { expectJson: true }).json as {
        alias_usage: Array<{ alias: string; canonical: string; count: number; last_seen: string }>;
        zero_use_aliases: string[];
      };
      expect(stats.alias_usage).toEqual([{
        alias: "list-open", canonical: "list", count: 1,
        last_seen: expect.any(String),
      }]);
      expect(stats.zero_use_aliases).not.toContain("list-open");
      expect(stats.alias_usage.map((entry) => entry.alias)).not.toContain("extension");
      const state = JSON.parse(await readFile(path.join(globalRoot, "runtime", "telemetry", "state.json"), "utf8")) as Record<string, unknown>;
      expect(state.alias_usage).toBeDefined();
    });
  });
});
