/**
 * @module tests/unit/regressions/context-integrity-recovery
 *
 * Cross-surface regression coverage for lossless context parsing, external
 * blocker classification, package receipts, and agent provenance recovery.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCsvKv } from "../../../src/core/item/parse.js";
import { resolveItemBlockers } from "../../../src/core/item/actionability.js";
import { isExternalDependencyReference } from "../../../src/core/item/dependency-reference.js";
import { getWorkspaceHistoryPath } from "../../../src/core/history/workspace-history.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { detectAgentIdentity } from "../../../src/core/shared/author.js";
import { _testOnlyInstallSources } from "../../../src/sdk/extension/install-sources.js";
import {
  registerExternalDependencyResolver,
  resolveExternalDependencyReference,
} from "../../../src/sdk/dependency-provenance.js";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { runValidate } from "../../../src/sdk/governance/validate.js";
import {
  assembleWorkspaceRelationshipGraph,
  collectExternalDependencyTargetIds,
} from "../../../src/sdk/graph/assembly.js";
import { runNext } from "../../../src/sdk/query/next.js";
import { runLinkedTests } from "../../../src/sdk/test/execution.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("context integrity recovery", () => {
  it("preserves comma whitespace and consumes escaped commas in structured metadata", () => {
    expect(parseCsvKv("path=README.md,note=alpha, beta", "--file")).toEqual({
      path: "README.md",
      note: "alpha, beta",
    });
    expect(
      parseCsvKv(String.raw`path=README.md,note=alpha\, beta`, "--file"),
    ).toEqual({ path: "README.md", note: "alpha, beta" });
  });

  it("selects npm 12 keyed receipts by requested package and rejects ambiguity", () => {
    const receipt = JSON.stringify({
      alpha: { filename: "alpha.tgz", name: "alpha", version: "1.0.0" },
      beta: { filename: "beta.tgz", name: "beta", version: "2.0.0" },
    });
    expect(
      _testOnlyInstallSources.parsePackedNpmPackage(
        receipt,
        "/tmp/pack",
        "beta",
      ),
    ).toEqual({
      tarball: path.join("/tmp/pack", "beta.tgz"),
      package: "beta",
      version: "2.0.0",
    });
    expect(() =>
      _testOnlyInstallSources.parsePackedNpmPackage(receipt, "/tmp/pack"),
    ).toThrow("unsupported or ambiguous");
    expect(() =>
      _testOnlyInstallSources.parsePackedNpmPackage(
        JSON.stringify({ beta: { filename: "", name: "beta" } }),
        "/tmp/pack",
        "beta",
      ),
    ).toThrow("unsupported or ambiguous");
    expect(() =>
      _testOnlyInstallSources.parsePackedNpmPackage(
        JSON.stringify("not-a-receipt"),
        "/tmp/pack",
      ),
    ).toThrow("unsupported or ambiguous");
    expect(() =>
      _testOnlyInstallSources.parsePackedNpmPackage(
        JSON.stringify([{ filename: "wrong.tgz", name: "wrong-package" }]),
        "/tmp/pack",
        "expected-package",
      ),
    ).toThrow("unsupported or ambiguous");
  });

  it("bounds Claude session probes and recursive metadata traversal", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pm-claude-bounds-"));
    temporaryRoots.push(home);
    const cwd = path.join(home, "workspace");
    const projectDirectory = cwd.replaceAll(/[^A-Za-z0-9-]/gu, "-");
    const sessionDirectory = path.join(
      home,
      ".claude",
      "projects",
      projectDirectory,
    );
    const sessionPath = path.join(sessionDirectory, "bounded-session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "", "utf8");
    const signals = {
      cwd,
      home_dir: home,
      env: {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "bounded-session",
      },
    } as const;
    expect(detectAgentIdentity(signals).model).toBeUndefined();

    const deepMetadata = {
      message: { one: { two: { three: { four: { model: "too-deep" } } } } },
    };
    const leadingRows = Array.from({ length: 5_000 }, (_, index) =>
      JSON.stringify({ type: "meta", index }),
    ).join("\n");
    const padding = "x".repeat(1_100_000);
    await writeFile(
      sessionPath,
      `${JSON.stringify(deepMetadata)}\n${leadingRows}\n${padding}\n${JSON.stringify({ model: "claude-sonnet-5", version: "2.2.0" })}\n`,
      "utf8",
    );
    expect(detectAgentIdentity(signals)).toMatchObject({
      model: "claude-sonnet-5",
      provenance: { version: { value: "2.2.0" } },
    });
  });

  it("classifies external locator variants without inventing local blockers", () => {
    expect(isExternalDependencyReference(undefined)).toBe(false);
    expect(isExternalDependencyReference("linear:ENG-42")).toBe(true);
    expect(
      resolveItemBlockers(
        { blocked_by: "jira:PM-42", dependencies: [] },
        new Map(),
        resolveRuntimeStatusRegistry(undefined),
      ),
    ).toEqual([
      {
        id: "jira:PM-42",
        title: null,
        status: null,
        resolved: false,
        external: true,
        resolver: null,
      },
    ]);
    expect(
      collectExternalDependencyTargetIds([
        {
          blocked_by: "https://example.test/Issue/1",
          dependencies: [
            null,
            { id: "pm-local", source_kind: "local" },
            { id: "", source_kind: "external" },
            { id: "linear:ENG-42", source_kind: "global" },
          ],
        },
        { blocked_by: "https://example.test/Issue/1", dependencies: [] },
      ] as never),
    ).toEqual(["https://example.test/Issue/1", "linear:ENG-42"]);
    const externalGraph = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-holder",
        title: "Holder",
        status: "blocked",
        blocked_by: "https://example.test/issues/1",
      },
    ] as never);
    expect(externalGraph.graph.edges()).toEqual([
      {
        source: "pm-holder",
        target: "https://example.test/issues/1",
        kind: "blocked_by",
      },
    ]);
    const structuredExternalGraph = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-holder",
        title: "Holder",
        status: "blocked",
        dependencies: [{ id: "linear:ENG-42", kind: "blocked_by" }],
      },
    ] as never);
    expect(structuredExternalGraph.graph.edges()).toEqual([
      {
        source: "pm-holder",
        target: "linear:ENG-42",
        kind: "blocked_by",
      },
    ]);

    const collisionGraph = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-42",
        title: "Local target",
        status: "closed",
      },
      {
        id: "pm-local-holder",
        title: "Local holder",
        status: "open",
        dependencies: [{ id: "PM-42", kind: "related" }],
      },
      {
        id: "pm-external-holder",
        title: "External holder",
        status: "blocked",
        dependencies: [
          {
            id: "PM-42",
            kind: "blocked_by",
            source_kind: "external",
          },
        ],
      },
    ] as never);
    expect(collisionGraph.graph.edges()).toEqual([
      {
        source: "pm-external-holder",
        target: "external:PM-42",
        kind: "blocked_by",
      },
      {
        source: "pm-local-holder",
        target: "pm-42",
        kind: "related",
      },
    ]);

    const externalParent = assembleWorkspaceRelationshipGraph([
      {
        id: "pm-child",
        title: "Child",
        status: "open",
        parent: "https://example.test/parent",
      },
    ] as never);
    expect(externalParent.dangling.active).toEqual([
      expect.objectContaining({
        holder_id: "pm-child",
        target_id: "https://example.test/parent",
        source: "parent",
      }),
    ]);
  });

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
          checkedAt: "2026-08-29T01:00:00.000Z",
        }),
      });
      cleanup.push(disposeUnknown);
      expect(await resolveExternalDependencyReference("linear:ENG-42")).toEqual(
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
    } finally {
      for (const dispose of cleanup.reverse()) dispose();
    }
  });

  it("reports future workspace history capabilities as version skew", async () => {
    await withTempPmPath(async (context) => {
      expect(
        context.runCli([
          "config",
          "project",
          "set",
          "author_default",
          "workspace-version-probe",
          "--json",
        ]).code,
      ).toBe(0);
      const historyPath = getWorkspaceHistoryPath(context.pmPath);
      const rows = (await readFile(historyPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => ({
          ...(JSON.parse(line) as Record<string, unknown>),
          item_hash_version: 99,
        }));
      await writeFile(
        historyPath,
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "utf8",
      );
      const health = await runHealth({ path: context.pmPath }, { full: true });
      expect(health.warnings).toContain(
        "history_drift_version_skew:_workspace",
      );
    });
  });

  it("finds Claude model and version after leading metadata and inside nested messages", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pm-claude-context-"));
    temporaryRoots.push(home);
    const cwd = path.join(home, "workspace");
    const projectDirectory = cwd.replaceAll(/[^A-Za-z0-9-]/gu, "-");
    const sessionDirectory = path.join(
      home,
      ".claude",
      "projects",
      projectDirectory,
    );
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      path.join(sessionDirectory, "nested-session.jsonl"),
      `${Array.from({ length: 19 }, (_, index) => JSON.stringify({ type: "meta", index })).join("\n")}\n${JSON.stringify({ message: { message: { model: "claude-opus-5", version: "2.1.251" } } })}\n`,
      "utf8",
    );
    expect(
      detectAgentIdentity({
        cwd,
        home_dir: home,
        env: {
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "nested-session",
        },
      }),
    ).toMatchObject({
      model: "claude-opus-5",
      provenance: {
        model: { value: "claude-opus-5" },
        version: { value: "2.1.251" },
      },
    });
  });

  it("keeps URL blockers out of dangling-local validation and exposes staleness", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "External wait",
          "--description",
          "Waits on an upstream issue",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      const external = "https://github.com/unbraind/pm-cli/issues/854";
      expect(
        context.runCli(
          [
            "update",
            id,
            "--status",
            "blocked",
            "--blocked-by",
            external,
            "--blocked-reason",
            "waiting upstream",
            "--json",
          ],
          { expectJson: true },
        ).code,
      ).toBe(0);

      const validation = await runValidate({}, { path: context.pmPath });
      const dependencyCheck = validation.checks.find(
        (check) => check.name === "dependency_references",
      );
      expect(dependencyCheck?.details).toMatchObject({
        dangling_reference_count: 0,
      });

      const next = await runNext({}, { path: context.pmPath });
      expect(next.blocked).toEqual([
        expect.objectContaining({
          id,
          blockers: [
            expect.objectContaining({
              id: external,
              external: true,
              blocked_since: expect.any(String),
              resolver: null,
            }),
          ],
        }),
      ]);
    });
  });

  it("fails a filtered linked test when the runner reports zero executed tests", async () => {
    const [result] = await runLinkedTests(
      [
        {
          command:
            "printf '# tests 0\\n# pass 0\\n' # --test-name-pattern missing",
          scope: "project",
        },
      ],
      30,
    );
    expect(result).toMatchObject({
      status: "failed",
      failure_category: "empty_run",
      error: expect.stringContaining("zero"),
    });
  });

  it("requires positive runner evidence for filtered linked tests", async () => {
    const [unproven, proven] = await runLinkedTests(
      [
        {
          command: "printf '.' # --test-name-pattern missing",
          scope: "project",
        },
        {
          command:
            "printf '# tests 1\\n# pass 1\\n' # --test-name-pattern present",
          scope: "project",
        },
      ],
      30,
    );
    expect(unproven).toMatchObject({
      status: "failed",
      failure_category: "empty_run",
      error: expect.stringContaining("missing_positive_execution_receipt"),
    });
    expect(proven).toMatchObject({ status: "passed" });
  });

  it("does not treat zero passes as empty when a runner reports executed tests", async () => {
    const [result] = await runLinkedTests(
      [
        {
          command:
            "printf '# tests 1\\n# pass 0\\n' # --test-name-pattern present",
          scope: "project",
        },
      ],
      30,
    );
    expect(result).toMatchObject({ status: "passed" });
  });
});
