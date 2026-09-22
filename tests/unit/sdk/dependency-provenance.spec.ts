import { describe, expect, it } from "vitest";
import { registerExternalDependencyResolver, resolveExternalDependencyReference, normalizeDependencySeedId, normalizeDependencySourceKind, EXTERNAL_DEPENDENCY_SOURCE_KIND_ALIAS } from "../../../src/sdk/dependency-provenance.js";
import {
  assembleWorkspaceRelationshipGraph,
  collectExternalDependencyTargetIds,
} from "../../../src/sdk/graph/assembly.js";

describe("external dependency graph assembly", () => {
  it("deduplicates exact external endpoints while preserving locator case", () => {
    const items = [
      {
        id: "pm-local",
        title: "Local consumer",
        status: "open" as const,
        blocked_by: "no-active-blocker",
        dependencies: [
          null,
          { id: "", kind: "related", source_kind: "global" },
          {
            id: "no-active-blocker",
            kind: "blocked_by",
            source_kind: "global",
          },
          { id: "Foreign-Z", kind: "related", source_kind: "global" },
          { id: "foreign-z", kind: "blocks", source_kind: "global" },
          { id: "foreign-a", kind: "related", source_kind: "global" },
          {
            id: "foreign-blocker",
            kind: "blocked_by",
            source_kind: "external",
          },
          { id: "pm-local-missing", kind: "related" },
        ],
      },
    ];

    expect(collectExternalDependencyTargetIds(items as never)).toEqual([
      "foreign-a",
      "foreign-blocker",
      "foreign-z",
      "Foreign-Z",
    ]);
    const assembled = assembleWorkspaceRelationshipGraph(items as never);
    expect(assembled.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "[external] Foreign-Z",
          status: "external",
        }),
        expect.objectContaining({
          title: "[external] foreign-z",
          status: "external",
        }),
        expect.objectContaining({ id: "foreign-a", status: "external" }),
        expect.objectContaining({
          id: "pm-local-missing",
          status: "missing",
        }),
      ]),
    );
    expect(assembled.dangling.active).toHaveLength(2);
    expect(assembled.dangling.no_active_blocker_sentinels).toHaveLength(1);
    expect(
      assembled.details.some((detail) =>
        detail.id.includes("no-active-blocker"),
      ),
    ).toBe(false);
    expect(
      assembled.graph.nodes().filter((id) => id.toLowerCase().endsWith("foreign-z")),
    ).toHaveLength(2);
  });

  it("keeps colliding local, missing, and external identities distinct", () => {
    const items = [
      {
        id: "pm-local",
        title: "Local consumer",
        status: "open" as const,
        dependencies: [
          { id: "pm-existing", kind: "related", source_kind: "global" },
          { id: "shared-target", kind: "related" },
          { id: "SHARED-TARGET", kind: "blocks", source_kind: "global" },
        ],
      },
      {
        id: "pm-existing",
        title: "Existing local target",
        status: "open" as const,
      },
    ];

    const assembled = assembleWorkspaceRelationshipGraph(items as never);
    expect(
      assembled.details.filter((detail) => detail.id === "pm-existing"),
    ).toHaveLength(1);
    expect(assembled.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external:pm-existing",
          status: "external",
        }),
        expect.objectContaining({ id: "shared-target", status: "missing" }),
        expect.objectContaining({
          id: "external:SHARED-TARGET",
          status: "external",
        }),
      ]),
    );
    expect(new Set(assembled.graph.nodes()).size).toBe(
      assembled.graph.nodes().length,
    );
  });
});

