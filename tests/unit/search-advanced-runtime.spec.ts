import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PmCliError } from "../../src/core/shared/errors.js";
import { activateExtensions } from "../../src/core/extensions/loader.js";
import { assertRegisteredSearchProvider } from "../../src/sdk/testing.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const SEARCH_ADVANCED_INDEX_PATH = path.join(
  process.cwd(),
  "packages",
  "pm-search-advanced",
  "extensions",
  "search-advanced",
  "index.js",
);

interface SearchProviderModule {
  manifest: { name: string; version: string };
  activate: (api: unknown) => void;
  SEARCH_ADVANCED_LOCAL_PROVIDER: string;
}

async function loadSearchAdvancedIndex(): Promise<SearchProviderModule> {
  process.env.PM_CLI_PACKAGE_ROOT = process.cwd();
  return (await import(
    `${pathToFileURL(SEARCH_ADVANCED_INDEX_PATH).href}?provider-test=${Date.now()}-${Math.random()}`
  )) as SearchProviderModule;
}

interface ProviderHit {
  id: string;
  score: number;
  matched_fields?: string[];
}

function sampleSearchDocument(id: string, title: string, tags: string[], description: string): unknown {
  return { metadata: { id, title, tags, description }, body: "" };
}

async function loadRuntimeModule(): Promise<typeof import("../../packages/pm-search-advanced/extensions/search-advanced/runtime.js")> {
  process.env.PM_CLI_PACKAGE_ROOT = process.cwd();
  const runtimePath = path.join(
    process.cwd(),
    "packages",
    "pm-search-advanced",
    "extensions",
    "search-advanced",
    "runtime.js",
  );
  return import(`${pathToFileURL(runtimePath).href}?test=${Date.now()}-${Math.random()}`);
}

async function importRuntimeWithPackageRoot(packageRoot: string | undefined): Promise<unknown> {
  const previous = process.env.PM_CLI_PACKAGE_ROOT;
  if (packageRoot === undefined) {
    delete process.env.PM_CLI_PACKAGE_ROOT;
  } else {
    process.env.PM_CLI_PACKAGE_ROOT = packageRoot;
  }
  const runtimePath = path.join(
    process.cwd(),
    "packages",
    "pm-search-advanced",
    "extensions",
    "search-advanced",
    "runtime.js",
  );
  try {
    return await import(`${pathToFileURL(runtimePath).href}?failureTest=${Date.now()}-${Math.random()}`);
  } finally {
    if (previous === undefined) {
      delete process.env.PM_CLI_PACKAGE_ROOT;
    } else {
      process.env.PM_CLI_PACKAGE_ROOT = previous;
    }
  }
}

