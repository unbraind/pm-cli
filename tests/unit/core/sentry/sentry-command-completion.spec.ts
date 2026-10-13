import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type * as RuntimePrimitives from "../../../../src/sdk/runtime-primitives.js";

const diagnostics = vi.hoisted(() => ({
  failedRead: false,
  context: null as RuntimePrimitives.ActiveTelemetryCommand | null,
  permission: vi.fn(),
  discard: vi.fn(),
  finish: vi.fn(),
  flush: vi.fn(),
  finishTelemetry: vi.fn(),
}));

vi.mock("../../../../src/sdk/runtime-primitives.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimePrimitives>();
  return {
    ...actual,
    readSettings: async (pmRoot: string) => {
      if (diagnostics.failedRead) throw new Error("Completion settings unavailable");
      return actual.readSettings(pmRoot);
    },
    startTelemetryCommand: vi.fn(async () => diagnostics.context),
    finishTelemetryCommand: diagnostics.finishTelemetry,
    ensureSentryCommandTracing: diagnostics.permission,
    sentryStartCommandSpan: vi.fn(() => { diagnostics.failedRead = true; }),
    sentrySetCommandContext: vi.fn(),
    sentryDiscardCommandSpan: diagnostics.discard,
    sentryFinishCommandSpan: diagnostics.finish,
    sentryFlush: diagnostics.flush,
  };
});

import { runPmCli } from "../../../../src/cli/public.js";
import { deriveTelemetryCommandTaxonomy } from "../../../../src/core/telemetry/observability.js";
import { PM_TELEMETRY_SOURCE_CONTEXT_VALUES } from "../../../../src/core/telemetry/policy.js";
import { withTempDir } from "../../../helpers/temp.js";

afterEach(() => {
  diagnostics.failedRead = false;
  diagnostics.context = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("discards unverified-completion-consent without changing the command outcome", async () => {
  await withTempDir("pm-sentry-completion-", async (root) => {
    vi.stubEnv("PM_PATH", path.join(root, "project"));
    vi.stubEnv("PM_GLOBAL_PATH", path.join(root, "global"));
    diagnostics.context = {
      command: "contracts",
      command_taxonomy: deriveTelemetryCommandTaxonomy("contracts"),
      started_at: new Date().toISOString(),
      started_at_ms: Date.now(),
      pm_version: "0.0.0",
      source_context: PM_TELEMETRY_SOURCE_CONTEXT_VALUES[0],
      source_context_source: "inferred",
      installation_id: randomUUID(),
      pm_root_hash: "a".repeat(64),
      cwd_hash: "b".repeat(64),
      endpoint: "http://127.0.0.1:1/events",
      retention_days: 7,
      global_pm_root: path.join(root, "global"),
      capture_level: "minimal",
    };
    diagnostics.permission.mockResolvedValueOnce(true).mockResolvedValue(false);
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });

    await runPmCli(["--no-extensions", "contracts", "--summary", "--json"]);

    expect(JSON.parse(stdout.join(""))).toHaveProperty("commands");
    expect(stderr).toEqual([]);
    expect(diagnostics.permission.mock.calls).toEqual([[true], [false]]);
    expect(diagnostics.discard).toHaveBeenCalledOnce();
    expect(diagnostics.finish).not.toHaveBeenCalled();
    expect(diagnostics.finishTelemetry).toHaveBeenCalledWith(diagnostics.context, expect.objectContaining({ ok: true }));
    expect(diagnostics.flush).toHaveBeenCalledOnce();
  });
});
