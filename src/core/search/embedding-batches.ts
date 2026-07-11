/**
 * @module core/search/embedding-batches
 *
 * Powers search, embeddings, and semantic retrieval behavior for Embedding Batches.
 */
import type { PmSettings } from "../../types/index.js";
import { executeEmbeddingRequest } from "./providers.js";
import type { EmbeddingProviderConfig } from "./providers.js";
import { toErrorMessage } from "../shared/primitives.js";
import {
  OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  SEMANTIC_CORPUS_TRUNCATION_SUFFIX,
  resolveSemanticCorpusCharacterLimit,
} from "./corpus.js";

/** Documents the embedding batch execution result payload exchanged by command, SDK, and package integrations. */
export interface EmbeddingBatchExecutionResult {
  /** Value that configures or reports vectors for this contract. */
  vectors: number[][];
  /** Value that configures or reports warnings for this contract. */
  warnings: string[];
}

/** Documents the embedding batch progress event payload exchanged by command, SDK, and package integrations. */
export interface EmbeddingBatchProgressEvent {
  /** Value that configures or reports batch index for this contract. */
  batch_index: number;
  /** Value that configures or reports batch total for this contract. */
  batch_total: number;
  /** Value that configures or reports batch size for this contract. */
  batch_size: number;
  /** Value that configures or reports completed inputs for this contract. */
  completed_inputs: number;
  /** Value that configures or reports total inputs for this contract. */
  total_inputs: number;
  /** Value that configures or reports attempt for this contract. */
  attempt?: number;
  /** Value that configures or reports phase for this contract. */
  phase: "start" | "complete";
}

/** Documents the embedding batch execution options payload exchanged by command, SDK, and package integrations. */
export interface EmbeddingBatchExecutionOptions {
  /** Value that configures or reports on progress for this contract. */
  onProgress?: (event: EmbeddingBatchProgressEvent) => void;
}

interface EmbeddingBatchRuntime {
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  maxBatchInputCharacters: number;
  maxInputCharacters: number;
}

function resolveBatchRuntime(
  settings: PmSettings,
  maxInputCharacters: number,
): EmbeddingBatchRuntime {
  const batchSizeCandidate = settings.search.embedding_batch_size;
  const timeoutMsCandidate = settings.search.embedding_timeout_ms;
  const maxRetriesCandidate = settings.search.scanner_max_batch_retries;
  const batchSize =
    Number.isFinite(batchSizeCandidate) && batchSizeCandidate > 0
      ? Math.floor(batchSizeCandidate)
      : 1;
  const timeoutMs =
    Number.isFinite(timeoutMsCandidate) && timeoutMsCandidate > 0
      ? Math.floor(timeoutMsCandidate)
      : 30_000;
  const maxRetries =
    Number.isFinite(maxRetriesCandidate) && maxRetriesCandidate >= 0
      ? Math.floor(maxRetriesCandidate)
      : 0;
  return {
    batchSize,
    timeoutMs,
    maxRetries,
    maxBatchInputCharacters: Number.POSITIVE_INFINITY,
    maxInputCharacters,
  };
}

