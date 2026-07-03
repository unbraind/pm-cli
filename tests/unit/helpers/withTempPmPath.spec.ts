import { describe, expect, it } from "vitest";
import { applyTempPmEnv, TEMP_PM_ENV_KEYS } from "../../helpers/withTempPmPath.js";

describe("withTempPmPath env helpers", () => {
  it("deletes missing temp env keys instead of assigning undefined", () => {
    const previousEnv = new Map(TEMP_PM_ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
      process.env.PM_PATH = "stale-path";
      applyTempPmEnv({
        PM_GLOBAL_PATH: "/tmp/pm-global",
        PM_AUTHOR: "test-author",
        PM_TELEMETRY_DISABLED: "1",
        PM_TELEMETRY_OTEL_DISABLED: "1",
        PM_TELEMETRY_PROMPT: "0",
        PM_DISABLE_OLLAMA_AUTO_DEFAULTS: "1",
        FORCE_COLOR: "0",
      });

      expect(process.env.PM_PATH).toBeUndefined();
      expect(process.env.PM_GLOBAL_PATH).toBe("/tmp/pm-global");
      expect(process.env.FORCE_COLOR).toBe("0");
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
