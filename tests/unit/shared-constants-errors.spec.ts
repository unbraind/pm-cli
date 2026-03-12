import { describe, expect, it } from "vitest";
import {
  EMPTY_CANONICAL_DOCUMENT,
  EXIT_CODE,
  FRONT_MATTER_KEY_ORDER,
  PM_DIRNAME,
  PM_REQUIRED_SUBDIRS,
  SETTINGS_DEFAULTS,
  SETTINGS_FILENAME,
  TYPE_TO_FOLDER,
} from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";

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
      "history",
      "index",
      "search",
      "extensions",
      "locks",
    ]);
    expect(TYPE_TO_FOLDER).toEqual({
      Epic: "epics",
      Feature: "features",
      Task: "tasks",
      Chore: "chores",
      Issue: "issues",
    });
    expect(FRONT_MATTER_KEY_ORDER).toEqual([
      "id",
      "title",
      "description",
      "type",
      "source_type",
      "status",
      "priority",
      "tags",
      "created_at",
      "updated_at",
      "deadline",
      "closed_at",
      "assignee",
      "source_owner",
      "author",
      "estimated_minutes",
      "acceptance_criteria",
      "design",
      "external_ref",
      "definition_of_ready",
      "order",
      "goal",
      "objective",
      "value",
      "impact",
      "outcome",
      "why_now",
      "parent",
      "reviewer",
      "risk",
      "confidence",
      "sprint",
      "release",
      "blocked_by",
      "blocked_reason",
      "unblock_note",
      "reporter",
      "severity",
      "environment",
      "repro_steps",
      "resolution",
      "expected_result",
      "actual_result",
      "affected_version",
      "fixed_version",
      "component",
      "regression",
      "customer_impact",
      "dependencies",
      "comments",
      "notes",
      "learnings",
      "files",
      "tests",
      "docs",
      "close_reason",
    ]);
    expect(EMPTY_CANONICAL_DOCUMENT).toEqual({
      front_matter: {},
      body: "",
    });
  });

  it("keeps default settings aligned with release contract", () => {
    expect(SETTINGS_DEFAULTS.version).toBe(1);
    expect(SETTINGS_DEFAULTS.id_prefix).toBe("pm-");
    expect(SETTINGS_DEFAULTS.author_default).toBe("");
    expect(SETTINGS_DEFAULTS.locks.ttl_seconds).toBe(1800);
    expect(SETTINGS_DEFAULTS.output.default_format).toBe("toon");
    expect(SETTINGS_DEFAULTS.extensions.enabled).toEqual([]);
    expect(SETTINGS_DEFAULTS.extensions.disabled).toEqual([]);
    expect(SETTINGS_DEFAULTS.search).toEqual({
      score_threshold: 0,
      hybrid_semantic_weight: 0.7,
      max_results: 50,
      embedding_model: "",
      embedding_batch_size: 32,
      scanner_max_batch_retries: 3,
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
      qdrant: {
        url: "",
        api_key: "",
      },
      lancedb: {
        path: "",
      },
    });
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

  it("constructs PmCliError with expected runtime shape", () => {
    const error = new PmCliError("conflict", EXIT_CODE.CONFLICT);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PmCliError");
    expect(error.message).toBe("conflict");
    expect(error.exitCode).toBe(EXIT_CODE.CONFLICT);
  });
});
