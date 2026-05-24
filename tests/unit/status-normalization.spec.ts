import { describe, expect, it } from "vitest";

import { isTerminalStatus, normalizeStatusForRegistry, normalizeStatusInput } from "../../src/core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../../src/core/schema/runtime-schema.js";
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
