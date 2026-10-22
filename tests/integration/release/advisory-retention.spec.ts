import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  "continue-on-error"?: boolean;
}

describe.each([
  ["auto-release", "auto-release", "Run auto release pipeline"],
  ["release", "release", "Static quality gate"],
])("%s advisory evidence", (workflow, job, gateName) => {
  it("retains one public receipt on success and refusal without softening the gate", async () => {
    const document = parse(await readFile(new URL(`../../../.github/workflows/${workflow}.yml`, import.meta.url), "utf8")) as {
      jobs: Record<string, { steps: WorkflowStep[] }>;
    };
    const steps = document.jobs[job].steps;
    const gateIndex = steps.findIndex((step) => step.name === gateName);
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    const uploads = steps.filter((step) => step.with?.path === ".cache/dependency-security/receipt.json");
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    expect(steps.indexOf(upload)).toBe(gateIndex + 1);
    expect(upload.if).toBe("always()");
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/u);
    expect(upload.with).toEqual({
      name: "dependency-advisory-${{ github.run_id }}-${{ github.run_attempt }}",
      path: ".cache/dependency-security/receipt.json",
      "include-hidden-files": true,
      "if-no-files-found": "warn",
      "retention-days": 7,
    });
    expect(steps[gateIndex]["continue-on-error"]).not.toBe(true);
    expect(steps[gateIndex].run).toBeTruthy();
  });
});
