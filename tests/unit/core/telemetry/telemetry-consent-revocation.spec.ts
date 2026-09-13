import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSettings, writeSettings } from "../../../../src/core/store/settings.js";
import { finishTelemetryCommand, startTelemetryCommand, waitForPendingFlush } from "../../../../src/core/telemetry/runtime.js";
import { runTelemetry } from "../../../../src/sdk/telemetry.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

afterEach(async () => { await waitForPendingFlush(); vi.unstubAllEnvs(); });

it.each(["clear", "disable", "clear-reenable"])("stops deferred lifecycle capture after %s revokes its installation", async (mode) => {
  await withTempGlobalRoot("pm-telemetry-revoke-", async (root) => {
    for (const [key, value] of Object.entries({
      PM_GLOBAL_PATH: root,
      PM_TELEMETRY_SEND_TEST_EVENTS: "1", DO_NOT_TRACK: "0",
      PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0",
      PM_TELEMETRY_OTEL_DISABLED: "1", PM_TELEMETRY_INLINE_FLUSH: "1",
      PM_TELEMETRY_READ_SAMPLE_RATE: "0.1",
    })) vi.stubEnv(key, value);
    const settings = await readSettings(root);
    settings.telemetry.enabled = true;
    settings.telemetry.endpoint = "";
    await writeSettings(root, settings, "test:enable");
    const active = await startTelemetryCommand({ command: "list", pm_version: "fixture", args: [], options: {}, global: { noExtensions: true }, pm_root: root });
    expect(active).not.toBeNull();
    await waitForPendingFlush();
    if (mode === "disable") {
      const current = await readSettings(root);
      current.telemetry.enabled = false;
      await writeSettings(root, current, "test:disable");
    } else {
      await runTelemetry({ subcommand: "clear" }, {});
      if (mode === "clear-reenable") {
        const current = await readSettings(root);
        current.telemetry.enabled = true;
        await writeSettings(root, current, "test:reenable");
      }
    }
    // Failures bypass read sampling, so privacy cannot accidentally pass by
    // randomly discarding this invocation.
    await finishTelemetryCommand(active, { ok: false, error_code: "usage_error" });
    await waitForPendingFlush();
    await expect(access(path.join(root, "runtime", "telemetry", "events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
