import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    expect(controls.WORKSPACE_COMPATIBILITY).toBeTypeOf("string");
    const controlRoot = path.resolve(path.dirname(controls.WORKSPACE_COMPATIBILITY), "../..");
    for (const file of ["scripts/release/workspace-compatibility.mjs", "scripts/release/workspace-linked-tests.mjs", "scripts/release/workspace-compatibility-policy.json", "scripts/release/utils.mjs", "tests/fixtures/compatibility/custom-fields/index.mjs", "tests/fixtures/compatibility/sdk-reader.mjs"]) {
      expect(await readFile(path.join(controlRoot, file), "utf8")).toBe(await readFile(file, "utf8"));
    }
    const gate = controls.PACKAGE_ARTIFACT_GATE;
    expect(await readFile(gate, "utf8")).toBe(await readFile("scripts/release/package-artifact-gate.mjs", "utf8"));
    const budget = JSON.parse(await readFile(path.join(path.dirname(gate), "package-artifact-budget.json"), "utf8")) as { required_paths: string[]; max_unpacked_bytes_by_profile: { base: number } };
    const workspace = path.join(root, "foreign source with spaces");
    await mkdir(workspace);
    const manifest = { name: "release-control-fixture", version: "1.0.0", files: budget.required_paths };
    for (const file of budget.required_paths) {
      await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
      await writeFile(path.join(workspace, file), file.endsWith(".json") ? JSON.stringify({ fixture: "reviewed control" }) : "reviewed control fixture\n");
    }
    await writeFile(path.join(workspace, "package.json"), JSON.stringify(manifest));
    await writeFile(path.join(workspace, "runtime-dependencies.json"), JSON.stringify({ packages: { "": manifest } }));
    const result = spawnSync(process.execPath, [gate], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, package: manifest.name, version: manifest.version, max_unpacked_size: budget.max_unpacked_bytes_by_profile.base });
    if (process.platform !== "win32") {
      const alias = path.join(root, "reviewed controls alias");
      await symlink(controlRoot, alias);
      for (const entry of [controls.WORKSPACE_COMPATIBILITY, path.join(alias, "scripts/release/workspace-compatibility.mjs")]) {
        const compatibility = spawnSync(process.execPath, [entry], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
        expect(compatibility.status, compatibility.stderr).toBe(1);
        expect(compatibility.stderr).toContain("Expected a stable calendar version");
        expect(compatibility.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      }
    }
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
  "timeout-minutes"?: number;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  strategy?: {
    "fail-fast": boolean;
    matrix: { os: string[]; install: string[] };
  };
  steps: Array<{ name: string; id?: string; run?: string; "timeout-minutes"?: number; with?: Record<string, unknown> }>;
}

it("blocks advertisement until every registry platform and manager accepted candidate and previous release", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release.yml", "utf8"),
  ) as { jobs: Record<string, Job> };
  const acceptance = workflow.jobs["installed-acceptance"];
  expect(acceptance.needs).toBe("publication");
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
    "publication",
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
    workflow.jobs.publication.steps.find(
      (step) => step.name === "Select previous public release control",
    )?.run,
  ).toContain('node "${RELEASE_CONTROL}"');
});

it("verifies the publication in its own job whose budget covers the full npm metadata wait (pm-0jzl5t)", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release.yml", "utf8"),
  ) as { jobs: Record<string, Job> };
  const verifier = await readFile("scripts/release/verify-published-release.mjs", "utf8");
  const attempts = Number(/const DEFAULT_NPM_ATTEMPTS = (\d+);/u.exec(verifier)?.[1]);
  const pollMs = Number(/const NPM_METADATA_POLL_MS = ([\d_]+);/u.exec(verifier)?.[1]?.replaceAll("_", ""));
  const publication = workflow.jobs.publication;
  expect(publication.needs).toBe("release");
  const moved = [
    "Verify published package on npm, npx, and bunx",
    "Accept exact installed package through npm and Bun agent sessions",
    "Select previous public release control",
  ];
  for (const name of moved) {
    expect(publication.steps.some((step) => step.name === name)).toBe(true);
    expect(workflow.jobs.release.steps.some((step) => step.name === name)).toBe(false);
  }
  const verify = publication.steps.find((step) => step.name === moved[0])!;
  const waitMinutes = (attempts * pollMs) / 60_000;
  expect(waitMinutes).toBeGreaterThanOrEqual(30);
  // The verifier still has to run npx/bunx journeys after the registry wait.
  expect(verify["timeout-minutes"]).toBeGreaterThanOrEqual(waitMinutes + 5);
  const stepBudget = publication.steps.reduce((total, step) => total + (step["timeout-minutes"] ?? 0), 0);
  expect(publication["timeout-minutes"]).toBeGreaterThanOrEqual(stepBudget + 3);
});

it("verifies the exact source the release job published, with the reviewed release control (Codex review of PR #1687)", async () => {
  const workflow = parse(
    await readFile(".github/workflows/release.yml", "utf8"),
  ) as { jobs: Record<string, Job> };
  const release = workflow.jobs.release;
  const names = release.steps.map((step) => step.name);
  const record = release.steps.find((step) => step.name === "Record published source");
  expect(record?.id).toBe("published-source");
  expect(record?.run).toContain("git rev-parse --verify 'HEAD^{commit}'");
  // Recorded after exact-tag source selection and immediately before publication.
  expect(names.indexOf("Select exact-tag recovery source")).toBeLessThan(names.indexOf("Record published source"));
  expect(names.indexOf("Record published source") + 1).toBe(names.indexOf("Publish to npm"));
  expect(release.outputs?.source_sha).toBe("${{ steps.published-source.outputs.sha }}");

  const publication = workflow.jobs.publication;
  const [source, control] = publication.steps;
  expect(source).toMatchObject({ name: "Checkout published source", with: { ref: "${{ needs.release.outputs.source_sha }}" } });
  expect(source?.with?.path).toBeUndefined();
  expect(control).toMatchObject({
    name: "Checkout reviewed release control",
    with: {
      ref: "${{ github.event_name == 'workflow_dispatch' && github.sha || github.ref }}",
      path: ".reviewed-release-control",
      "sparse-checkout": "scripts/release/release-control.mjs",
    },
  });
  expect(publication.env?.RELEASE_CONTROL).toBe(".reviewed-release-control/scripts/release/release-control.mjs");
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
