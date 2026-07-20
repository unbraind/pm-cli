import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as fsUtils from "../../../../src/core/fs/fs-utils.js";
import { runGraph } from "../../../../src/cli/commands/graph.js";
import { EXIT_CODE } from "../../../../src/core/shared/constants.js";
import { PmCliError } from "../../../../src/core/shared/errors.js";
import { resetWorkspaceGraphCache } from "../../../../src/sdk/graph/cache.js";
import {
  clearDurableGraphCache,
  durableGraphCachePath,
  durableGraphCacheStatus,
  graphAuditBaselinePath,
  loadGraphAuditBaseline,
  openDurableGraphCache,
  persistDurableGraphResult,
  saveGraphAuditBaseline,
  shouldPersistDurableGraphCache,
  GRAPH_DURABLE_CACHE_MIN_ITEMS,
  GRAPH_DURABLE_CACHE_VERSION,
} from "../../../../src/sdk/graph/durable-cache.js";
import type {
  GraphAnalyzeResult,
  GraphAuditResult,
  GraphIndexResult,
} from "../../../../src/sdk/graph/run.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../../helpers/withTempPmPath.js";

function createItem(
  context: TempPmContext,
  title: string,
  extraArgs: string[] = [],
): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--author",
      "durable-spec",
      ...extraArgs,
    ],
    { expectJson: true },
  );
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("durable graph cache primitives", () => {
  it("treats missing, corrupt, version-drifted, and misshapen envelopes as empty", async () => {
    await withTempPmPath(async (context) => {
      const missing = await openDurableGraphCache(context.pmPath, "fp");
      expect(missing).toEqual({ exists: false, fresh: false, results: {} });

      const cachePath = durableGraphCachePath(context.pmPath);
      await mkdir(path.dirname(cachePath), { recursive: true });
      for (const corrupt of [
        "{not json",
        JSON.stringify({
          version: 999,
          fingerprint: "fp",
          saved_at: "x",
          results: {},
        }),
        JSON.stringify({
          version: GRAPH_DURABLE_CACHE_VERSION,
          fingerprint: 7,
          saved_at: "x",
          results: {},
        }),
        JSON.stringify({
          version: GRAPH_DURABLE_CACHE_VERSION,
          fingerprint: "fp",
          saved_at: "x",
          results: null,
        }),
        JSON.stringify(null),
      ]) {
        await writeFile(cachePath, corrupt, "utf8");
        const view = await openDurableGraphCache(context.pmPath, "fp");
        expect(view).toEqual({ exists: true, fresh: false, results: {} });
        const status = await durableGraphCacheStatus(context.pmPath, "fp");
        expect(status).toEqual({ exists: true, fresh: false, entry_count: 0 });
      }
    });
  });

  it("persists atomically, invalidates on fingerprint change, and bounds retained entries", async () => {
    await withTempPmPath(async (context) => {
      let view = await openDurableGraphCache(context.pmPath, "fp-1");
      for (let index = 0; index < 70; index += 1) {
        await persistDurableGraphResult(
          context.pmPath,
          "fp-1",
          view,
          `query-${index}`,
          { index },
        );
      }
      view = await openDurableGraphCache(context.pmPath, "fp-1");
      expect(view.fresh).toBe(true);
      // The retention bound keeps the newest 64 entries.
      expect(Object.keys(view.results)).toHaveLength(64);
      expect(view.results["query-69"]).toEqual({ index: 69 });
      expect(view.results["query-5"]).toBeUndefined();
      const status = await durableGraphCacheStatus(context.pmPath, "fp-1");
      expect(status.fresh).toBe(true);
      expect(status.entry_count).toBe(64);
      expect(status.fingerprint).toBe("fp-1".slice(0, 12));
      expect(status.bytes).toBeGreaterThan(0);
      expect(typeof status.saved_at).toBe("string");

      await clearDurableGraphCache(context.pmPath);
      const firstView = await openDurableGraphCache(context.pmPath, "fp-1");
      const secondView = await openDurableGraphCache(context.pmPath, "fp-1");
      await Promise.all([
        persistDurableGraphResult(
          context.pmPath,
          "fp-1",
          firstView,
          "concurrent-a",
          { result: "a" },
        ),
        persistDurableGraphResult(
          context.pmPath,
          "fp-1",
          secondView,
          "concurrent-b",
          { result: "b" },
        ),
      ]);
      view = await openDurableGraphCache(context.pmPath, "fp-1");
      expect(view.results).toMatchObject({
        "concurrent-a": { result: "a" },
        "concurrent-b": { result: "b" },
      });

      const stale = await openDurableGraphCache(context.pmPath, "fp-2");
      expect(stale).toEqual({ exists: true, fresh: false, results: {} });

      await clearDurableGraphCache(context.pmPath);
      expect(await openDurableGraphCache(context.pmPath, "fp-1")).toEqual({
        exists: false,
        fresh: false,
        results: {},
      });
      // Clearing an absent envelope stays a no-op.
      await clearDurableGraphCache(context.pmPath);
    });
  });

  it("gates implicit persistence on item count or an existing envelope", () => {
    expect(shouldPersistDurableGraphCache(1, false)).toBe(false);
    expect(
      shouldPersistDurableGraphCache(GRAPH_DURABLE_CACHE_MIN_ITEMS, false),
    ).toBe(true);
    expect(shouldPersistDurableGraphCache(1, true)).toBe(true);
  });

  it("round-trips the audit baseline and ignores defective baselines", async () => {
    await withTempPmPath(async (context) => {
      expect(await loadGraphAuditBaseline(context.pmPath)).toBeUndefined();
      const snapshot = {
        saved_at: "2026-07-20T00:00:00.000Z",
        fingerprint: "fp",
        affected_subjects_by_code: { ordering_cycle: 1 },
        profile: {
          nodes: 1,
          edges: 0,
          edges_by_kind: {},
          active_nodes: 1,
          missing_nodes: 0,
          isolated_active_nodes: 1,
          degree_leq_one_active_nodes: 1,
          coverage_by_type: {},
        },
      };
      await saveGraphAuditBaseline(context.pmPath, snapshot);
      expect(await loadGraphAuditBaseline(context.pmPath)).toEqual(snapshot);
      for (const corrupt of [
        "{oops",
        JSON.stringify({ saved_at: 1 }),
        JSON.stringify({
          saved_at: "2026-07-20T00:00:00.000Z",
          fingerprint: "fp",
          affected_subjects_by_code: null,
          profile: {},
        }),
        JSON.stringify({
          saved_at: "2026-07-20T00:00:00.000Z",
          fingerprint: "fp",
          affected_subjects_by_code: {},
          profile: null,
        }),
        JSON.stringify({
          ...snapshot,
          affected_subjects_by_code: 7,
        }),
        JSON.stringify({
          ...snapshot,
          affected_subjects_by_code: [1],
        }),
        JSON.stringify({
          ...snapshot,
          affected_subjects_by_code: { ordering_cycle: "invalid" },
        }),
        JSON.stringify({
          ...snapshot,
          affected_subjects_by_code: { ordering_cycle: -1 },
        }),
        JSON.stringify({
          ...snapshot,
          profile: { ...snapshot.profile, nodes: "invalid" },
        }),
        JSON.stringify({
          ...snapshot,
          profile: { ...snapshot.profile, nodes: -1 },
        }),
        JSON.stringify({
          ...snapshot,
          profile: { ...snapshot.profile, edges_by_kind: null },
        }),
        JSON.stringify({
          ...snapshot,
          profile: {
            ...snapshot.profile,
            edges_by_kind: { related: "invalid" },
          },
        }),
        JSON.stringify({
          ...snapshot,
          profile: { ...snapshot.profile, edges_by_kind: { related: -1 } },
        }),
        JSON.stringify({
          ...snapshot,
          profile: { ...snapshot.profile, coverage_by_type: null },
        }),
        JSON.stringify({
          ...snapshot,
          profile: { ...snapshot.profile, coverage_by_type: [1] },
        }),
        JSON.stringify({
          ...snapshot,
          profile: {
            ...snapshot.profile,
            coverage_by_type: { Task: [1] },
          },
        }),
        JSON.stringify({
          ...snapshot,
          profile: {
            ...snapshot.profile,
            coverage_by_type: {
              Task: { active: 1, isolated: -1, degree_leq_one: 1 },
            },
          },
        }),
        JSON.stringify({
          ...snapshot,
          profile: {
            ...snapshot.profile,
            coverage_by_type: {
              Task: { active: 1, isolated: 0, degree_leq_one: "invalid" },
            },
          },
        }),
        JSON.stringify(null),
      ]) {
        await writeFile(
          graphAuditBaselinePath(context.pmPath),
          corrupt,
          "utf8",
        );
        expect(await loadGraphAuditBaseline(context.pmPath)).toBeUndefined();
      }
    });
  });
});

