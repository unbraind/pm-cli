import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTelemetry } from "../../../src/cli/commands/telemetry.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempGlobalRoot } from "../../helpers/temp.js";

const originalGlobalPath = process.env.PM_GLOBAL_PATH;
const originalTelemetryDisabled = process.env.PM_TELEMETRY_DISABLED;
const originalNoTelemetry = process.env.PM_NO_TELEMETRY;
const originalFetch = globalThis.fetch;

function queuePath(globalRoot: string): string {
  return path.join(globalRoot, "runtime", "telemetry", "events.jsonl");
}

function statePath(globalRoot: string): string {
  return path.join(globalRoot, "runtime", "telemetry", "state.json");
}

async function writeQueue(globalRoot: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(queuePath(globalRoot)), { recursive: true });
  await fs.writeFile(queuePath(globalRoot), `${lines.join("\n")}\n`, "utf8");
}

describe("runTelemetry", () => {
  afterEach(() => {
    if (originalGlobalPath === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = originalGlobalPath;
    }
    if (originalTelemetryDisabled === undefined) {
      delete process.env.PM_TELEMETRY_DISABLED;
    } else {
      process.env.PM_TELEMETRY_DISABLED = originalTelemetryDisabled;
    }
    if (originalNoTelemetry === undefined) {
      delete process.env.PM_NO_TELEMETRY;
    } else {
      process.env.PM_NO_TELEMETRY = originalNoTelemetry;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns local telemetry status summary", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-status-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({
          client_schema_version: 1,
          attempts: 0,
          event: { event_id: "evt-1", event_type: "command_start", schema_version: 1, command: "list-open" },
        }),
      ]);
      await fs.writeFile(
        statePath(globalRoot),
        `${JSON.stringify({ last_successful_flush_at: "2026-06-06T00:00:00.000Z" }, null, 2)}\n`,
        "utf8",
      );
      const result = await runTelemetry({ subcommand: "status" }, {});
      expect(result.action).toBe("telemetry");
      expect(result.subcommand).toBe("status");
      expect(result.status).toMatchObject({
        enabled: true,
        queue_entries: 1,
        queue_invalid_rows: 0,
        queue_rows_total: 1,
        last_successful_flush_at: "2026-06-06T00:00:00.000Z",
      });
    });
  });

  it("groups offline telemetry stats by command and applies --limit", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-stats-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({
          client_schema_version: 1,
          attempts: 0,
          event: { event_id: "evt-1", event_type: "command_start", schema_version: 1, command: "list-open" },
        }),
        JSON.stringify({
          client_schema_version: 1,
          attempts: 2,
          event: { event_id: "evt-2", event_type: "command_finish", schema_version: 1, command: "list-open" },
        }),
        JSON.stringify({
          client_schema_version: 1,
          attempts: 0,
          event: { event_id: "evt-3", event_type: "command_error", schema_version: 1, command: "update" },
        }),
        "not-json",
      ]);
      const result = await runTelemetry({ subcommand: "stats", limit: "1" }, {});
      expect(result).toMatchObject({
        action: "telemetry",
        subcommand: "stats",
        limit: 1,
        queue_entries: 3,
        queue_invalid_rows: 1,
        queue_rows_total: 4,
        total_commands: 2,
        truncated: true,
      });
      expect(result.stats).toEqual([
        {
          command: "list-open",
          count: 2,
          event_type_counts: {
            command_finish: 1,
            command_start: 1,
          },
          max_attempts: 2,
          event_schema_versions: [1],
          client_schema_versions: [1],
        },
      ]);
    });
  });

  it("flushes local queue entries when telemetry endpoint succeeds", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-flush-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      delete process.env.PM_TELEMETRY_DISABLED;
      delete process.env.PM_NO_TELEMETRY;
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = true;
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      settings.telemetry.installation_id = "test-installation";
      await writeSettings(globalRoot, settings, "test:telemetry_flush");
      await writeQueue(globalRoot, [
        JSON.stringify({
          client_schema_version: 1,
          attempts: 0,
          event: {
            event_id: "evt-1",
            event_type: "command_finish",
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            installation_id: "test-installation",
            session_id: "session-a",
            command: "list-open",
            payload: {},
          },
        }),
      ]);
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const result = await runTelemetry({ subcommand: "flush" }, {});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        action: "telemetry",
        subcommand: "flush",
        queue_entries_before: 1,
        queue_entries_after: 0,
        queue_drained: true,
      });
    });
  });

  it("clears runtime queue artifacts and disables telemetry", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-clear-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({
          client_schema_version: 1,
          attempts: 0,
          event: { event_id: "evt-1", event_type: "command_start", schema_version: 1, command: "list-open" },
        }),
      ]);
      await fs.writeFile(statePath(globalRoot), `${JSON.stringify({ last_failed_flush_error: "timeout" }, null, 2)}\n`, "utf8");
      const result = await runTelemetry({ subcommand: "clear" }, {});
      expect(result).toMatchObject({
        action: "telemetry",
        subcommand: "clear",
        queue_exists_after: false,
        state_exists_after: false,
      });
      const settings = await readSettings(globalRoot);
      expect(settings.telemetry.enabled).toBe(false);
      expect(settings.telemetry.installation_id).toBe("");
      expect(settings.telemetry.first_run_prompt_completed).toBe(true);
    });
  });

  it("rejects unsupported telemetry subcommands", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-usage-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await expect(runTelemetry({ subcommand: "oops" }, {})).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });
});
