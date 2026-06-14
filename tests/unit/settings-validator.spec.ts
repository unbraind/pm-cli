import { describe, expect, it } from "vitest";

import { validateSettings } from "../../src/core/store/settings-validator.js";

/**
 * A minimal settings object that passes validation. Mirrors the required
 * top-level fields of the schema (the optional blocks are exercised separately).
 */
function minimalValidSettings(): Record<string, unknown> {
  return {
    version: 1,
    id_prefix: "pm",
    author_default: "agent",
    locks: { ttl_seconds: 900 },
    output: { default_format: "toon" },
    extensions: { enabled: [], disabled: [] },
    search: {
      score_threshold: 0.2,
      max_results: 25,
      embedding_model: "qwen",
      embedding_batch_size: 16,
      scanner_max_batch_retries: 3,
    },
    providers: {
      openai: { base_url: "https://api.openai.com", api_key: "", model: "text-embedding-3-small" },
      ollama: { base_url: "http://localhost:11434", model: "qwen" },
    },
    vector_store: {
      qdrant: { url: "http://localhost:6333", api_key: "" },
      lancedb: { path: ".agents/pm/search/lancedb" },
    },
  };
}

describe("core/store/settings-validator", () => {
  it("accepts a minimal valid settings object and strips unknown keys", () => {
    const raw = { ...minimalValidSettings(), unknown_top_level_key: "dropped" };
    const result = validateSettings(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.id_prefix).toBe("pm");
      expect("unknown_top_level_key" in result.data).toBe(false);
      // Optional blocks that were absent must be omitted, not present-as-undefined.
      expect("validation" in result.data).toBe(false);
      expect("governance" in result.data).toBe(false);
    }
  });

  it("rejects a non-object payload", () => {
    expect(validateSettings(null).success).toBe(false);
    expect(validateSettings("nope").success).toBe(false);
    expect(validateSettings([1, 2, 3]).success).toBe(false);
  });

  it("rejects when a required top-level field is missing", () => {
    const raw = minimalValidSettings();
    delete raw.id_prefix;
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects a string where a number is required", () => {
    const raw = minimalValidSettings();
    raw.version = "1";
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects a non-integer where an integer is required", () => {
    const raw = minimalValidSettings();
    raw.version = 1.5;
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects a NaN number", () => {
    const raw = minimalValidSettings();
    (raw.search as Record<string, unknown>).score_threshold = Number.NaN;
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects an infinite number", () => {
    const raw = minimalValidSettings();
    (raw.search as Record<string, unknown>).score_threshold = Number.POSITIVE_INFINITY;
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects an unsafe integer where an integer is required", () => {
    const raw = minimalValidSettings();
    (raw.search as Record<string, unknown>).max_results = Number.MAX_SAFE_INTEGER + 1;
    expect(validateSettings(raw).success).toBe(false);
  });

  it("accepts a float where a non-integer number is allowed", () => {
    const raw = minimalValidSettings();
    (raw.search as Record<string, unknown>).score_threshold = 0.42;
    expect(validateSettings(raw).success).toBe(true);
  });

  it("rejects a non-positive value where positive is required", () => {
    const raw = minimalValidSettings();
    raw.telemetry = { enabled: true, retention_days: 0 };
    expect(validateSettings(raw).success).toBe(false);
  });

  it("accepts a valid positive integer constraint", () => {
    const raw = minimalValidSettings();
    raw.telemetry = { enabled: true, retention_days: 30 };
    expect(validateSettings(raw).success).toBe(true);
  });

  it("rejects a value outside a literal union", () => {
    const raw = minimalValidSettings();
    (raw.output as Record<string, unknown>).default_format = "yaml";
    expect(validateSettings(raw).success).toBe(false);
  });

  it("accepts each member of a literal union", () => {
    const raw = minimalValidSettings();
    (raw.output as Record<string, unknown>).default_format = "json";
    expect(validateSettings(raw).success).toBe(true);
  });

  it("accepts pm_max_version_exceeded_mode as a mode literal or per-layer object", () => {
    const literal = minimalValidSettings();
    literal.extensions = {
      enabled: [],
      disabled: [],
      policy: {
        pm_max_version_exceeded_mode: "warn",
      },
    };
    expect(validateSettings(literal).success).toBe(true);

    const perLayer = minimalValidSettings();
    perLayer.extensions = {
      enabled: [],
      disabled: [],
      policy: {
        pm_max_version_exceeded_mode: {
          global: "block",
          project: "warn",
        },
      },
    };
    expect(validateSettings(perLayer).success).toBe(true);
  });

  it("rejects a non-boolean where a boolean is required", () => {
    const raw = minimalValidSettings();
    raw.testing = { record_results_to_items: "yes" };
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects a non-array where an array is required", () => {
    const raw = minimalValidSettings();
    (raw.extensions as Record<string, unknown>).enabled = "beads";
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects an array containing an invalid element", () => {
    const raw = minimalValidSettings();
    (raw.extensions as Record<string, unknown>).enabled = ["beads", 42];
    expect(validateSettings(raw).success).toBe(false);
  });

  it("validates nested optional object blocks and their literal unions", () => {
    const raw = minimalValidSettings();
    raw.governance = { preset: "strict", ownership_enforcement: "warn" };
    raw.item_types = {
      definitions: [
        {
          name: "Spike",
          description: "Time-boxed investigation",
          default_status: "in_progress",
          aliases: ["spk"],
          options: [{ key: "size", values: ["s", "l"] }],
        },
      ],
    };
    raw.schema = { version: 2, statuses: [{ id: "in_review", roles: ["active"] }] };
    raw.context = { default_depth: "deep", sections: { hierarchy: true } };
    const result = validateSettings(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.governance?.preset).toBe("strict");
      expect(result.data.item_types?.definitions[0]?.name).toBe("Spike");
      // description + default_status must survive validation so inline settings
      // definitions behave identically to schema/types.json (config-driven).
      expect(result.data.item_types?.definitions[0]?.description).toBe("Time-boxed investigation");
      expect(result.data.item_types?.definitions[0]?.default_status).toBe("in_progress");
    }
  });

  it("accepts validation.estimate_defaults_by_type as a positive-integer map and rejects bad shapes (GH-212)", () => {
    const accepted = minimalValidSettings();
    accepted.validation = { sprint_release_format: "warn", estimate_defaults_by_type: { Epic: 2880, Task: 120 } };
    const result = validateSettings(accepted);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.validation?.estimate_defaults_by_type).toEqual({ Epic: 2880, Task: 120 });
    }

    // Arrays, non-number values, and non-positive minutes are all rejected.
    for (const bad of [["Epic", 2880], { Epic: "2880" }, { Epic: 0 }, { Epic: -5 }, { Epic: 1.5 }]) {
      const raw = minimalValidSettings();
      raw.validation = { sprint_release_format: "warn", estimate_defaults_by_type: bad as unknown };
      expect(validateSettings(raw).success).toBe(false);
    }
  });

  it("rejects when a nested array element fails a literal-union role check", () => {
    const raw = minimalValidSettings();
    raw.schema = { statuses: [{ id: "in_review", roles: ["bogus_role"] }] };
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects when an extension policy override is missing its required name", () => {
    const raw = minimalValidSettings();
    (raw.extensions as Record<string, unknown>).policy = { extension_overrides: [{ disabled: true }] };
    expect(validateSettings(raw).success).toBe(false);
  });

  it("accepts schema.type_workflows and governance.workflow_enforcement (pm-f4r1)", () => {
    const raw = minimalValidSettings();
    raw.governance = { preset: "default", workflow_enforcement: "strict", create_default_type: "Issue" };
    raw.schema = {
      type_workflows: [
        { type: "Story", allowed_transitions: [["open", "in_progress"], ["in_progress", "closed"]] },
      ],
    };
    const result = validateSettings(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.governance?.workflow_enforcement).toBe("strict");
      expect(result.data.governance?.create_default_type).toBe("Issue");
      expect(result.data.schema?.type_workflows?.[0]?.type).toBe("Story");
    }
  });

  it("rejects a type_workflows pair with the wrong arity (pm-f4r1)", () => {
    const raw = minimalValidSettings();
    raw.schema = {
      type_workflows: [{ type: "Story", allowed_transitions: [["open", "in_progress", "extra"]] }],
    };
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects a type_workflows pair whose element is not a string (pm-f4r1)", () => {
    const raw = minimalValidSettings();
    raw.schema = {
      type_workflows: [{ type: "Story", allowed_transitions: [["open", 5]] }],
    };
    expect(validateSettings(raw).success).toBe(false);
  });

  it("rejects an invalid governance.workflow_enforcement literal (pm-f4r1)", () => {
    const raw = minimalValidSettings();
    raw.governance = { preset: "default", workflow_enforcement: "bogus" };
    expect(validateSettings(raw).success).toBe(false);
  });
});
