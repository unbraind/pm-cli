import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWithHarnessDetectionSignals } from "../../src/core/shared/author.js";
import { runCreate } from "../../src/sdk/lifecycle/create.js";
import { runHealth } from "../../src/sdk/governance/health.js";
import { scanProvenanceResolverHealth } from "../../src/sdk/governance/provenance-health.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("immutable resolver recovery evidence", () => {
  it("clears a failed probe only after a real probe succeeds, preserving earlier history", async () => {
    await withTempPmPath(async ({ tempRoot, pmPath }) => {
      delete process.env.PM_AUTHOR;
      const sessions = path.join(tempRoot, ".codex", "sessions");
      await mkdir(sessions, { recursive: true });
      const sessionPath = path.join(sessions, "rollout-health-recovery.jsonl");
      await writeFile(sessionPath, "{}\n");
      const signals = {
        env: { CODEX_THREAD_ID: "health-recovery" },
        home_dir: tempRoot,
        cwd: tempRoot,
        argv: [],
        probes_enabled: true,
      };
      await runWithHarnessDetectionSignals(
        { ...signals, probes_enabled: false },
        () => runCreate({ title: "Unavailable probe", type: "Task" }, { path: pmPath }),
      );
      expect(await scanProvenanceResolverHealth(pmPath)).toMatchObject({
        outcomes: [],
        warnings: [],
        sample: { complete: true, events_read: 1 },
      });
      const failed = await runWithHarnessDetectionSignals(signals, () =>
        runCreate({ title: "Failed probe", type: "Task" }, { path: pmPath }),
      );
      const failedPath = path.join(
        pmPath,
        "history",
        `${failed.item.id}.jsonl`,
      );
      const originalHistory = await readFile(failedPath, "utf8");
      const failedScan = await scanProvenanceResolverHealth(pmPath);
      expect(failedScan.warnings).toContain(
        "provenance_resolver_zero_success:codex:model:codex_session_file:1",
      );

      await runWithHarnessDetectionSignals(
        {
          ...signals,
          env: { ...signals.env, CODEX_MODEL: "environment-model" },
        },
        () =>
          runCreate(
            { title: "Environment override", type: "Task" },
            { path: pmPath },
          ),
      );
      expect(
        (await scanProvenanceResolverHealth(pmPath)).outcomes,
      ).toContainEqual({
        harness: "codex",
        dimension: "model",
        resolver: "codex_session_file",
        attempts: 1,
        successes: 0,
      });

      await writeFile(
        path.join(sessions, "rollout-health-recovered.jsonl"),
        `${JSON.stringify({
          type: "turn_context",
          payload: { model: "recovered-model", effort: "high" },
        })}\n`,
      );
      const recovered = await runWithHarnessDetectionSignals(
        { ...signals, env: { CODEX_THREAD_ID: "health-recovered" } },
        () =>
          runCreate(
            { title: "Recovered probe", type: "Task" },
            { path: pmPath },
          ),
      );
      const health = await runHealth(
        { path: pmPath, noExtensions: true },
        { skipDrift: true, skipVectors: true },
      );
      expect(
        health.warnings.some((warning) =>
          warning.startsWith("provenance_resolver_zero_success:codex:model:"),
        ),
      ).toBe(false);
      expect(
        health.checks.find((check) => check.name === "storage")?.details,
      ).toMatchObject({
        provenance_resolver_outcomes: expect.arrayContaining([
          {
            harness: "codex",
            dimension: "model",
            resolver: "codex_session_file",
            attempts: 2,
            successes: 1,
          },
        ]),
        provenance_sample: { scope: "history_prefix", complete: true },
      });
      const history = await readFile(
        path.join(pmPath, "history", `${recovered.item.id}.jsonl`),
        "utf8",
      );
      expect(history).toContain('"status":"resolved"');
      expect(history).not.toContain(sessionPath);
      expect(await readFile(failedPath, "utf8")).toBe(originalHistory);
    });
  });
});
