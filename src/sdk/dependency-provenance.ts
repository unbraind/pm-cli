/**
 * @module sdk/dependency-provenance
 *
 * Defines the public provenance contract for dependency seeds that reference
 * items outside the current workspace.
 */
import { normalizeItemId } from "../core/item/id.js";
import {
  isExternalDependencyReference,
  isExternalDependencySourceKind,
} from "../core/item/dependency-reference.js";
export {
  isExternalDependencyReference,
  isExternalDependencySourceKind,
} from "../core/item/dependency-reference.js";

/** Provenance value declaring that a dependency id belongs to another workspace. */
export const EXTERNAL_DEPENDENCY_SOURCE_KIND = "global";
/** Human-facing alias accepted wherever external dependency provenance is parsed. */
export const EXTERNAL_DEPENDENCY_SOURCE_KIND_ALIAS = "external";
/** Stable external lifecycle values understood without coupling core to a provider. */
export const EXTERNAL_DEPENDENCY_RESOLUTION_STATUSES = [
  "open",
  "closed",
  "unknown",
] as const;
/** External lifecycle value returned by a registered dependency resolver. */
export type ExternalDependencyResolutionStatus =
  (typeof EXTERNAL_DEPENDENCY_RESOLUTION_STATUSES)[number];

/** Provider-owned external dependency data before the SDK applies output bounds. */
export interface ExternalDependencyResolverResult {
  /** Provider lifecycle state normalized to the universal external status vocabulary. */
  status: ExternalDependencyResolutionStatus;
  /** Optional bounded human context for the remote dependency. */
  title?: string;
  /** Optional canonical provider URL or locator used as evidence. */
  source?: string;
  /** Optional provider observation timestamp; invalid timestamps are replaced by SDK time. */
  checkedAt?: string;
}

/** Package-provided resolver contract for one or more external dependency locator families. */
export interface ExternalDependencyResolver {
  /** Stable resolver identity surfaced in agent-facing evidence. */
  name: string;
  /** Return whether this resolver owns the supplied external locator. */
  supports(reference: string): boolean;
  /** Resolve the locator without exposing provider credentials or unbounded response data. */
  resolve(reference: string): Promise<ExternalDependencyResolverResult | null>;
}

/** Bounded provider-neutral evidence returned by the public resolver registry. */
export interface ExternalDependencyResolution {
  /** Original normalized dependency locator. */
  id: string;
  /** Provider lifecycle state. */
  status: ExternalDependencyResolutionStatus;
  /** Whether trusted provider evidence proves the blocker terminal. */
  resolved: boolean;
  /** Bounded remote title, or null when the provider did not supply one. */
  title: string | null;
  /** Bounded evidence locator. */
  source: string;
  /** Observation timestamp supplied by the provider or SDK clock. */
  checked_at: string;
  /** Registered resolver identity that produced this evidence. */
  resolver: string;
}

/** Deterministic clock override for external resolver acceptance and tests. */
export interface ExternalDependencyResolutionOptions {
  /** Return the timestamp used when provider evidence omits or corrupts checkedAt. */
  now?: () => string;
}

const externalDependencyResolvers = new Map<
  string,
  ExternalDependencyResolver
>();
const MAX_EXTERNAL_TITLE_LENGTH = 240;
const MAX_EXTERNAL_SOURCE_LENGTH = 2_048;

/** Normalize and cap provider strings before they reach agent-facing output. */
function boundedExternalText(
  value: string | undefined,
  fallback: string,
  maximumLength: number,
): string {
  return (value?.trim() || fallback).slice(0, maximumLength);
}

/** Register a package-owned external dependency resolver and return its idempotent disposer. */
export function registerExternalDependencyResolver(
  resolver: ExternalDependencyResolver,
): () => void {
  const name = resolver.name.trim();
  if (name.length === 0) {
    throw new Error("External dependency resolver name must not be empty");
  }
  if (externalDependencyResolvers.has(name)) {
    throw new Error(`External dependency resolver already registered: ${name}`);
  }
  const registeredResolver: ExternalDependencyResolver = {
    name,
    supports: (reference) => resolver.supports(reference),
    resolve: (reference) => resolver.resolve(reference),
  };
  externalDependencyResolvers.set(name, registeredResolver);
  return () => {
    if (externalDependencyResolvers.get(name) === registeredResolver) {
      externalDependencyResolvers.delete(name);
    }
  };
}

/** Resolve one external locator through registered package providers with bounded provider-neutral evidence. */
export async function resolveExternalDependencyReference(
  reference: string,
  options: ExternalDependencyResolutionOptions = {},
): Promise<ExternalDependencyResolution | null> {
  const id = reference.trim();
  if (!isExternalDependencyReference(id)) {
    return null;
  }
  const resolvers = [...externalDependencyResolvers.values()].filter(
    (resolver) => {
      try {
        return resolver.supports(id);
      } catch {
        return false;
      }
    },
  );
  const outcomes = await Promise.allSettled(
    resolvers.map((resolver) =>
      Promise.resolve().then(() => resolver.resolve(id)),
    ),
  );
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status !== "fulfilled" || outcome.value === null) {
      continue;
    }
    const resolver = resolvers[index];
    const candidate = outcome.value;
    const status = EXTERNAL_DEPENDENCY_RESOLUTION_STATUSES.includes(
      candidate.status,
    )
      ? candidate.status
      : "unknown";
    const title = boundedExternalText(
      candidate.title,
      "",
      MAX_EXTERNAL_TITLE_LENGTH,
    );
    const source = boundedExternalText(
      candidate.source,
      id,
      MAX_EXTERNAL_SOURCE_LENGTH,
    );
    const observedAt = candidate.checkedAt?.trim() ?? "";
    const checkedAt = Number.isFinite(Date.parse(observedAt))
      ? observedAt
      : (options.now?.() ?? new Date().toISOString());
    return {
      id,
      status,
      resolved: status === "closed",
      title: title.length > 0 ? title : null,
      source,
      checked_at: checkedAt,
      resolver: resolver.name,
    };
  }
  return null;
}

/** Canonicalize external provenance while preserving other named source kinds. */
export function normalizeDependencySourceKind(
  sourceKind: string | undefined,
): string | undefined {
  const trimmed = sourceKind?.trim();
  if (!trimmed) {
    return undefined;
  }
  return isExternalDependencySourceKind(trimmed)
    ? EXTERNAL_DEPENDENCY_SOURCE_KIND
    : trimmed;
}

/**
 * Normalize a dependency seed id without corrupting cross-workspace identity.
 * Local and legacy seeds retain normal workspace-prefix behavior; explicitly
 * global seeds preserve the caller-provided id verbatim (apart from trimming).
 */
export function normalizeDependencySeedId(
  id: string,
  prefix: string,
  sourceKind: string | undefined,
): string {
  const trimmed = id.trim();
  return isExternalDependencySourceKind(sourceKind)
    ? trimmed
    : normalizeItemId(trimmed, prefix);
}
