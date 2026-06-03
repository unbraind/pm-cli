import { describe, expect, it } from "vitest";

import { isTerminalStatus, normalizeStatusForRegistry, normalizeStatusInput } from "../../src/core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../../src/core/schema/runtime-schema.js";
import {
  describeAllowedTransitions,
  evaluateTransition,
  normalizeStatusToken,
  resolveTypeWorkflows,
} from "../../src/core/schema/type-workflows.js";
import { SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import type { ItemStatus } from "../../src/types/index.js";

const builtInRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);

const customRegistry = resolveRuntimeStatusRegistry({
  statuses: [
    { id: "todo", roles: ["active", "default_open"] },
    { id: "doing", aliases: ["wip"], roles: ["active"] },
    { id: "shipped", roles: ["terminal", "terminal_done", "default_close"] },
    { id: "dropped", roles: ["terminal", "terminal_canceled", "default_cancel"] },
  ],
  fields: [],
  workflow: {
    open_status: "todo",
    close_status: "shipped",
    canceled_status: "dropped",
  },
});

describe("normalizeStatusInput", () => {
  it("accepts canonical statuses and in-progress alias", () => {
    expect(normalizeStatusInput("in_progress")).toBe("in_progress");
    expect(normalizeStatusInput(" in-progress ")).toBe("in_progress");
    expect(normalizeStatusInput("OPEN")).toBe("open");
  });

  it("returns undefined for blank and invalid status inputs", () => {
    expect(normalizeStatusInput("")).toBeUndefined();
    expect(normalizeStatusInput("   ")).toBeUndefined();
    expect(normalizeStatusInput("in progress")).toBeUndefined();
    expect(normalizeStatusInput("doing")).toBeUndefined();
    expect(normalizeStatusInput(undefined)).toBeUndefined();
  });
});

describe("normalizeStatusForRegistry", () => {
  it("normalizes a known status against the built-in registry", () => {
    expect(normalizeStatusForRegistry("closed" as ItemStatus, builtInRegistry)).toBe("closed");
  });

  it("resolves a custom alias to its canonical id", () => {
    expect(normalizeStatusForRegistry("wip" as ItemStatus, customRegistry)).toBe("doing");
  });

  it("falls back to the raw value when normalization does not resolve", () => {
    expect(normalizeStatusForRegistry("unmapped" as ItemStatus, customRegistry)).toBe("unmapped");
  });
});

describe("isTerminalStatus", () => {
  it("returns true for a built-in terminal status", () => {
    expect(isTerminalStatus("closed" as ItemStatus, builtInRegistry)).toBe(true);
    expect(isTerminalStatus("canceled" as ItemStatus, builtInRegistry)).toBe(true);
  });

  it("returns false for a non-terminal built-in status", () => {
    expect(isTerminalStatus("open" as ItemStatus, builtInRegistry)).toBe(false);
    expect(isTerminalStatus("in_progress" as ItemStatus, builtInRegistry)).toBe(false);
  });

  it("honors custom registry terminal statuses (including aliases and non-terminal ids)", () => {
    expect(isTerminalStatus("shipped" as ItemStatus, customRegistry)).toBe(true);
    expect(isTerminalStatus("dropped" as ItemStatus, customRegistry)).toBe(true);
    expect(isTerminalStatus("wip" as ItemStatus, customRegistry)).toBe(false);
    expect(isTerminalStatus("todo" as ItemStatus, customRegistry)).toBe(false);
  });

  it("returns false for unknown/blank input via raw fallback", () => {
    expect(isTerminalStatus("closed" as ItemStatus, customRegistry)).toBe(false);
    expect(isTerminalStatus("" as ItemStatus, customRegistry)).toBe(false);
  });
});

