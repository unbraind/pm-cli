import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import {
  _testOnlyImprovementLedger,
  readImprovementLedger,
  recordImprovementObservation,
} from "../../../src/sdk/improvement-ledger.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const execFileAsync = promisify(execFile);

describe("audited improvement ledger", () => {
  it("appends immutable observations, preserves retry identity, and derives trends", async () => {
    await withTempPmPath(async (context) => {
      const baseline = await recordImprovementObservation(
        {
          metric: "Quality.Coverage.Lines",
          value: 98,
          direction: "higher",
          unit: "percent",
          threshold: 100,
          source: "coverage-gate",
          itemId: "pm-owner",
          revision: "revision-a",
          observedAt: "2026-08-05T10:00:00.000Z",
          author: "measurement-agent",
          message: "Record coverage baseline",
        },
        { path: context.pmPath },
      );
      expect(baseline).toMatchObject({
        changed: true,
        observation: {
          metric: "quality.coverage.lines",
          revision_source: "caller",
          idempotency_key:
            "revision-a:quality.coverage.lines:coverage-gate:pm-owner",
        },
      });
      await expect(
        recordImprovementObservation(
          {
            metric: "quality.coverage.lines",
            value: 98,
            direction: "higher",
            unit: "percent",
            threshold: 100,
            source: "coverage-gate",
            itemId: "pm-owner",
            revision: "revision-a",
            observedAt: "2026-08-06T10:00:00.000Z",
          },
          { path: context.pmPath },
        ),
      ).resolves.toMatchObject({
        changed: false,
        observation: { id: baseline.observation.id },
      });

      await recordImprovementObservation(
        {
          metric: "quality.coverage.lines",
          value: 100,
          direction: "higher",
          unit: "percent",
          threshold: 100,
          source: "coverage-gate",
          itemId: "pm-owner",
          revision: "revision-b",
          observedAt: "2026-08-06T10:00:00.000Z",
        },
        { path: context.pmPath },
      );
      const ledger = await readImprovementLedger({
        pmRoot: context.pmPath,
        metric: "quality.coverage.lines",
        itemId: "pm-owner",
        since: "2026-08-05T00:00:00.000Z",
        limit: 1,
      });
      expect(ledger).toMatchObject({
        total: 2,
        truncated: true,
        source: "audited_workspace_singleton",
        trends: [{ delta: 2, improved: true, sample_count: 2 }],
      });
      expect(ledger.observations).toHaveLength(1);
      const workspaceHistory = await readFile(
        path.join(context.pmPath, "history", "_workspace.jsonl"),
        "utf8",
      );
      expect(workspaceHistory).toContain('"op":"improvement_observe"');
    });
  });

  it("enforces metric contracts, target thresholds, finite values, and bounds", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      await expect(
        recordImprovementObservation(
          { metric: "Bad Metric", value: 1, revision: "a" },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        recordImprovementObservation(
          { metric: "valid", value: Number.NaN, revision: "a" },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        recordImprovementObservation(
          { metric: "valid", value: 1, direction: "target", revision: "a" },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        recordImprovementObservation(
          {
            metric: "valid",
            value: 1,
            direction: "sideways" as "higher",
            revision: "a",
          },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });

      await recordImprovementObservation(
        {
          metric: "latency",
          value: 20,
          direction: "lower",
          unit: "ms",
          revision: "a",
        },
        global,
      );
      await expect(
        recordImprovementObservation(
          {
            metric: "latency",
            value: 21,
            direction: "higher",
            unit: "ms",
            revision: "b",
          },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.CONFLICT });
      await expect(
        recordImprovementObservation(
          { metric: "latency", value: 21, unit: "ms", revision: "a" },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.CONFLICT });
      await expect(
        readImprovementLedger({ pmRoot: context.pmPath, limit: 1001 }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
      await expect(
        readImprovementLedger({ pmRoot: context.pmPath, since: "not-a-date" }),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("reports target convergence and rejects corrupt singleton state", async () => {
    await withTempPmPath(async (context) => {
      for (const [revision, value, observedAt] of [
        ["a", 15, "2026-08-05T10:00:00.000Z"],
        ["b", 11, "2026-08-06T10:00:00.000Z"],
      ] as const) {
        await recordImprovementObservation(
          {
            metric: "target.metric",
            value,
            direction: "target",
            threshold: 10,
            revision,
            observedAt,
          },
          { path: context.pmPath },
        );
      }
      await expect(
        readImprovementLedger({ pmRoot: context.pmPath }),
      ).resolves.toMatchObject({ trends: [{ improved: true, delta: -4 }] });

      await writeFile(
        path.join(context.pmPath, "improvement-ledger.json"),
        "{broken",
        "utf8",
      );
      await expect(
        readImprovementLedger({ pmRoot: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
      expect(() => _testOnlyImprovementLedger.parseLedger("{}")).toThrow(
        PmCliError,
      );
    });
  });

  it("resolves git and unversioned revisions and preserves content-id retries", async () => {
    await withTempPmPath(async (context) => {
      const options = {
        metric: "unversioned.metric",
        value: 2,
        observedAt: "2026-08-06T10:00:00.000Z",
      };
      const unversioned = await recordImprovementObservation(options, {
        path: context.pmPath,
      });
      expect(unversioned.observation).toMatchObject({
        revision: "unversioned",
        revision_source: "unversioned",
      });
      expect(unversioned.observation).not.toHaveProperty("idempotency_key");
      await expect(
        recordImprovementObservation(options, { path: context.pmPath }),
      ).resolves.toMatchObject({ changed: false });

      await execFileAsync("git", ["init"], { cwd: context.tempRoot });
      await execFileAsync(
        "git",
        ["config", "user.email", "tests@example.invalid"],
        { cwd: context.tempRoot },
      );
      await execFileAsync("git", ["config", "user.name", "pm tests"], {
        cwd: context.tempRoot,
      });
      await writeFile(
        path.join(context.tempRoot, "seed.txt"),
        "seed\n",
        "utf8",
      );
      await execFileAsync("git", ["add", "seed.txt"], {
        cwd: context.tempRoot,
      });
      await execFileAsync("git", ["commit", "-m", "seed"], {
        cwd: context.tempRoot,
      });
      const gitBacked = await recordImprovementObservation(
        { metric: "git.metric", value: 1 },
        { path: context.pmPath },
      );
      expect(gitBacked.observation).toMatchObject({
        revision_source: "git",
        revision: expect.stringMatching(/^[0-9a-f]{40}$/u),
      });
    });
  });

  it("covers lower trends, sorting, optional values, and conflicts", async () => {
    await withTempPmPath(async (context) => {
      const global = { path: context.pmPath };
      for (const observation of [
        { metric: "z.metric", value: 5, revision: "z-a" },
        { metric: "a.metric", value: 5, revision: "a-a" },
        { metric: "z.metric", value: 4, revision: "z-b" },
      ]) {
        await recordImprovementObservation(
          {
            ...observation,
            observedAt: "2026-08-06T10:00:00.000Z",
            unit: "  ",
            source: "  ",
            itemId: "  ",
            idempotencyKey: "  ",
          },
          global,
        );
      }
      const result = await readImprovementLedger({
        pmRoot: context.pmPath,
        limit: 0,
      });
      expect(result.observations).toEqual([]);
      expect(result.trends.map((row) => row.metric)).toEqual([
        "a.metric",
        "z.metric",
      ]);
      expect(result.trends[1]).toMatchObject({ improved: true, delta: -1 });

      await expect(
        recordImprovementObservation(
          {
            metric: "z.metric",
            value: 99,
            revision: "different",
            idempotencyKey: "z-a:z.metric:manual:workspace",
          },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.CONFLICT });
      await expect(
        recordImprovementObservation(
          {
            metric: "z.metric",
            value: 3,
            unit: "count",
            revision: "z-c",
          },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.CONFLICT });
      await expect(
        recordImprovementObservation(
          {
            metric: "a.metric",
            value: 3,
            source: "x".repeat(257),
            revision: "a-b",
          },
          global,
        ),
      ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("rejects corrupt observations and missing trackers", async () => {
    const valid = {
      id: "id",
      metric: "metric",
      value: 1,
      direction: "lower",
      observed_at: "2026-08-06T10:00:00.000Z",
      revision: "revision",
      revision_source: "caller",
      author: "agent",
    };
    const invalidObservations: unknown[] = [
      null,
      [],
      { ...valid, id: 1 },
      { ...valid, metric: 1 },
      { ...valid, value: "1" },
      { ...valid, value: Number.NaN },
      { ...valid, direction: "sideways" },
      { ...valid, observed_at: 1 },
      { ...valid, revision: 1 },
      { ...valid, author: 1 },
      { ...valid, direction: "target" },
      { ...valid, direction: "target", threshold: Number.NaN },
    ];
    for (const observation of invalidObservations) {
      expect(() =>
        _testOnlyImprovementLedger.parseLedger(
          JSON.stringify({ format_version: 1, observations: [observation] }),
        ),
      ).toThrow(PmCliError);
    }
    for (const document of [
      "null",
      "[]",
      '{"format_version":2,"observations":[]}',
      '{"format_version":1}',
    ]) {
      expect(() => _testOnlyImprovementLedger.parseLedger(document)).toThrow(
        PmCliError,
      );
    }
    await expect(
      recordImprovementObservation(
        { metric: "metric", value: 1 },
        { path: "/missing/tracker" },
      ),
    ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.NOT_FOUND });
    await expect(
      readImprovementLedger({ pmRoot: "/missing/tracker" }),
    ).rejects.toMatchObject<PmCliError>({ exitCode: EXIT_CODE.NOT_FOUND });
  });
});
