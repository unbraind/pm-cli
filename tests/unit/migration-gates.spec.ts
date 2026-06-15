import { describe, expect, it } from "vitest";
import {
  collectMandatoryMigrationBlockers,
  decideWriteGate,
  enforceMandatoryMigrationWriteGate,
  resolveMigrationId,
  resolveNormalizedMigrationStatus,
} from "../../src/cli/migration-gates.js";
import { PmCliError } from "../../src/core/shared/errors.js";

describe("resolveMigrationId", () => {
  it("returns explicit id when present", () => {
    expect(resolveMigrationId({ id: "custom-id" }, 0)).toBe("custom-id");
  });

  it("generates fallback id from index", () => {
    expect(resolveMigrationId({}, 0)).toBe("migration-001");
    expect(resolveMigrationId({}, 9)).toBe("migration-010");
    expect(resolveMigrationId({}, 99)).toBe("migration-100");
  });

  it("ignores empty string id", () => {
    expect(resolveMigrationId({ id: "" }, 2)).toBe("migration-003");
    expect(resolveMigrationId({ id: "   " }, 2)).toBe("migration-003");
  });
});

describe("resolveNormalizedMigrationStatus", () => {
  it("normalizes status to lowercase", () => {
    expect(resolveNormalizedMigrationStatus({ status: "Applied" })).toBe("applied");
    expect(resolveNormalizedMigrationStatus({ status: "PENDING" })).toBe("pending");
  });

  it("defaults to pending when status is missing", () => {
    expect(resolveNormalizedMigrationStatus({})).toBe("pending");
  });

  it("defaults to pending for empty string status", () => {
    expect(resolveNormalizedMigrationStatus({ status: "" })).toBe("pending");
    expect(resolveNormalizedMigrationStatus({ status: "   " })).toBe("pending");
  });
});

describe("decideWriteGate", () => {
  it("identifies create as mutation without force capability", () => {
    const result = decideWriteGate("create", {});
    expect(result.isMutation).toBe(true);
    expect(result.forceCapable).toBe(false);
  });

  it("identifies update as mutation with force capability", () => {
    const result = decideWriteGate("update", {});
    expect(result.isMutation).toBe(true);
    expect(result.forceCapable).toBe(true);
    expect(result.forceRequested).toBe(false);
  });

  it("detects --force on force-capable commands", () => {
    const result = decideWriteGate("update", { force: true });
    expect(result.forceRequested).toBe(true);
  });

  it("treats restore and other force-capable lifecycle commands as mutations", () => {
    const result = decideWriteGate("restore", {});
    expect(result.isMutation).toBe(true);
    expect(result.forceCapable).toBe(true);
    expect(result.forceRequested).toBe(false);
  });

  it("identifies read commands as non-mutation", () => {
    expect(decideWriteGate("list", {}).isMutation).toBe(false);
    expect(decideWriteGate("search", {}).isMutation).toBe(false);
    expect(decideWriteGate("calendar", {}).isMutation).toBe(false);
    expect(decideWriteGate("context", {}).isMutation).toBe(false);
  });

  it("identifies comments/notes/learnings as mutation only with --add", () => {
    expect(decideWriteGate("comments", {}).isMutation).toBe(false);
    expect(decideWriteGate("comments", { add: "text" }).isMutation).toBe(true);
    expect(decideWriteGate("notes", { add: "note" }).isMutation).toBe(true);
    expect(decideWriteGate("learnings", {}).isMutation).toBe(false);
  });

  it("identifies files/docs/test as mutation only with --add or --remove arrays", () => {
    expect(decideWriteGate("files", {}).isMutation).toBe(false);
    expect(decideWriteGate("files", { add: ["path=x.ts"] }).isMutation).toBe(true);
    expect(decideWriteGate("docs", { remove: ["path=y.md"] }).isMutation).toBe(true);
    expect(decideWriteGate("test", { add: [] }).isMutation).toBe(false);
  });
});

describe("collectMandatoryMigrationBlockers", () => {
  it("returns empty for no migrations", () => {
    expect(collectMandatoryMigrationBlockers([])).toEqual([]);
  });

  it("skips non-mandatory migrations", () => {
    const result = collectMandatoryMigrationBlockers([
      { layer: "project", name: "ext-a", definition: { status: "pending" } },
    ]);
    expect(result).toEqual([]);
  });

  it("skips applied mandatory migrations", () => {
    const result = collectMandatoryMigrationBlockers([
      { layer: "project", name: "ext-a", definition: { mandatory: true, status: "applied" } },
    ]);
    expect(result).toEqual([]);
  });

  it("collects pending mandatory migrations as blockers", () => {
    const result = collectMandatoryMigrationBlockers([
      { layer: "project", name: "ext-a", definition: { mandatory: true, status: "pending", id: "m1" } },
    ]);
    expect(result).toEqual([
      { layer: "project", name: "ext-a", id: "m1", status: "pending" },
    ]);
  });

  it("sorts blockers by layer then name then id", () => {
    const result = collectMandatoryMigrationBlockers([
      { layer: "project", name: "ext-b", definition: { mandatory: true, id: "m1" } },
      { layer: "global", name: "ext-a", definition: { mandatory: true, id: "m2" } },
      { layer: "project", name: "ext-a", definition: { mandatory: true, id: "m3" } },
    ]);
    expect(result.map((b) => b.id)).toEqual(["m2", "m3", "m1"]);
  });

  it("breaks ties by id when layer and name match", () => {
    const result = collectMandatoryMigrationBlockers([
      { layer: "project", name: "ext-a", definition: { mandatory: true, id: "m-z", status: "pending" } },
      { layer: "project", name: "ext-a", definition: { mandatory: true, id: "m-a", status: "pending" } },
    ]);
    expect(result.map((b) => b.id)).toEqual(["m-a", "m-z"]);
  });
});

describe("enforceMandatoryMigrationWriteGate", () => {
  const blockers = [
    { layer: "project" as const, name: "ext-a", id: "m1", status: "pending" },
  ];

  it("does not throw for read commands", () => {
    expect(() => enforceMandatoryMigrationWriteGate("list", {}, blockers)).not.toThrow();
    expect(() => enforceMandatoryMigrationWriteGate("search", {}, blockers)).not.toThrow();
  });

  it("throws for write commands when blockers exist", () => {
    expect(() => enforceMandatoryMigrationWriteGate("create", {}, blockers)).toThrow(PmCliError);
    expect(() => enforceMandatoryMigrationWriteGate("update", {}, blockers)).toThrow(PmCliError);
  });

  it("allows force-capable commands with --force to bypass", () => {
    expect(() => enforceMandatoryMigrationWriteGate("update", { force: true }, blockers)).not.toThrow();
    expect(() => enforceMandatoryMigrationWriteGate("close", { force: true }, blockers)).not.toThrow();
  });

  it("does not allow --force bypass on non-force-capable commands", () => {
    expect(() => enforceMandatoryMigrationWriteGate("create", { force: true }, blockers)).toThrow(PmCliError);
  });

  it("does not throw when no blockers exist", () => {
    expect(() => enforceMandatoryMigrationWriteGate("create", {}, [])).not.toThrow();
  });

  it("includes migration codes in error message", () => {
    try {
      enforceMandatoryMigrationWriteGate("create", {}, blockers);
    } catch (error) {
      expect((error as PmCliError).message).toContain("extension_migration_blocking:project:ext-a:m1:pending");
    }
  });
});
