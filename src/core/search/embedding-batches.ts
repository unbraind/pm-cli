import type { PmSettings } from "../../types/index.js";
import { executeEmbeddingRequest } from "./providers.js";
import type { EmbeddingProviderConfig } from "./providers.js";
import { toErrorMessage } from "../shared/primitives.js";
import {
  DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  SEMANTIC_CORPUS_TRUNCATION_SUFFIX,
} from "./corpus.js";

export interface EmbeddingBatchExecutionResult {
  vectors: number[][];
  warnings: string[];
}

interface EmbeddingBatchRuntime {
  batchSize: number;
  maxRetries: number;
  maxBatchInputCharacters: number;
  maxInputCharacters: number;
}

function resolveBatchRuntime(settings: PmSettings): EmbeddingBatchRuntime {
  const batchSizeCandidate = settings.search.embedding_batch_size;
  const maxRetriesCandidate = settings.search.scanner_max_batch_retries;
  const batchSize = Number.isFinite(batchSizeCandidate) && batchSizeCandidate > 0 ? Math.floor(batchSizeCandidate) : 1;
  const maxRetries = Number.isFinite(maxRetriesCandidate) && maxRetriesCandidate >= 0 ? Math.floor(maxRetriesCandidate) : 0;
  return {
    batchSize,
    maxRetries,
    maxBatchInputCharacters: Number.POSITIVE_INFINITY,
    maxInputCharacters: DEFAULT_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  };
}

function createBatches(inputs: string[], batchSize: number, maxBatchInputCharacters: number): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentCharacters = 0;
  for (const input of inputs) {
    const wouldExceedCount = currentBatch.length >= batchSize;
    const wouldExceedCharacters =
      currentBatch.length > 0 &&
      Number.isFinite(maxBatchInputCharacters) &&
      currentCharacters + input.length > maxBatchInputCharacters;
    if (wouldExceedCount || wouldExceedCharacters) {
      batches.push(currentBatch);
      currentBatch = [];
      currentCharacters = 0;
    }
    currentBatch.push(input);
    currentCharacters += input.length;
  }
  batches.push(currentBatch);
  return batches;
}

function resolveProviderBatchRuntime(provider: EmbeddingProviderConfig, runtime: EmbeddingBatchRuntime): EmbeddingBatchRuntime {
  if (provider.name !== "ollama") {
    return runtime;
  }
  return {
    ...runtime,
    maxBatchInputCharacters: OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
    maxInputCharacters: OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  };
}

function truncateInputForRuntime(input: string, maxInputCharacters: number): string {
  if (!Number.isFinite(maxInputCharacters) || maxInputCharacters <= 0 || input.length <= maxInputCharacters) {
    return input;
  }
  const keepLength = Math.max(0, maxInputCharacters - SEMANTIC_CORPUS_TRUNCATION_SUFFIX.length);
  return `${input.slice(0, keepLength)}${SEMANTIC_CORPUS_TRUNCATION_SUFFIX}`.slice(0, maxInputCharacters);
}

function isEmbeddingTimeoutError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

async function executeBatchWithAdaptiveSplit(
  provider: EmbeddingProviderConfig,
  batch: string[],
  batchLabel: string,
  maxRetries: number,
  warnings: string[],
): Promise<number[][]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const batchVectors = await executeEmbeddingRequest(provider, batch);
      if (attempt > 0) {
        warnings.push(
          `search_embedding_batch_retry_succeeded:batch=${batchLabel}:attempt=${attempt + 1}:size=${batch.length}`,
        );
      }
      return batchVectors;
    } catch (error: unknown) {
      lastError = error;
      if (isEmbeddingTimeoutError(error) && batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2);
        const left = batch.slice(0, midpoint);
        const right = batch.slice(midpoint);
        warnings.push(
          `search_embedding_batch_split_after_timeout:batch=${batchLabel}:size=${batch.length}:parts=${left.length}|${right.length}`,
        );
        return [
          ...(await executeBatchWithAdaptiveSplit(provider, left, `${batchLabel}.1`, maxRetries, warnings)),
          ...(await executeBatchWithAdaptiveSplit(provider, right, `${batchLabel}.2`, maxRetries, warnings)),
        ];
      }
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(`Embedding batch ${batchLabel} failed after ${maxRetries + 1} attempt(s): ${toErrorMessage(lastError)}`);
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
  const runtime = resolveProviderBatchRuntime(provider, resolveBatchRuntime(settings));
  const warnings: string[] = [];
  let truncatedInputCount = 0;
  const normalizedInputs = inputs.map((input) => {
    const normalized = truncateInputForRuntime(input, runtime.maxInputCharacters);
    if (normalized.length < input.length) {
      truncatedInputCount += 1;
    }
    return normalized;
  });
  if (truncatedInputCount > 0) {
    warnings.push(`search_embedding_input_truncated:count=${truncatedInputCount}:max_characters=${runtime.maxInputCharacters}`);
  }
  const batches = createBatches(normalizedInputs, runtime.batchSize, runtime.maxBatchInputCharacters);
  const vectors: number[][] = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    vectors.push(...(await executeBatchWithAdaptiveSplit(provider, batch, String(batchIndex + 1), runtime.maxRetries, warnings)));
  }
  return {
    vectors,
    warnings,
  };
}
