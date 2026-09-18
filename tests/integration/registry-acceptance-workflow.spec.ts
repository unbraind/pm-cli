import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";

interface Job {
  needs?: string | string[];
  strategy?: {
    "fail-fast": boolean;
    matrix: { os: string[]; install: string[] };
  };
  steps: Array<{ name: string; run?: string }>;
}

it("blocks advertisement until every registry platform and manager accepted candidate and previous release", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release.yml", "utf8"),
  ) as { jobs: Record<string, Job> };
  const acceptance = workflow.jobs["installed-acceptance"];
  expect(acceptance.needs).toBe("release");
  expect(acceptance.strategy).toEqual({
    "fail-fast": false,
    matrix: {
      os: ["ubuntu-latest", "macos-latest", "windows-latest"],
      install: ["npm", "npm-global", "bun"],
    },
  });
  expect(
    acceptance.steps.find(
      (step) => step.name === "Accept candidate and previous release",
    )?.run,
  ).toContain('--previous-version "${CONTROL_VERSION}"');
  expect(workflow.jobs.advertise.needs).toEqual([
    "release",
    "installed-acceptance",
  ]);
  expect(
    workflow.jobs.release.steps.some(
      (step) => step.name === "Create GitHub release",
    ),
  ).toBe(false);
  expect(
    workflow.jobs.advertise.steps.some(
      (step) => step.name === "Create GitHub release",
    ),
  ).toBe(true);
  expect(
    workflow.jobs.release.steps.find(
      (step) => step.name === "Preserve reviewed package artifact controls",
    )?.run,
  ).toContain("cp scripts/release/release-control.mjs");
  expect(
    workflow.jobs.release.steps.find(
      (step) => step.name === "Select previous public release control",
    )?.run,
  ).toContain('node "${RELEASE_CONTROL}"');
});

it.each(["npm", "npm-global", "bun"])(
  "executes the registry workflow command for %s with strict native Bash",
  async (installMode) => {
    const workflow = parse(
      await readFile(".github/workflows/release.yml", "utf8"),
    ) as { jobs: Record<string, Job> };
    const command = workflow.jobs["installed-acceptance"].steps.find(
      (step) => step.name === "Accept candidate and previous release",
    )?.run;
    expect(command).toBeTypeOf("string");
    const root = await mkdtemp(path.join(tmpdir(), "pm-registry-shell-"));
    try {
      for (const exitCode of [0, 37]) {
        const result = spawnSync(
          process.platform === "darwin" ? "/bin/bash" : "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            `npm() { printf '%s\\n' "$@"; return "$PM_TEST_NPM_STATUS"; }\n${command}`,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              CANDIDATE_VERSION: "2026.9.18",
              CONTROL_VERSION: "2026.9.17",
              INSTALL_MODE: installMode,
              PM_TEST_NPM_STATUS: String(exitCode),
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(exitCode);
        const args = (
          await readFile(path.join(root, "acceptance.json"), "utf8")
        )
          .trim()
          .split("\n");
        expect(args.slice(0, 4)).toEqual([
          "run",
          "--silent",
          "release:verify-installed-agent",
          "--",
        ]);
        expect(args.slice(4, 10)).toEqual([
          "--version",
          "2026.9.18",
          "--previous-version",
          "2026.9.17",
          "--manager",
          installMode === "npm-global" ? "npm" : installMode,
        ]);
        expect(args.slice(10).sort()).toEqual(
          installMode === "npm-global" ? ["--global", "--json"] : ["--json"],
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
