import { describe, expect, it } from "vitest";
import {
  compileHistoryProvenanceMatcher,
  historyEntryMatchesProvenance,
  parseHistoryProvenanceFilters,
  projectHistoryProvenance,
  resolveHistoryProvenanceDimensions,
  summarizeHistoryProvenance,
} from "../../../src/sdk/history-provenance.js";
import type { HistoryEntry } from "../../../src/types.js";

const entry: HistoryEntry = {
  ts: "2026-08-02T00:00:00.000Z",
  author: "codex-root",
  author_source: "asserted",
  agent_instance: "instance-a",
  agent_provenance: {
    effort: { value: "xhigh", source: "environment" },
    model: { value: "gpt-5.6-sol", source: "probe" },
  },
  op: "update",
  patch: [{ op: "replace", path: "/metadata/status", value: "closed" }],
  before_hash: "before",
  after_hash: "after",
  message: "Close work",
};

const vocabulary = {
  version: 7,
  aliases: { "codex-root": "codex" },
};

describe("history provenance SDK primitives", () => {
  it("projects patch-free provenance and interprets legacy authors without mutation", () => {
    const original = structuredClone(entry);
    expect(
      projectHistoryProvenance(entry, vocabulary, {
        itemId: "pm-a",
        version: 3,
      }),
    ).toEqual({
      item_id: "pm-a",
      version: 3,
      ts: entry.ts,
      op: "update",
      author: "codex-root",
      author_source: "asserted",
      agent_harness: "codex",
      harness_source: "vocabulary",
      vocabulary_version: 7,
      agent_instance: "instance-a",
      agent_provenance: entry.agent_provenance,
      message: "Close work",
    });
    expect(projectHistoryProvenance(entry, vocabulary)).not.toHaveProperty(
      "patch",
    );
    expect(entry).toEqual(original);
  });

  it("filters by canonical harness, instance, and extensible dimensions", () => {
    expect(
      historyEntryMatchesProvenance(
        entry,
        {
          harness: "codex",
          agentInstance: "instance-a",
          provenance: ["model=gpt-5.6-sol", "effort=xhigh"],
        },
        vocabulary,
      ),
    ).toBe(true);
    expect(
      historyEntryMatchesProvenance(
        entry,
        { provenance: "model=other" },
        vocabulary,
      ),
    ).toBe(false);
    expect(() =>
      parseHistoryProvenanceFilters({ provenance: "secret=value" }),
    ).toThrow(/Declared dimensions: effort, model, role, topic, version/u);
    expect(() =>
      parseHistoryProvenanceFilters({ provenance: "model" }),
    ).toThrow(/dimension=value/u);
    expect(() =>
      parseHistoryProvenanceFilters({ provenance: "model= " }),
    ).toThrow(/dimension=value/u);
    expect(() =>
      parseHistoryProvenanceFilters({ provenance: "=value" }),
    ).toThrow(/Unknown provenance dimension "=value"/u);

    const matches = compileHistoryProvenanceMatcher(
      {
        harness: ["codex", " claude "],
        agentInstance: ["instance-a"],
      },
      vocabulary,
    );
    expect(matches(entry)).toBe(true);
    expect(matches({ ...entry, agent_harness: "claude" })).toBe(true);
    expect(matches({ ...entry, author: "unmapped", agent_harness: undefined })).toBe(
      false,
    );
    expect(matches({ ...entry, agent_instance: undefined })).toBe(false);
    expect(
      historyEntryMatchesProvenance(entry, { harness: " " }, vocabulary),
    ).toBe(true);
  });

  it("resolves custom descriptor dimensions and ignores invalid declarations", () => {
    expect(
      resolveHistoryProvenanceDimensions([
        {
          harness: "custom",
          environment_markers: ["CUSTOM_HOME"],
          provenance_environment_keys: {
            region: ["CUSTOM_REGION"],
            "Invalid Dimension": ["IGNORED"],
          },
          provenance_resolvers: { revision: "ai_agent_version" },
          provenance_unavailable_dimensions: ["tenant", "also_invalid"],
        },
        {
          harness: "minimal",
          environment_markers: ["MINIMAL_HOME"],
        },
      ]),
    ).toEqual([
      "effort",
      "model",
      "region",
      "revision",
      "role",
      "tenant",
      "topic",
      "version",
    ]);
  });

  it("summarizes resolved identity and every dimension at constant shape", () => {
    expect(
      summarizeHistoryProvenance(
        [
          entry,
          {
            ...entry,
            author: "unmapped-agent",
            agent_instance: undefined,
            agent_provenance: { model: null },
          },
        ],
        vocabulary,
      ),
    ).toMatchObject({
      entries: 2,
      vocabulary_version: 7,
      harness: {
        resolved: 1,
        unresolved: 1,
        unresolved_authors: [{ author: "unmapped-agent", entries: 1 }],
      },
      dimensions: expect.arrayContaining([
        {
          dimension: "model",
          observed: 1,
          unavailable: 1,
          legacy_missing: 0,
        },
        {
          dimension: "effort",
          observed: 1,
          unavailable: 0,
          legacy_missing: 1,
        },
      ]),
    });
  });

  it("projects sparse recorded identity and deterministically ranks unresolved authors", () => {
    const sparse: HistoryEntry = {
      ts: entry.ts,
      op: "create",
      author: "zeta",
      agent_harness: "recorded",
      patch: [],
      before_hash: "before",
      after_hash: "after",
    };
    expect(projectHistoryProvenance(sparse)).toEqual({
      ts: entry.ts,
      op: "create",
      author: "zeta",
      agent_harness: "recorded",
      harness_source: "recorded",
      vocabulary_version: 1,
      agent_provenance: {},
    });
    expect(
      summarizeHistoryProvenance([
        { ...sparse, agent_harness: undefined, author: "zeta" },
        { ...sparse, agent_harness: undefined, author: "alpha" },
      ]).harness.unresolved_authors,
    ).toEqual([
      { author: "alpha", entries: 1 },
      { author: "zeta", entries: 1 },
    ]);
  });
});
