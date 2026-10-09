import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";

it("executes preserved reviewed artifact controls with their transitive imports from a foreign workspace", async () => {
  const workflow = parse(await readFile(".github/workflows/release.yml", "utf8")) as { jobs: Record<string, Job> };
  const preserve = workflow.jobs.release.steps.find((step) => step.name === "Preserve reviewed package artifact controls")?.run;
  expect(preserve).toBeTypeOf("string");
  const root = await mkdtemp(path.join(tmpdir(), "pm-release-control-closure-"));
  const githubEnv = path.join(root, "github-env");
  try {
    const copied = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      input: preserve, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: githubEnv },
    });
    expect(copied.status, copied.stderr).toBe(0);
    const controls = Object.fromEntries((await readFile(githubEnv, "utf8")).trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const gate = controls.PACKAGE_ARTIFACT_GATE;
    expect(await readFile(gate, "utf8")).toBe(await readFile("scripts/release/package-artifact-gate.mjs", "utf8"));
    const budget = JSON.parse(await readFile(path.join(path.dirname(gate), "package-artifact-budget.json"), "utf8")) as { required_paths: string[]; max_unpacked_bytes_by_profile: { base: number } };
    const workspace = path.join(root, "foreign source with spaces");
    await mkdir(workspace);
    const manifest = { name: "release-control-fixture", version: "1.0.0", files: budget.required_paths };
    for (const file of budget.required_paths) {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await writeFile(path.join(workspace, file), "reviewed control fixture\n");
    }
    await writeFile(path.join(workspace, "package.json"), JSON.stringify(manifest));
    await writeFile(path.join(workspace, "runtime-dependencies.json"), JSON.stringify({ packages: { "": manifest } }));
    const result = spawnSync(process.execPath, [gate], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, package: manifest.name, version: manifest.version, max_unpacked_size: budget.max_unpacked_bytes_by_profile.base });
    await rm(path.resolve(path.dirname(controls.PACKAGE_DISTRIBUTION), "../temp-lifecycle.mjs"));
    const missing = spawnSync(process.execPath, [gate], { cwd: workspace, encoding: "utf8", timeout: 10_000 });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(missing.stderr).toContain("temp-lifecycle.mjs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
