/**
 * @module core/search/vectorization-metadata
 *
 * Powers search, embeddings, and semantic retrieval behavior for Vectorization Metadata.
 */
import { toNonEmptyString } from "../shared/primitives.js";

/**
 * Documents the vectorization embedding identity payload exchanged by command, SDK, and package integrations.
 */
export interface VectorizationEmbeddingIdentity {
  provider: string;
  model: string;
}

/**
 * Documents the vectorization embedding metadata payload exchanged by command, SDK, and package integrations.
 */
export interface VectorizationEmbeddingMetadata extends VectorizationEmbeddingIdentity {
  vector_dimension: number;
}

/**
 * Implements build vectorization embedding identity for the public runtime surface of this module.
 */
export function buildVectorizationEmbeddingIdentity(
  provider: unknown,
  model: unknown,
): VectorizationEmbeddingIdentity | null {
  const normalizedProvider = toNonEmptyString(provider);
  const normalizedModel = toNonEmptyString(model);
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }
  return {
    provider: normalizedProvider,
    model: normalizedModel,
  };
}

/**
 * Implements normalize vectorization embedding metadata for the public runtime surface of this module.
 */
export function normalizeVectorizationEmbeddingMetadata(value: unknown): VectorizationEmbeddingMetadata | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vectorization embedding metadata must be an object when set");
  }
  const identity = buildVectorizationEmbeddingIdentity(
    (value as { provider?: unknown }).provider,
    (value as { model?: unknown }).model,
  );
  const vectorDimension = (value as { vector_dimension?: unknown }).vector_dimension;
  if (!identity || typeof vectorDimension !== "number" || !Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error("Vectorization embedding metadata must include provider, model, and positive vector_dimension");
  }
  return {
    ...identity,
    vector_dimension: vectorDimension,
  };
}

/**
 * Implements build vectorization embedding metadata for the public runtime surface of this module.
 */
export function buildVectorizationEmbeddingMetadata(
  identity: VectorizationEmbeddingIdentity,
  vectorDimension: number,
): VectorizationEmbeddingMetadata {
  if (!Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error("Vectorization embedding metadata requires a positive vector dimension");
  }
  return {
    provider: identity.provider,
    model: identity.model,
    vector_dimension: vectorDimension,
  };
}

/**
 * Implements check whether vectorization embedding identity changed for the public runtime surface of this module.
 */
export function hasVectorizationEmbeddingIdentityChanged(
  metadata: VectorizationEmbeddingMetadata | null | undefined,
  identity: VectorizationEmbeddingIdentity,
): boolean {
  return !metadata || metadata.provider !== identity.provider || metadata.model !== identity.model;
}

/**
 * Implements check whether vectorization vector dimension changed for the public runtime surface of this module.
 */
export function hasVectorizationVectorDimensionChanged(
  metadata: VectorizationEmbeddingMetadata | null | undefined,
  vectorDimension: number,
): boolean {
  return Boolean(metadata && metadata.vector_dimension !== vectorDimension);
}

/**
 * Implements infer consistent vector dimension for the public runtime surface of this module.
 */
export function inferConsistentVectorDimension(vectors: readonly number[][], context: string): number {
  if (vectors.length === 0) {
    throw new Error(`${context} returned no vectors`);
  }
  const firstVector = vectors[0] as number[];
  const dimension = firstVector.length;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`${context} returned an empty vector`);
  }
  for (let index = 1; index < vectors.length; index += 1) {
    if (vectors[index]?.length !== dimension) {
      throw new Error(`${context} returned mixed vector dimensions`);
    }
  }
  return dimension;
}
