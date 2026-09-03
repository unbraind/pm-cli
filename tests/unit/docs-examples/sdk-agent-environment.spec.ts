import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importExampleScript,
  resetExampleScriptHarness,
} from "./example-script-harness.js";

/**
 * Executable acceptance coverage for the public-SDK agent-environment example.
 */

afterEach(resetExampleScriptHarness);

const SCRIPT = "docs/examples/sdk-agent-environment/run-agent-environment.mjs";

describe("sdk-agent-environment example", () => {
  it(
    "runs an isolated ordinary-PmClient trajectory through the public SDK",
    { timeout: 60_000 },
    async () => {
      const outputSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      await importExampleScript(SCRIPT, "agentEnvironmentSuccess");

      expect(
        JSON.parse(String(outputSpy.mock.calls.at(-1)?.[0] ?? "")),
      ).toEqual({
        initial_status: "served",
        initial_tier: "standard",
        verdict: "satisfied",
        policy: "verdict_only_no_reward",
        trajectory: ["reset", "observation", "action", "verdict", "close"],
      });
    },
  );

  it("keeps the exemplar dependency-free and on supported imports", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const packageJson = JSON.parse(
      await readFile(
        "docs/examples/sdk-agent-environment/package.json",
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };

    expect(source).toContain('from "@unbrained/pm-cli/sdk"');
    expect(source).not.toMatch(/from ["'](?:\.\.\/)+src\//u);
    expect(packageJson.dependencies).toBeUndefined();
  });
});
