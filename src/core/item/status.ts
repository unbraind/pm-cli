import { STATUS_VALUES } from "../../types/index.js";
import type { ItemStatus } from "../../types/index.js";

const STATUS_ALIAS_MAP: Readonly<Record<string, ItemStatus>> = {
  "in-progress": "in_progress",
};

export function normalizeStatusInput(value: string): ItemStatus | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const canonical = STATUS_ALIAS_MAP[normalized] ?? normalized;
  if (!STATUS_VALUES.includes(canonical as ItemStatus)) {
    return undefined;
  }
  return canonical as ItemStatus;
}
