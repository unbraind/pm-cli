import path from "node:path";
import { getActiveExtensionRegistrations, runActiveOnIndexHooks, runActiveOnWriteHooks } from "../../core/extensions/index.js";
import {
  resolveRegisteredSearchProvider,
  resolveRegisteredVectorStoreAdapter,
} from "../../core/extensions/runtime-registrations.js";
import { pathExists, writeFileAtomic } from "../../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { executeEmbeddingBatchesWithRetry } from "../../core/search/embedding-batches.js";
import { resolveEmbeddingProviders } from "../../core/search/providers.js";
import { executeVectorUpsert, resolveVectorStores } from "../../core/search/vector-stores.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import { listAllFrontMatterWithBody } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemDocument, PmSettings } from "../../types/index.js";

const MANIFEST_PATH = "index/manifest.json";
const EMBEDDINGS_PATH = "search/embeddings.jsonl";

export interface ReindexOptions {
  mode?: string;
}

export interface ReindexResult {
  ok: boolean;
  mode: "keyword" | "semantic" | "hybrid";
  total_items: number;
  artifacts: {
    manifest: string;
    embeddings: string;
  };
  warnings: string[];
  generated_at: string;
}

function parseMode(raw: string | undefined): "keyword" | "semantic" | "hybrid" {
  const normalized = (raw ?? "keyword").trim().toLowerCase();
  if (normalized === "keyword") {
    return "keyword";
  }
  if (normalized === "semantic" || normalized === "hybrid") {
    return normalized;
  }
  throw new PmCliError("Reindex mode must be one of keyword|semantic|hybrid", EXIT_CODE.USAGE);
}

async function loadDocuments(
  pmRoot: string,
  itemFormat: "toon" | "json_markdown",
  typeToFolder: Record<string, string>,
): Promise<ItemDocument[]> {
  const items = await listAllFrontMatterWithBody(pmRoot, itemFormat, typeToFolder);
  return items.map((item) => {
    const { body, ...frontMatter } = item;
    return {
      front_matter: frontMatter,
      body,
    };
  });
}

function buildKeywordRecord(document: ItemDocument, mode: "keyword" | "semantic" | "hybrid"): Record<string, unknown> {
  const item = document.front_matter;
  return {
    id: item.id,
    mode,
    updated_at: item.updated_at,
    corpus: {
      title: item.title,
      description: item.description,
      tags: item.tags,
      status: item.status,
      body: document.body,
      comments: (item.comments ?? []).map((entry) => entry.text),
      notes: (item.notes ?? []).map((entry) => entry.text),
      learnings: (item.learnings ?? []).map((entry) => entry.text),
      dependencies: (item.dependencies ?? []).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
      })),
    },
  };
}

function buildSemanticCorpusInput(document: ItemDocument): string {
  return JSON.stringify((buildKeywordRecord(document, "semantic") as { corpus: Record<string, unknown> }).corpus);
}

type ExtensionEmbedBatch = (context: {
  inputs: string[];
  settings: PmSettings;
  model: string;
}) => Promise<number[][]> | number[][];

type ExtensionEmbedOne = (context: {
  input: string;
  settings: PmSettings;
  model: string;
}) => Promise<number[]> | number[];

type ExtensionVectorUpsert = (context: {
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>;
  settings: PmSettings;
}) => Promise<void> | void;

function toOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveExtensionSearchEmbedding(
  settings: PmSettings,
): { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne } | null {
  const registrations = getActiveExtensionRegistrations();
  const providerName = toOptionalNonEmptyString(settings.search?.provider);
  const registration = resolveRegisteredSearchProvider(registrations, providerName);
  if (!registration) {
    return null;
  }
  const runtimeDefinition = registration.runtime_definition ?? registration.definition;
  const name =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((registration.definition as { name?: unknown }).name) ??
    providerName;
  if (!name) {
    return null;
  }
  const embedBatch = (runtimeDefinition as { embedBatch?: unknown; embed_batch?: unknown }).embedBatch;
  const embedBatchSnake = (runtimeDefinition as { embedBatch?: unknown; embed_batch?: unknown }).embed_batch;
  const embed = (runtimeDefinition as { embed?: unknown }).embed;
  const resolvedEmbedBatch =
    typeof embedBatch === "function"
      ? (embedBatch as ExtensionEmbedBatch)
      : typeof embedBatchSnake === "function"
        ? (embedBatchSnake as ExtensionEmbedBatch)
        : undefined;
  const resolvedEmbed = typeof embed === "function" ? (embed as ExtensionEmbedOne) : undefined;
  if (!resolvedEmbedBatch && !resolvedEmbed) {
    return null;
  }
  return {
    name,
    embedBatch: resolvedEmbedBatch,
    embed: resolvedEmbed,
  };
}

