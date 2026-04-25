import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../../src/core/store/settings.js";
import { finishTelemetryCommand, startTelemetryCommand } from "../../src/core/telemetry/runtime.js";

const originalGlobalPath = process.env.PM_GLOBAL_PATH;
const originalFetch = globalThis.fetch;

function telemetryQueuePath(globalRoot: string): string {
  return path.join(globalRoot, "runtime", "telemetry", "events.jsonl");
}

async function withTempGlobalRoot(run: (globalRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-telemetry-runtime-test-"));
  const globalRoot = path.join(tempRoot, ".pm-cli");
  process.env.PM_GLOBAL_PATH = globalRoot;
  try {
    await run(globalRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("core/telemetry/runtime", () => {
  afterEach(() => {
    if (originalGlobalPath === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = originalGlobalPath;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("queues redacted command_start events when exporter fails", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network_down");
      }) as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "create",
        args: ["--api-key", "supersecret", "--token=abc123", "user@example.com"],
        options: {
          apiKey: "value",
          title: "Telemetry smoke",
        },
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });

      expect(active).not.toBeNull();
      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      const firstLine = queueRaw
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      expect(firstLine).toBeDefined();
      const queued = JSON.parse(firstLine ?? "{}") as {
        attempts: number;
        event: {
          event_type: string;
          payload: {
            command_args: string[];
            command_options: Record<string, string>;
          };
        };
      };
      expect(queued.attempts).toBe(1);
      expect(queued.event.event_type).toBe("command_start");
      expect(queued.event.payload.command_args).toEqual([
        "--api-key",
        "[redacted]",
        "--token=[redacted]",
        "[redacted_email]",
      ]);
      expect(queued.event.payload.command_options.apiKey).toBe("[redacted]");
    });
  });

  it("persists installation id and flushes queue on successful exporter response", async () => {
    await withTempGlobalRoot(async (globalRoot) => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const active = await startTelemetryCommand({
        command: "list-open",
        args: [],
        options: {},
        global: {
          json: true,
          quiet: false,
          noExtensions: false,
          noPager: false,
          profile: false,
        },
        pm_root: "/tmp/project/.agents/pm",
      });
      expect(active).not.toBeNull();

      await finishTelemetryCommand(active, {
        ok: true,
        result: { count: 0, items: [] },
      });

      const queueRaw = await fs.readFile(telemetryQueuePath(globalRoot), "utf8");
      expect(queueRaw.trim()).toBe("");

      const settings = await readSettings(globalRoot);
      expect(settings.telemetry.installation_id.length).toBeGreaterThan(0);
      expect(settings.telemetry.enabled).toBe(true);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
