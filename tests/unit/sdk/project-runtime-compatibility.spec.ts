import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProjectRuntimeCompatibility,
  comparePmDateVersions,
  discoverProjectRuntimeVersionPins,
  inspectProjectRuntimeCompatibility,
  isProjectMutatingInvocation,
} from "../../../src/sdk/environment/project-runtime-compatibility.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pm-runtime-compat-"));
  roots.push(root);
  return root;
}

describe("project runtime compatibility", () => {
  it("compares date versions and rejects unsupported spellings", () => {
    expect(comparePmDateVersions("2026.8.7", "2026.8.8")).toBe(-1);
    expect(comparePmDateVersions("2026.8.8-2", "2026.8.8-1")).toBe(1);
    expect(comparePmDateVersions("2026.8.8", "2026.8.8")).toBe(0);
    expect(comparePmDateVersions("latest", "2026.8.8")).toBeNull();
  });

  it.each([
    [["create", "Task", "x"], true],
    [["close-task", "pm-a"], true],
    [["dedupe-merge", "pm-a"], true],
    [["create", "--help"], false],
    [["comments", "pm-a"], false],
    [["comments", "pm-a", "--add", "x"], true],
    [["comments", "pm-a", "--add=x"], true],
    [["learnings", "pm-a", "--add", "x"], true],
    [["notes", "pm-a"], false],
    [["files", "pm-a", "--list"], false],
    [["files", "discover", "pm-a", "--apply"], true],
    [["files", "discover", "pm-a", "--apply=true"], true],
    [["docs", "pm-a", "--add-glob", "docs/**"], true],
    [["deps", "pm-a"], false],
    [["events", "--follow"], false],
    [["duplicates"], false],
    [["config", "project", "get", "telemetry"], false],
    [["config", "global", "get", "telemetry"], false],
    [["config", "get", "telemetry"], false],
    [["config", "project", "set", "telemetry", "true"], true],
    [["merge", "report"], false],
    [["merge", "install"], true],
    [["schema", "list"], false],
    [["schema"], false],
    [["schema", "add-type", "Bug", "--infer"], false],
    [["schema", "add-type", "Bug", "--infer=true"], false],
    [["schema", "add-type", "Bug"], true],
    [["profile", "lint", "agile"], false],
    [["profile", "apply", "agile"], true],
    [["package", "explore"], false],
    [["package", "install", "pm-example"], true],
    [["extension", "doctor"], false],
    [["extension", "--reload"], true],
    [["telemetry", "stats"], false],
    [["telemetry", "flush"], true],
    [["templates", "show", "default"], false],
    [["templates", "save", "default"], true],
    [["vcs", "show", "pm-change"], false],
    [["vcs"], false],
    [["vcs", "create", "change"], true],
    [["workspace", "snapshot", "inspect", "baseline"], false],
    [["workspace", "snapshot"], false],
    [["workspace", "snapshot", "restore", "baseline"], true],
    [["changelog", "export"], false],
    [["changelog", "export", "notes.md"], true],
    [["changelog", "generate", "--check"], false],
    [["changelog", "generate"], true],
    [["test", "pm-a", "--metric-below", "duration=10"], false],
    [["test", "pm-a", "--measure", "duration=10"], true],
    [["health", "--check-only"], false],
    [["health"], true],
    [["validate", "--check-resolution"], false],
    [["validate", "--auto-fix", "--fix-scope", "metadata"], true],
    [["update-many", "--dry-run"], false],
    [["update-many", "--dry-run=true"], false],
    [["unknown-command"], false],
    [["--pm-path", "--odd-path", "create", "Task", "x"], true],
    [["--author", "merge", "merge", "report"], false],
  ] as const)("classifies %j mutation capability as %s", (argv, expected) => {
    expect(isProjectMutatingInvocation(argv)).toBe(expected);
  });

  it("discovers declared, installed, npm, pnpm, and yarn pins", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@unbrained/pm-cli": "^2026.8.8" },
        devDependencies: { "@unbrained/pm-cli": "2026.8.13" },
      }),
    );
    await mkdir(path.join(root, "node_modules", "@unbrained", "pm-cli"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "node_modules", "@unbrained", "pm-cli", "package.json"),
      JSON.stringify({ version: "2026.8.9" }),
    );
    await writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/@unbrained/pm-cli": { version: "2026.8.10" },
        },
      }),
    );
    await writeFile(
      path.join(root, "pnpm-lock.yaml"),
      "dependencies:\n  '@unbrained/pm-cli':\n    version: 2026.8.11\n  neighboring-package:\n    version: 2099.1.1\n",
    );
    await writeFile(
      path.join(root, "yarn.lock"),
      '"@unbrained/pm-cli@^2026.8.8":\n  version "2026.8.12"\nneighboring-package@^1:\n  version "2099.1.1"\n',
    );
    expect(discoverProjectRuntimeVersionPins(root)).toEqual([
      { version: "2026.8.13", source: "package.json" },
      { version: "2026.8.9", source: "installed-package" },
      { version: "2026.8.10", source: "package-lock.json" },
      { version: "2026.8.11", source: "pnpm-lock.yaml" },
      { version: "2026.8.12", source: "yarn.lock" },
    ]);
    expect(
      inspectProjectRuntimeCompatibility({
        executingVersion: "2026.8.7",
        projectRoot: root,
        argv: ["context"],
      }).project_version,
    ).toBe("2026.8.13");
    await writeFile(
      path.join(root, "yarn.lock"),
      '"@unbrained/pm-cli@2026.8.14":\n  checksum "sha512-example"\n',
    );
    expect(discoverProjectRuntimeVersionPins(root)).toContainEqual({
      version: "2026.8.14",
      source: "yarn.lock",
    });
  });

  it("ignores dependency upper bounds and exclusions as runtime floors", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@unbrained/pm-cli": "<2027.1.1" },
        devDependencies: { "@unbrained/pm-cli": "!=2028.1.1" },
      }),
    );
    expect(discoverProjectRuntimeVersionPins(root)).toEqual([]);
  });

  it("keeps reads available, refuses stale writes, and records an explicit override", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ devDependencies: { "@unbrained/pm-cli": "2026.8.9" } }),
    );
    expect(
      inspectProjectRuntimeCompatibility({
        executingVersion: "2026.8.7",
        projectRoot: root,
        argv: ["context"],
      }),
    ).toMatchObject({ compatible: true, mutating: false });
    expect(
      inspectProjectRuntimeCompatibility({
        executingVersion: "2026.8.7",
        projectRoot: root,
        argv: ["context"],
      }).project_version,
    ).toBe("2026.8.9");
    expect(() =>
      assertProjectRuntimeCompatibility({
        executingVersion: "2026.8.7",
        projectRoot: root,
        argv: ["create", "Task", "x"],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "project_runtime_stale_mutation",
        exitCode: 4,
      }),
    );
    expect(
      assertProjectRuntimeCompatibility({
        executingVersion: "2026.8.7",
        projectRoot: root,
        argv: ["create", "Task", "x"],
        allowStale: true,
      }),
    ).toMatchObject({
      compatible: true,
      override_applied: true,
      project_version: "2026.8.9",
    });
  });

  it("enforces the packaged CLI boundary with machine-readable recovery", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ devDependencies: { "@unbrained/pm-cli": "2026.8.9" } }),
    );
    const cliPath = path.resolve("dist/cli.js");
    const refused = spawnSync(
      process.execPath,
      [cliPath, "--json", "create", "Task", "stale runtime"],
      { cwd: root, encoding: "utf8" },
    );
    expect(refused.status).toBe(4);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      code: "project_runtime_stale_mutation",
      exit_code: 4,
    });

    const help = spawnSync(process.execPath, [cliPath, "create", "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Create a new project management item");
  });

  it("ignores unreadable and unrelated manifests", async () => {
    const root = await project();
    await writeFile(path.join(root, "package.json"), "not json");
    expect(discoverProjectRuntimeVersionPins(root)).toEqual([]);
    await writeFile(path.join(root, "package.json"), "42");
    await writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/@unbrained/pm-cli": {} } }),
    );
    expect(discoverProjectRuntimeVersionPins(root)).toEqual([]);
    await writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/@unbrained/pm-cli": null },
      }),
    );
    expect(discoverProjectRuntimeVersionPins(root)).toEqual([]);
    expect(
      inspectProjectRuntimeCompatibility({
        executingVersion: "2026.8.7",
        projectRoot: root,
        argv: ["create"],
      }),
    ).toMatchObject({ compatible: true });
  });
});
