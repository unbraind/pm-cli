import { runWithWorkspaceHarnessSignalDescriptors } from "../../../../src/core/shared/author.js";
import crypto from "node:crypto";
import { resolveTelemetryEnvironmentPolicy, resolveTelemetryReadSampleRate } from "../../../../src/core/telemetry/policy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  _testOnly, emitTelemetryErrorEvent, finishTelemetryCommand,
  flushTelemetryQueueNow, startTelemetryCommand, waitForPendingFlush,
} from "../../../../src/core/telemetry/runtime.js";
import { withTempGlobalRoot } from "../../../helpers/temp.js";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 }))));
afterEach(async () => { await waitForPendingFlush(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("telemetry consent and signal policy", () => {
  it.each(["1", "true", " YES ", "on"])("honors DO_NOT_TRACK=%s before creating identity or queues", async (value) => {
    await withTempGlobalRoot("pm-telemetry-policy-", async (root) => {
      vi.stubEnv("PM_GLOBAL_PATH", root);
      vi.stubEnv("PM_TELEMETRY_DISABLED", "0");
      vi.stubEnv("PM_NO_TELEMETRY", "0");
      vi.stubEnv("PM_TELEMETRY_SEND_TEST_EVENTS", "1");
      vi.stubEnv("DO_NOT_TRACK", value);
      const context = { command: "create", args: [], options: {}, global: {}, pm_root: root, pm_version: "test" };
      expect(await startTelemetryCommand(context)).toBeNull();
      await emitTelemetryErrorEvent({ ...context, error_code: "invalid_usage", error_message: "fixture", exit_code: 2 });
      await flushTelemetryQueueNow(root);
      await waitForPendingFlush();
      await expect(readFile(path.join(root, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(root, "runtime", "telemetry", "events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("suppresses inferred test execution without an explicit opt in", async () => {
    await withTempGlobalRoot("pm-telemetry-test-policy-", async (root) => {
      for (const key of ["DO_NOT_TRACK", "PM_TELEMETRY_DISABLED", "PM_NO_TELEMETRY", "PM_TELEMETRY_SEND_TEST_EVENTS", "PM_TELEMETRY_SOURCE_CONTEXT"]) vi.stubEnv(key, "");
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("PM_GLOBAL_PATH", root);
      const active = await startTelemetryCommand({ command: "list", args: [], options: {}, global: {}, pm_root: root, pm_version: "test" });
      expect(active).toBeNull();
      await finishTelemetryCommand(active, { ok: true });
      await flushTelemetryQueueNow(root);
      await expect(readFile(path.join(root, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("adds bounded harness and CI dimensions only above minimal capture", () => {
    vi.stubEnv("CI", "true");
    const payload = _testOnly.buildAuthorContextPayloadFields("redacted", "fixture");
    expect(payload.ci).toBe(true);
    expect(payload.agent_harness).toMatch(/^(claude-code|codex|pi|opencode|cursor|aider|gemini-cli|ci|other|none)$/);
    const minimal = _testOnly.buildAuthorContextPayloadFields("minimal", "fixture");
    expect(minimal).not.toHaveProperty("ci");
    expect(minimal).not.toHaveProperty("agent_harness");
  });
});

it.each([
  [{}, false],
  [{ VITEST: "" }, true],
  [{ VITEST_WORKER_ID: "1" }, true],
  [{ NODE_ENV: " TEST " }, true],
  [{ NODE_ENV: "test", PM_TELEMETRY_SOURCE_CONTEXT: "invalid" }, true],
  [{ NODE_ENV: "test", PM_TELEMETRY_SOURCE_CONTEXT: "dogfood" }, false],
  [{ NODE_ENV: "test", PM_TELEMETRY_SEND_TEST_EVENTS: "true" }, false],
  [{ PM_TELEMETRY_DISABLED: "yes" }, true],
  [{ PM_NO_TELEMETRY: "ON" }, true],
  [{ DO_NOT_TRACK: "1", PM_TELEMETRY_SOURCE_CONTEXT: "user" }, true],
] as const)("resolves process consent %j", (env, disabled) => {
  expect(resolveTelemetryEnvironmentPolicy(env).telemetry_disabled).toBe(disabled);
});

it.each([undefined, "", "bad", "0", "-1", "2", "Infinity", "0.25", "1"])("validates read inclusion probability %s", (raw) => {
  const env = { PM_TELEMETRY_READ_SAMPLE_RATE: raw };
  expect(resolveTelemetryReadSampleRate("list", true, env)).toBe(raw === "0.25" ? 0.25 : 1);
  expect(resolveTelemetryReadSampleRate("create", true, env)).toBe(1);
  expect(resolveTelemetryReadSampleRate("list", false, env)).toBe(1);
});

it.each([
  { ok: true, random: 0, count: 2, rate: 0.25 },
  { ok: true, random: 255, count: 0, rate: 0.25 },
  { ok: false, random: 255, count: 2, rate: 1 },
])("keeps lifecycle pairs and failures together: %j", async ({ ok, random, count, rate }) => {
  await withTempGlobalRoot("pm-telemetry-sampling-", async (root) => {
    for (const key of ["DO_NOT_TRACK", "PM_TELEMETRY_DISABLED", "PM_NO_TELEMETRY"]) vi.stubEnv(key, "0");
    vi.stubEnv("PM_GLOBAL_PATH", root);
    vi.stubEnv("PM_TELEMETRY_SEND_TEST_EVENTS", "1");
    vi.stubEnv("PM_TELEMETRY_READ_SAMPLE_RATE", "0.25");
    vi.stubEnv("PM_TELEMETRY_INLINE_FLUSH", "1");
    vi.stubEnv("PM_TELEMETRY_OTEL_DISABLED", "1");
    const active = await startTelemetryCommand({ command: "list", args: [], options: {}, global: { noExtensions: true }, pm_root: root, pm_version: "test" });
    expect(active).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(crypto, "randomBytes").mockImplementation((size) => Buffer.alloc(size, random));
    await finishTelemetryCommand(active, { ok });
    await waitForPendingFlush();
    const requests = vi.mocked(fetch).mock.calls;
    const events = requests.flatMap(([, options]) => (JSON.parse(String(options?.body)) as { events: Array<{ event_type: string; payload: Record<string, unknown> }> }).events);
    expect(events).toHaveLength(count);
    if (count > 0) {
      expect(events.map((event) => event.event_type)).toEqual(["command_start", "command_finish"]);
      expect(events.every((event) => event.payload.sample_rate === rate)).toBe(true);
    }
  });
});


it("bounds custom workspace harness names without exposing their raw identity", () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  try {
    process.env = { PM_FIXTURE_AGENT: "1" };
    process.argv = ["node", "pm"];
    runWithWorkspaceHarnessSignalDescriptors([
      { harness: "private-agent", environment_keys: ["PM_FIXTURE_AGENT"] },
    ], () => {
      const payload = _testOnly.buildAuthorContextPayloadFields("max", "fixture");
      expect(payload.agent_harness).toBe("other");
      expect(payload.ci).toBe(false);
      expect(payload.agent_harness_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(payload)).not.toContain("private-agent");
    }, { probesEnabled: false });
  } finally {
    process.env = originalEnv;
    process.argv = originalArgv;
  }
});

it("honors consent withdrawn between command start and completion", async () => {
  await withTempGlobalRoot("pm-telemetry-withdraw-consent-", async (root) => {
    vi.stubEnv("PM_GLOBAL_PATH", root);
    vi.stubEnv("PM_TELEMETRY_DISABLED", "0");
    vi.stubEnv("PM_NO_TELEMETRY", "0");
    vi.stubEnv("DO_NOT_TRACK", "0");
    vi.stubEnv("PM_TELEMETRY_SEND_TEST_EVENTS", "1");
    vi.stubEnv("PM_TELEMETRY_READ_SAMPLE_RATE", "0.5");
    const active = await startTelemetryCommand({ command: "get", args: [], options: {}, global: { noExtensions: true }, pm_root: root, pm_version: "test" });
    expect(active).not.toBeNull();
    vi.stubEnv("DO_NOT_TRACK", "1");
    await finishTelemetryCommand(active, { ok: false });
    await flushTelemetryQueueNow(root);
    expect(fetch).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, "runtime", "telemetry", "events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
