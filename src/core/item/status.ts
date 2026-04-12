import { STATUS_VALUES } from "../../types/index.js";
import type { ItemStatus } from "../../types/index.js";
import { normalizeStatusInputWithRegistry, type RuntimeStatusRegistry } from "../schema/runtime-schema.js";

const STATUS_ALIAS_MAP: Readonly<Record<string, ItemStatus>> = {
  "in-progress": "in_progress",
  cancelled: "canceled",
};

export function normalizeStatusInput(value: string, registry?: RuntimeStatusRegistry): ItemStatus | undefined {
  if (registry) {
    const normalizedFromRegistry = normalizeStatusInputWithRegistry(value, registry);
    if (normalizedFromRegistry) {
      return normalizedFromRegistry;
    }
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
