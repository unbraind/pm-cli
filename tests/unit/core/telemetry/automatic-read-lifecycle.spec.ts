import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { setActiveCommandContext, clearActiveExtensionHooks } from "../../../../src/core/extensions/index.js";
import { collectSettingsReadCacheSignatures, setSettingsReadCacheEntry } from "../../../../src/core/store/settings-read-cache.js";
import { readSettings, readSettingsWithMetadata, writeSettings } from "../../../../src/core/store/settings.js";
import { startTelemetryCommand, finishTelemetryCommand, waitForPendingFlush } from "../../../../src/core/telemetry/runtime.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

afterEach(async () => { await waitForPendingFlush(); clearActiveExtensionHooks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("automatically samples resolved reads without no-extensions while retaining failures and writes", async () => {
  await withTempGlobalRoot("pm-automatic-lifecycle-", async (root) => {
    vi.stubEnv("PM_GLOBAL_PATH", root);
    for (const key of ["DO_NOT_TRACK", "PM_NO_TELEMETRY", "PM_TELEMETRY_DISABLED"]) vi.stubEnv(key, "0");
    vi.stubEnv("PM_TELEMETRY_READ_SAMPLE_RATE", undefined);
    vi.stubEnv("PM_TELEMETRY_SEND_TEST_EVENTS", "1");
    vi.stubEnv("PM_TELEMETRY_OTEL_DISABLED", "1");
    const settings = await readSettings(root);
    settings.telemetry.enabled = true;
    settings.telemetry.endpoint = "";
    await writeSettings(root, settings, "test:local-capture");
    vi.spyOn(Date, "now").mockReturnValue(120_000);
    setActiveCommandContext({ command: "list", args: [], options: {} });
    const context = { command: "list", args: [], options: {}, global: {}, pm_root: root, pm_version: "test" };
    for (let index = 0; index < 10; index += 1) {
      const active = await startTelemetryCommand(context);
      expect(active).not.toBeNull();
      expect(active?.sample_rate).toBeUndefined();
      await finishTelemetryCommand(active, { ok: true });
    }
    vi.spyOn(crypto, "randomBytes").mockImplementation((size) => Buffer.alloc(size, 255));
    const dropped = await startTelemetryCommand(context);
    expect(dropped?.sample_rate).toBe((10 / 11) ** 2);
    await finishTelemetryCommand(dropped, { ok: true });
    const failed = await startTelemetryCommand(context);
    await finishTelemetryCommand(failed, { ok: false, error_code: "fixture_failure" });
    await finishTelemetryCommand(await startTelemetryCommand({ ...context, command: "create" }), { ok: true });
    await waitForPendingFlush();
    const events = (await readFile(path.join(root, "runtime", "telemetry", "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => (JSON.parse(line) as { event: { command: string; event_type: string; payload: Record<string, unknown> } }).event);
    expect(events).toHaveLength(24);
    expect(events.slice(20, 22).map((event) => event.payload.sample_rate)).toEqual([1, 1]);
    expect(events.slice(22).map((event) => event.command)).toEqual(["create", "create"]);
  });
});

it("shares the frequency ordinal between independent processes under the queue mutex", async () => {
  const sampling = pathToFileURL(path.resolve("dist/core/telemetry/read-sampling.js")).href;
  const runtime = pathToFileURL(path.resolve("dist/core/telemetry/runtime.js")).href;
  await withTempGlobalRoot("pm-sampling-processes-", async (root) => {
    await mkdir(path.join(root, "runtime", "telemetry"), { recursive: true });
    const child = `import { resolveAutomaticReadSampleRate } from ${JSON.stringify(sampling)};
      import { withTelemetryQueueMutation } from ${JSON.stringify(runtime)};
      const root = process.argv[1];
      const rates = [];
      for (let i = 0; i < 5; i++) rates.push(await withTelemetryQueueMutation(() => resolveAutomaticReadSampleRate(root, "list", true, {}, 0), root));
      console.log(JSON.stringify(rates));`;
    const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", child, root],
      { cwd: root, timeout: 20_000, env: { ...process.env, PM_GLOBAL_PATH: root, PM_PATH: root, PM_LOCK_WAIT_MS: "5000" } })));
    expect(results.map((result) => result.stderr)).toEqual(["", "", "", ""]);
    const rates = results.flatMap((result) => JSON.parse(result.stdout) as number[]).sort((a, b) => b - a);
    expect(rates).toEqual(Array.from({ length: 20 }, (_, index) => Math.min(1, (10 / (index + 1)) ** 2)));
  });
});

it("refreshes a pre-lock settings snapshot before initializing installation identity", async () => {
  await withTempGlobalRoot("pm-identity-snapshot-", async (root) => {
    vi.stubEnv("PM_GLOBAL_PATH", root);
    for (const key of ["DO_NOT_TRACK", "PM_NO_TELEMETRY", "PM_TELEMETRY_DISABLED"]) vi.stubEnv(key, "0");
    vi.stubEnv("PM_TELEMETRY_SEND_TEST_EVENTS", "1");
    vi.stubEnv("PM_TELEMETRY_OTEL_DISABLED", "1");
    const settings = await readSettings(root);
    settings.telemetry.enabled = true;
    settings.telemetry.endpoint = "";
    settings.telemetry.installation_id = "";
    await writeSettings(root, settings, "test:before-peer");
    const stale = await readSettingsWithMetadata(root);
    settings.telemetry.installation_id = "existing-peer-identity";
    await writeSettings(root, settings, "test:peer-initialized");
    // Model a read whose schema-load signatures were collected after a peer
    // persisted identity, but whose settings bytes came from before that write.
    const trackedPaths = [path.join(root, "settings.json")];
    setSettingsReadCacheEntry(root, { tracked_paths: trackedPaths, signatures: await collectSettingsReadCacheSignatures(trackedPaths), value: stale });
    const active = await startTelemetryCommand({ command: "create", args: [], options: {}, global: {}, pm_root: root, pm_version: "test" });
    expect(active?.installation_id).toBe("existing-peer-identity");
    await finishTelemetryCommand(active, { ok: true });
  });
});
