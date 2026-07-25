/**
 * @module core/item/plan-lifecycle
 *
 * Defines the terminal lifecycle semantics shared by Plan command mutations
 * and generic item closure.
 */
import type { ItemMetadata, PlanMode, PlanStep } from "../../types/index.js";

/** Plan modes that intentionally prevent any further Plan mutation. */
export const TERMINAL_PLAN_MODES: ReadonlySet<PlanMode> = new Set<PlanMode>([
  "completed",
  "superseded",
]);

/** Return whether a Plan mode represents a terminal planning state. */
export function isTerminalPlanMode(mode: PlanMode | undefined): boolean {
  return mode !== undefined && TERMINAL_PLAN_MODES.has(mode);
}

/** Return whether closing this item should complete its Plan lifecycle in the same mutation. */
export function shouldCompletePlanOnClose(item: ItemMetadata): boolean {
  if (item.type.trim().toLowerCase() !== "plan") return false;
  const steps: PlanStep[] = item.plan_steps ?? [];
  return steps.length > 0 && steps.every((step) => step.status === "completed");
}
