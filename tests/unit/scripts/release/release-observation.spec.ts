/** Outcome receipts must preserve provenance without archiving secret-bearing gate output. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReleaseObservation, writeReleaseObservation } from "../../../../scripts/release/release-observation.mjs";

afterEach(() => vi.unstubAllEnvs());

describe("release observations", () => {
  it("distinguishes published, verified-existing, no-op and unavailable outcomes", () => {
    const env = { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "schedule" };
    expect(createReleaseObservation(env, null).outcome).toBe("unknown_success");
    expect(createReleaseObservation({ ...env, RELEASE_PUBLISHED_TAG: "v2026.9.24" }, null).outcome).toBe("published");
    expect(createReleaseObservation({ ...env, RELEASE_PUBLISHED_TAG: "v2026.9.24", RELEASE_EXISTING_TAG: "v2026.9.24" }, null).outcome).toBe("same_day_verified");
    const receipt = createReleaseObservation({ ...env, RELEASE_PIPELINE_REASON: "no_changes_since_last_tag" }, {
      schema: "release-failure-record/1", stage: "coverage-gate", stdout: "sensitive gate text",
    });
    expect(receipt).toEqual({ schema: "release-observation/1", run_id: 42, run_attempt: 1, event: "schedule", outcome: "no_changes_since_last_tag", failure_stage: "coverage-gate" });
    expect(createReleaseObservation(env, { schema: "foreign" }).failure_stage).toBeNull();
    for (const bad of [{ GITHUB_RUN_ID: "x" }, { GITHUB_RUN_ID: "0" }, { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_RUN_ATTEMPT: "x" }]) {
      expect(() => createReleaseObservation({ ...env, ...bad }, null)).toThrow("identities");
    }
  });

  it("writes a real receipt file using the workflow environment", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-observation-test-"));
    try {
      const failurePath = path.join(root, "failure.json");
      const output = path.join(root, "release-observation.json");
      writeFileSync(failurePath, JSON.stringify({ schema: "release-failure-record/1", stage: "sentry-telemetry-gate", stderr: "private" }));
      for (const [key, value] of Object.entries({ GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "schedule", RELEASE_FAILURE_RECORD: failurePath, RELEASE_OBSERVATION_PATH: output })) vi.stubEnv(key, value);
      const result = writeReleaseObservation();
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result);
      expect(result.run_attempt).toBe(2);
      expect(readFileSync(output, "utf8")).not.toContain("private");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
