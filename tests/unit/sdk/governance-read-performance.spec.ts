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
    const healthRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-health-performance-"),
    );
    const validateRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-validate-performance-"),
    );
    try {
      const healthFixture = await generateSyntheticWorkspace({
        workspaceRoot: healthRoot,
        itemCount: 1_000,
        seed: 42,
        shape: "scratch",
        mode: "direct",
        force: true,
      });
      const validateFixture = await generateSyntheticWorkspace({
        workspaceRoot: validateRoot,
        itemCount: 1_000,
        seed: 43,
        shape: "scratch",
        mode: "direct",
        force: true,
      });
      let startedAt = performance.now();
      await runHealth(
        { path: healthFixture.pm_root },
        { skipDrift: true, skipIntegrity: true, skipVectors: true },
      );
      const healthDuration = performance.now() - startedAt;
      startedAt = performance.now();
      await runValidate({ counts: true }, { path: validateFixture.pm_root });
      const validateDuration = performance.now() - startedAt;

      // Instrumented repository-wide coverage runs execute hundreds of files
      // concurrently. The ceiling therefore includes bounded scheduler and V8
      // coverage overhead while still measuring exactly one cold read.
      expect(healthDuration).toBeLessThan(10_000);
      expect(validateDuration).toBeLessThan(10_000);
    } finally {
      await Promise.all([
        rm(healthRoot, { recursive: true, force: true }),
        rm(validateRoot, { recursive: true, force: true }),
      ]);
    }
  }, 45_000);
});
