import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { expect, it } from "vitest";

interface Job {
  needs?: string | string[];
  strategy?: { "fail-fast": boolean; matrix: { os: string[]; install: string[] } };
  steps: Array<{ name: string; run?: string }>;
}

it("blocks advertisement until every registry platform and manager accepted candidate and previous release", async () => {
  const workflow = parse(await readFile(".github/workflows/release.yml", "utf8")) as { jobs: Record<string, Job> };
  const acceptance = workflow.jobs["installed-acceptance"];
  expect(acceptance.needs).toBe("release");
  expect(acceptance.strategy).toEqual({
    "fail-fast": false,
    matrix: { os: ["ubuntu-latest", "macos-latest", "windows-latest"], install: ["npm", "npm-global", "bun"] },
  });
  expect(acceptance.steps.find((step) => step.name === "Accept candidate and previous release")?.run).toContain('--previous-version "${CONTROL_VERSION}"');
  expect(workflow.jobs.advertise.needs).toEqual(["release", "installed-acceptance"]);
  expect(workflow.jobs.release.steps.some((step) => step.name === "Create GitHub release")).toBe(false);
  expect(workflow.jobs.advertise.steps.some((step) => step.name === "Create GitHub release")).toBe(true);
  expect(workflow.jobs.release.steps.find((step) => step.name === "Preserve reviewed package artifact controls")?.run).toContain('cp scripts/release/release-control.mjs');
  expect(workflow.jobs.release.steps.find((step) => step.name === "Select previous public release control")?.run).toContain('node "${RELEASE_CONTROL}"');
});
