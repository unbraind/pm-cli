/**
 * @module sdk/governance/status-role-diagnostics
 *
 * Diagnoses lifecycle statuses that cannot participate in role-derived project
 * management views because they have no registered lifecycle role.
 */
import type { ItemMetadata } from "../../types/index.js";
import {
  normalizeStatusInputWithRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";

/** Bounded evidence describing roleless status definitions and affected items. */
export interface StatusRoleDiagnostics {
  /** Registered status ids that have no lifecycle role. */
  roleless_statuses: string[];
  /** Number of items whose status resolves to a roleless definition. */
  affected_item_count: number;
  /** Bounded, deterministic sample of affected item ids. */
  affected_item_ids: string[];
  /** Whether affected item ids were omitted from the bounded sample. */
  affected_item_ids_truncated: boolean;
}

/** Inspect role registration and affected items without mutating the tracker. */
export function inspectStatusRoleAssignments(
  statusRegistry: RuntimeStatusRegistry,
  items: readonly ItemMetadata[],
  itemLimit = 25,
): StatusRoleDiagnostics {
  const rolelessStatuses = statusRegistry.definitions
    .filter((definition) => definition.roles.length === 0)
    .map((definition) => definition.id)
    .sort((left, right) => left.localeCompare(right));
  const rolelessSet = new Set(rolelessStatuses);
  const affectedItemIds = items
    .filter((item) => {
      const resolved = normalizeStatusInputWithRegistry(
        item.status,
        statusRegistry,
      );
      return resolved !== undefined && rolelessSet.has(resolved);
    })
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
  return {
    roleless_statuses: rolelessStatuses,
    affected_item_count: affectedItemIds.length,
    affected_item_ids: affectedItemIds.slice(0, itemLimit),
    affected_item_ids_truncated: affectedItemIds.length > itemLimit,
  };
}

/** Convert role diagnostics into the stable health/validate warning token. */
export function buildStatusRoleWarnings(
  diagnostics: StatusRoleDiagnostics,
): string[] {
  return diagnostics.roleless_statuses.length === 0
    ? []
    : [
        `schema_status_missing_lifecycle_role:${diagnostics.roleless_statuses.length}`,
      ];
}
