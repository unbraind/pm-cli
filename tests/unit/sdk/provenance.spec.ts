import { describe, expect, it } from "vitest";
import {
  AGENT_PROVENANCE_DIMENSIONS,
  BUILTIN_HARNESS_SIGNAL_DESCRIPTORS,
} from "../../../src/core/shared/author.js";
import {
  analyzeAgentProvenanceDescriptorCoverage,
  summarizeAgentModelProvenance,
} from "../../../src/sdk/provenance.js";

describe("agent provenance SDK analysis", () => {
  it("declares a signal or an explicit no-signal disposition for every built-in dimension", () => {
    for (const descriptor of BUILTIN_HARNESS_SIGNAL_DESCRIPTORS) {
      for (const dimension of AGENT_PROVENANCE_DIMENSIONS) {
        const keys =
          dimension === "model"
            ? descriptor.model_environment_keys
            : descriptor.provenance_environment_keys?.[dimension];
        expect(
          (keys?.length ?? 0) > 0 ||
            descriptor.provenance_unavailable_dimensions?.includes(dimension),
          `${descriptor.harness}:${dimension}`,
        ).toBe(true);
      }
    }
  });

  it("derives built-in dimension conformance and supports a negative control", () => {
    expect(analyzeAgentProvenanceDescriptorCoverage()).toEqual([
      {
        dimension: "model",
        harnesses: [
          "aider",
          "claude-code",
          "codex",
          "cursor",
          "gemini-cli",
          "opencode",
          "pi",
        ],
        covered: true,
      },
      {
        dimension: "effort",
        harnesses: ["claude-code", "codex"],
        covered: true,
      },
      {
        dimension: "role",
        harnesses: ["codex"],
        covered: true,
      },
      {
        dimension: "topic",
        harnesses: [],
        covered: false,
      },
    ]);
    expect(
      analyzeAgentProvenanceDescriptorCoverage(
        [{ harness: "synthetic" }],
        ["synthetic-dimension"],
      ),
    ).toEqual([
      {
        dimension: "synthetic-dimension",
        harnesses: [],
        covered: false,
      },
    ]);
  });

  it("separates observed, unavailable, and legacy-missing model history", () => {
    expect(
      summarizeAgentModelProvenance(
        [
          {
            agent_harness: "codex",
            agent_model: "gpt-5.6-sol",
            agent_provenance: {
              model: { value: "gpt-5.6-sol", source: "environment" },
            },
          },
          {
            agent_harness: "codex",
            agent_provenance: { model: null },
          },
          { agent_harness: "codex" },
          {
            agent_harness: "claude-code",
            agent_provenance: { model: null },
          },
          {},
        ],
        1,
      ),
    ).toEqual([
      {
        harness: "claude-code",
        entries: 1,
        observed: 0,
        unavailable: 1,
        legacy_missing: 0,
        coverage: 0,
        inert: true,
      },
      {
        harness: "codex",
        entries: 3,
        observed: 1,
        unavailable: 1,
        legacy_missing: 1,
        coverage: 0.5,
        inert: false,
      },
    ]);
  });

  it("does not call a legacy-only or undersampled harness inert", () => {
    expect(
      summarizeAgentModelProvenance(
        [
          {
            agent_harness: "empty",
            agent_provenance: {
              model: { value: "", source: "host" },
            },
          },
          { agent_harness: "legacy" },
          { agent_harness: "sampled", agent_provenance: { model: null } },
        ],
        2,
      ),
    ).toEqual([
      {
        harness: "empty",
        entries: 1,
        observed: 0,
        unavailable: 0,
        legacy_missing: 1,
        coverage: null,
        inert: false,
      },
      {
        harness: "legacy",
        entries: 1,
        observed: 0,
        unavailable: 0,
        legacy_missing: 1,
        coverage: null,
        inert: false,
      },
      {
        harness: "sampled",
        entries: 1,
        observed: 0,
        unavailable: 1,
        legacy_missing: 0,
        coverage: 0,
        inert: false,
      },
    ]);
  });
});
