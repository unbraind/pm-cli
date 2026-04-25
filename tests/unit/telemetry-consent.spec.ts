import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maybeRunFirstUseTelemetryPrompt } from "../../src/core/telemetry/consent.js";

const originalGlobalPath = process.env.PM_GLOBAL_PATH;

async function withTempGlobalRoot(run: (globalRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-telemetry-consent-test-"));
  const globalRoot = path.join(tempRoot, ".pm-cli");
  process.env.PM_GLOBAL_PATH = globalRoot;
  try {
    await run(globalRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("core/telemetry/consent", () => {
  afterEach(() => {
    if (originalGlobalPath === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = originalGlobalPath;
    }
  });

  it("skips prompt and leaves settings untouched in non-interactive environments", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
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
