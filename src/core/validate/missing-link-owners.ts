/**
 * Owner attribution for stale linked paths reported by `pm validate --check-files`.
 *
 * The files check collects, per item, the linked paths (from the item's `files`
 * and `docs` link lists) that no longer resolve on disk. By default those are
 * surfaced as bare path strings + `path:classification` rows, which forces a
 * reverse lookup to discover which item owns each stale link. This module turns
 * the already-collected stale-link rows into owner-attributed, path-grouped rows
 * so an agent can perform evidence-based cleanup (relink/prune) without that
 * reverse lookup.
 *
 * Pure module (GH-210): no filesystem access and no heavy imports — callers pass
 * the already-collected stale-link rows plus a metadata `lookup` closure.
 */

/** Classification assigned to a stale linked path during files validation. */
export type StaleLinkClassification = "moved" | "deleted";

/** Documents the stale link owner input payload exchanged by command, SDK, and package integrations. */
export interface StaleLinkOwnerInput {
  /** Value that configures or reports item id for this contract. */
  item_id: string;
  /** Normalized workspace-relative path that no longer resolves. */
  path: string;
  /** Which link list of the owning item the path lives in. */
  link_kind: "files" | "docs";
  /** Value that configures or reports classification for this contract. */
  classification: StaleLinkClassification;
}

/** Documents the missing linked path owner payload exchanged by command, SDK, and package integrations. */
export interface MissingLinkedPathOwner {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Owning item type, `"Unknown"` if metadata is absent. */
  type: string;
  /** Owning item title, `""` if absent. */
  title: string;
  /** Owning item status, `""` if absent. */
  status: string;
  /** The link list the path lives in (= the input `link_kind`). */
  field: "files" | "docs";
}

/** Documents the missing linked path row payload exchanged by command, SDK, and package integrations. */
export interface MissingLinkedPathRow {
  /** Filesystem path used for path resolution. */
  path: string;
  /** Value that configures or reports classification for this contract. */
  classification: StaleLinkClassification;
  /** Value that configures or reports items for this contract. */
  items: MissingLinkedPathOwner[];
}

/** Documents the owner item metadata payload exchanged by command, SDK, and package integrations. */
export interface OwnerItemMetadata {
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports title for this contract. */
  title?: string;
  /** Lifecycle state reported for status. */
  status?: string;
}

interface PathBucket {
  classification: StaleLinkClassification;
  /** Keyed by `<id> <field>` so identical owners de-duplicate. */
  owners: Map<string, StaleLinkOwnerInput>;
}

/** `moved` wins over `deleted` when a single path's rows disagree on classification: `moved` means a relink candidate exists, which is the safer, more-actionable signal (relink instead of risk pruning a still-reachable link). In practice all rows for one path share a classification; this is a deterministic tie-break for the degenerate case. */
function preferClassification(
  current: StaleLinkClassification,
  next: StaleLinkClassification,
): StaleLinkClassification {
  return current === "moved" || next === "moved" ? "moved" : "deleted";
}

function ownerKey(input: StaleLinkOwnerInput): string {
  return `${input.item_id} ${input.link_kind}`;
}

/**
 * Group stale-link owner inputs by linked path and attach owning-item metadata.
 *
 * - Paths sorted ascending (`localeCompare`); items within a path sorted by `id`
 *   then `field`.
 * - De-duplicates identical `(id, field)` owners for the same path.
 * - `classification` per path follows {@link preferClassification} (moved wins).
 * - Missing metadata falls back: type `"Unknown"`, title `""`, status `""`.
 */
export function buildMissingLinkedPathRows(
  rows: readonly StaleLinkOwnerInput[],
  lookup: (itemId: string) => OwnerItemMetadata | undefined,
): MissingLinkedPathRow[] {
  const buckets = new Map<string, PathBucket>();
  for (const row of rows) {
    const bucket = buckets.get(row.path);
    if (bucket) {
      bucket.classification = preferClassification(
        bucket.classification,
        row.classification,
      );
      bucket.owners.set(ownerKey(row), row);
    } else {
      buckets.set(row.path, {
        classification: row.classification,
        owners: new Map([[ownerKey(row), row]]),
      });
    }
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, bucket]) => ({
      path,
      classification: bucket.classification,
      items: [...bucket.owners.values()]
        .map((owner): MissingLinkedPathOwner => {
          const metadata = lookup(owner.item_id);
          return {
            id: owner.item_id,
            type: metadata?.type ?? "Unknown",
            title: metadata?.title ?? "",
            status: metadata?.status ?? "",
            field: owner.link_kind,
          };
        })
        .sort((leftOwner, rightOwner) => {
          const byId = leftOwner.id.localeCompare(rightOwner.id);
          return byId !== 0
            ? byId
            : leftOwner.field.localeCompare(rightOwner.field);
        }),
    }));
}

function escapeTitle(title: string): string {
  return title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Token-efficient one-line-per-owner serialization for the files-check details
 * (compact text counterpart to the full {@link MissingLinkedPathRow} objects).
 * Format per owner row:
 *   `<path>:<classification> owner=<id> status=<status> field=<field> title="<title>"`
 * Title is double-quoted with backslash/quote escaping; empty status/title still
 * render (`status=` and `title=""`). Order follows
 * {@link buildMissingLinkedPathRows} output order.
 */
export function summarizeMissingLinkedPathRows(
  rows: readonly MissingLinkedPathRow[],
): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    for (const owner of row.items) {
      lines.push(
        `${row.path}:${row.classification} owner=${owner.id} status=${owner.status} field=${owner.field} title="${escapeTitle(owner.title)}"`,
      );
    }
  }
  return lines;
}
