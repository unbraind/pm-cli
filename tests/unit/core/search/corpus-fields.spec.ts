import { describe, expect, it } from "vitest";
import {
  buildSearchCorpus,
  buildSemanticCorpusInput,
  DEFAULT_SEARCH_CORPUS_FIELDS,
  resolveSearchCorpusFields,
} from "../../../../src/core/search/corpus.js";
import type { ItemDocument, ItemMetadata, PmSettings } from "../../../../src/types.js";

function makeMetadata(overrides: Partial<ItemMetadata> = {}): ItemMetadata {
  return {
    id: "pm-corpus-fields",
    title: "blocking release bug",
    description: "high priority issue",
    type: "Issue",
    status: "open",
    priority: 4,
    tags: ["search", "corpus"],
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    assignee: "alice",
    parent: "pm-epic-1",
    goal: "ship the release",
    value: "unblocks launch",
    why_now: "deadline imminent",
    risk: "high",
    confidence: "high",
    estimated_minutes: 90,
    acceptance_criteria: "tests pass",
    resolution: "fixed in patch",
    expected_result: "build green",
    actual_result: "build red",
    ...overrides,
  };
}

function makeDocument(overrides: Partial<ItemMetadata> = {}, body = "body-text"): ItemDocument {
  return { metadata: makeMetadata(overrides), body };
}

function makeSettings(corpusFields?: unknown): Pick<PmSettings, "search"> {
  return {
    search: {
      ...(corpusFields === undefined ? {} : { corpus_fields: corpusFields as string[] }),
    },
  } as Pick<PmSettings, "search">;
}

describe("core/search/corpus structured fields", () => {
  it("emits the new structured fields by default when present", () => {
    const corpus = buildSearchCorpus(makeDocument());
    expect(corpus.type).toBe("Issue");
    expect(corpus.priority).toBe(4);
    expect(corpus.assignee).toBe("alice");
    expect(corpus.parent).toBe("pm-epic-1");
    expect(corpus.goal).toBe("ship the release");
    expect(corpus.value).toBe("unblocks launch");
    expect(corpus.why_now).toBe("deadline imminent");
    expect(corpus.risk).toBe("high");
    expect(corpus.confidence).toBe("high");
    expect(corpus.estimated_minutes).toBe(90);
    expect(corpus.acceptance_criteria).toBe("tests pass");
    expect(corpus.resolution).toBe("fixed in patch");
    expect(corpus.expected_result).toBe("build green");
    expect(corpus.actual_result).toBe("build red");
  });

  it("omits absent / empty optional structured fields for token efficiency", () => {
    const corpus = buildSearchCorpus(
      makeDocument({
        assignee: undefined,
        parent: "   ",
        goal: undefined,
        value: undefined,
        why_now: undefined,
        risk: undefined,
        confidence: undefined,
        estimated_minutes: undefined,
        acceptance_criteria: "",
        resolution: undefined,
        expected_result: undefined,
        actual_result: undefined,
      }),
    );
    for (const field of [
      "assignee",
      "parent",
      "goal",
      "value",
      "why_now",
      "risk",
      "confidence",
      "estimated_minutes",
      "acceptance_criteria",
      "resolution",
      "expected_result",
      "actual_result",
    ]) {
      expect(corpus).not.toHaveProperty(field);
    }
    // Always-present default fields remain.
    expect(corpus).toHaveProperty("title");
    expect(corpus).toHaveProperty("status");
    expect(corpus).toHaveProperty("body");
    expect(corpus).toHaveProperty("comments");
  });

  it("respects an explicit fields subset and skips unknown names", () => {
    const corpus = buildSearchCorpus(makeDocument(), {
      fields: ["title", "priority", "unknown_field", "risk"],
    });
    expect(Object.keys(corpus).sort()).toEqual(["priority", "risk", "title"]);
  });

  it("includes plan only when plan content is present", () => {
    const withoutPlan = buildSearchCorpus(makeDocument(), { fields: ["plan", "title"] });
    expect(withoutPlan).not.toHaveProperty("plan");
    expect(withoutPlan).toHaveProperty("title");

    const withPlan = buildSearchCorpus(
      { metadata: makeMetadata({ plan_mode: "draft" }), body: "" },
      { fields: ["plan"] },
    );
    expect(withPlan).toHaveProperty("plan");
  });
});

describe("resolveSearchCorpusFields", () => {
  it("returns the full default set when settings is undefined", () => {
    expect(resolveSearchCorpusFields(undefined)).toEqual([...DEFAULT_SEARCH_CORPUS_FIELDS]);
  });

  it("returns the full default set when corpus_fields is unset", () => {
    expect(resolveSearchCorpusFields(makeSettings())).toEqual([...DEFAULT_SEARCH_CORPUS_FIELDS]);
  });

  it("returns the full default set when corpus_fields is not an array", () => {
    expect(resolveSearchCorpusFields(makeSettings("title"))).toEqual([...DEFAULT_SEARCH_CORPUS_FIELDS]);
  });

  it("returns the full default set when corpus_fields is an empty / all-blank array", () => {
    expect(resolveSearchCorpusFields(makeSettings([]))).toEqual([...DEFAULT_SEARCH_CORPUS_FIELDS]);
    expect(resolveSearchCorpusFields(makeSettings(["  ", ""]))).toEqual([...DEFAULT_SEARCH_CORPUS_FIELDS]);
  });

  it("returns the configured subset (trimmed, non-string entries dropped)", () => {
    expect(resolveSearchCorpusFields(makeSettings([" title ", "priority", 42, "risk"]))).toEqual([
      "title",
      "priority",
      "risk",
    ]);
  });

  it("threads through buildSemanticCorpusInput", () => {
    const resolved = resolveSearchCorpusFields(makeSettings(["title", "priority"]));
    const input = buildSemanticCorpusInput(makeDocument(), { fields: resolved });
    const parsed = JSON.parse(input) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["priority", "title"]);
  });
});
