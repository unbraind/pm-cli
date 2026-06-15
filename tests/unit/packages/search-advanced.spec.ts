import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ItemDocument, SearchProviderDefinition } from "../../../src/sdk/index.js";

const INDEX_PATH = path.join(
  process.cwd(),
  "packages",
  "pm-search-advanced",
  "extensions",
  "search-advanced",
  "index.ts",
);

const ORIGINAL_PACKAGE_ROOT = process.env.PM_CLI_PACKAGE_ROOT;

interface SearchAdvancedIndexModule {
  manifest: { name: string; version: string };
  SEARCH_ADVANCED_LOCAL_PROVIDER: string;
  searchAdvancedLocalProvider: () => SearchProviderDefinition;
}

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function loadIndex(): Promise<SearchAdvancedIndexModule> {
  // The package runtime resolves its core SDK exports from PM_CLI_PACKAGE_ROOT/dist/sdk.
  process.env.PM_CLI_PACKAGE_ROOT = process.cwd();
  return (await import(`${pathToFileURL(INDEX_PATH).href}?provider=${cacheBustToken()}`)) as SearchAdvancedIndexModule;
}

function documentOf(metadata: Record<string, unknown>): ItemDocument {
  return { metadata, body: "" } as unknown as ItemDocument;
}

function queryProvider(
  provider: SearchProviderDefinition,
  query: string,
  documents: ItemDocument[],
): Array<{ id: string; score: number; matched_fields: string[] }> {
  return provider.query?.({ query, documents } as never) as never;
}

afterEach(() => {
  if (ORIGINAL_PACKAGE_ROOT === undefined) {
    delete process.env.PM_CLI_PACKAGE_ROOT;
  } else {
    process.env.PM_CLI_PACKAGE_ROOT = ORIGINAL_PACKAGE_ROOT;
  }
});

describe("packages/pm-search-advanced index provider", () => {
  it("exposes the manifest and provider name constant", async () => {
    const mod = await loadIndex();
    expect(mod.manifest.name).toBe("builtin-search-advanced");
    expect(mod.SEARCH_ADVANCED_LOCAL_PROVIDER).toBe("search-advanced-local");
    expect(mod.searchAdvancedLocalProvider().name).toBe(mod.SEARCH_ADVANCED_LOCAL_PROVIDER);
  });

  it("returns no hits for an empty/whitespace query", async () => {
    const { searchAdvancedLocalProvider } = await loadIndex();
    const hits = queryProvider(searchAdvancedLocalProvider(), "   ", [documentOf({ id: "pm-1", title: "alpha" })]);
    expect(hits).toEqual([]);
  });

  it("treats documents without metadata or a non-string id as unscoreable", async () => {
    const { searchAdvancedLocalProvider } = await loadIndex();
    const hits = queryProvider(searchAdvancedLocalProvider(), "alpha", [
      documentOf({ id: 42, title: "alpha" }),
      { body: "" } as unknown as ItemDocument,
      documentOf({ id: "pm-real", title: "alpha" }),
    ]);
    expect(hits).toEqual([{ id: "pm-real", score: 3, matched_fields: ["title"] }]);
  });

  it("scores a non-string title and skips null tag entries without crashing (lines 43/48)", async () => {
    const { searchAdvancedLocalProvider } = await loadIndex();
    const hits = queryProvider(searchAdvancedLocalProvider(), "alpha beta", [
      documentOf({
        id: "pm-1",
        // non-string title exercises the false arm of the title ternary (line 43)
        title: 12345,
        // null/undefined tag entries exercise the `tag == null ? [] : ...` arm (line 48)
        tags: [null, undefined, "alpha"],
        description: "beta narrative",
      }),
    ]);
    expect(hits).toEqual([{ id: "pm-1", score: 2 + 1, matched_fields: ["tags", "description"] }]);
  });

  it("breaks score ties by id via localeCompare (line 95)", async () => {
    const { searchAdvancedLocalProvider } = await loadIndex();
    const hits = queryProvider(searchAdvancedLocalProvider(), "alpha", [
      documentOf({ id: "pm-zzz", title: "alpha" }),
      documentOf({ id: "pm-aaa", title: "alpha" }),
    ]);
    expect(hits.map((hit) => hit.id)).toEqual(["pm-aaa", "pm-zzz"]);
    expect(hits.every((hit) => hit.score === 3)).toBe(true);
  });

  it("handles documents with non-array tags", async () => {
    const { searchAdvancedLocalProvider } = await loadIndex();
    const hits = queryProvider(searchAdvancedLocalProvider(), "alpha", [
      documentOf({ id: "pm-1", title: "alpha", tags: "not-an-array" }),
    ]);
    expect(hits).toEqual([{ id: "pm-1", score: 3, matched_fields: ["title"] }]);
  });
});