describe("resolveTypeWorkflows (pm-f4r1)", () => {
  it("normalizes type names case-insensitively and status tokens, deduping pairs", () => {
    const resolved = resolveTypeWorkflows({
      type_workflows: [
        {
          type: "Story",
          allowed_transitions: [
            ["Open", "in-progress"],
            ["open", "in_progress"],
            ["", "blocked"],
            ["in_progress", ""],
          ] as [string, string][],
        },
        { type: "  ", allowed_transitions: [["open", "closed"]] },
      ],
    });
    expect(resolved).toEqual([
      { type: "story", allowed_transitions: [["open", "in_progress"]] },
    ]);
  });

  it("returns an empty list for missing or non-array input", () => {
    expect(resolveTypeWorkflows(undefined)).toEqual([]);
    expect(resolveTypeWorkflows({})).toEqual([]);
    expect(resolveTypeWorkflows({ type_workflows: "nope" as unknown as [] })).toEqual([]);
  });

  it("drops malformed pairs (non-array or wrong arity) and non-array allowed_transitions", () => {
    const resolved = resolveTypeWorkflows({
      type_workflows: [
        {
          type: "Bug",
          allowed_transitions: [
            ["open", "in_progress"],
            ["open", "blocked", "extra"] as unknown as [string, string],
            "open->closed" as unknown as [string, string],
          ],
        },
        { type: "Epic", allowed_transitions: "nope" as unknown as [string, string][] },
      ],
    });
    // Epic has no valid pairs (and is dropped); Bug keeps only the well-formed pair.
    expect(resolved).toEqual([{ type: "bug", allowed_transitions: [["open", "in_progress"]] }]);
  });

  it("sorts multiple normalized types by name", () => {
    const resolved = resolveTypeWorkflows({
      type_workflows: [
        { type: "Story", allowed_transitions: [["open", "in_progress"]] },
        { type: "Bug", allowed_transitions: [["open", "closed"]] },
      ],
    });
    expect(resolved.map((entry) => entry.type)).toEqual(["bug", "story"]);
  });

  it("drops entries whose type is not a string", () => {
    const resolved = resolveTypeWorkflows({
      type_workflows: [
        { type: 42 as unknown as string, allowed_transitions: [["open", "closed"]] },
        { type: "Bug", allowed_transitions: [["open", "closed"]] },
      ],
    });
    expect(resolved.map((entry) => entry.type)).toEqual(["bug"]);
  });

  it("normalizeStatusToken lowercases and collapses separators; non-strings yield empty", () => {
    expect(normalizeStatusToken(" In-Progress ")).toBe("in_progress");
    expect(normalizeStatusToken(42)).toBe("");
  });
});

describe("evaluateTransition (pm-f4r1)", () => {
  const typeWorkflows = resolveTypeWorkflows({
    type_workflows: [
      {
        type: "Story",
        allowed_transitions: [
          ["open", "in_progress"],
          ["in_progress", "closed"],
        ],
      },
    ],
  });

  it("allows any transition for an unrestricted type (no matching rule)", () => {
    const result = evaluateTransition({
      typeName: "Task",
      fromStatus: "open",
      toStatus: "blocked",
      typeWorkflows,
      statusRegistry: customRegistry,
    });
    expect(result).toEqual({ allowed: true, hasRule: false, allowedTransitions: [] });
  });

  it("allows a listed transition for a restricted type", () => {
    const result = evaluateTransition({
      typeName: "story",
      fromStatus: "open",
      toStatus: "in_progress",
      typeWorkflows,
      statusRegistry: builtInRegistry,
    });
    expect(result.allowed).toBe(true);
    expect(result.hasRule).toBe(true);
  });

  it("disallows an unlisted transition for a restricted type", () => {
    const result = evaluateTransition({
      typeName: "Story",
      fromStatus: "open",
      toStatus: "blocked",
      typeWorkflows,
      statusRegistry: builtInRegistry,
    });
    expect(result.allowed).toBe(false);
    expect(result.hasRule).toBe(true);
    expect(result.allowedTransitions).toEqual([
      ["open", "in_progress"],
      ["in_progress", "closed"],
    ]);
  });

  it("resolves from/to through the status registry alias map", () => {
    const aliasWorkflows = resolveTypeWorkflows({
      type_workflows: [{ type: "Story", allowed_transitions: [["todo", "doing"]] }],
    });
    // "wip" is an alias of "doing" in customRegistry; the rule lists "doing".
    const result = evaluateTransition({
      typeName: "Story",
      fromStatus: "todo",
      toStatus: "wip",
      typeWorkflows: aliasWorkflows,
      statusRegistry: customRegistry,
    });
    expect(result.allowed).toBe(true);
  });

  it("always allows a no-op self-transition under a restricting rule", () => {
    const result = evaluateTransition({
      typeName: "Story",
      fromStatus: "blocked",
      toStatus: "blocked",
      typeWorkflows,
      statusRegistry: builtInRegistry,
    });
    expect(result.allowed).toBe(true);
    expect(result.hasRule).toBe(true);
  });

  it("falls back to raw tokens when no status registry is provided", () => {
    const result = evaluateTransition({
      typeName: "Story",
      fromStatus: "open",
      toStatus: "in-progress",
      typeWorkflows,
    });
    expect(result.allowed).toBe(true);
  });

  it("treats a blank source status as a disallowed (non-no-op) transition under a rule", () => {
    const result = evaluateTransition({
      typeName: "Story",
      fromStatus: "   ",
      toStatus: "in_progress",
      typeWorkflows,
      statusRegistry: builtInRegistry,
    });
    expect(result.allowed).toBe(false);
    expect(result.hasRule).toBe(true);
  });
});

describe("describeAllowedTransitions (pm-f4r1)", () => {
  it("renders pairs as from -> to", () => {
    expect(
      describeAllowedTransitions([
        ["open", "in_progress"],
        ["in_progress", "closed"],
      ]),
    ).toBe("open -> in_progress, in_progress -> closed");
  });

  it("renders an explicit hint when no transitions are allowed", () => {
    expect(describeAllowedTransitions([])).toBe("(no transitions allowed)");
  });
});
