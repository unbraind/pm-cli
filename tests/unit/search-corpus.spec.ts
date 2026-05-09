import { describe, expect, it } from "vitest";
import {
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
