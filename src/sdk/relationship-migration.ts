/**
 * @module sdk/relationship-migration
 *
 * Plans deterministic, resumable migration of legacy item hierarchy and
 * dependency fields into the immutable relationship-event platform. Planning
 * is storage-independent and side-effect free: callers can inspect governance
 * evidence, persist the event batch through {@link RelationshipEventStore}, or
 * feed the same plan into another conforming durable adapter.
 */
import { createHash } from "node:crypto";
import {
  assembleWorkspaceRelationshipGraph,
  type WorkspaceRelationshipItem,
} from "./graph/assembly.js";
import type { RelationshipEventInput } from "./relationship-history.js";
import type { RelationshipKindRegistry } from "./relationships.js";

/** Controls for deterministic legacy relationship-event planning. */
export interface RelationshipEventBackfillOptions {
  /** Stable migration identity retained in generated event and relationship ids. */
  migrationId: string;
  /** Attributable actor responsible for the migration. */
  author: string;
  /** Valid event timestamp shared by the deterministic migration batch. */
  timestamp: string;
  /** Optional custom relationship ontology used during legacy normalization. */
  registry?: RelationshipKindRegistry;
  /** Event ids already committed by an earlier partial or concurrent run. */
  existingEventIds?: Iterable<string>;
}

/** Deterministic migration plan plus compact governance evidence. */
export interface RelationshipEventBackfillPlan {
  /** Caller-provided stable migration identity. */
  migration_id: string;
  /** SHA-256 identity of the complete normalized plan before resume filtering. */
  fingerprint: string;
  /** Fixed node universe required when opening a relationship event store. */
  nodes: readonly string[];
  /** Missing deterministic events that remain to be committed. */
  events: readonly RelationshipEventInput[];
  /** Total unique normalized edges represented by the complete plan. */
  edge_count: number;
  /** Events omitted because their deterministic ids already exist. */
  skipped_existing_count: number;
  /** Duplicate raw dependency identities found before graph deduplication. */
  duplicate_dependency_rows: number;
  /** Missing internal references retained as explicit placeholder nodes. */
  dangling_reference_count: number;
}

/** Validate and normalize one required migration text field. */
function requiredMigrationText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`Relationship backfill ${field} must be non-empty`);
  return value.trim();
}

/**
 * Convert legacy item relationship fields into an immutable deterministic event
 * batch. Input order does not affect ids, fingerprints, or event order.
 * Dangling internal targets and external dependency targets become explicit
 * nodes so replay never silently drops contextual edges.
 */
export function planRelationshipEventBackfill(
  items: readonly WorkspaceRelationshipItem[],
  options: RelationshipEventBackfillOptions,
): RelationshipEventBackfillPlan {
  const migrationId = requiredMigrationText(options.migrationId, "migrationId");
  const author = requiredMigrationText(options.author, "author");
  const parsedTimestamp = Date.parse(options.timestamp);
  if (!Number.isFinite(parsedTimestamp))
    throw new TypeError("Relationship backfill timestamp must be valid");
  const timestamp = new Date(parsedTimestamp).toISOString();
  const assembly = assembleWorkspaceRelationshipGraph(
    items,
    undefined,
    options.registry,
  );
  const nodes = assembly.graph.nodes();
  const completeEvents = assembly.graph.edges().map((edge) => {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          migrationId,
          edge.kind,
          edge.source,
          edge.target,
          edge.createdAt ?? null,
          edge.author ?? null,
          edge.payload ?? null,
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    return Object.freeze({
      eventId: `backfill:${migrationId}:${digest}`,
      relationshipId: `migration:${migrationId}:${digest}`,
      action: "add" as const,
      edge,
      author,
      timestamp,
      reason: `Backfill ${migrationId} from legacy item metadata`,
    });
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ migrationId, nodes, events: completeEvents }))
    .digest("hex");
  const existingEventIds = new Set(
    [...(options.existingEventIds ?? [])]
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const events = completeEvents.filter(
    (event) => !existingEventIds.has(event.eventId),
  );
  return Object.freeze({
    migration_id: migrationId,
    fingerprint,
    nodes,
    events: Object.freeze(events),
    edge_count: completeEvents.length,
    skipped_existing_count: completeEvents.length - events.length,
    duplicate_dependency_rows: assembly.duplicateRows.length,
    dangling_reference_count:
      assembly.dangling.active.length + assembly.dangling.legacy_terminal.length,
  });
}
