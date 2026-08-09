/**
 * @module governance read performance tests
 *
 * Enforces a real isolated-corpus latency ceiling for the field-driven health
 * and validate readers without mocking storage, parsing, or governance work.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateSyntheticWorkspace } from "../../../scripts/bench/scale-workspace.mjs";
import { runHealth } from "../../../src/sdk/governance/health.js";
import { runValidate } from "../../../src/sdk/governance/validate.js";

describe("governance read performance", () => {
  it("keeps body-free health and validate reads below the fixture ceiling", async () => {
    const workspaceRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-governance-read-performance-"),
    );
    try {
      const fixture = await generateSyntheticWorkspace({
        workspaceRoot,
        itemCount: 1_000,
        seed: 42,
        shape: "scratch",
        mode: "direct",
        force: true,
      });
      const healthSamples: number[] = [];
      const validateSamples: number[] = [];
      for (let iteration = 0; iteration < 2; iteration += 1) {
        let startedAt = performance.now();
        await runHealth(
          { path: fixture.pm_root },
          { skipDrift: true, skipIntegrity: true, skipVectors: true },
        );
        healthSamples.push(performance.now() - startedAt);

        startedAt = performance.now();
        await runValidate({ counts: true }, { path: fixture.pm_root });
        validateSamples.push(performance.now() - startedAt);
      }

      // The complete coverage suite runs hundreds of files concurrently, so
      // keep a bounded ceiling that includes scheduler contention while the
      // minimum of two samples excludes one-time cache warmup.
      expect(Math.min(...healthSamples)).toBeLessThan(5_000);
      expect(Math.min(...validateSamples)).toBeLessThan(5_000);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
