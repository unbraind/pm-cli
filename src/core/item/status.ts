/**
 * @module core/item/status
 *
 * Defines item parsing, formatting, and lifecycle helpers for Status.
 */
import { STATUS_VALUES } from "../../types/index.js";
import type { ItemStatus } from "../../types/index.js";
import {
  normalizeStatusInputWithRegistry,
  type RuntimeStatusRegistry,
} from "../schema/runtime-schema.js";

const STATUS_ALIAS_MAP: Readonly<Record<string, ItemStatus>> = {
  "in-progress": "in_progress",
  cancelled: "canceled",
};

/** Implements normalize status input for the public runtime surface of this module. */
export function normalizeStatusInput(
  value: unknown,
  registry?: RuntimeStatusRegistry,
): ItemStatus | undefined {
  if (registry) {
    const normalizedFromRegistry = normalizeStatusInputWithRegistry(
      value,
      registry,
    );
    if (normalizedFromRegistry) {
      return normalizedFromRegistry;
    }
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const canonical = STATUS_ALIAS_MAP[normalized] ?? normalized;
  if (!(STATUS_VALUES as readonly string[]).includes(canonical)) {
    return undefined;
  }
  return canonical as ItemStatus;
}

/** Normalize a status against the runtime registry, falling back to the original value when normalization does not resolve to a known status. This preserves the long-standing `normalizeStatusInput(status, registry) ?? status` pattern used by query commands so that unknown/custom statuses still compare against registry sets by their raw value. */
export function normalizeStatusForRegistry(
  status: ItemStatus,
  registry: RuntimeStatusRegistry,
): ItemStatus {
  return normalizeStatusInput(status, registry) ?? status;
}

/** Determine whether a status is terminal according to the runtime status registry, applying registry-aware normalization first (with raw fallback). */
export function isTerminalStatus(
  status: ItemStatus,
  registry: RuntimeStatusRegistry,
): boolean {
  return registry.terminal_statuses.has(
    normalizeStatusForRegistry(status, registry),
  );
}
