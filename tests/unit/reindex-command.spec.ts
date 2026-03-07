import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReindex } from "../../src/cli/commands/reindex.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { EXIT_CODE } from "../../src/constants.js";
import { readSettings, writeSettings } from "../../src/settings.js";
import type { TempPmContext } from "../helpers/withTempPmPath.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function createSeedItem(context: TempPmContext, title: string, body: string, withSeeds: boolean): string {
  const seedArgs = withSeeds
    ? [
        "--dep",
        "id=pm-seeddep,kind=related,author=unit-test,created_at=now",
        "--comment",
        "author=unit-test,created_at=now,text=seed-comment",
        "--note",
        "author=unit-test,created_at=now,text=seed-note",
        "--learning",
        "author=unit-test,created_at=now,text=seed-learning",
      ]
    : ["--dep", "none", "--comment", "none", "--note", "none", "--learning", "none"];
  const result = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "reindex,unit",
      "--body",
      body,
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      "Reindex captures deterministic keyword artifacts",
      "--author",
      "unit-test",
      "--message",
      "Create reindex seed item",
      "--assignee",
      "none",
      ...seedArgs,
      "--file",
      "none",
      "--test",
      "none",
      "--doc",
      "none",
    ],
    { expectJson: true },
  );
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("runReindex", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-reindex-not-init-"));
    try {
      await expect(runReindex({}, { path: tempDir })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates mode values and semantic/hybrid configuration requirements", async () => {
    await withTempPmPath(async (context) => {
      await expect(runReindex({ mode: "semantic" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires a configured embedding provider"),
      });
      await expect(runReindex({ mode: "hybrid" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires a configured embedding provider"),
      });
      await expect(runReindex({ mode: "bad-mode" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      await writeSettings(context.pmPath, settings);
      await expect(runReindex({ mode: "semantic" }, { path: context.pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("requires a configured vector store"),
      });

      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);
      const semanticResult = await runReindex({ mode: "semantic" }, { path: context.pmPath });
      expect(semanticResult.ok).toBe(true);
      expect(semanticResult.mode).toBe("semantic");
      expect(semanticResult.total_items).toBe(0);
    });
  });

  it("rebuilds deterministic keyword cache artifacts", async () => {
    await withTempPmPath(async (context) => {
      const idA = createSeedItem(context, "Alpha Reindex Item", "first body", true);
      const idB = createSeedItem(context, "Beta Reindex Item", "second body", false);

      const result = await runReindex({}, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("keyword");
      expect(result.total_items).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(result.artifacts).toEqual({
        manifest: "index/manifest.json",
        embeddings: "search/embeddings.jsonl",
      });
      expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const manifestRaw = await readFile(path.join(context.pmPath, "index", "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as {
        mode: string;
        total_items: number;
        items: Array<{ id: string; type: string; status: string }>;
      };
      expect(manifest.mode).toBe("keyword");
      expect(manifest.total_items).toBe(2);
      expect(manifest.items.map((entry) => entry.id)).toEqual([idA, idB].sort((a, b) => a.localeCompare(b)));
      expect(manifest.items.every((entry) => entry.type === "Task" && entry.status === "open")).toBe(true);

      const embeddingsRaw = await readFile(path.join(context.pmPath, "search", "embeddings.jsonl"), "utf8");
      const records = embeddingsRaw
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              id: string;
              mode: string;
              corpus: {
                body: string;
                comments: string[];
                notes: string[];
                learnings: string[];
                dependencies: Array<{ id: string; kind: string }>;
              };
            },
        );
      expect(records.map((entry) => entry.id)).toEqual([idA, idB].sort((a, b) => a.localeCompare(b)));
      expect(records.every((entry) => entry.mode === "keyword")).toBe(true);
      const byId = new Map(records.map((entry) => [entry.id, entry]));
      expect(byId.get(idA)?.corpus.body).toBe("first body");
      expect(byId.get(idB)?.corpus.body).toBe("second body");
      expect(byId.get(idA)?.corpus.comments).toEqual(["seed-comment"]);
      expect(byId.get(idA)?.corpus.notes).toEqual(["seed-note"]);
      expect(byId.get(idA)?.corpus.learnings).toEqual(["seed-learning"]);
      expect(byId.get(idA)?.corpus.dependencies).toEqual([{ id: "pm-seeddep", kind: "related" }]);

      const rerun = await runReindex({ mode: "keyword" }, { path: context.pmPath });
      expect(rerun.ok).toBe(true);
      expect(rerun.total_items).toBe(2);
    });
  });

  it("rebuilds semantic and hybrid artifacts with embedding + vector execution", async () => {
    await withTempPmPath(async (context) => {
      const idA = createSeedItem(context, "Semantic Alpha", "alpha body", false);
      const idB = createSeedItem(context, "Semantic Beta", "beta body", false);

      const settings = await readSettings(context.pmPath);
      settings.providers.openai.base_url = "https://api.example.test/v1";
      settings.providers.openai.model = "text-embedding-3-small";
      settings.vector_store.qdrant.url = "https://qdrant.example.test:6333";
      await writeSettings(context.pmPath, settings);

      const originalFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        fetchCalls.push(target);
        if (target.endsWith("/v1/embeddings")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] | string };
          const inputCount = Array.isArray(body.input) ? body.input.length : 1;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              data: Array.from({ length: inputCount }, (_, index) => ({
                index,
                embedding: [index + 0.1, index + 0.2],
              })),
            }),
            text: async () => "",
          } as unknown as Response;
        }
        if (target.endsWith("/collections/pm_items/points?wait=true")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ result: { status: "acknowledged" } }),
            text: async () => "",
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch target: ${target}`);
      }) as typeof globalThis.fetch;

      try {
        const semanticResult = await runReindex({ mode: "semantic" }, { path: context.pmPath });
        expect(semanticResult.ok).toBe(true);
        expect(semanticResult.mode).toBe("semantic");
        expect(semanticResult.total_items).toBe(2);

        const manifestSemanticRaw = await readFile(path.join(context.pmPath, "index", "manifest.json"), "utf8");
        const manifestSemantic = JSON.parse(manifestSemanticRaw) as { mode: string };
        expect(manifestSemantic.mode).toBe("semantic");

        const embeddingsSemanticRaw = await readFile(path.join(context.pmPath, "search", "embeddings.jsonl"), "utf8");
        const semanticRecords = embeddingsSemanticRaw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { id: string; mode: string });
        expect(semanticRecords.map((entry) => entry.id)).toEqual([idA, idB].sort((a, b) => a.localeCompare(b)));
        expect(semanticRecords.every((entry) => entry.mode === "semantic")).toBe(true);

        const hybridResult = await runReindex({ mode: "hybrid" }, { path: context.pmPath });
        expect(hybridResult.ok).toBe(true);
        expect(hybridResult.mode).toBe("hybrid");
        expect(hybridResult.total_items).toBe(2);

        const manifestHybridRaw = await readFile(path.join(context.pmPath, "index", "manifest.json"), "utf8");
        const manifestHybrid = JSON.parse(manifestHybridRaw) as { mode: string };
        expect(manifestHybrid.mode).toBe("hybrid");

        const embeddingsHybridRaw = await readFile(path.join(context.pmPath, "search", "embeddings.jsonl"), "utf8");
        const hybridRecords = embeddingsHybridRaw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { mode: string });
        expect(hybridRecords.every((entry) => entry.mode === "hybrid")).toBe(true);

        expect(fetchCalls).toEqual([
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
          "https://api.example.test/v1/embeddings",
          "https://qdrant.example.test:6333/collections/pm_items/points?wait=true",
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("dispatches active read/write/index hooks and reports hook warnings", async () => {
    await withTempPmPath(async (context) => {
      createSeedItem(context, "Hook Reindex Item", "hook body", false);
      const events: string[] = [];

      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "write-hook",
            run: (hookContext) => {
              events.push(`write:${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
        ],
        onRead: [
          {
            layer: "project",
            name: "read-hook",
            run: (hookContext) => {
              events.push(`read:${path.basename(hookContext.path)}`);
            },
          },
        ],
        onIndex: [
          {
            layer: "project",
            name: "index-hook",
            run: () => {
              throw new Error("index-hook-boom");
            },
          },
        ],
      });

      const result = await runReindex({}, { path: context.pmPath });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual(["extension_hook_failed:project:index-hook:onIndex"]);
      expect(events.some((entry) => entry.startsWith("read:"))).toBe(true);
      expect(events).toContain("write:reindex:manifest:manifest.json");
      expect(events).toContain("write:reindex:embeddings:embeddings.jsonl");
    });
  });
});