function createBatches(
  inputs: string[],
  batchSize: number,
  maxBatchInputCharacters: number,
): string[][] {
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

function resolveProviderBatchRuntime(
  provider: EmbeddingProviderConfig,
  runtime: EmbeddingBatchRuntime,
): EmbeddingBatchRuntime {
  if (provider.name !== "ollama") {
    return runtime;
  }
  return {
    ...runtime,
    maxBatchInputCharacters: OLLAMA_SEMANTIC_CORPUS_INPUT_MAX_CHARACTERS,
  };
}

function truncateInputForRuntime(
  input: string,
  maxInputCharacters: number,
): string {
  if (
    !Number.isFinite(maxInputCharacters) ||
    maxInputCharacters <= 0 ||
    input.length <= maxInputCharacters
  ) {
    return input;
  }
  const keepLength = Math.max(
    0,
    maxInputCharacters - SEMANTIC_CORPUS_TRUNCATION_SUFFIX.length,
  );
  return `${input.slice(0, keepLength)}${SEMANTIC_CORPUS_TRUNCATION_SUFFIX}`.slice(
    0,
    maxInputCharacters,
  );
}

function isEmbeddingTimeoutError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

function buildEmbeddingFailureMessage(
  provider: EmbeddingProviderConfig,
  batchLabel: string,
  batchSize: number,
  timeoutMs: number,
  attempts: number,
  error: unknown,
): string {
  const base = `Embedding batch ${batchLabel} failed after ${attempts} attempt(s): ${toErrorMessage(error)}`;
  const details = `provider=${provider.name} model=${provider.model} batch_size=${batchSize} timeout_ms=${timeoutMs}`;
  if (!isEmbeddingTimeoutError(error)) {
    return `${base} (${details})`;
  }
  return `${base} (${details}; guidance=check provider availability or lower search.embedding_batch_size, raise search.embedding_timeout_ms, or run keyword search while semantic indexing catches up)`;
}

async function executeBatchWithAdaptiveSplit(
  provider: EmbeddingProviderConfig,
  batch: string[],
  batchLabel: string,
  timeoutMs: number,
  maxRetries: number,
  warnings: string[],
): Promise<number[][]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const batchVectors = await executeEmbeddingRequest(provider, batch, {
        timeout_ms: timeoutMs,
      });
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
          ...(await executeBatchWithAdaptiveSplit(
            provider,
            left,
            `${batchLabel}.1`,
            timeoutMs,
            maxRetries,
            warnings,
          )),
          ...(await executeBatchWithAdaptiveSplit(
            provider,
            right,
            `${batchLabel}.2`,
            timeoutMs,
            maxRetries,
            warnings,
          )),
        ];
      }
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(
    buildEmbeddingFailureMessage(
      provider,
      batchLabel,
      batch.length,
      timeoutMs,
      maxRetries + 1,
      lastError,
    ),
  );
}

/** Implements execute embedding batches with retry for the public runtime surface of this module. */
export async function executeEmbeddingBatchesWithRetry(
  provider: EmbeddingProviderConfig,
  settings: PmSettings,
  inputs: string[],
  options: EmbeddingBatchExecutionOptions = {},
): Promise<EmbeddingBatchExecutionResult> {
  if (inputs.length === 0) {
    return {
      vectors: [],
      warnings: [],
    };
  }
  const warnings: string[] = [];
  const corpusLimitResolution = resolveSemanticCorpusCharacterLimit(
    provider.name,
    settings.search.embedding_corpus_max_characters,
  );
  if (corpusLimitResolution.warning) {
    warnings.push(corpusLimitResolution.warning);
  }
  const runtime = resolveProviderBatchRuntime(
    provider,
    resolveBatchRuntime(settings, corpusLimitResolution.maxCharacters),
  );
  let truncatedInputCount = 0;
  const normalizedInputs = inputs.map((input) => {
    const normalized = truncateInputForRuntime(
      input,
      runtime.maxInputCharacters,
    );
    if (normalized.length < input.length) {
      truncatedInputCount += 1;
    }
    return normalized;
  });
  if (truncatedInputCount > 0) {
    warnings.push(
      `search_embedding_input_truncated:count=${truncatedInputCount}:max_characters=${runtime.maxInputCharacters}`,
    );
  }
  const batches = createBatches(
    normalizedInputs,
    runtime.batchSize,
    runtime.maxBatchInputCharacters,
  );
  const vectors: number[][] = [];
  let completedInputs = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    options.onProgress?.({
      batch_index: batchIndex + 1,
      batch_total: batches.length,
      batch_size: batch.length,
      completed_inputs: completedInputs,
      total_inputs: normalizedInputs.length,
      phase: "start",
    });
    vectors.push(
      ...(await executeBatchWithAdaptiveSplit(
        provider,
        batch,
        String(batchIndex + 1),
        runtime.timeoutMs,
        runtime.maxRetries,
        warnings,
      )),
    );
    completedInputs += batch.length;
    options.onProgress?.({
      batch_index: batchIndex + 1,
      batch_total: batches.length,
      batch_size: batch.length,
      completed_inputs: completedInputs,
      total_inputs: normalizedInputs.length,
      phase: "complete",
    });
  }
  return {
    vectors,
    warnings,
  };
}