describe("pm graph index and durable envelopes", () => {
  it("keeps query execution successful when best-effort persistence fails", async () => {
    await withTempPmPath(async (context) => {
      const root = createItem(context, "Persistence failure root");
      await runGraph(
        "index",
        undefined,
        undefined,
        { rebuild: true },
        { path: context.pmPath },
      );
      resetWorkspaceGraphCache();
      const write = vi
        .spyOn(fsUtils, "writeFileAtomic")
        .mockRejectedValueOnce(new Error("cache is read-only"));
      try {
        const result = await runGraph(
          "descendants",
          root,
          undefined,
          {},
          { path: context.pmPath },
        );
        expect(result).toMatchObject({ subcommand: "descendants", count: 0 });
      } finally {
        write.mockRestore();
      }
    });
  });

  it("reports absent status and keeps small workspaces off the durable path", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Solo item");
      const status = (await runGraph(
        "index",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphIndexResult;
      expect(status).toMatchObject({
        subcommand: "index",
        action: "status",
        state: "absent",
        entry_count: 0,
        item_count: 1,
        min_items_threshold: GRAPH_DURABLE_CACHE_MIN_ITEMS,
        persist_enabled: false,
      });
      expect(status.saved_at).toBeUndefined();

      const analyze = (await runGraph(
        "analyze",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(analyze.cache?.durable).toBe("off");
      expect(
        (await durableGraphCacheStatus(context.pmPath, "any")).exists,
      ).toBe(false);
    });
  });

  it("rebuild warms the census queries and answers later invocations durably", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Indexed item");
      const rebuilt = (await runGraph(
        "index",
        undefined,
        undefined,
        {
          rebuild: true,
          direction: "outgoing",
          maxDepth: 1,
          sample: 1,
          exemptIsolate: "ignored",
          exemptIsolateType: "task",
        },
        { path: context.pmPath },
      )) as GraphIndexResult;
      expect(rebuilt).toMatchObject({
        action: "rebuilt",
        state: "fresh",
        entry_count: 2,
        persist_enabled: true,
      });
      expect(rebuilt.saved_at).toBeDefined();
      expect(rebuilt.bytes).toBeGreaterThan(0);

      // Drop the in-process memo so only the durable envelope can answer.
      resetWorkspaceGraphCache();
      const warmed = (await runGraph(
        "analyze",
        undefined,
        undefined,
        { summary: true },
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(warmed.cache?.durable).toBe("hit");
      expect(warmed.cache?.result).toBe("miss");
      expect(warmed.node_count).toBe(1);
      const warmedAudit = (await runGraph(
        "audit",
        undefined,
        undefined,
        { summary: true },
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(warmedAudit.cache?.durable).toBe("hit");

      // A novel query misses the envelope but persists because it now exists.
      const fresh = (await runGraph(
        "analyze",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAnalyzeResult;
      expect(fresh.cache?.durable).toBe("miss");
      const envelope = JSON.parse(
        await readFile(durableGraphCachePath(context.pmPath), "utf8"),
      ) as { results: Record<string, unknown> };
      expect(Object.keys(envelope.results)).toHaveLength(3);

      // Mutating the workspace makes the stored envelope stale.
      createItem(context, "Second item");
      const stale = (await runGraph(
        "index",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphIndexResult;
      expect(stale.state).toBe("stale");

      const cleared = (await runGraph(
        "index",
        undefined,
        undefined,
        { clear: true },
        { path: context.pmPath },
      )) as GraphIndexResult;
      expect(cleared).toMatchObject({ action: "cleared", state: "absent" });
    });
  });

  it("rejects maintenance and baseline flags outside their subcommand", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Scope item");
      for (const options of [{ rebuild: true }, { clear: true }]) {
        await expect(
          runGraph("analyze", undefined, undefined, options, {
            path: context.pmPath,
          }),
        ).rejects.toMatchObject<Partial<PmCliError>>({
          exitCode: EXIT_CODE.USAGE,
        });
      }
      await expect(
        runGraph(
          "index",
          undefined,
          undefined,
          { saveBaseline: true },
          {
            path: context.pmPath,
          },
        ),
      ).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runGraph(
          "index",
          undefined,
          undefined,
          { rebuild: true, clear: true },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("saves the audit baseline and reports signed census drift afterwards", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Baseline item");
      const first = (await runGraph(
        "audit",
        undefined,
        undefined,
        { saveBaseline: true },
        { path: context.pmPath },
      )) as GraphAuditResult;
      // No baseline existed before this invocation, so no delta is reported.
      expect(first.baseline).toBeUndefined();
      expect(await loadGraphAuditBaseline(context.pmPath)).toBeDefined();

      const unchanged = (await runGraph(
        "audit",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(unchanged.baseline).toMatchObject({
        same_snapshot: true,
        affected_subjects_by_code: {},
      });

      createItem(context, "Drift item");
      const drifted = (await runGraph(
        "audit",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(drifted.baseline).toMatchObject({ same_snapshot: false });
      expect(drifted.baseline?.profile.nodes).toBe(1);
      expect(drifted.baseline?.profile.active_nodes).toBe(1);
      expect(
        drifted.baseline?.affected_subjects_by_code.isolated_active_node,
      ).toBe(1);
    });
  });

  it("honors type-scoped isolate exemptions through the runner", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, "Isolated task");
      const strict = (await runGraph(
        "audit",
        undefined,
        undefined,
        {},
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(strict.findings_by_code.isolated_active_node).toBe(1);
      expect(strict.profile.coverage_by_type).toMatchObject({
        Task: { active: 1, isolated: 1, degree_leq_one: 1 },
      });
      const exempt = (await runGraph(
        "audit",
        undefined,
        undefined,
        { exemptIsolateType: "task" },
        { path: context.pmPath },
      )) as GraphAuditResult;
      expect(exempt.findings_by_code.isolated_active_node).toBeUndefined();
    });
  });
});
