import { describe, expect, it } from "vitest";
import { suggestNextLifecycleTransition } from "../../../src/cli/commands/lifecycle-transitions.js";
import type { RuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";

function buildRegistry(openStatus: string, aliases: Record<string, string>): RuntimeStatusRegistry {
  return {
    open_status: openStatus,
    alias_to_id: new Map(Object.entries(aliases)),
  } as unknown as RuntimeStatusRegistry;
}

const REGISTRY_WITH_IN_PROGRESS = buildRegistry("open", { in_progress: "in_progress" });

describe("suggestNextLifecycleTransition", () => {
  it("suggests start-task for a workable item in the open status", () => {
    expect(suggestNextLifecycleTransition("pm-a1b2", "Task", "open", REGISTRY_WITH_IN_PROGRESS)).toEqual({
      command: "pm start-task pm-a1b2",
      to_status: "in_progress",
    });
  });

  it("returns undefined for scheduling/reference types regardless of status", () => {
    for (const type of ["Event", "meeting", "Reminder", "Milestone", "decision", "ADR"]) {
      expect(suggestNextLifecycleTransition("pm-a1b2", type, "open", REGISTRY_WITH_IN_PROGRESS)).toBeUndefined();
    }
  });

  it("returns undefined when the item is not in the open status", () => {
    expect(
      suggestNextLifecycleTransition("pm-a1b2", "Feature", "in_progress", REGISTRY_WITH_IN_PROGRESS),
    ).toBeUndefined();
  });

  it("returns undefined when the workflow defines no distinct in_progress status", () => {
    const registry = buildRegistry("open", { open: "open" });
    expect(suggestNextLifecycleTransition("pm-a1b2", "Bug", "open", registry)).toBeUndefined();
  });

  it("returns undefined when in_progress collapses onto the open status", () => {
    const registry = buildRegistry("open", { in_progress: "open" });
    expect(suggestNextLifecycleTransition("pm-a1b2", "Chore", "open", registry)).toBeUndefined();
  });
});
