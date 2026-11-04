import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("config positional CLI parser", () => {
  it("accepts telemetry local-analytics as a backward-compatible subcommand namespace", async () => {
    await withTempPmPath(async (context) => {
      const status = context.runCli(["telemetry", "local-analytics", "status", "--json"], { expectJson: true });
      expect(status.code).toBe(0);
      expect(status.json).toMatchObject({
        action: "telemetry",
        subcommand: "status",
      });
    });
  });

  it("accepts config set values through the real CLI positional parser", async () => {
    await withTempPmPath(async (context) => {
      const telemetry = context.runCli(["config", "set", "telemetry-tracking", "off", "--json"], { expectJson: true });
      expect(telemetry.code).toBe(0);
      expect((telemetry.json as { policy?: string; changed?: boolean }).policy).toBe("disabled");
      expect((telemetry.json as { changed?: boolean }).changed).toBe(true);
      // GH-1660: the documented scope-less opt-out targets the global profile, where consent is read.
      expect((telemetry.json as { scope?: string }).scope).toBe("global");
      const status = context.runCli(["ops", "telemetry", "status", "--json"], { expectJson: true });
      expect((status.json as { status?: { configured_enabled?: boolean } }).status?.configured_enabled).toBe(false);

      const format = context.runCli(["config", "project", "set", "item-format", "toon", "--json"], { expectJson: true });
      expect(format.code).toBe(0);
      expect((format.json as { format?: string }).format).toBe("toon");

      const criterion = context.runCli(["config", "set", "definition-of-done", "Tests pass", "--json"], { expectJson: true });
      expect(criterion.code).toBe(0);
      expect((criterion.json as { criteria?: string[] }).criteria).toEqual(["Tests pass"]);
    });
  });
});
