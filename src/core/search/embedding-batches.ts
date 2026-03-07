import type { PmSettings } from "../../types/index.js";
import { executeEmbeddingRequest } from "./providers.js";
import type { EmbeddingProviderConfig } from "./providers.js";

export interface EmbeddingBatchExecutionResult {
  vectors: number[][];
  warnings: string[];
}

interface EmbeddingBatchRuntime {
  batchSize: number;
  maxRetries: number;
}

function resolveBatchRuntime(settings: PmSettings): EmbeddingBatchRuntime {
  const batchSizeCandidate = settings.search.embedding_batch_size;
  const maxRetriesCandidate = settings.search.scanner_max_batch_retries;
  const batchSize = Number.isFinite(batchSizeCandidate) && batchSizeCandidate > 0 ? Math.floor(batchSizeCandidate) : 1;
  const maxRetries = Number.isFinite(maxRetriesCandidate) && maxRetriesCandidate >= 0 ? Math.floor(maxRetriesCandidate) : 0;
  return { batchSize, maxRetries };
}

function createBatches(inputs: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < inputs.length; index += batchSize) {
    batches.push(inputs.slice(index, index + batchSize));
  }
  return batches;
}

export async function executeEmbeddingBatchesWithRetry(
  provider: EmbeddingProviderConfig,
  settings: PmSettings,
  inputs: string[],
): Promise<EmbeddingBatchExecutionResult> {
  if (inputs.length === 0) {
    return {
      vectors: [],
      warnings: [],
    };
  }
  const runtime = resolveBatchRuntime(settings);
  const batches = createBatches(inputs, runtime.batchSize);
  const vectors: number[][] = [];
  const warnings: string[] = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    let success = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= runtime.maxRetries; attempt += 1) {
      try {
        const batchVectors = await executeEmbeddingRequest(provider, batch);
        vectors.push(...batchVectors);
        if (attempt > 0) {
          warnings.push(
            `search_embedding_batch_retry_succeeded:batch=${batchIndex + 1}:attempt=${attempt + 1}:size=${batch.length}`,
          );
        }
        success = true;
        break;
      } catch (error: unknown) {
        lastError = error;
      }
    }
    if (!success) {
      throw new Error(
        `Embedding batch ${batchIndex + 1} failed after ${runtime.maxRetries + 1} attempt(s): ${String(lastError)}`,
      );
    }
  }
  return {
    vectors,
    warnings,
  };
}
