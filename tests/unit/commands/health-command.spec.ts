import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testOnlyHealthCommand as healthInternals, runHealth } from "../../../src/cli/commands/health.js";
import {
  buildCapabilityContractMetadata as doctorBuildCapabilityContractMetadata,
  collectUnknownCapabilityGuidance as doctorCollectUnknownCapabilityGuidance,
} from "../../../src/sdk/extension/doctor.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../../src/core/extensions/index.js";
import { writeVectorizationStatusLedger } from "../../../src/core/search/cache.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";
import { installFailingFetchMock, installSemanticFetchMock } from "../../helpers/semanticFetchMock.js";

const initialDisableAutoDefaults = process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;

function createSeedItem(context: TempPmContext): string {
  const create = context.runCli(
    [
      "create",
      "--json",
      "--title",
      "Health Seed",
      "--description",
      "Seed item for health checks",
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "health,coverage",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "15",
      "--acceptance-criteria",
      "Health command summarizes storage",
      "--author",
      "test-author",
      "--message",
      "Create health seed",
      "--assignee",
      "none",
      "--dep",
      "none",
      "--comment",
      "none",
      "--note",
      "none",
      "--learning",
      "none",
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(create.code).toBe(0);
  return (create.json as { item: { id: string } }).item.id;
}

describe("runHealth", () => {
  beforeEach(() => {
    process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = "1";
  });

  afterEach(() => {
    clearActiveExtensionHooks();
    if (initialDisableAutoDefaults === undefined) {
      delete process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS;
    } else {
      process.env.PM_DISABLE_OLLAMA_AUTO_DEFAULTS = initialDisableAutoDefaults;
    }
  });

  it("covers pure health helper normalization and summarization branches", () => {
    const previousDisabled = process.env.PM_TELEMETRY_DISABLED;
    try {
      process.env.PM_TELEMETRY_DISABLED = " YES ";
      expect(healthInternals.telemetryEnvFlagEnabled("PM_TELEMETRY_DISABLED")).toBe(true);
      process.env.PM_TELEMETRY_DISABLED = "0";
      expect(healthInternals.telemetryEnvFlagEnabled("PM_TELEMETRY_DISABLED")).toBe(false);
    } finally {
      if (previousDisabled === undefined) {
        delete process.env.PM_TELEMETRY_DISABLED;
      } else {
        process.env.PM_TELEMETRY_DISABLED = previousDisabled;
      }
    }

    expect(healthInternals.warningCode("missing_directory:history")).toBe("missing_directory");
    expect(healthInternals.warningCode(" telemetry_state_invalid_json ")).toBe("telemetry_state_invalid_json");
    expect(healthInternals.isAdvisoryHealthWarning("telemetry_endpoint_probe_failed")).toBe(true);
    expect(healthInternals.normalizeEndpointForDisplay(" https://user:pass@example.test/path?token=secret#hash ")).toBe(
      "https://example.test/path",
    );
    expect(healthInternals.normalizeEndpointForDisplay("not a url")).toBe("not a url");
    expect(healthInternals.normalizeExtensionNameForMatch(" Builtin-Guide ")).toBe("builtin-guide");
    expect(healthInternals.isExpectedUnmanagedExtension("builtin-guide", "anything")).toBe(true);
    expect(healthInternals.isExpectedUnmanagedExtension("todos", "TODOS")).toBe(true);
    expect(healthInternals.isExpectedUnmanagedExtension("custom", "custom")).toBe(false);
    expect(healthInternals.summarizeRecordList("bad", 2)).toEqual({ count: 0, sample: [], truncated: false });
    expect(healthInternals.summarizeRecordList([{ a: 1 }, { a: 2 }, { a: 3 }], 2)).toEqual({
      count: 3,
      sample: [{ a: 1 }, { a: 2 }],
      truncated: true,
    });
    expect(healthInternals.summarizeExtensionList([null, { name: "ext", module: "hidden", enabled: true }], 5)).toEqual({
      count: 2,
      sample: [
        {},
        {
          layer: undefined,
          directory: undefined,
          name: "ext",
          version: undefined,
          enabled: true,
          status: undefined,
          has_activate: undefined,
          capabilities: undefined,
        },
      ],
      truncated: false,
    });
    expect(healthInternals.summarizeStringList(["a", 1, "b", "c"], 2)).toEqual({
      count: 3,
      sample: ["a", "b"],
      truncated: true,
    });
    expect(healthInternals.buildCapabilityContractMetadata).toBe(doctorBuildCapabilityContractMetadata);
    expect(healthInternals.collectUnknownCapabilityGuidance).toBe(doctorCollectUnknownCapabilityGuidance);
    expect(healthInternals.buildCapabilityContractMetadata().capabilities.length).toBeGreaterThan(0);
    const vectorizationDetails = healthInternals.buildVectorizationProviderDetails(
      {
        ...structuredClone(SETTINGS_DEFAULTS),
        search: {},
        vector_store: {},
      },
      {
        providerResolution: { active: null },
        vectorStoreResolution: { active: null },
      } as Parameters<typeof healthInternals.buildVectorizationProviderDetails>[1],
    );
    expect(vectorizationDetails).toMatchObject({
      provider_configured: null,
      vector_store_configured: null,
    });
  });

  it("covers additional health helper edge branches", async () => {
    expect(healthInternals.normalizeEndpointForDisplay("   ")).toBe("");
    expect(healthInternals.parseTelemetryQueue('{"attempts":"bad"}').invalidRows).toBe(1);
    const guidance = healthInternals.collectUnknownCapabilityGuidance([
      "extension_capability_unknown:project:custom:legacy:allowed=schema,commands:suggested=schema",
      "extension_capability_unknown:project:custom:legacy:allowed=schema,commands:suggested=schema",
    ]);
    expect(guidance).toHaveLength(1);
    const triage = healthInternals.buildExtensionHealthTriageSummary(
      ["extension_command_definition_legacy_handler_alias:project:ext", "managed_state_warning:project:ext"],
      0,
      0,
      { applied_count: 0, pending_count: 0, failed_count: 0 },
      1,
      1,
      ["project:custom"],
      ["project:todos"],
      ["project:custom"],
    );
    expect(triage.remediation.some((entry) => entry.includes("refresh managed-state diagnostics"))).toBe(true);
    expect(triage.remediation.some((entry) => entry.includes("legacy handler were auto-remapped"))).toBe(true);
    expect(
      healthInternals.summarizeHealthCheckDetails(
        {
          name: "custom",
          status: "ok",
          details: { value: 1 },
        } as never,
        3,
      ),
    ).toEqual({ value: 1 });
    expect(
      healthInternals.summarizeHealthCheckDetails(
        {
          name: "extensions",
          status: "ok",
          details: { activation: { migration_status: "invalid" } },
        } as never,
        3,
      ),
    ).toMatchObject({ activation: { migration_status: null } });
    expect(
      healthInternals.summarizeHealthCheckDetails(
        {
          name: "directories",
          status: "ok",
          details: { required: "invalid", optional: "invalid" },
        } as never,
        3,
      ),
    ).toMatchObject({ required_count: 0, optional_count: 0 });
    expect(
      healthInternals.summarizeHealthCheckDetails(
        {
          name: "extensions",
          status: "ok",
          details: { activation: "invalid" },
        } as never,
        3,
      ),
    ).toMatchObject({ activation: { failed: { count: 0 }, warnings: { count: 0 } } });

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-health-list-paths-"));
    try {
      await writeFile(path.join(tempRoot, "tasks"), "not-a-directory", "utf8");
      await mkdir(path.join(tempRoot, "notes"), { recursive: true });
      await writeFile(path.join(tempRoot, "notes", "keep.toon"), "item", "utf8");
      await writeFile(path.join(tempRoot, "notes", "skip.txt"), "item", "utf8");
      const itemPaths = await healthInternals.listItemDocumentPaths(tempRoot, { Task: "tasks", Note: "notes" });
      expect(itemPaths.some((entry) => entry.endsWith("keep.toon"))).toBe(true);
      expect(itemPaths.some((entry) => entry.endsWith("skip.txt"))).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-health-not-init-"));
    try {
      await expect(runHealth({ path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns deterministic ok checks for initialized storage", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual([]);
      expect(health.checks.map((check) => check.name)).toEqual([
        "settings",
        "directories",
        "settings_values",
        "telemetry",
        "extensions",
        "storage",
        "locks",
        "integrity",
        "history_drift",
        "vectorization",
      ]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("ok");
      expect(directoriesCheck?.details).toMatchObject({
        missing: [],
      });

      const settingValuesCheck = health.checks.find((check) => check.name === "settings_values");
      expect(settingValuesCheck?.status).toBe("ok");
      expect(settingValuesCheck?.details).toEqual({ warnings: [] });

      const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
      expect(telemetryCheck?.status).toBe("ok");
      expect(telemetryCheck?.details).toMatchObject({
        enabled: true,
        capture_level: "redacted",
        queue_entries: 0,
        endpoint_probe: {
          attempted: false,
        },
        env_overrides: {
          telemetry_disabled: true,
          pm_no_telemetry: false,
          telemetry_otel_disabled: true,
        },
      });

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("ok");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        configured_enabled: [],
        configured_disabled: [],
        discovered: [],
        warnings: [],
        triage: {
          status: "ok",
          warning_count: 0,
          load_failure_count: 0,
          activation_failure_count: 0,
        },
      });
      expect(extensionCheck?.details).toMatchObject({
        activation: {
          managed_extensions: {
            project: {
              count: 0,
              entries: [],
            },
            global: {
              count: 0,
              entries: [],
            },
          },
        },
      });
      const defaultExtensionDetails = extensionCheck?.details as
        | { loaded?: Array<{ name: string; has_activate: boolean; module?: unknown }> }
        | undefined;
      const defaultLoaded = defaultExtensionDetails?.loaded ?? [];
      expect(defaultLoaded).toEqual([]);
      expect(defaultLoaded.every((entry) => !("module" in entry))).toBe(true);

      const storageCheck = health.checks.find((check) => check.name === "storage");
      expect(storageCheck?.details).toEqual({
        items: 1,
        history_streams: 1,
      });

      const locksCheck = health.checks.find((check) => check.name === "locks");
      expect(locksCheck?.status).toBe("ok");
      expect(locksCheck?.details).toEqual({
        active_lock_count: 0,
        stale_lock_count: 0,
        unreadable_lock_count: 0,
        unparseable_lock_count: 0,
      });

      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      expect(historyDriftCheck?.status).toBe("ok");
      expect(historyDriftCheck?.details).toMatchObject({
        checked_items: 1,
        cache_hit_verification: "metadata",
        drifted_items: [],
        counts: {
          drifted: 0,
          missing_streams: 0,
          unreadable_streams: 0,
          hash_mismatches: 0,
          chain_mismatches: 0,
        },
      });

      const vectorizationCheck = health.checks.find((check) => check.name === "vectorization");
      expect(vectorizationCheck?.status).toBe("ok");
      expect(vectorizationCheck?.details).toMatchObject({
        semantic_runtime_available: false,
        stale_items_before: [],
        stale_items_after: [],
        // GH-244: surface the persisted (empty) config value and how the
        // resolution was sourced so audits can distinguish auto-detect from
        // genuine misconfiguration.
        provider_source: "unconfigured",
        provider_configured: "",
        vector_store_source: "unconfigured",
        vector_store_configured: "",
      });

      const integrityCheck = health.checks.find((check) => check.name === "integrity");
      expect(integrityCheck?.status).toBe("ok");
      expect(integrityCheck?.details).toMatchObject({
        counts: {
          item_unreadable: 0,
          item_conflict_markers: 0,
          item_parse_failures: 0,
          history_unreadable: 0,
          history_conflict_markers: 0,
          history_invalid_json: 0,
        },
      });
      expect(health.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("reports PM_NO_TELEMETRY as a standalone telemetry opt-out", async () => {
    const originalTelemetryDisabled = process.env.PM_TELEMETRY_DISABLED;
    const originalNoTelemetry = process.env.PM_NO_TELEMETRY;
    const originalOtelDisabled = process.env.PM_TELEMETRY_OTEL_DISABLED;
    delete process.env.PM_TELEMETRY_DISABLED;
    process.env.PM_NO_TELEMETRY = "1";
    delete process.env.PM_TELEMETRY_OTEL_DISABLED;
    try {
      await withTempPmPath(async (context) => {
        delete process.env.PM_TELEMETRY_OTEL_DISABLED;
        const health = await runHealth({ path: context.pmPath });
        const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
        expect(telemetryCheck?.details).toMatchObject({
          env_overrides: {
            telemetry_disabled: true,
            pm_no_telemetry: true,
            telemetry_otel_disabled: false,
          },
        });
      });
    } finally {
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
      if (originalOtelDisabled === undefined) {
        delete process.env.PM_TELEMETRY_OTEL_DISABLED;
      } else {
        process.env.PM_TELEMETRY_OTEL_DISABLED = originalOtelDisabled;
      }
    }
  });

  it("reports pending telemetry queue entries and last successful flush metadata", async () => {
    await withTempPmPath(async (context) => {
      const globalRoot = context.env.PM_GLOBAL_PATH as string;
      const telemetryRuntimeDir = path.join(globalRoot, "runtime", "telemetry");
      await mkdir(telemetryRuntimeDir, { recursive: true });
      await writeFile(
        path.join(telemetryRuntimeDir, "events.jsonl"),
        `${JSON.stringify({ attempts: 0, event: { event_id: "evt-1" } })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(telemetryRuntimeDir, "state.json"),
        `${JSON.stringify(
          {
            last_successful_flush_at: "2026-04-26T10:11:12.000Z",
            pending_otel_spans: "not-a-number",
            queue_entries: 1,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(true);
      expect(health.warnings).not.toEqual(expect.arrayContaining(["telemetry_queue_pending:1"]));

      const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
      expect(telemetryCheck?.status).toBe("ok");
      expect(telemetryCheck?.details).toMatchObject({
        queue_entries: 1,
        queue_draining: true,
        queue_exists: true,
        last_successful_flush_at: "2026-04-26T10:11:12.000Z",
        pending_otel_spans: 0,
      });
    });
  });

  it("warns on telemetry queue when flush is in active failure state", async () => {
    await withTempPmPath(async (context) => {
      const globalRoot = context.env.PM_GLOBAL_PATH as string;
      const telemetryRuntimeDir = path.join(globalRoot, "runtime", "telemetry");
      await mkdir(telemetryRuntimeDir, { recursive: true });
      await writeFile(
        path.join(telemetryRuntimeDir, "events.jsonl"),
        `${JSON.stringify({ attempts: 3, event: { event_id: "evt-1" } })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(telemetryRuntimeDir, "state.json"),
        `${JSON.stringify(
          {
            last_successful_flush_at: "2026-04-26T10:00:00.000Z",
            last_failed_flush_at: "2026-04-26T11:00:00.000Z",
            pending_otel_spans: 3,
            queue_entries: 1,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      // Telemetry warnings are advisory: surfaced but never flip overall health.
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual(expect.arrayContaining(["telemetry_queue_pending:1"]));

      const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
      expect(telemetryCheck?.status).toBe("warn");
      expect(telemetryCheck?.details).toMatchObject({
        queue_entries: 1,
        queue_draining: false,
        queue_exists: true,
        pending_otel_spans: 3,
      });
    });
  });

  it("surfaces an advisory storage warning for streams over the compaction threshold", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context);
      for (let index = 0; index < 5; index += 1) {
        expect(context.runCli(["update", itemId, "--priority", String(index % 5)]).code).toBe(0);
      }
      // A second, shallow stream stays under the threshold so the policy scan
      // exercises both the over- and under-threshold branches.
      const shallowId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.history.compact_policy = { enabled: true, max_entries: 3, trigger: "health_warn" };
      await writeSettings(context.pmPath, settings, "test:compact-policy");

      const health = await runHealth({ path: context.pmPath });
      // Over-threshold warnings are advisory: surfaced but never flip overall health.
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual(
        expect.arrayContaining([`history_stream_over_compact_threshold:${itemId}`]),
      );

      const storageCheck = health.checks.find((check) => check.name === "storage");
      expect(storageCheck?.status).toBe("warn");
      expect(storageCheck?.details).toMatchObject({
        compact_policy: {
          enabled: true,
          max_entries: 3,
          trigger: "health_warn",
          over_threshold_count: 1,
          over_threshold: [itemId],
        },
        remediation_map: { history_stream_over_compact_threshold: "pm history-compact <id>" },
      });
    });
  });

  it("rewrites the storage remediation to the bulk sweep when multiple streams are over threshold", async () => {
    await withTempPmPath(async (context) => {
      const first = createSeedItem(context);
      const second = createSeedItem(context);
      for (const itemId of [first, second]) {
        for (let index = 0; index < 5; index += 1) {
          expect(context.runCli(["update", itemId, "--priority", String(index % 5)]).code).toBe(0);
        }
      }
      const settings = await readSettings(context.pmPath);
      settings.history.compact_policy = { enabled: true, max_entries: 3, trigger: "auto" };
      await writeSettings(context.pmPath, settings, "test:compact-policy");

      const health = await runHealth({ path: context.pmPath });
      const storageCheck = health.checks.find((check) => check.name === "storage");
      const compactPolicyDetails = storageCheck?.details as
        | { compact_policy?: { over_threshold_count?: number } }
        | undefined;
      expect(compactPolicyDetails?.compact_policy?.over_threshold_count).toBe(2);
      expect(storageCheck?.details).toMatchObject({
        remediation_map: { history_stream_over_compact_threshold: "pm history-compact --all-streams" },
      });
    });
  });

  it("warns when telemetry queue entries approach retry exhaustion", async () => {
    await withTempPmPath(async (context) => {
      const globalRoot = context.env.PM_GLOBAL_PATH as string;
      const telemetryRuntimeDir = path.join(globalRoot, "runtime", "telemetry");
      await mkdir(telemetryRuntimeDir, { recursive: true });
      await writeFile(
        path.join(telemetryRuntimeDir, "events.jsonl"),
        [
          JSON.stringify({ attempts: 12, event: { event_id: "evt-near-exhaustion" } }),
          JSON.stringify({ attempts: 1, event: { event_id: "evt-fresh" } }),
        ].join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(telemetryRuntimeDir, "state.json"),
        `${JSON.stringify(
          {
            last_successful_flush_at: "2026-04-26T10:00:00.000Z",
            queue_entries: 2,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual(expect.arrayContaining(["telemetry_queue_high_retries:1"]));

      const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
      expect(telemetryCheck?.status).toBe("warn");
      expect(telemetryCheck?.details).toMatchObject({
        queue_entries: 2,
        queue_high_retry_entries: 1,
        queue_high_retry_threshold: 12,
        queue_max_attempts: 12,
        queue_draining: false,
      });
      const telemetryDetails = telemetryCheck?.details as { remediation_map?: Record<string, string> } | undefined;
      expect(telemetryDetails?.remediation_map).toMatchObject({
        telemetry_queue_high_retries: "pm telemetry flush",
      });
    });
  });

  it("warns on malformed telemetry queue rows and runtime state JSON", async () => {
    await withTempPmPath(async (context) => {
      const globalRoot = context.env.PM_GLOBAL_PATH as string;
      const telemetryRuntimeDir = path.join(globalRoot, "runtime", "telemetry");
      await mkdir(telemetryRuntimeDir, { recursive: true });
      await writeFile(
        path.join(telemetryRuntimeDir, "events.jsonl"),
        `${JSON.stringify({ attempts: 1, event: { event_id: "evt-valid" } })}\nnot-json\n`,
        "utf8",
      );
      await writeFile(path.join(telemetryRuntimeDir, "state.json"), "{bad-json\n", "utf8");

      const health = await runHealth({ path: context.pmPath });

      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual(
        expect.arrayContaining(["telemetry_state_invalid_json", "telemetry_queue_invalid_rows:1"]),
      );
      const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
      expect(telemetryCheck?.status).toBe("warn");
      expect(telemetryCheck?.details).toMatchObject({
        queue_entries: 1,
        queue_invalid_rows: 1,
      });
    });
  });

  it("probes telemetry endpoint health when --check-telemetry is enabled", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => new Response("service unavailable", {
        status: 503,
        headers: {
          "x-pm-telemetry-max-schema-version": "2",
        },
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        const health = await runHealth({ path: context.pmPath }, { checkTelemetry: true });
        // Telemetry endpoint probe failures are advisory: surfaced but not blocking.
        expect(health.ok).toBe(true);
        expect(health.warnings).toEqual(expect.arrayContaining(["telemetry_endpoint_probe_http_status:503"]));
        expect(health.warnings).not.toEqual(expect.arrayContaining(["telemetry_schema_version_behind:2"]));
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
        expect(telemetryCheck?.status).toBe("warn");
        expect(telemetryCheck?.details).toMatchObject({
          endpoint: "https://pm-cli.unbrained.dev/v1/events",
          endpoint_probe: {
            attempted: true,
            ok: false,
            status: 503,
            probe_url: "https://pm-cli.unbrained.dev/healthz",
            max_schema_version: "2",
          },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("warns when telemetry endpoint advertises a newer schema version", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => new Response("ok", {
        status: 200,
        headers: {
          "x-pm-telemetry-max-schema-version": "2",
        },
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        const health = await runHealth({ path: context.pmPath }, { checkTelemetry: true });
        expect(health.ok).toBe(true);
        expect(health.warnings).toEqual(expect.arrayContaining(["telemetry_schema_version_behind:2"]));

        const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
        expect(telemetryCheck?.details).toMatchObject({
          endpoint_probe: {
            attempted: true,
            ok: true,
            status: 200,
            max_schema_version: "2",
          },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("does not warn when telemetry endpoint schema version matches the client", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => new Response("ok", {
        status: 200,
        headers: {
          "x-pm-telemetry-max-schema-version": "1",
        },
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        const health = await runHealth({ path: context.pmPath }, { checkTelemetry: true });
        expect(health.ok).toBe(true);
        expect(health.warnings).not.toEqual(expect.arrayContaining(["telemetry_schema_version_behind:1"]));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("does not warn when telemetry endpoint omits max schema version headers", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      try {
        const health = await runHealth({ path: context.pmPath }, { checkTelemetry: true });
        expect(health.ok).toBe(true);
        expect(health.warnings).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^telemetry_schema_version_behind:/)]),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("warns when telemetry endpoint probing throws before an HTTP response", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.telemetry.endpoint = "https://pm-cli.unbrained.dev/v1/events";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => {
        throw new Error("network unavailable");
      }) as unknown as typeof fetch;
      try {
        const health = await runHealth({ path: context.pmPath }, { checkTelemetry: true });
        expect(health.ok).toBe(true);
        expect(health.warnings).toEqual(expect.arrayContaining(["telemetry_endpoint_probe_failed"]));
        const telemetryCheck = health.checks.find((check) => check.name === "telemetry");
        expect(telemetryCheck?.status).toBe("warn");
        expect(telemetryCheck?.details).toMatchObject({
          endpoint_probe: {
            attempted: true,
            ok: false,
            error: "network unavailable",
          },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("detects missing unreadable and hash-mismatched history drift", async () => {
    await withTempPmPath(async (context) => {
      const missingId = createSeedItem(context);
      const unreadableId = createSeedItem(context);
      const mismatchId = createSeedItem(context);

      await rm(path.join(context.pmPath, "history", `${missingId}.jsonl`), { force: true });
      await writeFile(path.join(context.pmPath, "history", `${unreadableId}.jsonl`), "not-json\n", "utf8");

      const mismatchPath = path.join(context.pmPath, "history", `${mismatchId}.jsonl`);
      const mismatchRaw = await readFile(mismatchPath, "utf8");
      const mismatchLines = mismatchRaw.trim().split(/\r?\n/);
      const lastEntry = JSON.parse(mismatchLines[mismatchLines.length - 1]) as { after_hash: string };
      lastEntry.after_hash = "corrupted-after-hash";
      mismatchLines[mismatchLines.length - 1] = JSON.stringify(lastEntry);
      await writeFile(mismatchPath, `${mismatchLines.join("\n")}\n`, "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual(
        expect.arrayContaining([
          `history_drift_missing_stream:${missingId}`,
          `history_drift_unreadable_stream:${unreadableId}`,
          `history_drift_hash_mismatch:${mismatchId}`,
          `history_drift_chain_mismatch:${mismatchId}`,
        ]),
      );

      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      expect(historyDriftCheck?.status).toBe("warn");
      expect(historyDriftCheck?.details).toMatchObject({
        checked_items: 3,
        drifted_items: [mismatchId, missingId, unreadableId].sort((left, right) => left.localeCompare(right)),
        missing_streams: [missingId],
        unreadable_streams: [unreadableId],
        hash_mismatches: [mismatchId],
        chain_mismatches: [mismatchId],
      });
    });
  });

  it("detects history chain drift when the latest item hash still matches", async () => {
    await withTempPmPath(async (context) => {
      const id = createSeedItem(context);
      const update = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--author",
          "test-author",
          "--message",
          "Add second history entry",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const lines = (await readFile(historyPath, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const firstEntry = JSON.parse(lines[0]) as { after_hash: string };
      firstEntry.after_hash = "tampered-after-hash";
      lines[0] = JSON.stringify(firstEntry);
      await writeFile(historyPath, `${lines.join("\n")}\n`, "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toContain(`history_drift_chain_mismatch:${id}`);
      expect(health.warnings).not.toContain(`history_drift_hash_mismatch:${id}`);

      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      expect(historyDriftCheck?.details).toMatchObject({
        drifted_items: [id],
        hash_mismatches: [],
        chain_mismatches: [id],
      });
    });
  });

  it("reports integrity conflict-marker diagnostics for item and history files", async () => {
    await withTempPmPath(async (context) => {
      const itemConflictId = createSeedItem(context);
      const historyConflictId = createSeedItem(context);

      const markdownItemPath = path.join(context.pmPath, "tasks", `${itemConflictId}.md`);
      const toonItemPath = path.join(context.pmPath, "tasks", `${itemConflictId}.toon`);
      let itemPath = markdownItemPath;
      try {
        await access(itemPath);
      } catch {
        itemPath = toonItemPath;
      }
      await writeFile(itemPath, "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch\n", "utf8");
      await writeFile(
        path.join(context.pmPath, "history", `${historyConflictId}.jsonl`),
        "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch\n",
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      const relativeItemPath = path.relative(context.pmPath, itemPath).replaceAll("\\", "/");
      expect(health.warnings).toEqual(
        expect.arrayContaining([
          `integrity_item_conflict_marker:${relativeItemPath}:L1`,
          `integrity_history_conflict_marker:${historyConflictId}:L1`,
        ]),
      );

      const integrityCheck = health.checks.find((check) => check.name === "integrity");
      expect(integrityCheck?.status).toBe("warn");
      expect(integrityCheck?.details).toMatchObject({
        counts: {
          item_conflict_markers: 1,
          history_conflict_markers: 1,
        },
      });
    });
  });

  it("reports integrity unreadable and parse-failure diagnostics", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);

      await mkdir(path.join(context.pmPath, "tasks", "integrity-unreadable.md"), { recursive: true });
      await writeFile(path.join(context.pmPath, "tasks", "integrity-parse-failure.md"), "{ invalid-json", "utf8");
      await mkdir(path.join(context.pmPath, "history", "integrity-unreadable.jsonl"), { recursive: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual(
        expect.arrayContaining([
          "integrity_item_unreadable:tasks/integrity-unreadable.md",
          "integrity_item_parse_failed:tasks/integrity-parse-failure.md",
          "integrity_history_unreadable:integrity-unreadable",
        ]),
      );

      const integrityCheck = health.checks.find((check) => check.name === "integrity");
      expect(integrityCheck?.status).toBe("warn");
      expect(integrityCheck?.details).toMatchObject({
        counts: {
          item_unreadable: 1,
          item_parse_failures: 1,
          history_unreadable: 1,
        },
      });
    });
  });

  it("reports an integrity warning for items written by a newer format version", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);

      await writeFile(
        path.join(context.pmPath, "tasks", "pm-ahead.toon"),
        [
          "id: pm-ahead",
          "title: Future format item",
          'description: ""',
          "type: Task",
          "pm_format_version: 2",
          "status: open",
          "priority: 2",
          "tags: []",
          'created_at: "2026-02-22T00:00:00.000Z"',
          'updated_at: "2026-02-22T00:00:00.000Z"',
          "author: test-author",
          'body: ""',
          "",
        ].join("\n"),
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.warnings).toEqual(
        expect.arrayContaining(["integrity_item_ahead_format_version:tasks/pm-ahead.toon"]),
      );
      expect(health.warnings.some((warning) => warning.startsWith("integrity_item_outdated_format_version:"))).toBe(false);

      const integrityCheck = health.checks.find((check) => check.name === "integrity");
      expect(integrityCheck?.status).toBe("warn");
      expect(integrityCheck?.details).toMatchObject({
        counts: {
          item_outdated_format_version: 0,
          item_ahead_format_version: 1,
        },
        item_outdated_format_version: [],
        item_ahead_format_version: ["tasks/pm-ahead.toon"],
      });
    });
  });

  it("fails in strict mode when required history streams are missing", async () => {
    await withTempPmPath(async (context) => {
      const missingId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.history.missing_stream = "strict_error";
      await writeSettings(context.pmPath, settings);
      await rm(path.join(context.pmPath, "history", `${missingId}.jsonl`), { force: true });

      await expect(runHealth({ path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("auto-refreshes stale vectorization entries through targeted semantic refresh", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installSemanticFetchMock();

      try {
        const health = await runHealth({ path: context.pmPath });
        expect(health.ok).toBe(true);
        expect(health.warnings).toEqual([]);

        const vectorizationCheck = health.checks.find((check) => check.name === "vectorization");
        expect(vectorizationCheck?.status).toBe("ok");
        expect(vectorizationCheck?.details).toMatchObject({
          semantic_runtime_available: true,
          stale_items_before: [itemId],
          refresh_attempted: true,
          stale_items_after: [],
          refresh_result: {
            refreshed: [itemId],
            skipped: [],
            warnings: [],
          },
        });

        const settledHealth = await runHealth({ path: context.pmPath });
        const settledVectorizationCheck = settledHealth.checks.find((check) => check.name === "vectorization");
        expect(settledVectorizationCheck?.details).toMatchObject({
          semantic_runtime_available: true,
          stale_items_before: [],
          stale_items_after: [],
          refresh_attempted: false,
          refresh_skipped_reason: "no_stale_items",
        });
        expect(semanticMock.calls).toEqual([
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
        ]);
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("warns when vectorization embedding identity differs from current runtime provider settings", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context);
      const getResult = context.runCli(["get", itemId, "--json"], { expectJson: true });
      expect(getResult.code).toBe(0);
      const updatedAt = (getResult.json as { item: { updated_at: string } }).item.updated_at;

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "new-model";
      settings.vector_store.lancedb.path = path.join(context.pmPath, "search", "lancedb-health-identity");
      await writeSettings(context.pmPath, settings);

      await writeVectorizationStatusLedger(
        context.pmPath,
        { [itemId]: updatedAt },
        {
          provider: "openai",
          model: "old-model",
          vector_dimension: 2,
        },
      );

      const health = await runHealth({ path: context.pmPath }, { checkOnly: true });
      expect(health.warnings).toEqual(expect.arrayContaining(["vectorization_embedding_identity_changed"]));
      const vectorizationCheck = health.checks.find((check) => check.name === "vectorization");
      expect(vectorizationCheck?.status).toBe("warn");
      expect(vectorizationCheck?.details).toMatchObject({
        semantic_runtime_available: true,
        embedding_identity_changed: true,
        embedding_identity_before: {
          provider: "openai",
          model: "old-model",
          vector_dimension: 2,
        },
        embedding_identity_runtime: {
          provider: "openai",
          model: "new-model",
        },
      });
    });
  });

  it("supports read-only vectorization checks via --check-only/--no-refresh semantics", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: unknown) => {
        fetchCalls.push(String(url));
        throw new Error("fetch should not be called when refresh is disabled");
      }) as typeof globalThis.fetch;

      try {
        const checkOnly = await runHealth(
          { path: context.pmPath },
          {
            checkOnly: true,
          },
        );
        expect(checkOnly.ok).toBe(false);
        const checkOnlyVectorization = checkOnly.checks.find((check) => check.name === "vectorization");
        expect(checkOnlyVectorization?.details).toMatchObject({
          semantic_runtime_available: true,
          stale_items_before: [itemId],
          stale_items_after: [itemId],
          refresh_attempted: false,
          refresh_skipped_reason: "refresh_disabled",
          refresh_policy: {
            enabled: false,
            check_only: true,
            no_refresh: true,
            refresh_vectors: false,
          },
        });

        const noRefresh = await runHealth(
          { path: context.pmPath },
          {
            noRefresh: true,
          },
        );
        expect(noRefresh.ok).toBe(false);
        const noRefreshVectorization = noRefresh.checks.find((check) => check.name === "vectorization");
        expect(noRefreshVectorization?.details).toMatchObject({
          semantic_runtime_available: true,
          stale_items_before: [itemId],
          stale_items_after: [itemId],
          refresh_attempted: false,
          refresh_skipped_reason: "refresh_disabled",
          refresh_policy: {
            enabled: false,
            check_only: false,
            no_refresh: true,
            refresh_vectors: false,
          },
        });
        expect(fetchCalls).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it(
    "summarizes stale vectorization IDs by default and supports verbose expansion",
    async () => {
      await withTempPmPath(async (context) => {
        const ids: string[] = [];
        for (let index = 0; index < 26; index += 1) {
          ids.push(createSeedItem(context));
        }

        const settings = await readSettings(context.pmPath);
        settings.providers.openai.base_url = "https://api.example.test/v1";
        settings.providers.openai.model = "text-embedding-3-small";
        settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
        await writeSettings(context.pmPath, settings);

        const summaryResult = await runHealth(
          { path: context.pmPath },
          {
            checkOnly: true,
          },
        );
        const summaryVectorizationCheck = summaryResult.checks.find((check) => check.name === "vectorization");
        const summaryDetails = summaryVectorizationCheck?.details as
          | {
              stale_items_detail_mode: string;
              stale_items_summary_limit: number;
              stale_items_before_total: number;
              stale_items_before: string[];
              stale_items_before_truncated: boolean;
              stale_items_after_total: number;
              stale_items_after: string[];
              stale_items_after_truncated: boolean;
            }
          | undefined;
        if (summaryDetails === undefined) {
          throw new TypeError("Expected health vectorization summary details to exist.");
        }
        expect(summaryDetails.stale_items_detail_mode).toBe("summary");
        expect(summaryDetails.stale_items_summary_limit).toBe(25);
        expect(summaryDetails.stale_items_before_total).toBe(ids.length);
        expect(summaryDetails.stale_items_after_total).toBe(ids.length);
        expect(summaryDetails.stale_items_before.length).toBe(25);
        expect(summaryDetails.stale_items_after.length).toBe(25);
        expect(summaryDetails.stale_items_before_truncated).toBe(true);
        expect(summaryDetails.stale_items_after_truncated).toBe(true);
        expect(summaryDetails.stale_items_before.every((entry) => ids.includes(entry))).toBe(true);
        expect(summaryDetails.stale_items_after.every((entry) => ids.includes(entry))).toBe(true);

        const verboseResult = await runHealth(
          { path: context.pmPath },
          {
            checkOnly: true,
            verboseStaleItems: true,
          },
        );
        const verboseVectorizationCheck = verboseResult.checks.find((check) => check.name === "vectorization");
        const verboseDetails = verboseVectorizationCheck?.details as
          | {
              stale_items_detail_mode: string;
              stale_items_before_total: number;
              stale_items_before: string[];
              stale_items_before_truncated: boolean;
              stale_items_after_total: number;
              stale_items_after: string[];
              stale_items_after_truncated: boolean;
            }
          | undefined;
        if (verboseDetails === undefined) {
          throw new TypeError("Expected health vectorization verbose details to exist.");
        }
        expect(verboseDetails.stale_items_detail_mode).toBe("full");
        expect(verboseDetails.stale_items_before_total).toBe(ids.length);
        expect(verboseDetails.stale_items_after_total).toBe(ids.length);
        expect(verboseDetails.stale_items_before.length).toBe(ids.length);
        expect(verboseDetails.stale_items_after.length).toBe(ids.length);
        expect(verboseDetails.stale_items_before_truncated).toBe(false);
        expect(verboseDetails.stale_items_after_truncated).toBe(false);
        expect(verboseDetails.stale_items_before).toEqual(expect.arrayContaining(ids));
        expect(verboseDetails.stale_items_after).toEqual(expect.arrayContaining(ids));
      });
    },
    120_000,
  );

  it("rejects conflicting vector refresh policy flags", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      await expect(
        runHealth(
          { path: context.pmPath },
          {
            checkOnly: true,
            refreshVectors: true,
          },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runHealth(
          { path: context.pmPath },
          {
            noRefresh: true,
            refreshVectors: true,
          },
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("warns when targeted vectorization refresh fails and stale items remain", async () => {
    await withTempPmPath(async (context) => {
      const itemId = createSeedItem(context);
      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const semanticMock = installFailingFetchMock({ text: "embedding unavailable" });

      try {
        const health = await runHealth({ path: context.pmPath });
        expect(health.ok).toBe(false);
        expect(health.warnings).toEqual(expect.arrayContaining([`vectorization_stale_items_remaining:1`]));

        const vectorizationCheck = health.checks.find((check) => check.name === "vectorization");
        expect(vectorizationCheck?.status).toBe("warn");
        expect(vectorizationCheck?.details).toMatchObject({
          semantic_runtime_available: true,
          stale_items_before: [itemId],
          stale_items_after: [itemId],
        });
      } finally {
        semanticMock.restore();
      }
    });
  });

  it("reports warn checks for missing directories and invalid settings values", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        id_prefix: string;
        locks: { ttl_seconds: number };
      };
      settings.id_prefix = "";
      settings.locks.ttl_seconds = 0;
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await rm(path.join(context.pmPath, "history"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "search"), { recursive: true, force: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "missing_directory:history",
        "missing_directory:search",
        "settings:id_prefix_empty",
        "settings:locks_ttl_non_positive",
      ]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("warn");
      expect(directoriesCheck?.details).toMatchObject({
        missing: ["history", "search"],
      });

      const settingValuesCheck = health.checks.find((check) => check.name === "settings_values");
      expect(settingValuesCheck?.status).toBe("warn");
      // settings_values is a remediation source, so a machine-executable
      // remediation_map is attached alongside the warning list in full output.
      expect(settingValuesCheck?.details).toEqual({
        warnings: ["settings:id_prefix_empty", "settings:locks_ttl_non_positive"],
        remediation_map: {
          "settings:id_prefix_empty": "pm config list --json",
          "settings:locks_ttl_non_positive": "pm config list --json",
        },
      });

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("ok");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        discovered: [],
        warnings: [],
      });

      const storageCheck = health.checks.find((check) => check.name === "storage");
      expect(storageCheck?.details).toEqual({
        items: 0,
        history_streams: 0,
      });
    });
  });

  it("treats missing optional type directories as informational by default", async () => {
    await withTempPmPath(async (context) => {
      await rm(path.join(context.pmPath, "events"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "reminders"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "milestones"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "meetings"), { recursive: true, force: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(true);
      expect(health.warnings).toEqual([]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("ok");
      expect(directoriesCheck?.details).toMatchObject({
        missing: [],
        missing_optional: ["events", "meetings", "milestones", "reminders"],
        strict_directories: false,
      });
    });
  });

  it("fails on missing optional directories when strict mode is enabled", async () => {
    await withTempPmPath(async (context) => {
      await rm(path.join(context.pmPath, "events"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "reminders"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "milestones"), { recursive: true, force: true });
      await rm(path.join(context.pmPath, "meetings"), { recursive: true, force: true });

      const health = await runHealth({ path: context.pmPath }, { strictDirectories: true });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "missing_directory:events",
        "missing_directory:meetings",
        "missing_directory:milestones",
        "missing_directory:reminders",
      ]);

      const directoriesCheck = health.checks.find((check) => check.name === "directories");
      expect(directoriesCheck?.status).toBe("warn");
      expect(directoriesCheck?.details).toMatchObject({
        missing: ["events", "meetings", "milestones", "reminders"],
        missing_optional: ["events", "meetings", "milestones", "reminders"],
        strict_directories: true,
      });
    });
  });

  it("marks extension check unhealthy when runtime load probe fails", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "boom"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "boom", "manifest.json"),
        `${JSON.stringify(
          {
            name: "boom-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "boom", "index.js"), "throw new Error('boom-load');\n", "utf8");

      await mkdir(path.join(projectExtensionsRoot, "ok"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "ok", "manifest.json"),
        `${JSON.stringify(
          {
            name: "ok-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "ok", "index.js"), "export default { ok: true };\n", "utf8");

      await mkdir(path.join(projectExtensionsRoot, "primitive"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "primitive", "manifest.json"),
        `${JSON.stringify(
          {
            name: "primitive-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "primitive", "index.js"), "export default 1;\n", "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "extension_load_failed:project:boom-ext",
        "extension_update_health_partial_coverage:skipped_unmanaged:2",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        warnings: [
          "extension_load_failed:project:boom-ext",
          "extension_update_health_partial_coverage:skipped_unmanaged:2",
        ],
        failed: [
          expect.objectContaining({
            layer: "project",
            name: "boom-ext",
          }),
        ],
        triage: {
          status: "warn",
          warning_count: 2,
          load_failure_count: 1,
          activation_failure_count: 0,
        },
      });
      // The system-wide adoption gap surfaces a machine-executable remediation
      // map alongside the per-extension triage; the load-failure code is not in
      // the shared registry and is intentionally absent (pm-bdvm).
      const extensionDetails = extensionCheck?.details as
        | { remediation_map?: Record<string, string>; loaded?: Array<{ name: string; has_activate: boolean; module?: unknown }> }
        | undefined;
      expect(extensionDetails?.remediation_map).toEqual({
        extension_update_health_partial_coverage: "pm extension --adopt-all --project",
      });

      const loaded = extensionDetails?.loaded ?? [];
      expect(loaded).toEqual([
        expect.objectContaining({
          name: "ok-ext",
          has_activate: false,
        }),
        expect.objectContaining({
          name: "primitive-ext",
          has_activate: false,
        }),
      ]);
      expect(loaded.every((entry) => !("module" in entry))).toBe(true);
    });
  });

  it("marks extension check unhealthy when runtime activation probe fails", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "activate-boom"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "activate-boom", "manifest.json"),
        `${JSON.stringify(
          {
            name: "activate-boom-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "activate-boom", "index.js"),
        "export default { activate() { throw new Error('activate-boom'); } };\n",
        "utf8",
      );

      await mkdir(path.join(projectExtensionsRoot, "ok"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "ok", "manifest.json"),
        `${JSON.stringify(
          {
            name: "ok-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "ok", "index.js"),
        "export default { activate() {} };\n",
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "extension_activate_failed:project:activate-boom-ext",
        "extension_update_health_partial_coverage:skipped_unmanaged:2",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        failed: [],
        warnings: [
          "extension_activate_failed:project:activate-boom-ext",
          "extension_update_health_partial_coverage:skipped_unmanaged:2",
        ],
        triage: {
          status: "warn",
          warning_count: 2,
          load_failure_count: 0,
          activation_failure_count: 1,
        },
        activation: {
          warnings: ["extension_activate_failed:project:activate-boom-ext"],
          failed: [
            expect.objectContaining({
              layer: "project",
              name: "activate-boom-ext",
              error: "activate-boom",
            }),
          ],
          hook_counts: {
            before_command: 0,
            after_command: 0,
            on_write: 0,
            on_read: 0,
            on_index: 0,
          },
          command_override_count: 0,
          command_handler_count: 0,
          renderer_override_count: 0,
        },
      });

      const extensionDetails = extensionCheck?.details as { loaded?: Array<{ name: string }> } | undefined;
      const loaded = extensionDetails?.loaded ?? [];
      expect(loaded.map((entry) => entry.name)).toEqual([
        "activate-boom-ext",
        "ok-ext",
      ]);
    });
  });

  it("reports actionable extension collision remediation in health diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      for (const name of ["pm-starter", "pm-ts-starter"]) {
        const extensionDir = path.join(projectExtensionsRoot, name);
        await mkdir(extensionDir, { recursive: true });
        await writeFile(
          path.join(extensionDir, "manifest.json"),
          `${JSON.stringify(
            {
              name,
              version: "1.0.0",
              entry: "./index.js",
              capabilities: ["preflight", "renderers"],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await writeFile(
          path.join(extensionDir, "index.js"),
          [
            "export default {",
            "  activate(api) {",
            "    api.registerPreflight(() => ({}));",
            "    api.registerRenderer('json', () => '{}');",
            "  },",
            "};",
            "",
          ].join("\n"),
          "utf8",
        );
      }

      const health = await runHealth({ path: context.pmPath });
      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      const extensionDetails = extensionCheck?.details as
        | {
            triage?: {
              warning_codes: string[];
              remediation: string[];
            };
          }
        | undefined;
      const triage = extensionDetails?.triage;

      expect(triage?.warning_codes).toEqual(
        expect.arrayContaining(["extension_preflight_override_collision", "extension_renderer_collision"]),
      );
      expect(triage?.remediation.join(" ")).toContain("Conflicting extensions: pm-starter, pm-ts-starter");
      expect(triage?.remediation.join(" ")).toContain("pm extension --deactivate <name> --project/--global");
      expect(triage?.remediation.join(" ")).toContain("pm extension --doctor --project/--global --detail deep --trace");
    });
  });

  it("treats bundled-style unmanaged extensions as informational for update-health coverage", async () => {
    await withTempPmPath(async (context) => {
      const bundledStyleDir = path.join(context.pmPath, "extensions", "beads");
      await mkdir(bundledStyleDir, { recursive: true });
      await writeFile(
        path.join(bundledStyleDir, "manifest.json"),
        `${JSON.stringify(
          {
            name: "custom-beads-like-ext",
            version: "1.0.0",
            entry: "index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(bundledStyleDir, "index.js"), "export default { activate() {} };\n", "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.warnings.some((warning) => warning.startsWith("extension_update_health_partial_coverage:"))).toBe(false);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      const extensionDetails = extensionCheck?.details as
        | {
            discovered?: Array<{ name: string | null }>;
            loaded?: Array<{ name: string }>;
            triage?: {
              update_health_coverage: string;
              update_health_partial: boolean;
              unmanaged_loaded_extension_count: number;
              unmanaged_expected_extension_count: number;
              unmanaged_action_required_extension_count: number;
              remediation: string[];
            };
          }
        | undefined;
      const triage = extensionDetails?.triage;
      expect(triage).toMatchObject({
        update_health_coverage: "full",
        update_health_partial: false,
        unmanaged_loaded_extension_count: 1,
        unmanaged_expected_extension_count: 1,
        unmanaged_action_required_extension_count: 0,
      });
      expect((triage?.remediation ?? []).some((entry) => entry.includes("treated as informational"))).toBe(true);
    });
  });

  it("reports applied pending and failed extension migrations in health diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      const globalExtensionsRoot = path.join(context.env.PM_GLOBAL_PATH as string, "extensions");

      await mkdir(path.join(globalExtensionsRoot, "global-migration-ext"), { recursive: true });
      await writeFile(
        path.join(globalExtensionsRoot, "global-migration-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "global-migration-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(globalExtensionsRoot, "global-migration-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'global-migrate' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      await mkdir(path.join(projectExtensionsRoot, "a-ext"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "a-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "a-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "a-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({});",
          "    api.registerMigration({ id: 'zzz-migrate' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      await mkdir(path.join(projectExtensionsRoot, "b-ext"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "b-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "b-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "b-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: 'applied-migrate', status: 'APPLIED' });",
          "    api.registerMigration({ id: 'bbb-migrate' });",
          "    api.registerMigration({ id: 'failed-migrate', status: 'FAILED', error: 'checksum_mismatch' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "extension_migration_failed:project:b-ext:failed-migrate",
        "extension_migration_pending:global:global-migration-ext:global-migrate",
        "extension_migration_pending:project:a-ext:migration-002",
        "extension_migration_pending:project:a-ext:zzz-migrate",
        "extension_migration_pending:project:b-ext:bbb-migrate",
        "extension_update_health_partial_coverage:skipped_unmanaged:3",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        warnings: [
          "extension_migration_failed:project:b-ext:failed-migrate",
          "extension_migration_pending:global:global-migration-ext:global-migrate",
          "extension_migration_pending:project:a-ext:migration-002",
          "extension_migration_pending:project:a-ext:zzz-migrate",
          "extension_migration_pending:project:b-ext:bbb-migrate",
          "extension_update_health_partial_coverage:skipped_unmanaged:3",
        ],
        activation: {
          migration_status: {
            applied_count: 1,
            pending_count: 4,
            failed_count: 1,
            applied: [
              {
                layer: "project",
                name: "b-ext",
                id: "applied-migrate",
                status: "applied",
              },
            ],
            pending: [
              {
                layer: "global",
                name: "global-migration-ext",
                id: "global-migrate",
                status: "pending",
              },
              {
                layer: "project",
                name: "a-ext",
                id: "migration-002",
                status: "pending",
              },
              {
                layer: "project",
                name: "a-ext",
                id: "zzz-migrate",
                status: "pending",
              },
              {
                layer: "project",
                name: "b-ext",
                id: "bbb-migrate",
                status: "pending",
              },
            ],
            failed: [
              {
                layer: "project",
                name: "b-ext",
                id: "failed-migrate",
                status: "failed",
                reason: "checksum_mismatch",
              },
            ],
          },
        },
      });
    });
  });

  it("includes allowed capability guidance and nearest-match suggestions for unknown capabilities", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      await mkdir(path.join(projectExtensionsRoot, "unknown-capability"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "unknown-capability", "manifest.json"),
        `${JSON.stringify(
          {
            name: "unknown-capability-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["service"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "unknown-capability", "index.js"), "export default { activate() {} };\n", "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      const capabilityWarning = health.warnings.find((warning) =>
        warning.startsWith("extension_capability_unknown:project:unknown-capability-ext:service"),
      );
      expect(capabilityWarning).toBeDefined();
      expect(capabilityWarning).toContain("allowed=commands,renderers,hooks,schema,importers,search,parser,preflight,services");
      expect(capabilityWarning).toContain("suggested=services");

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      const details = extensionCheck?.details as {
        capability_contract?: { version?: number; legacy_aliases?: Record<string, string> };
        capability_guidance?: Array<Record<string, unknown>>;
        triage?: { unknown_capability_count?: number; remediation?: string[] };
      };
      expect(details.capability_contract?.version).toBeGreaterThanOrEqual(1);
      expect(details.capability_contract?.legacy_aliases?.migration).toBe("schema");
      expect(details.capability_guidance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: "project",
            name: "unknown-capability-ext",
            capability: "service",
            suggested_capability: "services",
            suggestion_source: "nearest_match",
          }),
        ]),
      );
      const allowedCapabilities = details.capability_guidance?.[0]?.allowed_capabilities as string[] | undefined;
      expect(allowedCapabilities ?? []).toContain("services");
      expect(typeof details.capability_guidance?.[0]?.capability_contract_version).toBe("number");
      expect(details.triage?.unknown_capability_count).toBeGreaterThanOrEqual(1);
      expect((details.triage?.remediation ?? []).some((entry) => entry.includes("Allowed capabilities"))).toBe(true);
    });
  });

  it("includes legacy capability alias guidance for health extension diagnostics", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      await mkdir(path.join(projectExtensionsRoot, "legacy-capability"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "legacy-capability", "manifest.json"),
        `${JSON.stringify(
          {
            name: "legacy-capability-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["migration"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(projectExtensionsRoot, "legacy-capability", "index.js"), "export default { activate() {} };\n", "utf8");

      const health = await runHealth({ path: context.pmPath });
      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      const details = extensionCheck?.details as {
        capability_guidance?: Array<Record<string, unknown>>;
      };
      expect(details.capability_guidance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "migration",
            suggested_capability: "schema",
            suggestion_source: "legacy_alias",
            legacy_alias_target: "schema",
          }),
        ]),
      );
    });
  });

  it("normalizes blank migration metadata and falls back to message reason", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "fallback-ext"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "fallback-ext", "manifest.json"),
        `${JSON.stringify(
          {
            name: "fallback-ext",
            version: "1.0.0",
            entry: "./index.js",
            capabilities: ["schema"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(projectExtensionsRoot, "fallback-ext", "index.js"),
        [
          "export default {",
          "  activate(api) {",
          "    api.registerMigration({ id: '   ' });",
          "    api.registerMigration({ id: 'failed-message', status: 'failed', reason: '   ', error: '   ', message: 'message_only' });",
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath });
      expect(health.warnings).toEqual([
        "extension_migration_failed:project:fallback-ext:failed-message",
        "extension_migration_pending:project:fallback-ext:migration-001",
        "extension_update_health_partial_coverage:skipped_unmanaged:1",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.details).toMatchObject({
        activation: {
          migration_status: {
            pending_count: 1,
            failed_count: 1,
            pending: [
              {
                layer: "project",
                name: "fallback-ext",
                id: "migration-001",
                status: "pending",
              },
            ],
            failed: [
              {
                layer: "project",
                name: "fallback-ext",
                id: "failed-message",
                status: "failed",
                reason: "message_only",
              },
            ],
          },
        },
      });
    });
  });

  it("reports extension manifest issues and respects --no-extensions", async () => {
    await withTempPmPath(async (context) => {
      const projectExtensionsRoot = path.join(context.pmPath, "extensions");
      const globalExtensionsRoot = path.join(context.env.PM_GLOBAL_PATH as string, "extensions");

      await mkdir(path.join(projectExtensionsRoot, "broken-manifest"), { recursive: true });
      await writeFile(path.join(projectExtensionsRoot, "broken-manifest", "manifest.json"), "{not-json", "utf8");
      await mkdir(path.join(projectExtensionsRoot, "invalid-entry"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "invalid-entry", "manifest.json"),
        `${JSON.stringify(
          {
            name: "invalid-entry-ext",
            version: "0.1.0",
            entry: "",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "invalid-name"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "invalid-name", "manifest.json"),
        `${JSON.stringify(
          {
            name: "",
            version: "0.1.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "invalid-version"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "invalid-version", "manifest.json"),
        `${JSON.stringify(
          {
            name: "invalid-version-ext",
            version: "",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "missing-manifest"), { recursive: true });
      await mkdir(path.join(projectExtensionsRoot, "missing-entry"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "missing-entry", "manifest.json"),
        `${JSON.stringify(
          {
            name: "project-missing-entry",
            version: "0.1.0",
            entry: "./dist/index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await mkdir(path.join(projectExtensionsRoot, "non-object"), { recursive: true });
      await writeFile(path.join(projectExtensionsRoot, "non-object", "manifest.json"), '"not-an-object"\n', "utf8");
      await mkdir(path.join(projectExtensionsRoot, "outside-entry"), { recursive: true });
      await writeFile(
        path.join(projectExtensionsRoot, "outside-entry", "manifest.json"),
        `${JSON.stringify(
          {
            name: "outside-entry-ext",
            version: "0.1.0",
            entry: "../outside-target.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(context.pmPath, "outside-target.js"), "export default {};\n", "utf8");

      await mkdir(path.join(globalExtensionsRoot, "global-valid"), { recursive: true });
      await writeFile(
        path.join(globalExtensionsRoot, "global-valid", "manifest.json"),
        `${JSON.stringify(
          {
            name: "global-valid-ext",
            version: "1.0.0",
            entry: "./index.js",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(path.join(globalExtensionsRoot, "global-valid", "index.js"), "export default {};\n", "utf8");

      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        extensions: {
          enabled: string[];
          disabled: string[];
        };
      };
      settings.extensions.enabled = [" zed ", "alpha", "alpha"];
      settings.extensions.disabled = ["gamma", " beta "];
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual([
        "extension_manifest_invalid:project:broken-manifest",
        "extension_manifest_invalid:project:invalid-entry",
        "extension_manifest_invalid:project:invalid-name",
        "extension_manifest_invalid:project:invalid-version",
        "extension_entry_missing:project:project-missing-entry",
        "extension_manifest_missing:project:missing-manifest",
        "extension_manifest_invalid:project:non-object",
        "extension_entry_outside_extension:project:outside-entry-ext",
      ]);

      const extensionCheck = health.checks.find((check) => check.name === "extensions");
      expect(extensionCheck?.status).toBe("warn");
      expect(extensionCheck?.details).toMatchObject({
        disabled_by_flag: false,
        configured_enabled: ["alpha", "zed"],
        configured_disabled: ["beta", "gamma"],
        warnings: [
          "extension_manifest_invalid:project:broken-manifest",
          "extension_manifest_invalid:project:invalid-entry",
          "extension_manifest_invalid:project:invalid-name",
          "extension_manifest_invalid:project:invalid-version",
          "extension_entry_missing:project:project-missing-entry",
          "extension_manifest_missing:project:missing-manifest",
          "extension_manifest_invalid:project:non-object",
          "extension_entry_outside_extension:project:outside-entry-ext",
        ],
      });
      const extensionDetails = extensionCheck?.details as
        | {
            discovered?: Array<{ name: string | null }>;
            loaded?: Array<{ name: string }>;
          }
        | undefined;
      const filteredLoaded = extensionDetails?.loaded ?? [];
      expect(filteredLoaded.map((entry) => entry.name)).toEqual([]);

      const discovered = extensionDetails?.discovered ?? [];
      expect(discovered.map((entry) => entry.name)).toEqual([
        "global-valid-ext",
        null,
        null,
        null,
        null,
        "project-missing-entry",
        null,
        null,
        "outside-entry-ext",
      ]);

      const skipped = await runHealth({ path: context.pmPath, noExtensions: true });
      expect(skipped.ok).toBe(true);
      expect(skipped.warnings).toEqual([]);
      const skippedCheck = skipped.checks.find((check) => check.name === "extensions");
      expect(skippedCheck?.status).toBe("ok");
      expect(skippedCheck?.details).toMatchObject({
        disabled_by_flag: true,
        discovered: [],
        loaded: [],
        warnings: [],
      });
    });
  });

  it("reports extension hook warnings from health read-path dispatch", async () => {
    await withTempPmPath(async (context) => {
      const firstSeedId = createSeedItem(context);
      const secondSeedId = createSeedItem(context);
      const events: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [
          {
            layer: "project",
            name: "boom-read-hook",
            run: () => {
              throw new Error("boom-read");
            },
          },
          {
            layer: "project",
            name: "ok-read-hook",
            run: (hookContext) => {
              events.push(path.basename(hookContext.path));
            },
          },
        ],
        onIndex: [],
      });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toContain("extension_hook_failed:project:boom-read-hook:onRead");
      expect(events).toContain("history");
      const expectedHistoryEvents = [firstSeedId, secondSeedId]
        .sort((left, right) => left.localeCompare(right))
        .map((id) => `${id}.jsonl`);
      const historyStreamEvents = events.filter((event) => event.endsWith(".jsonl"));
      expect(historyStreamEvents).toEqual(expectedHistoryEvents);
    });
  });

  it("skips integrity, drift, and vector checks when skip flags are set", async () => {
    await withTempPmPath(async (context) => {
      const health = await runHealth({ path: context.pmPath }, { skipIntegrity: true, skipDrift: true, skipVectors: true });
      const integrityCheck = health.checks.find((c) => c.name === "integrity");
      const driftCheck = health.checks.find((c) => c.name === "history_drift");
      const vectorCheck = health.checks.find((c) => c.name === "vectorization");
      expect(integrityCheck?.details).toMatchObject({ skipped: true });
      expect(driftCheck?.details).toMatchObject({ skipped: true });
      expect(vectorCheck?.details).toMatchObject({ skipped: true });
      expect(health.ok).toBe(true);
    });
  });

  it("supports brief low-token projection for agent health checks", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      const health = await runHealth({ path: context.pmPath }, { brief: true });
      expect(health.ok).toBe(true);
      expect(health.projection).toEqual({
        mode: "brief",
        warning_count: 0,
        warnings_truncated: false,
        detail_limit: 8,
      });
      const extensionCheck = health.checks.find((c) => c.name === "extensions");
      expect(extensionCheck?.details).toMatchObject({
        discovered: {
          count: 0,
          sample: [],
          truncated: false,
        },
        activation: {
          command_handler_count: 0,
        },
      });
      expect(extensionCheck?.details).not.toHaveProperty("roots");
    });
  });

  it("uses fast skipped expensive checks for brief check-only agent loops", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      const health = await runHealth({ path: context.pmPath }, { brief: true, checkOnly: true });
      const integrityCheck = health.checks.find((c) => c.name === "integrity");
      const driftCheck = health.checks.find((c) => c.name === "history_drift");
      const vectorCheck = health.checks.find((c) => c.name === "vectorization");
      expect(integrityCheck?.details).toMatchObject({ skipped: true });
      expect(driftCheck?.details).toMatchObject({ skipped: true });
      expect(vectorCheck?.details).toMatchObject({ skipped: true });
      expect(health.projection?.mode).toBe("brief");
      expect(health.ok).toBe(true);
    });
  });

  it("supports summary projection and omits skipped check sections", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      const health = await runHealth(
        { path: context.pmPath },
        { summary: true, skipIntegrity: true, skipDrift: true, skipVectors: true },
      );
      expect(health.ok).toBe(true);
      expect(health.warning_count).toBe(0);
      expect(health.projection).toMatchObject({
        mode: "summary",
        warning_count: 0,
        warnings_truncated: false,
        omitted_checks: ["integrity", "history_drift", "vectorization"],
      });
      expect(health.checks.map((check) => check.name)).toEqual([
        "settings",
        "directories",
        "settings_values",
        "telemetry",
        "extensions",
        "storage",
        "locks",
      ]);
      expect(health.checks.every((check) => Object.keys(check.details).length === 0)).toBe(true);
    });
  });

  it("full flag overrides skip flags", async () => {
    await withTempPmPath(async (context) => {
      const health = await runHealth({ path: context.pmPath }, { skipIntegrity: true, skipDrift: true, full: true });
      const integrityCheck = health.checks.find((c) => c.name === "integrity");
      const driftCheck = health.checks.find((c) => c.name === "history_drift");
      expect(integrityCheck?.details).not.toMatchObject({ skipped: true });
      expect(driftCheck?.details).not.toMatchObject({ skipped: true });
    });
  });

  it("attaches a machine-executable remediation_map to the history_drift check on missing-stream drift", async () => {
    await withTempPmPath(async (context) => {
      const missingId = createSeedItem(context);
      await rm(path.join(context.pmPath, "history", `${missingId}.jsonl`), { force: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toContain(`history_drift_missing_stream:${missingId}`);

      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      expect(historyDriftCheck?.status).toBe("warn");
      const historyDriftDetails = historyDriftCheck?.details as
        | { remediation_map?: Record<string, string> }
        | undefined;
      const remediationMap = historyDriftDetails?.remediation_map;
      expect(remediationMap).toEqual({
        history_drift_missing_stream: "pm history-repair <id>",
      });
    });
  });

  it("omits the remediation_map from history_drift details in brief projection mode", async () => {
    await withTempPmPath(async (context) => {
      const missingId = createSeedItem(context);
      await rm(path.join(context.pmPath, "history", `${missingId}.jsonl`), { force: true });

      const health = await runHealth({ path: context.pmPath }, { brief: true });
      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      expect(historyDriftCheck).toBeDefined();
      expect(historyDriftCheck?.details).not.toHaveProperty("remediation_map");
    });
  });

  it("rewrites history_drift remediation to pm history-repair --all when more than one stream is drifted", async () => {
    await withTempPmPath(async (context) => {
      const firstId = createSeedItem(context);
      const secondId = createSeedItem(context);
      await rm(path.join(context.pmPath, "history", `${firstId}.jsonl`), { force: true });
      await rm(path.join(context.pmPath, "history", `${secondId}.jsonl`), { force: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.ok).toBe(false);
      expect(health.warnings).toEqual(
        expect.arrayContaining([
          `history_drift_missing_stream:${firstId}`,
          `history_drift_missing_stream:${secondId}`,
        ]),
      );
      const historyDriftCheck = health.checks.find((check) => check.name === "history_drift");
      const historyDriftDetails = historyDriftCheck?.details as
        | { remediation_map?: Record<string, string> }
        | undefined;
      const remediationMap = historyDriftDetails?.remediation_map;
      expect(remediationMap).toEqual({
        history_drift_missing_stream: "pm history-repair --all",
      });
    });
  });

  it("reports stale/unreadable/unparseable locks with warnings and a remediation_map", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      const locksDir = path.join(context.pmPath, "locks");
      await mkdir(locksDir, { recursive: true });
      const lockPayload = (createdAt: string, ttlSeconds: number): string =>
        JSON.stringify({ id: "pm-lock", pid: 1234, owner: "spec-owner", created_at: createdAt, ttl_seconds: ttlSeconds });
      // active: fresh timestamp, generous ttl
      await writeFile(path.join(locksDir, "pm-active.lock"), lockPayload(new Date().toISOString(), 3600), "utf8");
      // stale: ttl elapsed long ago
      await writeFile(
        path.join(locksDir, "pm-stale.lock"),
        lockPayload(new Date(Date.now() - 7200 * 1000).toISOString(), 60),
        "utf8",
      );
      // unparseable: invalid JSON
      await writeFile(path.join(locksDir, "pm-broken.lock"), "{not json", "utf8");
      // unreadable: a directory with a .lock name makes readFile fail deterministically
      await mkdir(path.join(locksDir, "pm-unreadable.lock"), { recursive: true });

      const health = await runHealth({ path: context.pmPath });
      expect(health.warnings).toEqual(expect.arrayContaining(["locks_stale_count:1", "locks_unreadable:1"]));

      const locksCheck = health.checks.find((check) => check.name === "locks");
      expect(locksCheck?.status).toBe("warn");
      expect(locksCheck?.details).toMatchObject({
        active_lock_count: 1,
        stale_lock_count: 1,
        unreadable_lock_count: 1,
        unparseable_lock_count: 1,
      });
      const lockDetails = locksCheck?.details as { remediation_map?: Record<string, string> } | undefined;
      const remediationMap = lockDetails?.remediation_map;
      expect(remediationMap).toEqual({
        locks_stale_count: "pm gc --scope locks",
        locks_unreadable: "pm gc --scope locks --dry-run",
      });

      // Read-only contract: the scan never removes or mutates lock files.
      await expect(access(path.join(locksDir, "pm-stale.lock"))).resolves.toBeUndefined();
      await expect(access(path.join(locksDir, "pm-broken.lock"))).resolves.toBeUndefined();
    });
  });

  it("reports a warn check when the locks scan cannot read the locks directory", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      await rm(path.join(context.pmPath, "locks"), { recursive: true, force: true });
      await writeFile(path.join(context.pmPath, "locks"), "not a directory", "utf8");

      const health = await runHealth({ path: context.pmPath });
      expect(health.warnings.some((warning) => warning.startsWith("locks_scan_failed:"))).toBe(true);
      const locksCheck = health.checks.find((check) => check.name === "locks");
      expect(locksCheck?.status).toBe("warn");
      expect(locksCheck?.details).toMatchObject({
        active_lock_count: 0,
        stale_lock_count: 0,
        unreadable_lock_count: 0,
        unparseable_lock_count: 0,
        scan_failed: true,
        pm_root: context.pmPath,
      });
      const lockDetails = locksCheck?.details as { error?: string } | undefined;
      expect(lockDetails?.error).toContain("not a directory");
    });
  });

  it("projects locks counts in brief mode without the remediation_map", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context);
      const locksDir = path.join(context.pmPath, "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(
        path.join(locksDir, "pm-stale.lock"),
        JSON.stringify({
          id: "pm-stale",
          pid: 1234,
          owner: "spec-owner",
          created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
          ttl_seconds: 60,
        }),
        "utf8",
      );

      const health = await runHealth({ path: context.pmPath }, { brief: true });
      const locksCheck = health.checks.find((check) => check.name === "locks");
      expect(locksCheck?.status).toBe("warn");
      expect(locksCheck?.details).toEqual({
        active_lock_count: 0,
        stale_lock_count: 1,
        unreadable_lock_count: 0,
        unparseable_lock_count: 0,
      });
      expect(locksCheck?.details).not.toHaveProperty("remediation_map");
      expect(health.warnings).toContain("locks_stale_count:1");

      const summary = await runHealth({ path: context.pmPath }, { summary: true });
      const summaryLocks = summary.checks.find((check) => check.name === "locks");
      expect(summaryLocks?.status).toBe("warn");
      expect(summaryLocks?.details).toEqual({});
    });
  });
});
