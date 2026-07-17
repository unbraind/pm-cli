/**
 * @module sdk/graph/cache
 *
 * Incremental workspace graph cache: fingerprint-keyed reuse of the assembled
 * relationship graph plus memoized analytics results, so long-lived processes
 * (the MCP server, SDK consumers, packages) stop paying the full-workspace
 * assembly and analysis cost on every bounded query. The fingerprint is a
 * deterministic digest of every relationship-relevant item field — id, title,
 * lifecycle status and its terminal classification, hierarchy parent, legacy
 * blocker, and structured dependency edges — so any mutation that could change
 * the graph or its projections invalidates the entry, while unrelated payload
 * churn (bodies, comments) does not enter the digest at all. Every lookup
 * reports hit/miss observability so envelopes can explain their freshness.
 */
import { createHash } from "node:crypto";
import type { Dependency, ItemStatus } from "../../types/index.js";
import type {
  WorkspaceRelationshipAssembly,
  WorkspaceRelationshipItem,
} from "./assembly.js";

/** Default memoized query results retained per workspace entry. */
const DEFAULT_MAX_RESULTS_PER_WORKSPACE = 64;

/** Cache observability attached to graph result envelopes. */
export interface GraphCacheMetadata {
  /** Truncated workspace graph fingerprint identifying the snapshot answered from. */
  fingerprint: string;
  /** Whether the workspace assembly was reused from cache. */
  assembly: "hit" | "miss";
  /** Whether the full query result was reused from cache. */
  result: "hit" | "miss";
}

/** Digest one item's relationship-relevant fields into a deterministic line. */
function fingerprintLine(
  item: WorkspaceRelationshipItem,
  isTerminal: (status: ItemStatus) => boolean,
): string {
  const dependencies = (item.dependencies ?? [])
    .map((rawDependency) => {
      // Public SDK callers may supply legacy or JSON-decoded payloads; mirror
      // assembly's defensive normalization so the digest tracks what assembly
      // would actually index.
      if (typeof rawDependency !== "object" || rawDependency === null)
        return "";
      const dependency = rawDependency as Partial<Dependency>;
      return `${typeof dependency.kind === "string" ? dependency.kind : "related"}:${
        typeof dependency.id === "string" ? dependency.id : ""
      }`;
    })
    .join(",");
  return [
    item.id,
    item.title,
    item.status,
    isTerminal(item.status) ? "1" : "0",
    item.parent ?? "",
    item.blocked_by ?? "",
    dependencies,
  ].join("\u0000");
}

/**
 * Compute the deterministic workspace graph fingerprint for one item snapshot.
 * Items are digested in sorted order so storage enumeration order never
 * changes the fingerprint, and the terminal classification of each status is
 * folded in so schema changes to lifecycle semantics invalidate cached
 * assemblies even when raw statuses are unchanged.
 */
export function computeWorkspaceGraphFingerprint(
  items: readonly WorkspaceRelationshipItem[],
  isTerminal: (status: ItemStatus) => boolean = (status) =>
    status === "closed" || status === "canceled",
): string {
  const lines = items
    .filter(
      (item) => typeof item?.id === "string" && item.id.trim().length > 0,
    )
    .map((item) => fingerprintLine(item, isTerminal))
    .sort((left, right) => left.localeCompare(right));
  // Separate fields and records with control characters no stored field can
  // contain unescaped, so adjacent free-text fields can never collide.
  return createHash("sha256").update(lines.join("\u0001")).digest("hex");
}

/** One cached workspace snapshot: its assembly plus memoized query results. */
interface WorkspaceGraphCacheEntry {
  /** Fingerprint of the item snapshot this entry answers for. */
  fingerprint: string;
  /** Assembled relationship graph reused across queries. */
  assembly: WorkspaceRelationshipAssembly;
  /** Bounded insertion-ordered memo of deterministic query results. */
  results: Map<string, unknown>;
}

/** One resolved cache lookup bound to a workspace snapshot. */
export interface WorkspaceGraphCacheLookup {
  /** The (possibly reused) workspace assembly. */
  assembly: WorkspaceRelationshipAssembly;
  /** Whether the assembly came from cache instead of being rebuilt. */
  assemblyReused: boolean;
  /** Full fingerprint of the snapshot this lookup is bound to. */
  fingerprint: string;
  /**
   * Memoize one deterministic query result under this snapshot. On a miss the
   * freshly computed value is returned as-is while an independent clone is
   * stored, so mutating a miss result never corrupts the cache; every hit
   * returns a fresh clone of the stored entry. Callers must not rely on the
   * miss and hit paths returning the same object identity.
   */
  memoize<T>(queryKey: string, compute: () => T): { value: T; reused: boolean };
}

/**
 * Fingerprint-keyed cache of workspace relationship assemblies and memoized
 * deterministic query results. One entry is retained per workspace key; a
 * changed fingerprint atomically replaces the entry and drops its memoized
 * results. Memoized values are structured-cloned on store and on read so
 * neither the producer nor any consumer can mutate cached state.
 */
export class WorkspaceGraphCache {
  readonly #entries = new Map<string, WorkspaceGraphCacheEntry>();
  readonly #maxResultsPerWorkspace: number;

  /** Create a cache, optionally bounding memoized results per workspace. */
  public constructor(options: { maxResultsPerWorkspace?: number } = {}) {
    const bound =
      options.maxResultsPerWorkspace ?? DEFAULT_MAX_RESULTS_PER_WORKSPACE;
    if (!Number.isInteger(bound) || bound < 1)
      throw new TypeError(
        `Invalid maxResultsPerWorkspace bound: ${String(options.maxResultsPerWorkspace)}`,
      );
    this.#maxResultsPerWorkspace = bound;
  }

  /**
   * Resolve the cached assembly for one workspace key and fingerprint,
   * building and storing it on miss. The returned lookup exposes snapshot-
   * scoped memoization for query results derived from the same assembly.
   */
  public lookup(
    key: string,
    fingerprint: string,
    build: () => WorkspaceRelationshipAssembly,
  ): WorkspaceGraphCacheLookup {
    let entry = this.#entries.get(key);
    let assemblyReused = true;
    if (entry === undefined || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, assembly: build(), results: new Map() };
      this.#entries.set(key, entry);
      assemblyReused = false;
    }
    const resolved = entry;
    const maxResults = this.#maxResultsPerWorkspace;
    return {
      assembly: resolved.assembly,
      assemblyReused,
      fingerprint,
      memoize<T>(
        queryKey: string,
        compute: () => T,
      ): { value: T; reused: boolean } {
        if (resolved.results.has(queryKey)) {
          return {
            value: structuredClone(resolved.results.get(queryKey)) as T,
            reused: true,
          };
        }
        const value = compute();
        if (resolved.results.size >= maxResults) {
          // Evict the oldest memoized result; Map preserves insertion order.
          resolved.results.delete(resolved.results.keys().next().value!);
        }
        resolved.results.set(queryKey, structuredClone(value));
        return { value, reused: false };
      },
    };
  }

  /** Drop every cached workspace entry and memoized result. */
  public clear(): void {
    this.#entries.clear();
  }
}

/** Process-wide shared cache used by the CLI/MCP graph and deps adapters. */
const sharedCache = new WorkspaceGraphCache();

/** Return the process-wide shared workspace graph cache. */
export function workspaceGraphCache(): WorkspaceGraphCache {
  return sharedCache;
}

/** Reset the process-wide shared workspace graph cache (tests and long-lived hosts). */
export function resetWorkspaceGraphCache(): void {
  sharedCache.clear();
}
