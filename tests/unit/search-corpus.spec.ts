import { describe, expect, it } from "vitest";
import {
  buildPlanCorpus,
  buildPlanFlatCorpus,
  buildSearchCorpus,
  buildSemanticCorpusInput,
  DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  resolveSemanticCorpusInputCharacterLimit,
  SEMANTIC_CORPUS_TRUNCATION_SUFFIX,
} from "../../src/core/search/corpus.js";
import type { ItemDocument, ItemMetadata } from "../../src/types.js";

function makeMetadata(id: string): ItemMetadata {
  return {
    id,
    title: id,
    description: `${id}-description`,
    type: "Task",
    status: "open",
    priority: 1,
    tags: ["search", "corpus"],
    created_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:00:00.000Z",
  };
}

function makeDocument(id: string, body: string): ItemDocument {
  return {
    metadata: makeMetadata(id),
    body,
  };
}

describe("core/search/corpus semantic helpers", () => {
  it("resolves provider-aware semantic corpus limits deterministically", () => {
    expect(resolveSemanticCorpusInputCharacterLimit("ollama")).toBe(OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS);
    expect(resolveSemanticCorpusInputCharacterLimit(" OPENAI ")).toBe(DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS);
    expect(resolveSemanticCorpusInputCharacterLimit(undefined)).toBe(DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS);
  });

  it("falls back to default semantic corpus limit when maxCharacters is invalid", () => {
    const corpus = buildSemanticCorpusInput(makeDocument("pm-corpus-default", "x".repeat(20_000)), {
      maxCharacters: 0,
    });
    expect(corpus.length).toBeLessThanOrEqual(DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS);
    expect(corpus.length).toBeGreaterThan(300);
  });

  it("caps semantic corpus payload by ollama provider limit", () => {
    const corpus = buildSemanticCorpusInput(makeDocument("pm-corpus-ollama", "x".repeat(12_000)), {
      providerName: "ollama",
    });
    expect(corpus.length).toBeLessThanOrEqual(OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS);
  });

  it("handles tiny maxCharacters values by slicing the truncation suffix", () => {
    const corpus = buildSemanticCorpusInput(makeDocument("pm-corpus-tiny", "token"), { maxCharacters: 5 });
    expect(corpus).toBe(SEMANTIC_CORPUS_TRUNCATION_SUFFIX.slice(0, 5));
  });
});

describe("plan corpus integration", () => {
  it("buildPlanCorpus returns undefined for non-plan items", () => {
    expect(buildPlanCorpus(makeMetadata("pm-no-plan"))).toBeUndefined();
  });

  it("buildPlanCorpus and buildPlanFlatCorpus surface plan fields", () => {
    const meta: ItemMetadata = {
      ...makeMetadata("pm-plan-corpus"),
      plan_mode: "approved",
      plan_scope: "scope-text",
      plan_harness: "claude-code",
      plan_resume_context: "resume-here",
      plan_steps: [
        {
          id: "plan-step-001",
          order: 1,
          title: "step-title",
          body: "step-body",
          status: "in_progress",
          owner: "agent",
          evidence: "evidence-text",
          blocked_reason: "blocked-reason-text",
          superseded_by: "supersedes-ref",
          linked_items: [{ id: "pm-rel1", kind: "related", note: "rel-note" }],
          files: [{ path: "src/x.ts", note: "file-note" }],
          tests: [{ command: "node t", path: "t.ts", note: "test-note" }],
          docs: [{ path: "docs/x.md", note: "doc-note" }],
          created_at: "2026-05-09T00:00:00.000Z",
          updated_at: "2026-05-09T00:00:00.000Z",
        },
      ],
      plan_decisions: [{ ts: "2026-05-09T00:00:00.000Z", author: "a", decision: "pick-a", rationale: "r", evidence: "e", step_id: "plan-step-001" }],
      plan_discoveries: [{ ts: "2026-05-09T00:00:00.000Z", author: "a", text: "discovery-text", step_id: "plan-step-001" }],
      plan_validation: [{ text: "validate-text", command: "cmd", expected: "ok" }],
    };
    const planCorpus = buildPlanCorpus(meta);
    expect(planCorpus).toMatchObject({
      mode: "approved",
      scope: "scope-text",
      harness: "claude-code",
      resume_context: "resume-here",
    });
    const flat = buildPlanFlatCorpus(meta);
    expect(flat).toContain("scope-text");
    expect(flat).toContain("step-title");
    expect(flat).toContain("evidence-text");
    expect(flat).toContain("rel-note");
    expect(flat).toContain("file-note");
    expect(flat).toContain("test-note");
    expect(flat).toContain("doc-note");
    expect(flat).toContain("pick-a");
    expect(flat).toContain("discovery-text");
    expect(flat).toContain("validate-text");

    const fullCorpus = buildSearchCorpus({ metadata: meta, body: "body-text" });
    expect(fullCorpus).toHaveProperty("plan");
  });

  it("buildPlanFlatCorpus returns empty string when item has no plan content", () => {
    expect(buildPlanFlatCorpus(makeMetadata("pm-empty-plan"))).toBe("");
  });

  it("handles plan steps without linked_items, files, tests, docs and minimal decision/discovery fields", () => {
    const meta: ItemMetadata = {
      ...makeMetadata("pm-plan-minimal"),
      plan_mode: "draft",
      plan_steps: [
        {
          id: "plan-step-001",
          order: 1,
          title: "bare-step",
          status: "pending",
          created_at: "2026-05-09T00:00:00.000Z",
          updated_at: "2026-05-09T00:00:00.000Z",
        },
      ],
      plan_decisions: [{ ts: "2026-05-09T00:00:00.000Z", author: "a", decision: "d" }],
      plan_discoveries: [{ ts: "2026-05-09T00:00:00.000Z", author: "a", text: "found" }],
      plan_validation: [{ text: "validate" }],
    };
    const planCorpus = buildPlanCorpus(meta);
    expect(planCorpus?.mode).toBe("draft");
    const flat = buildPlanFlatCorpus(meta);
    expect(flat).toContain("bare-step");
    expect(flat).toContain("d");
    expect(flat).toContain("found");
    expect(flat).toContain("validate");
  });
});