function resolveExtensionVectorUpsert(settings: PmSettings): { name: string; upsert: ExtensionVectorUpsert } | null {
  const registrations = getActiveExtensionRegistrations();
  const adapterName = toOptionalNonEmptyString(settings.vector_store?.adapter);
  const registration = resolveRegisteredVectorStoreAdapter(registrations, adapterName);
  if (!registration) {
    return null;
  }
  const runtimeDefinition = registration.runtime_definition ?? registration.definition;
  const name =
    toOptionalNonEmptyString((runtimeDefinition as { name?: unknown }).name) ??
    toOptionalNonEmptyString((registration.definition as { name?: unknown }).name) ??
    adapterName;
  const upsert = (runtimeDefinition as { upsert?: unknown }).upsert;
  if (!name || typeof upsert !== "function") {
    return null;
  }
  return {
    name,
    upsert: upsert as ExtensionVectorUpsert,
  };
}

function assertVector(value: unknown, context: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new PmCliError(`Invalid vector returned by ${context}`, EXIT_CODE.GENERIC_FAILURE);
  }
  return value;
}

async function executeExtensionEmbedding(
  extensionEmbedding: { name: string; embedBatch?: ExtensionEmbedBatch; embed?: ExtensionEmbedOne },
  settings: PmSettings,
  corpusInputs: string[],
): Promise<number[][]> {
  const model = settings.search?.embedding_model?.trim() || "text-embedding-3-small";
  if (extensionEmbedding.embedBatch) {
    const vectors = await Promise.resolve(
      extensionEmbedding.embedBatch({
        inputs: corpusInputs,
        settings,
        model,
      }),
    );
    if (!Array.isArray(vectors)) {
      throw new PmCliError(
        `Extension search provider "${extensionEmbedding.name}" embedBatch must return an array of vectors`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    return vectors.map((vector, index) =>
      assertVector(vector, `extension search provider "${extensionEmbedding.name}" embedBatch output at index ${index}`),
    );
  }
  if (!extensionEmbedding.embed) {
    throw new PmCliError(
      `Extension search provider "${extensionEmbedding.name}" does not implement embed/embedBatch`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  const vectors: number[][] = [];
  for (const [index, input] of corpusInputs.entries()) {
    const vector = await Promise.resolve(
      extensionEmbedding.embed({
        input,
        settings,
        model,
      }),
    );
    vectors.push(assertVector(vector, `extension search provider "${extensionEmbedding.name}" embed output at index ${index}`));
  }
  return vectors;
}

export async function runReindex(options: ReindexOptions, global: GlobalOptions): Promise<ReindexResult> {
  const requestedMode = parseMode(options.mode);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const extensionEmbedding = resolveExtensionSearchEmbedding(settings);
  const extensionVectorUpsert = resolveExtensionVectorUpsert(settings);
  let activeEmbeddingProvider: ReturnType<typeof resolveEmbeddingProviders>["active"] = null;
  let activeVectorStore: ReturnType<typeof resolveVectorStores>["active"] = null;
  if (requestedMode !== "keyword") {
    const providerResolution = resolveEmbeddingProviders(settings);
    if (!providerResolution.active && !extensionEmbedding) {
      throw new PmCliError(
        `Reindex mode '${requestedMode}' requires a configured embedding provider in settings.providers.openai/settings.providers.ollama or an extension provider selected by settings.search.provider`,
        EXIT_CODE.USAGE,
      );
    }
    const vectorResolution = resolveVectorStores(settings);
    if (!vectorResolution.active && !extensionVectorUpsert) {
      throw new PmCliError(
        `Reindex mode '${requestedMode}' requires a configured vector store in settings.vector_store.qdrant/settings.vector_store.lancedb or an extension adapter selected by settings.vector_store.adapter`,
        EXIT_CODE.USAGE,
      );
    }
    activeEmbeddingProvider = providerResolution.active;
    activeVectorStore = vectorResolution.active;
  }
  const mode = requestedMode;
  const documents = await loadDocuments(pmRoot, settings.item_format, typeRegistry.type_to_folder);
  const generatedAt = nowIso();

  const manifest = {
    version: 1,
    mode,
    generated_at: generatedAt,
    total_items: documents.length,
    items: documents.map((document) => ({
      id: document.front_matter.id,
      type: document.front_matter.type,
      status: document.front_matter.status,
      priority: document.front_matter.priority,
      updated_at: document.front_matter.updated_at,
    })),
  };

  const manifestPath = path.join(pmRoot, MANIFEST_PATH);
  const embeddingsPath = path.join(pmRoot, EMBEDDINGS_PATH);

  const embeddingsLines = documents.map((document) => JSON.stringify(buildKeywordRecord(document, mode))).join("\n");
  const semanticWarnings: string[] = [];
  if (mode !== "keyword" && documents.length > 0) {
    const corpusInputs = documents.map((document) => buildSemanticCorpusInput(document));
    let vectors: number[][] = [];
    if (extensionEmbedding) {
      try {
        vectors = await executeExtensionEmbedding(extensionEmbedding, settings, corpusInputs);
      } catch (error: unknown) {
        if (!activeEmbeddingProvider) {
          throw new PmCliError(
            `Extension search provider "${extensionEmbedding.name}" failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`,
            EXIT_CODE.GENERIC_FAILURE,
          );
        }
        semanticWarnings.push(
          `Extension search provider "${extensionEmbedding.name}" failed; falling back to built-in provider (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (vectors.length === 0) {
      if (!activeEmbeddingProvider) {
        throw new PmCliError(
          `No embedding executor available for reindex mode '${requestedMode}'`,
          EXIT_CODE.USAGE,
        );
      }
      const embeddingResult = await executeEmbeddingBatchesWithRetry(activeEmbeddingProvider, settings, corpusInputs);
      semanticWarnings.push(...embeddingResult.warnings);
      vectors = embeddingResult.vectors;
    }
    if (vectors.length !== documents.length) {
      throw new PmCliError(
        `Embedding output size mismatch (expected ${documents.length}, received ${vectors.length})`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
    const points = documents.map((document, index) => ({
      id: document.front_matter.id,
      vector: assertVector(vectors[index], `reindex embeddings output at index ${index}`),
      payload: {
        id: document.front_matter.id,
        type: document.front_matter.type,
        status: document.front_matter.status,
        priority: document.front_matter.priority,
        updated_at: document.front_matter.updated_at,
      },
    }));
    if (extensionVectorUpsert) {
      try {
        await Promise.resolve(
          extensionVectorUpsert.upsert({
            points,
            settings,
          }),
        );
      } catch (error: unknown) {
        if (!activeVectorStore) {
          throw new PmCliError(
            `Extension vector adapter "${extensionVectorUpsert.name}" failed to upsert vectors: ${error instanceof Error ? error.message : String(error)}`,
            EXIT_CODE.GENERIC_FAILURE,
          );
        }
        semanticWarnings.push(
          `Extension vector adapter "${extensionVectorUpsert.name}" failed; falling back to built-in vector store (${error instanceof Error ? error.message : String(error)})`,
        );
        await executeVectorUpsert(activeVectorStore, points);
      }
    } else if (activeVectorStore) {
      await executeVectorUpsert(activeVectorStore, points);
    } else {
      throw new PmCliError(
        `No vector upsert executor available for reindex mode '${requestedMode}'`,
        EXIT_CODE.USAGE,
      );
    }
  }
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileAtomic(embeddingsPath, `${embeddingsLines}\n`);
  const hookWarnings = [
    ...(await runActiveOnWriteHooks({
      path: manifestPath,
      scope: "project",
      op: "reindex:manifest",
    })),
    ...(await runActiveOnWriteHooks({
      path: embeddingsPath,
      scope: "project",
      op: "reindex:embeddings",
    })),
    ...(await runActiveOnIndexHooks({
      mode,
      total_items: documents.length,
    })),
  ];

  return {
    ok: true,
    mode,
    total_items: documents.length,
    artifacts: {
      manifest: MANIFEST_PATH,
      embeddings: EMBEDDINGS_PATH,
    },
    warnings: [...semanticWarnings, ...hookWarnings],
    generated_at: generatedAt,
  };
}
