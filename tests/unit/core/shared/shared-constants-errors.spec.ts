import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_DEFINITIONS,
  EMPTY_CANONICAL_DOCUMENT,
  EXIT_CODE,
  ITEM_METADATA_KEY_ORDER,
  PM_DIRNAME,
  PM_REQUIRED_SUBDIRS,
  resolveTelemetryErrorCategory,
  SETTINGS_DEFAULTS,
  SETTINGS_FILENAME,
  TELEMETRY_ERROR_CATEGORY_BY_CODE,
  TYPE_TO_FOLDER,
} from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";

describe("shared constants and errors contracts", () => {
  it("matches canonical storage constants and key ordering", () => {
    expect(PM_DIRNAME).toBe(".agents/pm");
    expect(SETTINGS_FILENAME).toBe("settings.json");
    expect(PM_REQUIRED_SUBDIRS).toEqual([
      "",
      "epics",
      "features",
      "tasks",
      "chores",
      "issues",
      "schema",
      "history",
      "search",
      "extensions",
      "locks",
      "decisions",
      "events",
      "reminders",
      "milestones",
      "meetings",
      "plans",
    ]);
    expect(TYPE_TO_FOLDER).toEqual({
      Epic: "epics",
      Feature: "features",
      Task: "tasks",
      Chore: "chores",
      Issue: "issues",
      Decision: "decisions",
      Event: "events",
      Reminder: "reminders",
      Milestone: "milestones",
      Meeting: "meetings",
      Plan: "plans",
    });
    // Structural contract: required fields present, no duplicates, canonical group ordering.
    // Update sentinel list only when intentionally reordering the serialization contract.
    const sentinelOrder = [
      "id", "title", "type", "status", "created_at", "updated_at",
      "closed_at", "assignee", "dependencies",
      "comments", "notes", "learnings", "files", "tests", "docs",
      "close_reason", "plan_steps",
    ];
    const indices = sentinelOrder.map((k) => ITEM_METADATA_KEY_ORDER.indexOf(k));
    // all sentinel keys are present
    expect(indices.every((i) => i !== -1)).toBe(true);
    // sentinel keys appear in the declared relative order
    for (let i = 0; i < indices.length - 1; i++) {
      expect(indices[i]).toBeLessThan(indices[i + 1]);
    }
    // no duplicate keys in the full array
    expect(new Set(ITEM_METADATA_KEY_ORDER).size).toBe(ITEM_METADATA_KEY_ORDER.length);
    expect(EMPTY_CANONICAL_DOCUMENT).toEqual({
      metadata: {},
      body: "",
    });
  });

  it("keeps default settings aligned with release contract", () => {
    expect(SETTINGS_DEFAULTS.version).toBe(1);
    expect(SETTINGS_DEFAULTS.id_prefix).toBe("pm-");
    expect(SETTINGS_DEFAULTS.author_default).toBe("");
    expect(SETTINGS_DEFAULTS.locks.ttl_seconds).toBe(1800);
    expect(SETTINGS_DEFAULTS.output.default_format).toBe("toon");
    expect(SETTINGS_DEFAULTS.history.missing_stream).toBe("auto_create");
    expect(SETTINGS_DEFAULTS.testing.record_results_to_items).toBe(false);
    expect(SETTINGS_DEFAULTS.item_types.definitions).toEqual([]);
    expect(SETTINGS_DEFAULTS.extensions.enabled).toEqual([]);
    expect(SETTINGS_DEFAULTS.extensions.disabled).toEqual([]);
    expect(SETTINGS_DEFAULTS.search).toEqual({
      score_threshold: 0,
      hybrid_semantic_weight: 0.7,
      max_results: 50,
      embedding_model: "",
      embedding_batch_size: 32,
      embedding_timeout_ms: 30000,
      scanner_max_batch_retries: 3,
      provider: "",
      mutation_refresh_policy: "semantic_configured",
      query_expansion: {
        enabled: false,
        provider: "",
      },
      rerank: {
        enabled: false,
        model: "",
        top_k: 20,
      },
    });
    expect(SETTINGS_DEFAULTS.providers).toEqual({
      openai: {
        base_url: "",
        api_key: "",
        model: "",
      },
      ollama: {
        base_url: "",
        model: "",
      },
    });
    expect(SETTINGS_DEFAULTS.vector_store).toEqual({
      adapter: "",
      collection_name: "pm_items",
      qdrant: {
        url: "",
        api_key: "",
      },
      lancedb: {
        path: "",
      },
    });
  });

  it("does not share mutable status defaults with the canonical registry", () => {
    const firstDefault = SETTINGS_DEFAULTS.schema.statuses[0];
    const firstCanonical = DEFAULT_STATUS_DEFINITIONS[0];

    expect(firstDefault).toEqual(firstCanonical);
    expect(firstDefault).not.toBe(firstCanonical);
    expect(firstDefault.roles).not.toBe(firstCanonical.roles);
  });

  it("keeps canonical exit code mapping", () => {
    expect(EXIT_CODE).toEqual({
      SUCCESS: 0,
      GENERIC_FAILURE: 1,
      USAGE: 2,
      NOT_FOUND: 3,
      CONFLICT: 4,
      DEPENDENCY_FAILED: 5,
    });
  });

  it("classifies telemetry error codes with explicit and heuristic fallbacks", () => {
    expect(TELEMETRY_ERROR_CATEGORY_BY_CODE.no_update_fields).toBe("validation");
    expect(TELEMETRY_ERROR_CATEGORY_BY_CODE.dependency_failed).toBe("runtime");
    expect(TELEMETRY_ERROR_CATEGORY_BY_CODE.terminal_state_conflict).toBe("conflict");
    expect(resolveTelemetryErrorCategory(undefined)).toBe("unknown");
    expect(resolveTelemetryErrorCategory("")).toBe("unknown");
    expect(resolveTelemetryErrorCategory("lock_conflict")).toBe("conflict");
    expect(resolveTelemetryErrorCategory("item_locked_by_other_owner")).toBe("conflict");
    expect(resolveTelemetryErrorCategory("terminal_state_conflict")).toBe("conflict");
    expect(resolveTelemetryErrorCategory("unknown_command_variant")).toBe("usage");
    expect(resolveTelemetryErrorCategory("missing_required_token")).toBe("usage");
    expect(resolveTelemetryErrorCategory("invalid_deadline")).toBe("validation");
    expect(resolveTelemetryErrorCategory("health_findings")).toBe("validation");
    expect(resolveTelemetryErrorCategory("validation_findings")).toBe("validation");
    expect(resolveTelemetryErrorCategory("close_through_update")).toBe("validation");
    expect(resolveTelemetryErrorCategory("legacy_item_not_found")).toBe("validation");
    expect(resolveTelemetryErrorCategory("schema_validation_failed")).toBe("validation");
    expect(resolveTelemetryErrorCategory("dependency_failed")).toBe("runtime");
    expect(resolveTelemetryErrorCategory("merge_git_config_unwritable")).toBe(
      "runtime",
    );
    expect(resolveTelemetryErrorCategory("network_error")).toBe("runtime");
    expect(resolveTelemetryErrorCategory("command_failed")).toBe("runtime");
    expect(resolveTelemetryErrorCategory("custom_signal")).toBe("unknown");
  });

  it("constructs PmCliError with expected runtime shape", () => {
    const error = new PmCliError("conflict", EXIT_CODE.CONFLICT);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PmCliError");
    expect(error.message).toBe("conflict");
    expect(error.exitCode).toBe(EXIT_CODE.CONFLICT);
  });
});
