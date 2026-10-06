import { describe, expect, it, vi } from "vitest";
import { readSettings } from "../../../src/core/store/settings.js";
import {
  applyTempPmEnv,
  TEMP_PM_ENV_KEYS,
  withTempPmPath,
} from "../../helpers/withTempPmPath.js";

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

  it("keeps fresh initialization author attribution representative", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await expect(readSettings(pmPath)).resolves.toMatchObject({
        author_default: "test-author",
      });
    });
  });

  it.each([
    { debug: "1", failed: true, notification: true },
    { debug: "0", failed: true, notification: false },
    { debug: "1", failed: false, notification: false },
  ])("keeps worker diagnostics private with debug=$debug and failed=$failed", async ({ debug, failed, notification }) => {
    vi.stubEnv("PM_TEST_CLI_BRIDGE_DEBUG", debug);
    vi.stubEnv("PM_TEST_CLI_RUNNER", "bridge");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withTempPmPath(async ({ runCli }) => {
        const privateArgument = "pm-private-debug-example";
        const result = runCli(failed ? [privateArgument] : ["--version"]);
        expect(result.status).toBe(failed ? 2 : 0);
        if (failed) {
          // The real CLI still returns the private input to its caller. Only
          // the bridge's automatic log broadcast must exclude it.
          expect(result.stderr).toContain(privateArgument);
        } else {
          expect(result.stdout.trim()).toMatch(/^\d{4}\.\d+\.\d+$/u);
          expect(result.stderr).toBe("");
        }
        expect(diagnostic.mock.calls).toEqual(notification ? [[
          "[cli-bridge] CLI invocation failed; inspect the returned result for its exit status and captured stderr.",
        ]] : []);
      });
    } finally {
      diagnostic.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
