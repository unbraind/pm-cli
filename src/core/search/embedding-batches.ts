/**
 * @module core/search/embedding-batches
 *
 * Bounds embedding requests independently of per-input truncation and preserves
 * input ordering through retries and adaptive splits.
 */
import type { PmSettings } from "../../types/index.js";
import { executeEmbeddingRequest } from "./providers.js";
import { SearchHttpError } from "./http-client.js";
import type { EmbeddingProviderConfig } from "./providers.js";
import { toErrorMessage } from "../shared/primitives.js";
import {
  SEMANTIC_CORPUS_TRUNCATION_SUFFIX,
  resolveSemanticCorpusCharacterLimit,
} from "./corpus.js";

/** Completed vectors and execution evidence returned only after every input succeeds. */
export interface EmbeddingBatchExecutionResult {
  /** One vector for each input position, including repeated input text. */
  vectors: number[][];
  /** Truncation, retry, and split diagnostics; never contains source input text. */
  warnings: string[];
  /** Actual provider work, including retries and adaptive splits. */
  receipt?: EmbeddingBatchReceipt;
}

/** Bounded summary of actual provider work; histogram keys are successful request sizes. */
export interface EmbeddingBatchReceipt {
  /** Provider and model used for this execution, without endpoint or credentials. */
  provider: string;
  /** Model requested from the provider. */
  model: string;
  /** Maximum encoded JSON request size, including model and escaping. */
  max_request_bytes: number;
  /** Whether the request ceiling was supplied by the caller or the runtime. */
  limit_source: "caller" | "default";
  /** Number of requests planned before adaptive splitting. */
  planned_batches: number;
  /** Total HTTP attempts, including unsuccessful requests. */
  requests: number;
  /** Requests that returned validated vectors. */
  successful_batches: number;
  /** Failed requests subdivided into smaller requests. */
  split_batches: number;
  /** Additional attempts of the same batch after a transient failure. */
  retries: number;
  /** Successful request count by number of input positions. */
  batch_size_histogram: Record<string, number>;
  /** Wall-clock duration including provider time and retry backoff. */
  elapsed_ms: number;
  /** Completed input positions divided by elapsed seconds. */
  inputs_per_second: number;
}

/** Progress across planned batches; actual HTTP work is reported separately in the receipt. */
export interface EmbeddingBatchProgressEvent {
  /** One-based index of the current planned batch. */
  batch_index: number;
  /** Number of planned batches before adaptive splitting. */
  batch_total: number;
  /** Number of input positions in the current planned batch. */
  batch_size: number;
  /** Input positions successfully embedded before or after this event. */
  completed_inputs: number;
  /** Total input positions in this execution. */
  total_inputs: number;
  /** Optional attempt counter for callers extending progress reporting. */
  attempt?: number;
  /** Whether dispatch is starting or the complete planned batch has succeeded. */
  phase: "start" | "complete";
}

/** Host controls for progress reporting and transport payload bounds. */
export interface EmbeddingBatchExecutionOptions {
  /** Observe planned-batch boundaries without receiving input text. */
  onProgress?: (event: EmbeddingBatchProgressEvent) => void;
  /** Positive JSON payload byte ceiling, independent of per-input corpus truncation; defaults to 256 KiB. */
  maxRequestBytes?: number;
}

interface EmbeddingBatchRuntime {
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  maxRequestBytes: number;
  maxInputCharacters: number;
}

/** Normalize scheduler settings while keeping corpus and transport limits independent. */
function resolveBatchRuntime(
  settings: PmSettings,
  maxInputCharacters: number,
  maxRequestBytes: number,
): EmbeddingBatchRuntime {
  const batchSizeCandidate = settings.search.embedding_batch_size;
  const timeoutMsCandidate = settings.search.embedding_timeout_ms;
  const maxRetriesCandidate = settings.search.scanner_max_batch_retries;
  const batchSize =
    Number.isFinite(batchSizeCandidate) && batchSizeCandidate > 0
      ? Math.max(1, Math.floor(batchSizeCandidate))
      : 1;
  const timeoutMs =
    Number.isFinite(timeoutMsCandidate) && timeoutMsCandidate > 0
      ? Math.max(1, Math.floor(timeoutMsCandidate))
      : 30_000;
  const maxRetries =
    Number.isFinite(maxRetriesCandidate) && maxRetriesCandidate >= 0
      ? Math.floor(maxRetriesCandidate)
      : 0;
  return {
    batchSize,
    timeoutMs,
    maxRetries,
    maxRequestBytes,
    maxInputCharacters,
  };
}

