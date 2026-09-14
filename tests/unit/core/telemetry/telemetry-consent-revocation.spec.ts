import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as settingsStore from "../../../../src/core/store/settings.js";
import { emitTelemetryErrorEvent, finishTelemetryCommand, flushTelemetryQueueNow, startTelemetryCommand, waitForPendingFlush } from "../../../../src/core/telemetry/runtime.js";
import { runTelemetry } from "../../../../src/sdk/telemetry.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

const execFileAsync = promisify(execFile);
const telemetryUrl = pathToFileURL(path.resolve("dist/sdk/telemetry.js")).href;

beforeEach(() => {
  for (const [key, value] of Object.entries({
    PM_TELEMETRY_SEND_TEST_EVENTS: "1", DO_NOT_TRACK: "0",
    PM_TELEMETRY_DISABLED: "0", PM_NO_TELEMETRY: "0",
    PM_TELEMETRY_OTEL_DISABLED: "1", PM_TELEMETRY_INLINE_FLUSH: "1",
    PM_TELEMETRY_READ_SAMPLE_RATE: "0.1", PM_LOCK_WAIT_MS: "5000",
  })) vi.stubEnv(key, value);
});
afterEach(async () => { await waitForPendingFlush(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each(["clear", "disable", "clear-reenable", "concurrent-clear", "concurrent-optout"])("stops deferred lifecycle capture after %s revokes its installation", async (mode) => {
  await withTempGlobalRoot("pm-telemetry-revoke-", async (root) => {
    vi.stubEnv("PM_GLOBAL_PATH", root);
    const settings = await settingsStore.readSettings(root);
    settings.telemetry.enabled = true;
    settings.telemetry.endpoint = "";
    await settingsStore.writeSettings(root, settings, "test:enable");
    const active = await startTelemetryCommand({ command: "list", pm_version: "fixture", args: [], options: {}, global: { noExtensions: true }, pm_root: root });
    expect(active).not.toBeNull();
    await waitForPendingFlush();
    let childDone: Promise<unknown[]> | undefined;
    if (mode === "concurrent-clear" || mode === "concurrent-optout") {
      const readSettings = settingsStore.readSettings;
      let intercepted = false;
      vi.spyOn(settingsStore, "readSettings").mockImplementation(async (target) => {
        const snapshot = await readSettings(target);
        if (target !== root || intercepted) return snapshot;
        intercepted = true;
        if (mode === "concurrent-optout") {
          vi.stubEnv("DO_NOT_TRACK", "1");
          return snapshot;
        }
        const child = spawn(process.execPath, ["--input-type=module", "-e", `
          import { runTelemetry } from ${JSON.stringify(telemetryUrl)};
          const timer = setTimeout(() => process.send("waiting"), 500);
          await runTelemetry({ subcommand: "clear" }, {});
          clearTimeout(timer);
          process.send("cleared");
          process.disconnect();
        `], { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, PM_GLOBAL_PATH: root, PM_TELEMETRY_INGEST_KEY: "" } });
        childDone = once(child, "exit");
        await once(child, "message");
        return snapshot;
      });
    } else if (mode === "disable") {
      const current = await settingsStore.readSettings(root);
      current.telemetry.enabled = false;
      await settingsStore.writeSettings(root, current, "test:disable");
    } else {
      await runTelemetry({ subcommand: "clear" }, {});
      if (mode === "clear-reenable") {
        const current = await settingsStore.readSettings(root);
        current.telemetry.enabled = true;
        await settingsStore.writeSettings(root, current, "test:reenable");
      }
    }
    // Failures bypass read sampling, so privacy cannot accidentally pass by
    // randomly discarding this invocation.
    await finishTelemetryCommand(active, { ok: false, error_code: "usage_error" });
    if (childDone) expect(await childDone).toEqual([0, null]);
    await waitForPendingFlush();
    await expect(access(path.join(root, "runtime", "telemetry", "events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each(["start", "error", "flush"].flatMap((mode) => ["clear", "environment"].map((revocation) => [mode, revocation])))("does not recreate identity or capture when %s preflight loses to %s", async (mode, revocation) => {
  await withTempGlobalRoot("pm-telemetry-preflight-revoke-", async (root) => {
    vi.stubEnv("PM_GLOBAL_PATH", root);
    vi.stubEnv("PM_TELEMETRY_READ_SAMPLE_RATE", "1");
    const settings = await settingsStore.readSettings(root);
    settings.telemetry.enabled = true;
    settings.telemetry.endpoint = "";
    await settingsStore.writeSettings(root, settings, "test:enable");
    const readSettings = settingsStore.readSettings;
    let intercepted = false;
    vi.spyOn(settingsStore, "readSettings").mockImplementation(async (target) => {
      const snapshot = await readSettings(target);
      if (target !== root || intercepted) return snapshot;
      intercepted = true;
      if (revocation === "environment") {
        vi.stubEnv("DO_NOT_TRACK", "1");
        return snapshot;
      }
      await execFileAsync(process.execPath, ["--input-type=module", "-e", `
        import { runTelemetry } from ${JSON.stringify(telemetryUrl)};
        await runTelemetry({ subcommand: "clear" }, {});
      `], { cwd: root, timeout: 20_000, env: { ...process.env, PM_TELEMETRY_INGEST_KEY: "" } });
      return snapshot;
    });
    const context = { command: "create", pm_version: "fixture", args: [], options: {}, global: { noExtensions: true }, pm_root: root };
    if (mode === "start") expect(await startTelemetryCommand(context)).toBeNull();
    else if (mode === "error") await emitTelemetryErrorEvent({ ...context, error_code: "usage_error", error_message: "fixture", exit_code: 2 });
    else await flushTelemetryQueueNow(root);
    await waitForPendingFlush();
    expect(intercepted).toBe(true);
    const current = await readSettings(root);
    expect(current.telemetry.enabled).toBe(revocation !== "clear");
    expect(current.telemetry.installation_id).toBe("");
    await expect(access(path.join(root, "runtime", "telemetry", "events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