describe("external dependency resolver contracts", () => {
  it("resolves external blockers through bounded package-owned providers", async () => {
    const cleanup: Array<() => void> = [];
    expect(await resolveExternalDependencyReference("pm-local")).toBeNull();
    expect(() =>
      registerExternalDependencyResolver({
        name: " ",
        supports: () => true,
        resolve: async () => null,
      }),
    ).toThrow("must not be empty");
    try {
      const disposeUnsupported = registerExternalDependencyResolver({
        name: "unsupported",
        supports: () => false,
        resolve: async () => null,
      });
      cleanup.push(disposeUnsupported);
      const disposeThrowingSupport = registerExternalDependencyResolver({
        name: "throwing-support",
        supports: () => {
          throw new Error("support probe unavailable");
        },
        resolve: async () => {
          throw new Error("excluded resolver must not execute");
        },
      });
      cleanup.push(disposeThrowingSupport);
      const disposeThrowing = registerExternalDependencyResolver({
        name: "throwing",
        supports: () => true,
        resolve: () => {
          throw new Error("provider unavailable");
        },
      });
      cleanup.push(disposeThrowing);
      const disposeEmpty = registerExternalDependencyResolver({
        name: "empty",
        supports: () => true,
        resolve: async () => null,
      });
      cleanup.push(disposeEmpty);
      const disposeUndefined = registerExternalDependencyResolver({
        name: "undefined-result",
        supports: () => true,
        resolve: async () => undefined as never,
      });
      cleanup.push(disposeUndefined);
      const disposeMalformedTitle = registerExternalDependencyResolver({
        name: "malformed-title",
        supports: () => true,
        resolve: async () => ({ status: "closed", title: 42 }) as never,
      });
      cleanup.push(disposeMalformedTitle);
      const disposeGitHub = registerExternalDependencyResolver({
        name: " github-issues ",
        supports: (reference) => reference.startsWith("https://github.com/"),
        resolve: async () => ({
          status: "closed",
          title: ` ${"x".repeat(300)} `,
          source: ` ${"s".repeat(2_100)} `,
          checkedAt: "not-a-timestamp",
        }),
      });
      cleanup.push(disposeGitHub);
      expect(() =>
        registerExternalDependencyResolver({
          name: "github-issues",
          supports: () => true,
          resolve: async () => null,
        }),
      ).toThrow("already registered");
      expect(
        await resolveExternalDependencyReference(
          " https://github.com/example/project/issues/42 ",
          { now: () => "2026-08-29T00:00:00.000Z" },
        ),
      ).toEqual({
        id: "https://github.com/example/project/issues/42",
        status: "closed",
        resolved: true,
        title: "x".repeat(240),
        source: "s".repeat(2_048),
        checked_at: "2026-08-29T00:00:00.000Z",
        resolver: "github-issues",
      });
      disposeGitHub();
      disposeMalformedTitle();
      disposeUndefined();
      disposeEmpty();
      disposeThrowing();
      disposeUnsupported();

      const disposeOriginal = registerExternalDependencyResolver({
        name: "replacement-safe",
        supports: () => true,
        resolve: async () => null,
      });
      cleanup.push(disposeOriginal);
      disposeOriginal();
      const disposeReplacement = registerExternalDependencyResolver({
        name: "replacement-safe",
        supports: () => true,
        resolve: async () => ({ status: "closed" }),
      });
      cleanup.push(disposeReplacement);
      disposeOriginal();
      expect(
        await resolveExternalDependencyReference("linear:ENG-42"),
      ).toMatchObject({ resolver: "replacement-safe", resolved: true });
      disposeReplacement();

      const disposeUnknown = registerExternalDependencyResolver({
        name: "unknown-status",
        supports: () => true,
        resolve: async () => ({
          status: "provider-specific" as never,
          title: " ",
          checkedAt: " \t2026-08-29T01:00:00.000Z\n ",
        }),
      });
      cleanup.push(disposeUnknown);
      expect(await resolveExternalDependencyReference("linear:ENG-42", { now: () => "2000-01-01T00:00:00.000Z" })).toEqual(
        {
          id: "linear:ENG-42",
          status: "unknown",
          resolved: false,
          title: null,
          source: "linear:ENG-42",
          checked_at: "2026-08-29T01:00:00.000Z",
          resolver: "unknown-status",
        },
      );
      disposeUnknown();

      const disposeClockFallback = registerExternalDependencyResolver({
        name: "clock-fallback",
        supports: () => true,
        resolve: async () => ({ status: "open" }),
      });
      cleanup.push(disposeClockFallback);
      const clockFallback =
        await resolveExternalDependencyReference("jira:PM-42");
      disposeClockFallback();
      expect(clockFallback).toMatchObject({
        id: "jira:PM-42",
        status: "open",
        resolved: false,
        resolver: "clock-fallback",
      });
      expect(clockFallback?.checked_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      );
      expect(
        await resolveExternalDependencyReference("linear:ENG-42"),
      ).toBeNull();

      class PrototypeResolver {
        readonly name = " class-resolver ";

        supports(reference: string): boolean {
          return reference.startsWith("jira:");
        }

        async resolve(): Promise<{ status: "closed" }> {
          return { status: "closed" };
        }
      }
      const disposeClassResolver = registerExternalDependencyResolver(
        new PrototypeResolver(),
      );
      cleanup.push(disposeClassResolver);
      expect(
        await resolveExternalDependencyReference("jira:PM-42"),
      ).toMatchObject({ resolver: "class-resolver", resolved: true });
      disposeClassResolver();
    } finally {
      for (const dispose of cleanup.reverse()) dispose();
    }
  });

  it("normalizes provenance and preserves foreign identity", () => {
    expect(EXTERNAL_DEPENDENCY_SOURCE_KIND_ALIAS).toBe("external");
    for (const value of [undefined, "", "  "]) expect(normalizeDependencySourceKind(value)).toBeUndefined();
    for (const value of [" global ", " external "]) expect(normalizeDependencySourceKind(value)).toBe("global");
    expect(normalizeDependencySourceKind(" provider-owned ")).toBe("provider-owned");
    expect(normalizeDependencySeedId(" OTHER-Case ", "pm-", "external")).toBe("OTHER-Case");
    expect(normalizeDependencySeedId(" #ABC ", "team-", undefined)).toBe("team-abc");
  });
  it("never invokes unsupported or throwing support probes, and ignores invalid provider fields", async () => {
    const calls: string[] = [];
    const disposers: Array<() => void> = [];
    try {
      for (const name of ["unsupported", "throwing"]) {
        disposers.push(registerExternalDependencyResolver({
          name,
          supports: () => { if (name === "throwing") throw new Error("unsupported"); return false; },
          resolve: async () => { calls.push(name); return { status: "closed" }; },
        }));
      }
      for (const [index, result] of [
        { status: 1 }, { status: "closed", source: 42 }, { status: "closed", checkedAt: 42 },
      ].entries()) {
        disposers.push(registerExternalDependencyResolver({ name: `invalid-${index}`, supports: () => true, resolve: async () => result as never }));
      }
      expect(await resolveExternalDependencyReference("jira:PROJ-1")).toBeNull();
      expect(calls).toEqual([]);
      disposers.push(registerExternalDependencyResolver({
        name: "valid", supports: () => true,
        resolve: async () => { calls.push("valid"); return { status: "open" }; },
      }));
      expect(await resolveExternalDependencyReference("pm-local")).toBeNull();
      expect(calls).toEqual([]);
    } finally { for (const dispose of disposers) dispose(); }
  });

});
