import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maybeRunFirstUseTelemetryPrompt } from "../../src/core/telemetry/consent.js";
import { withTempGlobalRoot } from "../helpers/temp.js";

const originalGlobalPath = process.env.PM_GLOBAL_PATH;

describe("core/telemetry/consent", () => {
  afterEach(() => {
    if (originalGlobalPath === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = originalGlobalPath;
    }
  });

  it("skips prompt and leaves settings untouched in non-interactive environments", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-consent-test-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await maybeRunFirstUseTelemetryPrompt("init", {
        json: false,
        quiet: false,
        noExtensions: false,
        noPager: false,
        profile: false,
      });

      await expect(fs.access(path.join(globalRoot, "settings.json"))).rejects.toBeDefined();
    });
  });
});