describe("search-advanced package runtime", () => {
  it("keeps search-advanced keyword-first while supporting semantic and hybrid aliases", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "--json",
          "create",
          "--title",
          "Search advanced runtime target",
          "--description",
          "calendar package workflow",
          "--type",
          "Task",
          "--status",
          "open",
          "--create-mode",
          "progressive",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      const runtime = await loadRuntimeModule();
      const global = { json: true, quiet: true, noPager: true, path: context.pmPath };

      const defaultSearch = await runtime.runAdvancedSearchPackage(
        ["calendar package", "--fields", "id,title,score", "--limit", "5"],
        { fields: "id,title,score", limit: "5", full: "false", includeLinked: "false" },
        global,
      );
      expect(defaultSearch.mode).toBe("keyword");
      expect(defaultSearch.query).toBe("calendar package");

      const compactSearch = await runtime.runAdvancedSearchPackage(
        ["calendar package", "--compact", "--limit", "5"],
        { compact: true, limit: "5" },
        global,
      );
      expect(compactSearch.mode).toBe("keyword");

      const fullFilteredSearch = await runtime.runAdvancedSearchPackage(
        ["Search advanced runtime target", "--full", "--include-linked", "--title-exact", "--phrase-exact"],
        {
          full: true,
          includeLinked: true,
          titleExact: true,
          phraseExact: true,
          type: "Task",
          tag: "missing-tag",
          priority: "2",
          deadline_before: "2030-01-01",
          deadline_after: "2000-01-01",
        },
        global,
      );
      expect(fullFilteredSearch.mode).toBe("keyword");

      const aliasFilteredSearch = await runtime.runAdvancedSearchPackage(
        [
          undefined,
          "Search advanced runtime target",
          "--include_linked",
          "--title_exact",
          "--phrase_exact",
          "--deadline-before=2030-01-01",
          "--deadline_after=2000-01-01",
          "--json",
          "",
        ] as unknown as string[],
        {
          include_linked: "no",
          title_exact: "0",
          phrase_exact: "off",
          deadline_before: "2030-01-01",
          deadline_after: "2000-01-01",
        },
        global,
      );
      expect(aliasFilteredSearch.query).toBe("Search advanced runtime target");

      const invalidBooleanSearch = await runtime.runAdvancedSearchPackage(
        ["calendar package"],
        { compact: 1, full: "maybe" },
        global,
      );
      expect(invalidBooleanSearch.mode).toBe("keyword");

      // Explicit hybrid/semantic with no embedding backend configured must
      // degrade to keyword search (never block) instead of throwing.
      const hybridFallback = await runtime.runAdvancedSearchPackage(
        ["--hybrid", "calendar package", "--limit", "5"],
        { limit: "5" },
        global,
      );
      expect(hybridFallback.mode).toBe("keyword");
      expect(hybridFallback.warnings?.some((warning: string) => warning.startsWith("search_hybrid_fallback:"))).toBe(true);

      const semanticFallback = await runtime.runAdvancedSearchPackage(
        ["--semantic", "calendar package", "--limit=5"],
        {},
        global,
      );
      expect(semanticFallback.mode).toBe("keyword");
      expect(semanticFallback.warnings?.some((warning: string) => warning.startsWith("search_semantic_fallback:"))).toBe(true);
    });
  });

  it("validates empty queries and normalizes reindex options", async () => {
    await withTempPmPath(async (context) => {
      const runtime = await loadRuntimeModule();
      const global = { json: true, quiet: true, noPager: true, path: context.pmPath };

      await expect(runtime.runAdvancedSearchPackage(["--limit", "5"], { limit: "5" }, global)).rejects.toMatchObject<
        PmCliError
      >({
        message: "Search query must not be empty",
      });

      const reindex = await runtime.runAdvancedReindexPackage({ mode: "keyword", progress: "true" }, global);
      expect(reindex.mode).toBe("keyword");
      expect(reindex.total_items).toBeGreaterThanOrEqual(0);

      const quietReindex = await runtime.runAdvancedReindexPackage({ mode: "keyword", progress: "false" }, global);
      expect(quietReindex.mode).toBe("keyword");
    });
  });

  it("reports deterministic SDK loading failures", async () => {
    await expect(importRuntimeWithPackageRoot(undefined)).rejects.toThrow("requires PM_CLI_PACKAGE_ROOT");
    await expect(importRuntimeWithPackageRoot("/tmp/pm-cli-missing-sdk-root")).rejects.toThrow(
      "failed to load SDK runtime exports",
    );
    const partialRoot = await mkdtemp(path.join(tmpdir(), "pm-search-runtime-partial-"));
    await mkdir(path.join(partialRoot, "dist", "sdk"), { recursive: true });
    await writeFile(path.join(partialRoot, "dist", "sdk", "runtime.js"), "export const runSearch = true;\n", "utf8");
    await expect(importRuntimeWithPackageRoot(partialRoot)).rejects.toThrow("failed to load SDK runtime exports");
  });

  it("registers the local search provider exemplar and ranks documents by lexical overlap", async () => {
    const mod = await loadSearchAdvancedIndex();
    expect(mod.SEARCH_ADVANCED_LOCAL_PROVIDER).toBe("search-advanced-local");

    const activation = await activateExtensions({
      disabled_by_flag: false,
      roots: { global: "/tmp/global", project: "/tmp/project" },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      loaded: [
        {
          layer: "project",
          directory: "pm-search-advanced",
          manifest_path: "/tmp/project/pm-search-advanced/manifest.json",
          name: mod.manifest.name,
          version: mod.manifest.version,
          entry: "./index.js",
          priority: 0,
          entry_path: SEARCH_ADVANCED_INDEX_PATH,
          module: { manifest: mod.manifest, activate: mod.activate },
        },
      ],
      failed: [],
    });

    expect(activation.failed).toEqual([]);
    expect(activation.warnings).toEqual([]);

    // The SDK assertion helper resolves the real first-party provider registration.
    const registration = assertRegisteredSearchProvider(activation.registrations, {
      provider: "search-advanced-local",
      extensionName: mod.manifest.name,
    });
    const runtimeDefinition = registration.runtime_definition ?? registration.definition;
    const query = (runtimeDefinition as { query: (context: unknown) => ProviderHit[] }).query;
    expect(typeof query).toBe("function");

    const documents = [
      sampleSearchDocument("pm-1", "Calendar agenda view", ["calendar", "ui"], "Render the agenda timeline"),
      sampleSearchDocument("pm-2", "Search ranking", ["search"], "calendar mentions appear in the body only"),
      sampleSearchDocument("pm-3", "Unrelated item", ["misc"], "nothing to see here"),
    ];
    const hits = query({ query: "calendar", mode: "keyword", tokens: ["calendar"], options: {}, settings: {}, documents });

    // pm-1 matches title(3) + tags(2) = 5; pm-2 matches description(1) = 1; pm-3 has no match.
    expect(hits.map((hit) => hit.id)).toEqual(["pm-1", "pm-2"]);
    expect(hits[0]).toEqual({ id: "pm-1", score: 5, matched_fields: ["title", "tags"] });
    expect(hits[1]).toEqual({ id: "pm-2", score: 1, matched_fields: ["description"] });

    // An empty/punctuation-only query returns no hits.
    const emptyHits = query({ query: "  ... ", mode: "keyword", tokens: [], options: {}, settings: {}, documents });
    expect(emptyHits).toEqual([]);

    // Unicode-aware: non-ASCII queries/titles/tags tokenize correctly (universal corpora).
    const unicodeDocs = [
      sampleSearchDocument("pm-u1", "Kalénder Übersicht", ["café"], "日本語 description"),
      sampleSearchDocument("pm-u2", "unrelated", ["misc"], "nothing"),
    ];
    const unicodeHits = query({
      query: "café 日本語",
      mode: "keyword",
      tokens: [],
      options: {},
      settings: {},
      documents: unicodeDocs,
    });
    expect(unicodeHits.map((hit) => hit.id)).toEqual(["pm-u1"]);

    // Malformed documents (missing/null metadata, null tags) are scored safely, never crash.
    const malformedHits = query({
      query: "calendar",
      mode: "keyword",
      tokens: ["calendar"],
      options: {},
      settings: {},
      documents: [
        {},
        { metadata: null },
        { metadata: { title: "calendar" } },
        { metadata: { id: 123, title: "calendar" } },
        { metadata: { id: "pm-z", title: "calendar", tags: [null, "calendar"] } },
      ],
    });
    // Documents missing metadata, with a missing/non-string id, are skipped (no crash in sort()).
    expect(malformedHits.map((hit) => hit.id)).toEqual(["pm-z"]);
  });
});