/** Partition inputs by both configured count and encoded request bytes, preserving position order. */
function createBatches(
  provider: EmbeddingProviderConfig,
  inputs: string[],
  batchSize: number,
  maxRequestBytes: number,
): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  // Both providers use the same model/input fields. Array encoding is a safe
  // upper bound for OpenAI's single-string request and for provider deduplication.
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ model: provider.model, input: [] }));
  let currentBytes = envelopeBytes;
  for (const input of inputs) {
    const inputBytes = Buffer.byteLength(JSON.stringify(input.trim()));
    if (envelopeBytes + inputBytes > maxRequestBytes) {
      throw new RangeError(`Embedding input exceeds request byte ceiling ${maxRequestBytes}; lower search.embedding_corpus_max_characters or raise maxRequestBytes`);
    }
    const separatorBytes = currentBatch.length > 0 ? 1 : 0;
    if (currentBatch.length >= batchSize || currentBytes + separatorBytes + inputBytes > maxRequestBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = envelopeBytes;
    }
    currentBytes += inputBytes + (currentBatch.length > 0 ? 1 : 0);
    currentBatch.push(input);
  }
  batches.push(currentBatch);
  return batches;
}

/** Apply the corpus character limit with its explicit truncation marker before planning requests. */
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

/** Recognize timeout diagnostics emitted by both built-in provider adapters. */
function isEmbeddingTimeoutError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

/** Include request context and timeout recovery guidance in the terminal batch failure. */
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

/** Classify recoverable request-size failures without interpreting arbitrary HTTP response text. */
function resolveSplitReason(error: unknown): "payload_too_large" | "timeout" | null {
  if (error instanceof SearchHttpError) return error.status === 413 ? "payload_too_large" : null;
  return isEmbeddingTimeoutError(error) ? "timeout" : null;
}

/** Retry or split a planned batch, accumulating real work counters and preserving vector positions. */
async function executeBatchWithAdaptiveSplit(
  provider: EmbeddingProviderConfig,
  batch: string[],
  batchLabel: string,
  timeoutMs: number,
  maxRetries: number,
  warnings: string[],
  receipt: EmbeddingBatchReceipt,
): Promise<number[][]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      receipt.requests += 1;
      const batchVectors = await executeEmbeddingRequest(provider, batch, {
        timeout_ms: timeoutMs,
      });
      if (attempt > 0) {
        warnings.push(
          `search_embedding_batch_retry_succeeded:batch=${batchLabel}:attempt=${attempt + 1}:size=${batch.length}`,
        );
      }
      receipt.successful_batches += 1;
      receipt.batch_size_histogram[batch.length] = (receipt.batch_size_histogram[batch.length] ?? 0) + 1;
      return batchVectors;
    } catch (error: unknown) {
      lastError = error;
      const splitReason = resolveSplitReason(error);
      if (splitReason !== null && batch.length > 1) {
        receipt.split_batches += 1;
        const midpoint = Math.ceil(batch.length / 2);
        const left = batch.slice(0, midpoint);
        const right = batch.slice(midpoint);
        warnings.push(
          `search_embedding_batch_split_after_${splitReason}:batch=${batchLabel}:size=${batch.length}:parts=${left.length}|${right.length}`,
        );
        return [
          ...(await executeBatchWithAdaptiveSplit(
            provider,
            left,
            `${batchLabel}.1`,
            timeoutMs,
            maxRetries,
            warnings,
            receipt,
          )),
          ...(await executeBatchWithAdaptiveSplit(
            provider,
            right,
            `${batchLabel}.2`,
            timeoutMs,
            maxRetries,
            warnings,
            receipt,
          )),
        ];
      }
      if (attempt < maxRetries) {
        receipt.retries += 1;
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

/** Execute count- and byte-bounded batches in order. Reject impossible inputs before dispatch, retry transient failures, and subdivide size or timeout failures without returning partial vectors. */
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
  const startedAt = performance.now();
  const maxRequestBytes = options.maxRequestBytes ?? 262_144;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new RangeError("maxRequestBytes must be a positive safe integer");
  }
  const receipt: EmbeddingBatchReceipt = {
    provider: provider.name,
    model: provider.model,
    max_request_bytes: maxRequestBytes,
    limit_source: options.maxRequestBytes === undefined ? "default" : "caller",
    planned_batches: 0,
    requests: 0,
    successful_batches: 0,
    split_batches: 0,
    retries: 0,
    batch_size_histogram: {},
    elapsed_ms: 0,
    inputs_per_second: 0,
  };
  const warnings: string[] = [];
  const corpusLimitResolution = resolveSemanticCorpusCharacterLimit(
    provider.name,
    settings.search.embedding_corpus_max_characters,
  );
  if (corpusLimitResolution.warning) {
    warnings.push(corpusLimitResolution.warning);
  }
  const runtime = resolveBatchRuntime(settings, corpusLimitResolution.maxCharacters, maxRequestBytes);
  let truncatedInputCount = 0;
  const normalizedInputs = inputs.map((input) => {
    if (input.trim().length === 0) throw new TypeError("Embedding inputs must be non-empty strings");
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
    provider,
    normalizedInputs,
    runtime.batchSize,
    runtime.maxRequestBytes,
  );
  receipt.planned_batches = batches.length;
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
        receipt,
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
  receipt.elapsed_ms = Math.max(1, performance.now() - startedAt);
  receipt.inputs_per_second = inputs.length * 1000 / receipt.elapsed_ms;
  return {
    vectors,
    warnings,
    receipt,
  };
}
