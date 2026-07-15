import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTelemetry } from "../../../src/cli/commands/telemetry.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import * as telemetryRuntime from "../../../src/core/telemetry/runtime.js";
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
          // The finish event carries no payload, so ok is treated as not-ok
          // (conservative) and no duration/resolution fields are emitted.
          ok_count: 0,
          error_count: 1,
          error_rate: 1,
        },
      ]);
    });
  });

  it("derives latency percentiles, ok/error rates, and resolution counts from command_finish payloads", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-finish-metrics-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({ attempts: 0, event: { event_type: "command_start", command: "list" } }),
        JSON.stringify({
          attempts: 0,
          event: {
            event_type: "command_finish",
            command: "list",
            payload: { duration_ms: 100, ok: true, command_resolution: "success" },
          },
        }),
        JSON.stringify({
          attempts: 0,
          event: {
            event_type: "command_finish",
            command: "list",
            payload: { duration_ms: 300, ok: false, command_resolution: "error_usage" },
          },
        }),
        JSON.stringify({
          attempts: 0,
          event: {
            event_type: "command_finish",
            command: "list",
            payload: { duration_ms: 200, ok: true, command_resolution: "success" },
          },
        }),
      ]);
      const result = (await runTelemetry({ subcommand: "stats", limit: 10 }, {})) as {
        stats: Array<Record<string, unknown>>;
      };
      const bucket = result.stats.find((entry) => entry.command === "list");
      expect(bucket).toMatchObject({
        // sorted durations [100, 200, 300]: nearest-rank p50 -> 200, p95 -> 300.
        duration_p50_ms: 200,
        duration_p95_ms: 300,
        duration_max_ms: 300,
        ok_count: 2,
        error_count: 1,
        error_rate: 1 / 3,
        command_resolution_counts: { error_usage: 1, success: 2 },
      });
    });
  });

  it("computes a single-entry percentile and treats malformed payload.ok as an error", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-single-finish-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({
          attempts: 0,
          event: {
            event_type: "command_finish",
            command: "solo",
            // duration_ms present but ok is a non-boolean string and resolution is blank.
            payload: { duration_ms: 42, ok: "yes", command_resolution: "   " },
          },
        }),
      ]);
      const result = (await runTelemetry({ subcommand: "stats", limit: 10 }, {})) as {
        stats: Array<Record<string, unknown>>;
      };
      const bucket = result.stats.find((entry) => entry.command === "solo");
      expect(bucket).toMatchObject({
        duration_p50_ms: 42,
        duration_p95_ms: 42,
        duration_max_ms: 42,
        ok_count: 0,
        error_count: 1,
        error_rate: 1,
      });
      expect(bucket).not.toHaveProperty("command_resolution_counts");
    });
  });

  it("omits finish-only metrics for buckets without command_finish events", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-no-finish-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({ attempts: 0, event: { event_type: "command_start", command: "startonly" } }),
        // A finish event with a non-finite duration must not register a percentile.
        JSON.stringify({
          attempts: 0,
          event: { event_type: "command_error", command: "startonly", payload: { duration_ms: Number.NaN } },
        }),
      ]);
      const result = (await runTelemetry({ subcommand: "stats", limit: 10 }, {})) as {
        stats: Array<Record<string, unknown>>;
      };
      const bucket = result.stats.find((entry) => entry.command === "startonly");
      expect(bucket).toBeDefined();
      expect(bucket).not.toHaveProperty("duration_p50_ms");
      expect(bucket).not.toHaveProperty("ok_count");
      expect(bucket).not.toHaveProperty("error_rate");
      expect(bucket).not.toHaveProperty("command_resolution_counts");
    });
  });

  it("emits ok/error tallies without percentiles when finish events omit duration_ms", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-finish-no-duration-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({
          attempts: 0,
          event: { event_type: "command_finish", command: "noduration", payload: { ok: true } },
        }),
      ]);
      const result = (await runTelemetry({ subcommand: "stats", limit: 10 }, {})) as {
        stats: Array<Record<string, unknown>>;
      };
      const bucket = result.stats.find((entry) => entry.command === "noduration");
      expect(bucket).toMatchObject({ ok_count: 1, error_count: 0, error_rate: 0 });
      expect(bucket).not.toHaveProperty("duration_p50_ms");
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

  it("keeps queue_drained false when a bounded flush leaves queued events", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-partial-flush-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      delete process.env.PM_TELEMETRY_DISABLED;
      delete process.env.PM_NO_TELEMETRY;
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = true;
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      settings.telemetry.installation_id = "test-installation";
      await writeSettings(globalRoot, settings, "test:telemetry_partial_flush");
      await writeQueue(
        globalRoot,
        Array.from({ length: 101 }, (_, index) =>
          JSON.stringify({
            client_schema_version: 1,
            attempts: 0,
            event: {
              event_id: `evt-partial-${index}`,
              event_type: "command_finish",
              schema_version: 1,
              occurred_at: new Date().toISOString(),
              installation_id: "test-installation",
              session_id: "session-partial",
              command: "list-open",
              payload: {},
            },
          }),
        ),
      );
      globalThis.fetch = vi.fn(async () =>
        new Response("ok", { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await runTelemetry(
        { subcommand: "flush" },
        { path: globalRoot },
      );
      expect(result).toMatchObject({
        queue_entries_before: 101,
        queue_entries_after: 1,
        queue_drained: false,
      });
    });
  });

  it("honors the SDK configured tracker root over the environment default", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-environment-root-", async (environmentRoot) => {
      await withTempGlobalRoot("pm-cli-telemetry-client-root-", async (clientRoot) => {
        process.env.PM_GLOBAL_PATH = environmentRoot;
        await writeQueue(clientRoot, [
          JSON.stringify({
            client_schema_version: 1,
            attempts: 0,
            event: {
              event_id: "evt-client-root",
              event_type: "command_start",
              schema_version: 1,
              command: "context",
            },
          }),
        ]);
        const result = await runTelemetry(
          { subcommand: "status" },
          { path: clientRoot },
        );
        expect(result.status?.queue_entries).toBe(1);
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

  it("persists first-run prompt completion during clear even when telemetry was already disabled", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-clear-prompt-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      const settings = await readSettings(globalRoot);
      settings.telemetry.enabled = false;
      settings.telemetry.installation_id = "";
      settings.telemetry.first_run_prompt_completed = false;
      await writeSettings(globalRoot, settings, "test:telemetry_clear_prompt");

      const result = await runTelemetry({ subcommand: "clear" }, {});
      expect(result.settings_changed).toBe(true);
      const refreshed = await readSettings(globalRoot);
      expect(refreshed.telemetry.enabled).toBe(false);
      expect(refreshed.telemetry.installation_id).toBe("");
      expect(refreshed.telemetry.first_run_prompt_completed).toBe(true);
    });
  });

  it("rejects non-numeric stats limits", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-limit-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await expect(runTelemetry({ subcommand: "stats", limit: "10abc" }, {})).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
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

  it("rejects an empty-string subcommand and falls back to an empty value in the error", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-empty-sub-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await expect(runTelemetry({ subcommand: "   " }, {})).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("defaults to status when subcommand is omitted", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-default-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      const result = await runTelemetry({}, {});
      expect(result.subcommand).toBe("status");
    });
  });

  it("accepts a numeric stats limit and rejects non-positive numeric limits", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-numeric-limit-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({ attempts: 0, event: { event_type: "command_start", command: "list-open" } }),
      ]);
      const result = await runTelemetry({ subcommand: "stats", limit: 5 }, {});
      expect(result.limit).toBe(5);

      await expect(runTelemetry({ subcommand: "stats", limit: 0 }, {})).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTelemetry({ subcommand: "stats", limit: 2.5 }, {})).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runTelemetry({ subcommand: "stats", limit: "0" }, {})).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("uses the default stats limit when no limit is provided", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-default-limit-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({ attempts: 0, event: { event_type: "command_start", command: "list-open" } }),
      ]);
      const result = await runTelemetry({ subcommand: "stats" }, {});
      expect(result.limit).toBe(20);
    });
  });

  it("counts JSON rows that fail the queue-entry shape check as invalid", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-invalid-shape-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        // valid JSON object but missing numeric attempts / event object → invalid row
        JSON.stringify({ attempts: "nope", event: { command: "x" } }),
        JSON.stringify({ attempts: 0, event: null }),
        JSON.stringify([1, 2, 3]),
      ]);
      const result = await runTelemetry({ subcommand: "status" }, {});
      expect(result.status).toMatchObject({
        queue_entries: 0,
        queue_invalid_rows: 3,
        queue_rows_total: 3,
      });
    });
  });

  it("ignores a non-object runtime state file", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-state-array-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await fs.mkdir(path.dirname(statePath(globalRoot)), { recursive: true });
      await fs.writeFile(statePath(globalRoot), "[1, 2, 3]\n", "utf8");
      const result = await runTelemetry({ subcommand: "status" }, {});
      expect(result.status).toMatchObject({
        last_attempted_flush_at: null,
        last_successful_flush_at: null,
        last_failed_flush_at: null,
        last_failed_flush_error: null,
      });
    });
  });

  it("buckets entries with missing/blank command + event metadata and sorts schema versions", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-fallbacks-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        // blank command + blank event_type + non-finite/absent schema versions → fallbacks
        JSON.stringify({ attempts: -3, event: { command: "   ", event_type: "  ", schema_version: Number.NaN } }),
        JSON.stringify({ attempts: "malformed", event: { command: "   ", event_type: "  " } }),
        '{"attempts":1e999,"event":{"command":"   ","event_type":"  "}}',
        JSON.stringify({ attempts: 0, client_schema_version: Number.POSITIVE_INFINITY, event: {} }),
        // same fallback command bucket with two distinct schema versions to exercise the sort comparators
        JSON.stringify({ client_schema_version: 3, attempts: 0, event: { schema_version: 2 } }),
        JSON.stringify({ client_schema_version: 1, attempts: 0, event: { schema_version: 5 } }),
      ]);
      const result = await runTelemetry({ subcommand: "stats", limit: 10 }, {}) as {
        stats: Array<{
          command: string;
          event_type_counts: Record<string, number>;
          max_attempts: number;
          event_schema_versions: number[];
          client_schema_versions: number[];
        }>;
      };
      const unknownBucket = result.stats.find((bucket) => bucket.command === "<unknown>");
      expect(unknownBucket).toBeDefined();
      expect(unknownBucket?.event_type_counts).toMatchObject({ unknown: expect.any(Number) });
      expect(unknownBucket?.max_attempts).toBe(0);
      expect(unknownBucket?.event_schema_versions).toEqual([2, 5]);
      expect(unknownBucket?.client_schema_versions).toEqual([1, 3]);
    });
  });

  it("sorts equal-count command buckets alphabetically", async () => {
    await withTempGlobalRoot("pm-cli-telemetry-tiebreak-", async (globalRoot) => {
      process.env.PM_GLOBAL_PATH = globalRoot;
      await writeQueue(globalRoot, [
        JSON.stringify({ attempts: 0, event: { event_type: "command_start", command: "zeta" } }),
        JSON.stringify({ attempts: 0, event: { event_type: "command_start", command: "alpha" } }),
      ]);
      const result = (await runTelemetry({ subcommand: "stats", limit: 10 }, {})) as {
        stats: Array<{ command: string }>;
      };
      expect(result.stats.map((bucket) => bucket.command)).toEqual(["alpha", "zeta"]);
    });
  });

  it("runs the telemetry-flush entrypoint against the runtime flush helper", async () => {
    const flushSpy = vi.spyOn(telemetryRuntime, "flushTelemetryQueueNow").mockResolvedValue({
      attempted: false,
      disabled: true,
      queued_before: 0,
      queued_after: 0,
      sent: 0,
      failed: 0,
      warnings: [],
    });

    await import("../../../src/cli/telemetry-flush.js?telemetry-flush-entrypoint");

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });
});
