import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const TEMP_ROOTS: string[] = [];

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

async function importRepoModuleNoQuery<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(pathToFileURL(absolutePath).href)) as T;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_ROOTS.push(root);
  return root;
}

async function waitForCondition(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Condition did not pass before timeout.");
}

function mockProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${String(code ?? "")}`);
  }) as never);
}

function restoreProcessState(): void {
  process.argv = [...ORIGINAL_ARGV];

  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(async () => {
  restoreProcessState();
  process.exitCode = 0;
  globalThis.fetch = ORIGINAL_FETCH;
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:readline");
  vi.doUnmock("esbuild");
  vi.doUnmock("../../../scripts/smoke-cleanup.mjs");
  vi.doUnmock("../../../scripts/plugin-mcp-smoke-harness.mjs");
  vi.doUnmock("../../../scripts/release/utils.mjs");
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of TEMP_ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("lane-c scripts wave3: docs, static quality, release pipeline, compatibility", () => {
  async function seedDocsSkillsFixture(root: string): Promise<void> {
    const docsContent = [
      "# Docs",
      "",
      "Install the guide package first:",
      "",
      "`pm install guide-shell --project`",
      "",
      "Then route via `pm guide workflows`.",
      "",
      "[Docs index](docs/README.md)",
    ].join("\n");
    await writeFile(path.join(root, "README.md"), docsContent, "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "# Agents\n\nAgent links are local.\n", "utf8");
    await writeFile(path.join(root, "CONTRIBUTING.md"), "# Contributing\n\nNo broken links.\n", "utf8");

    const docs = {
      "docs/README.md": docsContent,
      "docs/COMMANDS.md": docsContent,
      "docs/AGENT_GUIDE.md": docsContent,
      "docs/SDK.md": "# SDK\n\nMinimal SDK guide.\n",
      "docs/QUICKSTART.md": "# Quickstart\n\nMinimal quickstart.\n",
      "docs/RELEASING.md": "# Releasing\n\nMinimal releasing guide.\n",
      "docs/EXTENSIONS.md": [
        "# Extensions",
        "",
        "## Install",
        "Use `pm install guide-shell --project` and route via `pm guide`.",
        "",
        "## Validate",
        "Keep this page compact.",
      ].join("\n"),
    } as const;
    for (const [relativePath, content] of Object.entries(docs)) {
      await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await writeFile(path.join(root, relativePath), content, "utf8");
    }

    await mkdir(path.join(root, ".agents", "skills"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "skills", "HARNESS_COMPATIBILITY.md"),
      "# Harness compatibility\n\nLocal fixture.\n",
      "utf8",
    );

    const requiredSkills = ["pm-developer", "pm-user", "pm-extensions", "pm-sdk"];
    for (const skill of requiredSkills) {
      const skillDir = path.join(root, ".agents", "skills", skill);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          `name: ${skill}`,
          'description: "Example fixture. Use when validating docs skills."',
          "---",
          "",
          "# Body",
          "",
          "Run `pm install guide-shell --project` before using `pm guide workflows`.",
        ].join("\n"),
        "utf8",
      );
    }
  }

  it("covers docs-skills full-mode pass path", async () => {
    const fixtureRoot = await createTempRoot("pm-docs-skills-wave3-");
    await seedDocsSkillsFixture(fixtureRoot);

    const runCommand = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("contracts --runtime-only --availability-only --json")) {
        return {
          status: 0,
          stdout: JSON.stringify({ commands: ["guide", "contracts"] }),
          stderr: "",
        };
      }
      if (joined.includes("guide --json")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            mode: "index",
            topics: [{ id: "workflows" }],
          }),
          stderr: "",
        };
      }
      if (joined.includes("guide workflows --depth standard --json")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            mode: "topic",
            topic: {
              id: "workflows",
              commands: ["pm guide workflows"],
              workflows: [{ commands: ["pm contracts --command guide --flags-only"] }],
            },
            docs: [{ path: "README.md", exists: true, optional: false }],
            warnings: [],
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    });

    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        repoRoot: fixtureRoot,
        runCommand,
        fail(message: string, exitCode = 1) {
          process.exitCode = exitCode;
          console.error(message);
        },
      };
    });

    const scriptPath = path.join(process.cwd(), "scripts/release/docs-skills-gate.mjs");
    process.argv = ["node", scriptPath, "--json"];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await importRepoModuleNoQuery("scripts/release/docs-skills-gate.mjs");
    await waitForCondition(() => {
      expect(stdoutSpy).toHaveBeenCalled();
    });

    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      checks: { mode: string };
      failures: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.checks.mode).toBe("full");
    expect(payload.failures).toEqual([]);
    expect(runCommand).toHaveBeenCalled();
  });

  it("covers docs-skills links-only broken-link failure path", async () => {
    const fixtureRoot = await createTempRoot("pm-docs-skills-links-wave3-");
    await mkdir(path.join(fixtureRoot, "docs"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "README.md"), "# Root\n\n[Broken](missing.md)\n", "utf8");
    await writeFile(path.join(fixtureRoot, "AGENTS.md"), "# Agents\n\nNo links.\n", "utf8");
    await writeFile(path.join(fixtureRoot, "CONTRIBUTING.md"), "# Contributing\n\nNo links.\n", "utf8");
    await writeFile(path.join(fixtureRoot, "docs", "README.md"), "# Docs\n\n[Missing](../ghost.md)\n", "utf8");

    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        repoRoot: fixtureRoot,
        fail(message: string, exitCode = 1) {
          process.exitCode = exitCode;
          console.error(message);
        },
      };
    });

    const scriptPath = path.join(process.cwd(), "scripts/release/docs-skills-gate.mjs");
    process.argv = ["node", scriptPath, "--links-only", "--json"];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importRepoModuleNoQuery("scripts/release/docs-skills-gate.mjs");
    await waitForCondition(() => {
      expect(stdoutSpy).toHaveBeenCalled();
    });

    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      checks: { mode: string };
      failures: string[];
    };
    expect(payload.checks.mode).toBe("links-only");
    expect(Array.isArray(payload.failures)).toBe(true);
  });

  async function seedStaticQualityFixture(root: string): Promise<void> {
    const files = {
      "src/cli.ts": 'import "./core/a";\nexport const cli = true;\n',
      "src/core/a.ts": 'import "./b";\nexport function run() { return true; }\n',
      "src/core/b.ts": "export const value = 1;\n",
      "tests/unit/sample.ts": "export const sample = true;\n",
      "packages/pkg/index.ts": "export const pkg = true;\n",
    } as const;
    for (const [relativePath, content] of Object.entries(files)) {
      await mkdir(path.join(root, path.dirname(relativePath)), { recursive: true });
      await writeFile(path.join(root, relativePath), content, "utf8");
    }
  }

  it("covers static-quality full scan pass/fail reporting and duplicate-window guard", async () => {
    const fixtureRoot = await createTempRoot("pm-static-quality-wave3-");
    await seedStaticQualityFixture(fixtureRoot);

    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        repoRoot: fixtureRoot,
        fail(message: string, exitCode = 1) {
          throw new Error(`FAIL:${exitCode}:${message}`);
        },
      };
    });

    process.argv = [
      "node",
      "scripts/release/static-quality-gate.mjs",
      "--json",
      "--max-lines",
      "500",
      "--max-lines-tests",
      "500",
      "--max-complexity",
      "20",
      "--max-files-per-dir",
      "20",
      "--duplicate-window",
      "5",
      "--max-duplicate-chunks",
      "1",
    ];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importRepoModule("scripts/release/static-quality-gate.mjs", "staticQualityPass");
    const passPayload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      scanned: { file_count: number };
    };
    expect(passPayload.ok).toBe(true);
    expect(passPayload.scanned.file_count).toBeGreaterThan(0);

    vi.resetModules();
    process.exitCode = 0;
    process.argv = [
      "node",
      "scripts/release/static-quality-gate.mjs",
      "--max-lines",
      "1",
      "--max-lines-tests",
      "1",
      "--max-complexity",
      "1",
      "--max-files-per-dir",
      "1",
      "--duplicate-window",
      "5",
      "--max-duplicate-chunks",
      "0",
    ];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await importRepoModule("scripts/release/static-quality-gate.mjs", "staticQualityViolations");
    expect(process.exitCode).toBe(1);
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("Static quality gate failed.");

    vi.resetModules();
    process.exitCode = 0;
    process.argv = ["node", "scripts/release/static-quality-gate.mjs", "--duplicate-window", "3"];
    await expect(importRepoModule("scripts/release/static-quality-gate.mjs", "staticQualityInvalidWindow")).rejects.toThrow(
      "--duplicate-window must be >= 5.",
    );
  });

  it("covers run-release-pipeline tracker-only and dry-run branches", async () => {
    const runCommandTrackerOnly = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "describe") {
        return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-list" && args[2] === "v2026.6.13..HEAD") {
        return { status: 0, stdout: "3\n", stderr: "" };
      }
      if (command === "git" && args[0] === "diff") {
        return {
          status: 0,
          stdout: ".agents/pm/tasks/pm-1.toon\n.agents/pm/history/pm-1.jsonl\n",
          stderr: "",
        };
      }
      if (command === "git" && args[0] === "tag") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        runCommand: runCommandTrackerOnly,
        fail(message: string, exitCode = 1) {
          throw new Error(`FAIL:${exitCode}:${message}`);
        },
      };
    });

    const scriptPath = path.join(process.cwd(), "scripts/release/run-release-pipeline.mjs");
    process.argv = ["node", scriptPath, "--json"];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await importRepoModuleNoQuery("scripts/release/run-release-pipeline.mjs");

    const trackerOnly = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      skipped: boolean;
      reason: string;
    };
    expect(trackerOnly.skipped).toBe(true);
    expect(trackerOnly.reason).toBe("tracker_only_changes_since_last_tag");

    vi.resetModules();
    const runCommandDryRun = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "status") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "describe") {
        return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-list" && args[2] === "v2026.6.13..HEAD") {
        return { status: 0, stdout: "2\n", stderr: "" };
      }
      if (command === "git" && args[0] === "diff") {
        return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
      }
      if (command === "git" && args[0] === "tag") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === process.execPath && args[0] === "scripts/release/run-gates.mjs") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === process.execPath && args[0] === "scripts/generate-release-notes.mjs") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        runCommand: runCommandDryRun,
        fail(message: string, exitCode = 1) {
          throw new Error(`FAIL:${exitCode}:${message}`);
        },
      };
    });

    process.argv = [
      "node",
      scriptPath,
      "--json",
      "--dry-run",
      "--version",
      "2026.6.15",
      "--telemetry-mode",
      "off",
    ];
    const stdoutSpyDryRun = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importRepoModuleNoQuery("scripts/release/run-release-pipeline.mjs");
    const dryRunPayload = JSON.parse(String(stdoutSpyDryRun.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      skipped: boolean;
      dry_run: boolean;
      target_version: string;
      gates: { telemetry_mode: string };
    };
    expect(dryRunPayload.ok).toBe(true);
    expect(dryRunPayload.skipped).toBe(false);
    expect(dryRunPayload.dry_run).toBe(true);
    expect(dryRunPayload.target_version).toBe("2026.6.15");
    expect(dryRunPayload.gates.telemetry_mode).toBe("off");
  });

  it("covers compatibility-check legacy-seed migration success path", async () => {
    const state = {
      taskId: "pm-compat-task",
      issueId: "pm-compat-issue",
      itemCount: 2,
      comments: ["legacy comment"],
      notes: ["legacy note"],
      learnings: ["legacy learning"],
      tests: [{ command: "node --version" }],
    };

    const runCommand = vi.fn(
      (command: string, args: string[], options?: { env?: Record<string, string>; capture?: boolean }) => {
        const env = options?.env ?? {};
        const json = (payload: unknown) => ({
          status: 0,
          stdout: JSON.stringify(payload),
          stderr: "",
        });

        if ((command === "npm" || command === "npm.cmd") && args[0] === "view") {
          return { status: 0, stdout: "2026.6.14\n", stderr: "" };
        }

        if ((command === "npx" || command === "npx.cmd") && args.includes("pm")) {
          const pmArgs = args.slice(args.indexOf("pm") + 1).filter((entry) => entry !== "--json");
          const cmd = pmArgs[0];
          if (cmd === "init") {
            mkdirSync(path.join(env.PM_PATH ?? "", "tasks"), { recursive: true });
            return json({ ok: true });
          }
          if (cmd === "create") {
            const type = pmArgs[pmArgs.indexOf("--type") + 1];
            return json({
              item: { id: type === "Issue" ? state.issueId : state.taskId },
            });
          }
          if (cmd === "list-all") {
            return json({ count: state.itemCount });
          }
          if (cmd === "get") {
            return json({
              item: { id: state.taskId },
              body: "legacy seeded body",
            });
          }
          return json({ ok: true });
        }

        if (command === process.execPath && args[0].endsWith(path.join("dist", "cli.js"))) {
          const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
          const cmd = pmArgs[0];
          const id = pmArgs[1];

          if (cmd === "comments" && !pmArgs.includes("--add")) {
            return json({ comments: state.comments });
          }
          if (cmd === "notes") {
            return json({ notes: state.notes });
          }
          if (cmd === "learnings") {
            return json({ learnings: state.learnings });
          }
          if (cmd === "test" && !pmArgs.includes("--run")) {
            return json({ tests: state.tests });
          }
          if (cmd === "update" && id === state.taskId) {
            const tasksDir = path.join(env.PM_PATH ?? "", "tasks");
            mkdirSync(tasksDir, { recursive: true });
            writeFileSync(path.join(tasksDir, `${state.taskId}.toon`), "migrated toon entry\n", "utf8");
            rmSync(path.join(tasksDir, `${state.taskId}.md`), { force: true });
            return json({ ok: true });
          }
          if (cmd === "comments" && pmArgs.includes("--add")) {
            state.comments.push("post migration comment");
            return json({ ok: true });
          }
          if (cmd === "test" && pmArgs.includes("--run")) {
            return json({ ok: true });
          }
          if (cmd === "validate") {
            return json({ ok: true });
          }
          if (cmd === "health") {
            return json({ checks: [{ name: "storage", status: "ok" }] });
          }
          if (cmd === "list-all") {
            return json({ count: state.itemCount });
          }
          return json({ ok: true });
        }

        return { status: 0, stdout: "", stderr: "" };
      },
    );

    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        runCommand,
        fail(message: string, exitCode = 1) {
          throw new Error(`FAIL:${exitCode}:${message}`);
        },
      };
    });

    process.argv = ["node", "scripts/release/compatibility-check.mjs", "--json"];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await importRepoModule("scripts/release/compatibility-check.mjs", "compatibilityGateSuccess");

    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      item_count_before: number;
      item_count_after: number;
      validation_ok: boolean;
      health_ok: boolean;
    };
    expect(payload.ok).toBe(true);
    expect(payload.item_count_before).toBe(state.itemCount);
    expect(payload.item_count_after).toBe(state.itemCount);
    expect(payload.validation_ok).toBe(true);
    expect(payload.health_ok).toBe(true);
    expect(runCommand).toHaveBeenCalled();
  });
});

describe("lane-c scripts wave2: release utils + run-gates", () => {
  it("covers release utils helpers and failure handling branches", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("json-ok")) {
        return { status: 0, stdout: "{\"ok\":true}", stderr: "" };
      }
      if (joined.includes("json-bad")) {
        return { status: 0, stdout: "not-json", stderr: "" };
      }
      if (joined.includes("allowed-failure")) {
        return { status: 5, stdout: "", stderr: "allowed failure" };
      }
      if (joined.includes("hard-failure")) {
        return { status: 7, stdout: "", stderr: "fatal failure" };
      }
      return { status: 0, stdout: "ok", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const utils = await importRepoModule<typeof import("../../../scripts/release/utils.mjs")>(
      "scripts/release/utils.mjs",
      "releaseUtils",
    );

    const parsed = utils.parseFlags(["--json", "--telemetry-mode", "required", "positional", "--skip-dogfood"]);
    expect(parsed.positionals).toEqual(["positional"]);
    expect(parsed.flags.get("json")).toBe(true);
    expect(parsed.flags.get("telemetry-mode")).toBe("required");
    expect(parsed.flags.get("skip-dogfood")).toBe(true);

    expect(utils.flagString(parsed.flags, "telemetry-mode", "best-effort")).toBe("required");
    expect(utils.flagString(parsed.flags, "missing", "fallback")).toBe("fallback");
    expect(utils.flagBool(parsed.flags, "json", false)).toBe(true);
    expect(utils.flagBool(new Map([["truthy", "yes"]]), "truthy", false)).toBe(true);
    expect(utils.flagBool(new Map([["falsy", "off"]]), "falsy", true)).toBe(false);
    expect(utils.flagBool(new Map([["maybe", "invalid"]]), "maybe", true)).toBe(true);
    expect(utils.utcDateKey(new Date(Date.UTC(2026, 5, 14, 12, 0, 0)))).toBe("2026.6.14");
    expect(utils.utcIsoDate(new Date(Date.UTC(2026, 5, 4, 12, 0, 0)))).toBe("2026-06-04");

    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(utils.commandFor("npm")).toBe("npm.cmd");
    expect(utils.commandFor("npm.cmd")).toBe("npm.cmd");
    platformSpy.mockRestore();

    const success = utils.runCommand("pm", ["json-ok"], { capture: true, cwd: "/tmp/pm", shell: true });
    expect(success).toEqual({ status: 0, stdout: "{\"ok\":true}", stderr: "" });
    expect(spawnSync).toHaveBeenCalledWith(
      "pm",
      ["json-ok"],
      expect.objectContaining({
        cwd: "/tmp/pm",
        shell: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    const allowedFailure = utils.runCommand("pm", ["allowed-failure"], { allowFailure: true, capture: true });
    expect(allowedFailure.status).toBe(5);
    expect(allowedFailure.stderr).toContain("allowed failure");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    expect(() => utils.requireFlag(new Map<string, string | boolean>(), "missing", "missing required")).toThrow("EXIT:1");
    expect(errorSpy).toHaveBeenCalledWith("missing required");
    exitSpy.mockRestore();

    const hardFailExit = mockProcessExit();
    expect(() => utils.runCommand("pm", ["hard-failure"], { capture: true })).toThrow("EXIT:7");
    hardFailExit.mockRestore();

    const jsonFailExit = mockProcessExit();
    expect(() => utils.runCommandJson("pm", ["json-bad"])).toThrow("EXIT:1");
    jsonFailExit.mockRestore();
  });

  it("covers run-gates help, skip branches, and JSON summary output", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 0, stdout: "{\"compatibility\":\"ok\"}", stderr: "" };
      }
      if (joined.includes("sentry-telemetry-gate.mjs")) {
        return { status: 0, stdout: "{\"ok\":true,\"mode\":\"best-effort\"}", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    process.argv = ["node", "scripts/release/run-gates.mjs", "--help"];
    const helpLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModule("scripts/release/run-gates.mjs", "runGatesHelp");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(String(helpLog.mock.calls.at(-1)?.[0] ?? "")).toContain("--skip-compatibility");

    vi.resetModules();
    process.argv = [
      "node",
      "scripts/release/run-gates.mjs",
      "--json",
      "--skip-dogfood",
      "--skip-compatibility",
      "--skip-telemetry-sentry",
      "--telemetry-mode",
      "required",
    ];
    const jsonWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importRepoModule("scripts/release/run-gates.mjs", "runGatesSkips");
    const payload = JSON.parse(String(jsonWriteSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; skipped?: boolean }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.checks.some((entry) => entry.name === "package-first-dogfood" && entry.skipped === true)).toBe(true);
    expect(payload.checks.some((entry) => entry.name === "compatibility-check" && entry.skipped === true)).toBe(true);
    expect(payload.checks.some((entry) => entry.name === "sentry-telemetry-gate" && entry.skipped === true)).toBe(true);
    expect(spawnSync).toHaveBeenCalled();
  });

  it("covers run-gates compatibility failure details and parse-json error handling", async () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 9, stdout: "compat stdout", stderr: "compat stderr" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync }));

    process.argv = ["node", "scripts/release/run-gates.mjs", "--skip-dogfood", "--skip-telemetry-sentry"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failExit = mockProcessExit();
    await expect(importRepoModule("scripts/release/run-gates.mjs", "runGatesFail")).rejects.toThrow("EXIT:9");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Gate failed: compatibility-check");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("stdout:");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("stderr:");
    failExit.mockRestore();

    vi.resetModules();
    const parseFailSpawn = vi.fn((cmd: string, args: string[]) => {
      const joined = [cmd, ...args].join(" ");
      if (joined.includes("compatibility-check.mjs")) {
        return { status: 0, stdout: "not-json", stderr: "" };
      }
      if (joined.includes("sentry-telemetry-gate.mjs")) {
        return { status: 0, stdout: "{\"ok\":true}", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync: parseFailSpawn }));
    process.argv = ["node", "scripts/release/run-gates.mjs", "--json", "--skip-dogfood", "--skip-telemetry-sentry"];
    const parseErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const parseExit = mockProcessExit();
    await expect(importRepoModule("scripts/release/run-gates.mjs", "runGatesParseFail")).rejects.toThrow("EXIT:1");
    expect(String(parseErrorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Failed to parse JSON for compatibility-check");
    parseExit.mockRestore();
  });

  it("covers release relevance path normalization", async () => {
    const module = await importRepoModule<typeof import("../../../scripts/release/release-relevance.mjs")>(
      "scripts/release/release-relevance.mjs",
      "releaseRelevance",
    );
    expect(module.isReleaseRelevantPath(".agents/pm/tasks/pm-1.md")).toBe(false);
    expect(module.isReleaseRelevantPath(".agents\\pm\\tasks\\pm-1.md")).toBe(false);
    expect(module.isReleaseRelevantPath("src/cli/main.ts")).toBe(true);
  });
});

describe("lane-c scripts wave2: release-version", () => {
  async function runReleaseVersionScenario(options: {
    args: string[];
    packageJson?: Record<string, unknown>;
    execFileSyncImpl?: (command: string, args: string[]) => string;
  }) {
    process.argv = ["node", "scripts/release-version.mjs", ...options.args];
    const packageJson = options.packageJson ?? { name: "pm-cli", version: "2026.6.14" };
    const readFileSync = vi.fn(() => JSON.stringify(packageJson));
    const execFileSync = vi.fn(
      options.execFileSyncImpl ??
        (() => {
          return "[]";
        }),
    );
    vi.doMock("node:fs", () => ({ readFileSync }));
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value ?? ""));
    });
    const exitSpy = mockProcessExit();

    let failure: unknown = null;
    try {
      await importRepoModule("scripts/release-version.mjs", "releaseVersionScenario");
    } catch (error) {
      failure = error;
    }
    exitSpy.mockRestore();
    return { failure, logs, errors, readFileSync, execFileSync };
  }

  it("covers release-version check/next success paths and npm E404 fallback", async () => {
    const checkSuccess = await runReleaseVersionScenario({
      args: ["check"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
    });
    expect(checkSuccess.failure).toBeNull();
    expect(checkSuccess.logs.join("\n")).toContain("Version policy check passed (2026.6.14).");
    expect(checkSuccess.execFileSync).not.toHaveBeenCalled();

    const nextWithPublished = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
      execFileSyncImpl: () => JSON.stringify(["2026.6.14", "2026.6.14-2", "2026.6.13"]),
    });
    expect(nextWithPublished.failure).toBeNull();
    expect(nextWithPublished.logs.at(-1)).toBe("2026.6.14-3");

    const nextWithE404 = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.15"],
      execFileSyncImpl: () => {
        const error = new Error("npm view failed") as Error & { stderr?: string };
        error.stderr = "E404 Not Found";
        throw error;
      },
    });
    expect(nextWithE404.failure).toBeNull();
    expect(nextWithE404.logs.at(-1)).toBe("2026.6.15");
  });

  it("covers release-version verify/tag/flag/command failures", async () => {
    const tagMismatch = await runReleaseVersionScenario({
      args: ["check", "--tag", "v0.0.1"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
    });
    expect(String(tagMismatch.failure ?? "")).toContain("EXIT:1");
    expect(tagMismatch.errors.join("\n")).toContain("Tag/version mismatch");

    const verifyMismatch = await runReleaseVersionScenario({
      args: ["check", "--verify-next", "--date", "2026.6.14"],
      packageJson: { name: "pm-cli", version: "2026.6.14" },
      execFileSyncImpl: () => JSON.stringify(["2026.6.14"]),
    });
    expect(String(verifyMismatch.failure ?? "")).toContain("EXIT:1");
    expect(verifyMismatch.errors.join("\n")).toContain("Version sequencing mismatch");

    const unknownFlag = await runReleaseVersionScenario({
      args: ["check", "--mystery-flag"],
    });
    expect(String(unknownFlag.failure ?? "")).toContain("EXIT:1");
    expect(unknownFlag.errors.join("\n")).toContain('Unknown flag "--mystery-flag"');

    const unknownCommand = await runReleaseVersionScenario({
      args: ["ship"],
    });
    expect(String(unknownCommand.failure ?? "")).toContain("EXIT:1");
    expect(unknownCommand.errors.join("\n")).toContain('Unknown command "ship"');

    const invalidNpmJson = await runReleaseVersionScenario({
      args: ["next", "--date", "2026.6.14"],
      execFileSyncImpl: () => "not-json",
    });
    expect(String(invalidNpmJson.failure ?? "")).toContain("EXIT:1");
    expect(invalidNpmJson.errors.join("\n")).toContain("Failed to parse npm versions JSON");

    const helpFlag = await runReleaseVersionScenario({
      args: ["check", "--help"],
    });
    expect(String(helpFlag.failure ?? "")).toContain("EXIT:0");
    expect(helpFlag.logs.join("\n")).toContain("Usage:");
  });

  it.each([
    {
      name: "missing package name",
      packageJson: { version: "2026.6.14" },
      expected: "missing a valid \"name\"",
    },
    {
      name: "missing package version",
      packageJson: { name: "pm-cli" },
      expected: "missing a valid \"version\"",
    },
    {
      name: "invalid calendar date",
      packageJson: { name: "pm-cli", version: "2026.2.30" },
      expected: "uses an invalid calendar date",
    },
    {
      name: "forbidden ordinal one suffix",
      packageJson: { name: "pm-cli", version: "2026.6.14-1" },
      expected: "omit suffix for first release",
    },
  ])("covers release-version validation failure: $name", async ({ packageJson, expected }) => {
    const result = await runReleaseVersionScenario({
      args: ["check"],
      packageJson,
    });
    expect(String(result.failure ?? "")).toContain("EXIT:1");
    expect(result.errors.join("\n")).toContain(expected);
  });
});

describe("lane-c scripts wave2: contracts-snapshot", () => {
  interface ContractsSnapshotOptions {
    args: string[];
    cliExists?: boolean;
    spawnResult?: {
      status?: number | null;
      stdout?: string;
      stderr?: string;
      error?: Error;
    };
    snapshotReadResult?: string;
    snapshotReadError?: Error;
  }

  async function runContractsSnapshotScenario(options: ContractsSnapshotOptions) {
    process.argv = ["node", "scripts/contracts-snapshot.mjs", ...options.args];

    const existsSync = vi.fn(() => options.cliExists ?? true);
    const mkdtempSync = vi.fn(() => "/tmp/pm-cli-contracts-global-test");
    const rmSync = vi.fn();
    vi.doMock("node:fs", () => ({
      existsSync,
      mkdtempSync,
      rmSync,
    }));

    const mkdir = vi.fn(async () => undefined);
    const readFile = vi.fn(async () => {
      if (options.snapshotReadError) {
        throw options.snapshotReadError;
      }
      return options.snapshotReadResult ?? "{\n  \"a\": 1,\n  \"b\": 2\n}\n";
    });
    const writeFile = vi.fn(async () => undefined);
    vi.doMock("node:fs/promises", () => ({
      mkdir,
      readFile,
      writeFile,
    }));

    const spawnSync = vi.fn(() => ({
      status: options.spawnResult?.status ?? 0,
      stdout: options.spawnResult?.stdout ?? "{\"b\":2,\"a\":1}",
      stderr: options.spawnResult?.stderr ?? "",
      error: options.spawnResult?.error,
    }));
    vi.doMock("node:child_process", () => ({ spawnSync }));

    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value ?? ""));
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = mockProcessExit();

    let failure: unknown = null;
    try {
      await importRepoModule("scripts/contracts-snapshot.mjs", "contractsSnapshotScenario");
    } catch (error) {
      failure = error;
    }
    exitSpy.mockRestore();

    return { failure, logs, errors, existsSync, readFile, writeFile, mkdir, spawnSync };
  }

  it("covers contracts-snapshot mode and missing-build guards", async () => {
    const noMode = await runContractsSnapshotScenario({
      args: [],
    });
    expect(String(noMode.failure ?? "")).toContain("EXIT:2");
    expect(noMode.errors.join("\n")).toContain("Usage: node scripts/contracts-snapshot.mjs --update|--check");

    const missingBuild = await runContractsSnapshotScenario({
      args: ["--check"],
      cliExists: false,
    });
    expect(String(missingBuild.failure ?? "")).toContain("EXIT:1");
    expect(missingBuild.errors.join("\n")).toContain("Missing dist/cli.js");
  });

  it("covers contracts-snapshot check/update success plus stale/missing snapshot failures", async () => {
    const checkCurrent = await runContractsSnapshotScenario({
      args: ["--check"],
      snapshotReadResult: "{\n  \"a\": 1,\n  \"b\": 2\n}\n",
      spawnResult: { status: 0, stdout: "{\"b\":2,\"a\":1}" },
    });
    expect(checkCurrent.failure).toBeNull();
    expect(checkCurrent.logs.join("\n")).toContain("Contract snapshot is current");

    const staleSnapshot = await runContractsSnapshotScenario({
      args: ["--check"],
      snapshotReadResult: "{\n  \"a\": 1,\n  \"b\": 3\n}\n",
      spawnResult: { status: 0, stdout: "{\"b\":2,\"a\":1}" },
    });
    expect(String(staleSnapshot.failure ?? "")).toContain("EXIT:1");
    expect(staleSnapshot.errors.join("\n")).toContain("Contract snapshot is stale");

    const missingSnapshot = await runContractsSnapshotScenario({
      args: ["--check"],
      snapshotReadError: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });
    expect(String(missingSnapshot.failure ?? "")).toContain("EXIT:1");
    expect(missingSnapshot.errors.join("\n")).toContain("Missing contracts snapshot");

    const updateSnapshot = await runContractsSnapshotScenario({
      args: ["--update"],
      spawnResult: { status: 0, stdout: "{\"z\":9,\"a\":1}" },
    });
    expect(String(updateSnapshot.failure ?? "")).toContain("EXIT:0");
    expect(updateSnapshot.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("tests/fixtures/contracts/full.json"),
      "{\n  \"a\": 1,\n  \"z\": 9\n}\n",
      "utf8",
    );
    expect(updateSnapshot.logs.join("\n")).toContain("Updated");
  });

  it("covers contracts-snapshot spawn and parse failure branches", async () => {
    const failedStart = await runContractsSnapshotScenario({
      args: ["--check"],
      spawnResult: { error: new Error("spawn failed"), status: null, stdout: "", stderr: "" },
    });
    expect(String(failedStart.failure ?? "")).toContain("failed to start");

    const failedExit = await runContractsSnapshotScenario({
      args: ["--check"],
      spawnResult: { status: 4, stdout: "stdout text", stderr: "stderr text" },
    });
    expect(String(failedExit.failure ?? "")).toContain("failed with exit code 4");

    const invalidJson = await runContractsSnapshotScenario({
      args: ["--check"],
      spawnResult: { status: 0, stdout: "not-json", stderr: "" },
    });
    expect(String(invalidJson.failure ?? "")).toContain("invalid JSON");
  });
});

describe("lane-c scripts wave2: bundle-cli + smoke wrappers", () => {
  interface BundleCliMocks {
    mkdir?: (target: string) => Promise<void>;
    stat?: (target: string) => Promise<{ mtimeMs: number }>;
    rename?: (source: string, destination: string) => Promise<void>;
    rm?: (target: string) => Promise<void>;
    readdir?: (target: string) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>>;
    lstat?: (target: string) => Promise<{ mtimeMs: number } | null>;
    unlink?: (target: string) => Promise<void>;
    readFile?: (target: string, encoding: string) => Promise<string>;
    writeFile?: (target: string, content: string, encoding: string) => Promise<void>;
    build?: () => Promise<{ metafile: { outputs: Record<string, Record<string, unknown>> } }>;
  }

  async function runBundleCliScenario(mocks: BundleCliMocks = {}) {
    const mkdir = vi.fn(async (target: string) => {
      if (mocks.mkdir) {
        await mocks.mkdir(target);
      }
    });
    const stat = vi.fn(async (target: string) => {
      if (mocks.stat) {
        return mocks.stat(target);
      }
      return { mtimeMs: Date.now() };
    });
    const rename = vi.fn(async (source: string, destination: string) => {
      if (mocks.rename) {
        await mocks.rename(source, destination);
      }
    });
    const rm = vi.fn(async (target: string) => {
      if (mocks.rm) {
        await mocks.rm(target);
      }
    });
    const readdir = vi.fn(async (target: string) => {
      if (mocks.readdir) {
        return mocks.readdir(target);
      }
      return [];
    });
    const lstat = vi.fn(async (target: string) => {
      if (mocks.lstat) {
        return mocks.lstat(target);
      }
      return { mtimeMs: Date.now() - 20 * 60_000 };
    });
    const unlink = vi.fn(async (target: string) => {
      if (mocks.unlink) {
        await mocks.unlink(target);
      }
    });
    const readFile = vi.fn(async (target: string, encoding: string) => {
      if (mocks.readFile) {
        return mocks.readFile(target, encoding);
      }
      return '#!/usr/bin/env node\nawait import("./cli/main.js")\n';
    });
    const writeFile = vi.fn(async (target: string, content: string, encoding: string) => {
      if (mocks.writeFile) {
        await mocks.writeFile(target, content, encoding);
      }
    });
    vi.doMock("node:fs/promises", () => ({
      lstat,
      mkdir,
      readdir,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    }));

    const build = vi.fn(async () => {
      if (mocks.build) {
        return mocks.build();
      }
      return { metafile: { outputs: { "dist/cli-bundle/main.js": {} } } };
    });
    vi.doMock("esbuild", () => ({ build }));

    const exitSpy = mockProcessExit();
    let failure: unknown = null;
    try {
      await importRepoModule("scripts/bundle-cli.mjs", "bundleCliScenario");
    } catch (error) {
      failure = error;
    }
    exitSpy.mockRestore();
    return { failure, mkdir, stat, rename, rm, readdir, lstat, unlink, readFile, writeFile, build };
  }

  it("covers bundle-cli stale lock recovery, stale bundle cleanup, and cli rewrite", async () => {
    let lockAttempts = 0;
    const scenario = await runBundleCliScenario({
      mkdir: async (target) => {
        if (target.endsWith(".cli-bundle-build.lock")) {
          lockAttempts += 1;
          if (lockAttempts === 1) {
            throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
          }
        }
      },
      stat: async () => ({ mtimeMs: Date.now() - 11 * 60_000 }),
      readdir: async () => [
        {
          name: "main.js",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: "obsolete.js",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
      ],
      lstat: async (target) => ({ mtimeMs: target.endsWith("obsolete.js") ? Date.now() - 11 * 60_000 : Date.now() }),
      build: async () => ({
        metafile: { outputs: { "dist/cli-bundle/main.js": {} } },
      }),
      readFile: async () => '#!/usr/bin/env node\nawait import("./cli/main.js")\n',
    });

    expect(scenario.failure).toBeNull();
    expect(scenario.rename).toHaveBeenCalled();
    expect(scenario.unlink).toHaveBeenCalledWith(expect.stringContaining("obsolete.js"));
    expect(scenario.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("dist/cli.js"),
      expect.stringContaining('await import("./cli-bundle/main.js")'),
      "utf8",
    );
    expect(
      scenario.rm.mock.calls.some((call) => String(call[0]).includes(".cli-bundle-build.lock")),
    ).toBe(true);
  });

  it("covers bundle-cli early bundled exit and rewrite marker failure", async () => {
    const alreadyBundled = await runBundleCliScenario({
      readFile: async () => '#!/usr/bin/env node\nawait import("./cli-bundle/main.js")\n',
    });
    expect(String(alreadyBundled.failure ?? "")).toContain("EXIT:0");
    expect(alreadyBundled.writeFile).not.toHaveBeenCalled();

    const missingMarker = await runBundleCliScenario({
      readFile: async () => '#!/usr/bin/env node\nconsole.log("missing marker")\n',
    });
    expect(String(missingMarker.failure ?? "")).toContain("Unable to rewrite dist/cli.js");
  });

  it("covers smoke-codex wrapper entry execution with deterministic MCP harness mocks", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "tools/list") {
        return {
          tools: [
            { name: "pm_run" },
            { name: "pm_context" },
            { name: "pm_create" },
            { name: "pm_get" },
            { name: "pm_update" },
            { name: "pm_comments" },
            { name: "pm_files" },
            { name: "pm_docs" },
            { name: "pm_notes" },
            { name: "pm_learnings" },
            { name: "pm_deps" },
            { name: "pm_test" },
            { name: "pm_claim" },
            { name: "pm_validate" },
          ],
        };
      }
      return { ok: true };
    });
    const callTool = vi.fn(async (tool: string) => {
      if (tool === "pm_create") {
        return { item: { id: "pm-smoke-1" } };
      }
      if (tool === "pm_get") {
        return {
          item: { status: "in_progress" },
          linked: { files: [{ path: "README.md" }], tests: [{ command: "node --version" }] },
        };
      }
      return { ok: true };
    });
    const dispose = vi.fn(async () => undefined);
    vi.doMock("../../../scripts/plugin-mcp-smoke-harness.mjs", () => ({
      startPluginMcpSmoke: vi.fn(async () => ({
        tmpRoot: "/tmp/pm-codex-smoke",
        request,
        callTool,
        dispose,
      })),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModule("scripts/smoke-codex-plugin-mcp.mjs", "smokeCodexWrapper");
    expect(request).toHaveBeenCalledWith("initialize", expect.any(Object));
    expect(callTool).toHaveBeenCalledWith("pm_run", expect.any(Object));
    expect(callTool).toHaveBeenCalledWith("pm_validate", expect.any(Object));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Codex plugin MCP smoke passed");
  });
});

describe("lane-c scripts wave3: sentry, external smoke, and package-first dogfood", () => {
  it("covers sentry-telemetry required-mode command-missing failure and best-effort threshold fail", async () => {
    const failRunCommand = vi.fn(() => ({
      status: 0,
      stdout: "[]",
      stderr: "",
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
    }));
    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        runCommand: failRunCommand,
        commandFor(binary: string) {
          return binary;
        },
        fail(message: string, exitCode = 1) {
          process.exitCode = exitCode;
          console.error(message);
        },
      };
    });

    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_PERSONAL_ADMIN_TOKEN;
    delete process.env.SENTRY_ORG_TOKEN;
    delete process.env.PM_TELEMETRY_QUERY_COMMAND;
    process.argv = ["node", "scripts/release/sentry-telemetry-gate.mjs", "--json", "--telemetry-mode", "required"];
    const requiredStdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importRepoModule("scripts/release/sentry-telemetry-gate.mjs", "sentryRequiredMissingCommand");
    await waitForCondition(() => {
      expect(requiredStdoutSpy).toHaveBeenCalled();
    });
    const requiredPayload = JSON.parse(String(requiredStdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      telemetry: { warning: string | null; mode: string };
    };
    expect(requiredPayload.ok).toBe(false);
    expect(requiredPayload.telemetry.mode).toBe("required");
    expect(String(requiredPayload.telemetry.warning ?? "")).toContain("telemetry_query_command_missing");
    expect(process.exitCode).toBe(1);

    vi.resetModules();
    process.exitCode = 0;
    const telemetryCsv = [
      "### overall finish error rate",
      "finish_error_rate_pct,sample_size",
      "1,50",
      "(1 rows)",
      "",
      "### missing error code coverage",
      "error_code,count",
      "(0 rows)",
    ].join("\n");
    const successRunCommand = vi.fn((command: string, args: string[]) => {
      if (command === "bash" && args[0]?.includes("query-telemetry.sh")) {
        return {
          status: 0,
          stdout: telemetryCsv,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
    }));
    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        runCommand: successRunCommand,
        commandFor(binary: string) {
          return binary;
        },
        fail(message: string, exitCode = 1) {
          process.exitCode = exitCode;
          console.error(message);
        },
      };
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          { shortId: "PM-1", level: "fatal", logger: "node", metadata: { value: "fatal crash", type: "Error" } },
          { shortId: "PM-2", level: "error", logger: "node", metadata: { value: "error crash", type: "Error" } },
          {
            shortId: "PM-3",
            level: "error",
            logger: "console",
            title: "[starter-extension] activating",
            metadata: { value: "all 8 capabilities registered.", type: "Error" },
          },
          {
            shortId: "PM-4",
            level: "error",
            logger: "node",
            isUnhandled: false,
            metadata: { value: "tracker_not_initialized", type: "CommandError" },
          },
        ]),
    })) as typeof fetch;

    process.env.SENTRY_AUTH_TOKEN = "token-wave3";
    process.argv = [
      "node",
      "scripts/release/sentry-telemetry-gate.mjs",
      "--json",
      "--telemetry-mode",
      "best-effort",
      "--telemetry-command",
      "scripts/prod/telemetry/query-telemetry.sh",
      "--max-critical",
      "0",
      "--max-high",
      "0",
    ];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importRepoModule("scripts/release/sentry-telemetry-gate.mjs", "sentryBestEffortThresholdFail");
    await waitForCondition(() => {
      expect(stdoutSpy).toHaveBeenCalled();
    });
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      sentry: {
        critical: number;
        high: number;
        ignored_noise_total: number;
        ignored_expected_cli_error_total: number;
      };
      telemetry: { checked: boolean; ok: boolean };
    };
    expect(payload.ok).toBe(false);
    expect(payload.sentry.critical).toBe(1);
    expect(payload.sentry.high).toBe(1);
    expect(payload.sentry.ignored_noise_total).toBe(1);
    expect(payload.sentry.ignored_expected_cli_error_total).toBe(1);
    expect(payload.telemetry.checked).toBe(true);
    expect(payload.telemetry.ok).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("covers smoke-external-packages discover-only and mixed pass/fail smoke runs", async () => {
    const discoverSpawn = vi.fn((command: string, args: string[]) => {
      if (command === process.execPath && args[0]?.endsWith(path.join("dist", "cli.js")) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "search") {
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: "pm-package-alpha", description: "pm package", keywords: ["pm-package"] },
            { name: "not-related", description: "other", keywords: ["misc"] },
            { name: "pm-extension-beta", description: "pm extension", keywords: ["pm-extension"] },
          ]),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync: discoverSpawn }));

    process.argv = ["node", "scripts/smoke-external-packages.mjs", "--discover-only", "--limit", "2"];
    const discoverLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModule("scripts/smoke-external-packages.mjs", "smokeExternalDiscover");
    const discoverPayload = JSON.parse(String(discoverLogSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      mode: string;
      packages: string[];
    };
    expect(discoverPayload.ok).toBe(true);
    expect(discoverPayload.mode).toBe("discover");
    expect(discoverPayload.packages).toEqual(["pm-package-alpha", "pm-extension-beta"]);

    vi.resetModules();
    let currentPackage = "";
    const smokeSpawn = vi.fn((command: string, args: string[]) => {
      if (command === process.execPath && args[0]?.endsWith(path.join("dist", "cli.js")) && args[1] === "--version") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === process.execPath && args[0]?.endsWith(path.join("dist", "cli.js"))) {
        const pmArgs = args.slice(1).filter((entry) => entry !== "--json");
        const cmd = pmArgs[0];
        if (cmd === "init") {
          return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        if (cmd === "install") {
          currentPackage = String(pmArgs[1] ?? "").replace(/^npm:/, "");
          if (currentPackage === "pm-bad") {
            return { status: 1, stdout: "", stderr: "install failed" };
          }
          return {
            status: 0,
            stdout: JSON.stringify({ details: { installed_count: 1 } }),
            stderr: "",
          };
        }
        if (cmd === "package" && pmArgs[1] === "doctor") {
          return {
            status: 0,
            stdout: JSON.stringify({
              details: { summary: { activation_failure_count: 0, blocking_failure_count: 0 }, triage: { warning_codes: [] } },
            }),
            stderr: "",
          };
        }
        if (cmd === "contracts") {
          return {
            status: 0,
            stdout: JSON.stringify({
              action_availability: [{ action: `action-${currentPackage}`, invocable: true, available: true }],
            }),
            stderr: "",
          };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("node:child_process", () => ({ spawnSync: smokeSpawn }));

    process.exitCode = 0;
    process.argv = [
      "node",
      "scripts/smoke-external-packages.mjs",
      "--package",
      "npm:pm-good",
      "--package",
      "pm-bad",
      "--timeout-ms",
      "50",
    ];
    const smokeLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModule("scripts/smoke-external-packages.mjs", "smokeExternalMixedRun");
    const smokePayload = JSON.parse(String(smokeLogSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      tested: number;
      failed: number;
      results: Array<{ package: string; ok: boolean }>;
    };
    expect(smokePayload.ok).toBe(false);
    expect(smokePayload.tested).toBe(2);
    expect(smokePayload.failed).toBe(1);
    expect(smokePayload.results.some((entry) => entry.package === "pm-good" && entry.ok)).toBe(true);
    expect(smokePayload.results.some((entry) => entry.package === "pm-bad" && !entry.ok)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("covers dogfood-package-first success path with deterministic mocked command responses", async () => {
    let guidancePresent = false;
    const taskId = "pm-dogfood-1";
    const planId = "plan-dogfood-1";
    let planAddStepCount = 0;

    const pmJson = (payload: unknown) => ({
      status: 0,
      stdout: JSON.stringify(payload),
      stderr: "",
    });

    const spawnSync = vi.fn((command: string, args: string[]) => {
      if (command === process.execPath && args[0] === "--input-type=module") {
        return { status: 0, stdout: "", stderr: "" };
      }

      if (command !== process.execPath || !args[0]?.endsWith(path.join("dist", "cli.js"))) {
        return { status: 0, stdout: "", stderr: "" };
      }

      let pmArgs = args.slice(1);
      const jsonMode = pmArgs[0] === "--json";
      if (jsonMode) {
        pmArgs = pmArgs.slice(1);
      }
      const cmd = pmArgs[0];

      if (!jsonMode) {
        if (cmd === "calendar") {
          return {
            status: 0,
            stdout: "# pm calendar\n\nDogfood calendar event\n",
            stderr: "",
          };
        }
        if (cmd === "completion") {
          return { status: 0, stdout: "function _pm_completion() {}\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }

      if (cmd === "init") {
        if (pmArgs[1] === "--agent-guidance") {
          const action = pmArgs[2];
          if (action === "status") {
            return pmJson({ agent_guidance: { present: guidancePresent } });
          }
          if (action === "add") {
            guidancePresent = true;
            return pmJson({ agent_guidance: { present: true, applied: true } });
          }
        }
        return pmJson({
          installed_packages: { installed_all: true, installed_count: 9 },
          agent_guidance: { mode: "ask", present: false },
        });
      }

      if (cmd === "create") {
        const typeIndex = pmArgs.indexOf("--type");
        const type = typeIndex >= 0 ? pmArgs[typeIndex + 1] : null;
        return pmJson({ item: { id: type === "Event" ? "pm-event-1" : taskId } });
      }

      if (cmd === "get") {
        if (pmArgs.includes("--depth") && pmArgs.includes("brief")) {
          return pmJson({ item: { id: taskId } });
        }
        if (pmArgs.includes("--fields")) {
          return pmJson({
            item: {
              id: taskId,
              title: "Dogfood package-first workflow",
              status: "in_progress",
              parent: null,
              type: "Task",
            },
          });
        }
      }

      if (cmd === "list-open") {
        return pmJson({
          projection: { mode: "compact", fields: ["id", "status", "type", "title"] },
        });
      }

      if (cmd === "search-advanced") {
        return pmJson({
          mode: "keyword",
          query: "Dogfood package-first workflow",
        });
      }

      if (cmd === "contracts") {
        if (pmArgs.includes("--command") && pmArgs.includes("list-open")) {
          return pmJson({
            command_flags: [
              { flags: ["--compact", "--brief", "--full", "--fields", "--include-body"].map((flag) => ({ flag })) },
            ],
          });
        }
        if (pmArgs.includes("--command") && pmArgs.includes("search-advanced")) {
          return pmJson({
            command_flags: [{ flags: ["--mode", "--semantic", "--hybrid", "--fields", "--limit"].map((flag) => ({ flag })) }],
          });
        }
        if (pmArgs.includes("--command") && pmArgs.includes("search")) {
          return pmJson({
            command_flags: [{ flags: ["--mode", "--semantic", "--hybrid", "--include-linked"].map((flag) => ({ flag })) }],
          });
        }
        if (pmArgs.includes("--availability-only") && pmArgs.includes("--runtime-only")) {
          return pmJson({
            action_availability: [
              "beads-import",
              "completion",
              "comments-audit",
              "dedupe-audit",
              "guide",
              "search-advanced",
              "templates-save",
              "templates-show",
              "test-runs-list",
              "todos-export",
            ].map((action) => ({ action, available: true, invocable: true })),
          });
        }
        return pmJson({
          command_flags: [
            { command: "package", flags: ["--catalog", "--explore", "--doctor", "--install", "--project", "--global"].map((flag) => ({ flag })) },
            { command: "upgrade", flags: ["--packages-only", "--dry-run"].map((flag) => ({ flag })) },
            { command: "init", flags: ["--agent-guidance", "--with-packages"].map((flag) => ({ flag })) },
            { command: "get", flags: ["--fields"].map((flag) => ({ flag })) },
          ],
          command_aliases: [{ canonical: "package", aliases: ["install"] }],
        });
      }

      if (cmd === "install") {
        if (pmArgs[1] === "all") {
          return pmJson({ details: { installed_all: true, installed_count: 9 } });
        }
        return pmJson({ details: { installed_count: 1 } });
      }

      if (cmd === "package") {
        const sub = pmArgs[1];
        if (sub === "catalog") {
          return pmJson({
            details: {
              total: 9,
              packages: [
                "beads",
                "calendar",
                "governance-audit",
                "guide-shell",
                "lifecycle-hooks",
                "linked-test-adapters",
                "search-advanced",
                "templates",
                "todos",
              ].map((alias) => ({ alias })),
            },
          });
        }
        if (sub === "list") {
          return pmJson({ action: "catalog", details: { total: 9 } });
        }
        if (sub === "doctor") {
          return pmJson({
            details: {
              summary: { activation_failure_count: 0, blocking_failure_count: 0 },
              triage: { warning_codes: [] },
            },
          });
        }
        if (sub === "init") {
          return pmJson({ details: { extension: { command: "scaffold-package ping" } } });
        }
      }

      if (cmd === "scaffold-package") {
        return pmJson({ ok: true, command: "scaffold-package ping" });
      }
      if (cmd === "guide" && pmArgs.includes("--list")) {
        return pmJson({ topics: [{ id: "workflows" }] });
      }
      if (cmd === "dedupe-audit") {
        return pmJson({ clusters: [] });
      }
      if (cmd === "comments-audit") {
        return pmJson({ items: [] });
      }
      if (cmd === "normalize") {
        return pmJson({ dry_run: true });
      }
      if (cmd === "test-runs" && pmArgs[1] === "list") {
        return pmJson({ runs: [] });
      }
      if (cmd === "templates" && pmArgs[1] === "save") {
        return pmJson({ name: "dogfood-defaults" });
      }
      if (cmd === "templates" && pmArgs[1] === "show") {
        return pmJson({ options: { tags: "dogfood,templates" } });
      }
      if (cmd === "beads" && pmArgs[1] === "import") {
        return pmJson({ imported: 1 });
      }
      if (cmd === "todos" && pmArgs[1] === "export") {
        return pmJson({ exported: 1 });
      }
      if (cmd === "upgrade" && pmArgs.includes("--packages-only")) {
        return pmJson({ summary: { requested_packages: true, failed: 0 } });
      }
      if (cmd === "upgrade" && pmArgs.includes("--dry-run")) {
        return pmJson({
          dry_run: true,
          summary: { requested_cli: true, requested_packages: true },
        });
      }

      if (cmd === "plan") {
        const sub = pmArgs[1];
        if (sub === "create") return pmJson({ plan: { id: planId } });
        if (sub === "add-step") {
          planAddStepCount += 1;
          return pmJson({ step: { id: `plan-step-00${planAddStepCount}` } });
        }
        if (sub === "update-step") return pmJson({ step: { status: "in_progress" } });
        if (sub === "complete-step") return pmJson({ step: { status: "completed" } });
        if (sub === "decision") return pmJson({ plan: { decisions: [{}] } });
        if (sub === "discovery") return pmJson({ plan: { discoveries: [{}] } });
        if (sub === "validation") return pmJson({ plan: { validation: [{}] } });
        if (sub === "resume") return pmJson({ plan: { resume_context: "step 2 pending; materialize next" } });
        if (sub === "approve") return pmJson({ plan: { mode: "approved" } });
        if (sub === "materialize") return pmJson({ materialized: [{ id: "pm-materialized-1" }] });
        if (sub === "show" && pmArgs.includes("--depth")) return pmJson({ plan: { steps: [{}, {}] } });
        if (sub === "show" && pmArgs.includes("--fields")) {
          return pmJson({
            plan: {
              id: planId,
              title: "Dogfood plan workflow",
              steps_summary: { total: 2 },
            },
          });
        }
      }

      if (cmd === "history" && pmArgs.includes("--verify")) {
        return pmJson({ verification: { ok: true } });
      }
      if (cmd === "search" && pmArgs[1] === "exponential dogfood") {
        return pmJson({ items: [] });
      }
      if (cmd === "history-redact" && pmArgs.includes("--dry-run")) {
        return pmJson({ changed: true, history: { audit_entry_added: false } });
      }
      if (cmd === "history-redact") {
        return pmJson({ changed: true, history: { audit_entry_added: true, verify_ok: true } });
      }
      if (cmd === "health" && pmArgs.includes("--brief")) {
        return pmJson({ projection: { mode: "brief" } });
      }

      return pmJson({ ok: true });
    });

    const mkdirSyncMock = vi.fn();
    const mkdtempSyncMock = vi.fn(() => "/tmp/pm-dogfood-wave3");
    const readdirSyncMock = vi.fn(() => ["README.md", "scripts", ".hidden"]);
    const rmSyncMock = vi.fn();
    const writeFileSyncMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawnSync }));
    vi.doMock("node:fs", () => ({
      mkdirSync: mkdirSyncMock,
      mkdtempSync: mkdtempSyncMock,
      readdirSync: readdirSyncMock,
      rmSync: rmSyncMock,
      writeFileSync: writeFileSyncMock,
    }));

    delete process.env.PM_DOGFOOD_SEMANTIC;
    process.argv = ["node", "scripts/dogfood-package-first.mjs"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await importRepoModule("scripts/dogfood-package-first.mjs", "dogfoodPackageFirstSuccess");

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      semantic_dogfood: { attempted: boolean; skipped_reason: string };
      commands: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.semantic_dogfood.attempted).toBe(false);
    expect(payload.semantic_dogfood.skipped_reason).toContain("PM_DOGFOOD_SEMANTIC not set");
    expect(payload.commands).toBeGreaterThan(20);
    expect(spawnSync).toHaveBeenCalled();
    expect(rmSyncMock).toHaveBeenCalled();
  });
});

describe("lane-c scripts wave4: targeted zero-coverage scripts", () => {
  it("covers generate-release-notes output path plus help/unknown exits", async () => {
    const changelog = [
      "# Changelog",
      "",
      "## [2026.6.14]",
      "- Added deterministic release smoke coverage.",
      "",
      "## [Unreleased]",
      "- Ongoing work.",
    ].join("\n");
    const writeFileSync = vi.fn();
    const readFileSync = vi.fn((target: string) => {
      if (target.endsWith("CHANGELOG.md")) {
        return changelog;
      }
      if (target.endsWith("package.json")) {
        return JSON.stringify({ version: "2026.6.14" });
      }
      throw new Error(`Unexpected readFileSync target: ${target}`);
    });
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "git" && args[0] === "log") {
        const tag = String(args[3] ?? "");
        return tag === "v2026.6.13" ? "2026-06-13T00:00:00.000Z\n" : "2026-06-14T00:00:00.000Z\n";
      }
      throw new Error(`Unexpected execFileSync: ${command} ${args.join(" ")}`);
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync,
      writeFileSync,
    }));

    process.argv = [
      "node",
      "scripts/generate-release-notes.mjs",
      "--version",
      "2026.6.14",
      "--from",
      "v2026.6.13",
      "--output",
      "release-notes.md",
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModule("scripts/generate-release-notes.mjs", "generateReleaseNotesOutput");

    const written = String(writeFileSync.mock.calls.at(-1)?.[1] ?? "");
    expect(written).toContain("# @unbrained/pm-cli 2026.6.14");
    expect(written).toContain("Source range: v2026.6.13...v2026.6.14");
    expect(written).toContain("dist/cli.js is not built; pm tracker summary skipped.");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Wrote release notes"));

    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn() }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(),
    }));
    const helpExit = mockProcessExit();
    process.argv = ["node", "scripts/generate-release-notes.mjs", "--help"];
    await expect(importRepoModule("scripts/generate-release-notes.mjs", "generateReleaseNotesHelp")).rejects.toThrow(
      "EXIT:0",
    );
    helpExit.mockRestore();

    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFileSync: vi.fn() }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(),
    }));
    const failExit = mockProcessExit();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "scripts/generate-release-notes.mjs", "--mystery"];
    await expect(
      importRepoModule("scripts/generate-release-notes.mjs", "generateReleaseNotesUnknownFlag"),
    ).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain('Unknown flag "--mystery"');
    failExit.mockRestore();
  });

  it("covers verify-published-release success and executor mismatch failure", async () => {
    const mkdtempSyncMock = vi.fn(() => "/tmp/verify-published-wave4");
    const rmSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      mkdtempSync: mkdtempSyncMock,
      rmSync: rmSyncMock,
    }));

    const runCommandSuccess = vi.fn((command: string, args: string[]) => {
      if (command === "npm" && args[0] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({
            version: "2026.6.14",
            dist: { integrity: "sha512-wave4", unpackedSize: 12345 },
          }),
          stderr: "",
        };
      }
      if (command === "npx" || command === "bunx") {
        return { status: 0, stdout: "2026.6.14\n", stderr: "" };
      }
      if (command === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({
            tagName: "v2026.6.14",
            name: "v2026.6.14",
            isDraft: false,
            isPrerelease: false,
            url: "https://example.test/release/v2026.6.14",
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        commandFor(binary: string) {
          return binary;
        },
        runCommand: runCommandSuccess,
        fail(message: string, exitCode = 1) {
          throw new Error(`FAIL:${exitCode}:${message}`);
        },
      };
    });

    process.argv = [
      "node",
      "scripts/release/verify-published-release.mjs",
      "--version",
      "2026.6.14",
      "--json",
      "--npm-attempts",
      "1",
      "--executor-attempts",
      "1",
    ];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await importRepoModule("scripts/release/verify-published-release.mjs", "verifyPublishedReleaseSuccess");
    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
      ok: boolean;
      package: {
        npm: { ok: boolean };
        npx: { direct: { ok: boolean }; package: { ok: boolean } };
        bunx: { ok: boolean };
      };
      github_release: { tagName: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.package.npm.ok).toBe(true);
    expect(payload.package.npx.direct.ok).toBe(true);
    expect(payload.package.npx.package.ok).toBe(true);
    expect(payload.package.bunx.ok).toBe(true);
    expect(payload.github_release.tagName).toBe("v2026.6.14");
    expect(rmSyncMock).toHaveBeenCalled();

    vi.resetModules();
    vi.doMock("node:fs", () => ({
      mkdtempSync: vi.fn(() => "/tmp/verify-published-wave4-fail"),
      rmSync: vi.fn(),
    }));
    const runCommandFailure = vi.fn((command: string, args: string[]) => {
      if (command === "npm" && args[0] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ version: "2026.6.14", dist: { integrity: "sha", unpackedSize: 1 } }),
          stderr: "",
        };
      }
      if (command === "npx") {
        return { status: 0, stdout: "0.0.0\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.doMock("../../../scripts/release/utils.mjs", async () => {
      const actual = await vi.importActual<typeof import("../../../scripts/release/utils.mjs")>(
        "../../../scripts/release/utils.mjs",
      );
      return {
        ...actual,
        commandFor(binary: string) {
          return binary;
        },
        runCommand: runCommandFailure,
        fail(message: string, exitCode = 1) {
          throw new Error(`FAIL:${exitCode}:${message}`);
        },
      };
    });
    process.argv = [
      "node",
      "scripts/release/verify-published-release.mjs",
      "--version",
      "2026.6.14",
      "--skip-github-release",
      "--npm-attempts",
      "1",
      "--executor-attempts",
      "1",
    ];
    await expect(
      importRepoModule("scripts/release/verify-published-release.mjs", "verifyPublishedReleaseMismatch"),
    ).rejects.toThrow("npx-direct verification failed");
  });

  it("covers smoke-claude-plugin happy path and missing-file guard", async () => {
    const requiredTools = [
      "pm_run",
      "pm_context",
      "pm_search",
      "pm_list",
      "pm_get",
      "pm_create",
      "pm_copy",
      "pm_update",
      "pm_append",
      "pm_claim",
      "pm_release",
      "pm_close",
      "pm_comments",
      "pm_files",
      "pm_docs",
      "pm_notes",
      "pm_learnings",
      "pm_deps",
      "pm_test",
      "pm_validate",
      "pm_health",
      "pm_contracts",
      "pm_schema",
      "pm_config",
      "pm_plan",
    ];

    const request = vi.fn(async (method: string) => {
      if (method === "initialize") {
        return { instructions: "Use pm_context before mutation tools." };
      }
      if (method === "tools/list") {
        return { tools: requiredTools.map((name) => ({ name })) };
      }
      return {};
    });
    const callTool = vi.fn(async (toolName: string) => {
      if (toolName === "pm_create") {
        return { item: { id: "pm-claude-smoke-1" } };
      }
      if (toolName === "pm_get") {
        return {
          item: { status: "in_progress" },
          linked: { files: [{ path: "README.md" }], tests: [{ command: "node --version" }] },
        };
      }
      return { ok: true };
    });
    const dispose = vi.fn(async () => undefined);
    const startPluginMcpSmoke = vi.fn(async () => ({
      tmpRoot: "/tmp/pm-claude-wave4",
      request,
      callTool,
      dispose,
    }));

    vi.doMock("../../../scripts/plugin-mcp-smoke-harness.mjs", () => ({
      startPluginMcpSmoke,
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((target: string) => {
        if (target.endsWith(path.join(".claude-plugin", "marketplace.json"))) {
          return JSON.stringify({ name: "pm", plugins: [{ name: "pm-claude" }] });
        }
        if (target.endsWith(path.join("plugins", "pm-claude", ".claude-plugin", "plugin.json"))) {
          return JSON.stringify({ name: "pm-claude" });
        }
        return "{}";
      }),
    }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() => ""),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModule("scripts/smoke-claude-plugin.mjs", "smokeClaudePluginSuccess");
    expect(startPluginMcpSmoke).toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith("pm_validate", expect.any(Object));
    expect(callTool).toHaveBeenCalledWith("pm_health", expect.any(Object));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Claude Code plugin smoke passed");

    vi.resetModules();
    const startPluginMcpSmokeNever = vi.fn();
    vi.doMock("../../../scripts/plugin-mcp-smoke-harness.mjs", () => ({
      startPluginMcpSmoke: startPluginMcpSmokeNever,
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "{}"),
    }));
    await expect(importRepoModule("scripts/smoke-claude-plugin.mjs", "smokeClaudePluginMissingFile")).rejects.toThrow(
      "Missing plugin file",
    );
    expect(startPluginMcpSmokeNever).not.toHaveBeenCalled();
  });

  it("covers smoke-npx-from-pack fallback plus cleanup warning path", async () => {
    const cleanupTempRoot = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    vi.doMock("../../../scripts/smoke-cleanup.mjs", () => ({
      cleanupTempRoot,
    }));
    vi.doMock("node:fs", () => ({
      mkdirSync: vi.fn(),
      mkdtempSync: vi.fn(() => "/tmp/pm-pack-smoke-wave4"),
    }));

    let npxVersionFailedOnce = false;
    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === "npm" && args[0] === "pack") {
        return "pm-cli-2026.6.14.tgz\n";
      }
      if (command === "npm" && args[0] === "exec") {
        return "2026.6.14\n";
      }
      if (command === "npx" && String(args[1] ?? "").startsWith("file:")) {
        if (args.includes("--version")) {
          return "2026.6.14\n";
        }
        if (args.includes("--help")) {
          return "Usage: pm\n";
        }
      }
      if (command === "npx" && args.includes("--package") && args.includes("pm-cli")) {
        if (args.includes("--version")) {
          return "2026.6.14\n";
        }
        if (args.includes("--help")) {
          return "Usage: pm-cli\n";
        }
      }
      if (command === "npx" && args.includes("--package") && args.includes("pm")) {
        const pmArgs = args.slice(args.indexOf("pm") + 1);
        const commandName = pmArgs[0];
        if (commandName === "--version") {
          if (!npxVersionFailedOnce) {
            npxVersionFailedOnce = true;
            const error = new Error("npx direct package failed") as Error & { stderr?: string };
            error.stderr = "npx stderr";
            throw error;
          }
          return "2026.6.14\n";
        }
        if (commandName === "init") {
          return JSON.stringify({ ok: true });
        }
        if (commandName === "install") {
          return JSON.stringify({ details: { installed_all: true, installed_count: 9 } });
        }
        if (commandName === "package" && pmArgs[1] === "catalog") {
          return JSON.stringify({
            details: {
              packages: [{ alias: "a" }, { alias: "b" }, { alias: "c" }, { alias: "d" }],
            },
          });
        }
        if (commandName === "create") {
          return JSON.stringify({ item: { id: "pm-pack-smoke-item" } });
        }
        if (commandName === "calendar") {
          return JSON.stringify({ summary: { events: 1 } });
        }
        if (commandName === "upgrade") {
          return JSON.stringify({ summary: { requested_packages: true }, packages: [] });
        }
        return "{}";
      }
      return "";
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.argv = ["node", path.join(process.cwd(), "scripts/smoke-npx-from-pack.mjs")];
    await importRepoModule("scripts/smoke-npx-from-pack.mjs", "smokeNpxFromPackWave4");
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("npx packed package smoke passed");
    expect(cleanupTempRoot).toHaveBeenCalledWith("/tmp/pm-pack-smoke-wave4");
    expect(String(warnSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("[pm-pack-smoke] cleanup warning");
  });

  it("covers run-tests mode validation and spawn branches", async () => {
    const mkdtempMock = vi.fn(async () => "/tmp/pm-run-tests-wave4");
    const rmMock = vi.fn(async () => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const closeChild = (code: number) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", code, null));
      return child as never;
    };
    const errorChild = (error: Error) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", error));
      return child as never;
    };

    const invalidSpawn = vi.fn(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn: invalidSpawn }));
    vi.doMock("node:fs/promises", () => ({
      mkdtemp: mkdtempMock,
      rm: rmMock,
    }));
    process.argv = ["node", "scripts/run-tests.mjs", "invalid-mode"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsInvalidModeWave4");
    expect(process.exitCode).toBe(2);
    expect(invalidSpawn).not.toHaveBeenCalled();

    vi.resetModules();
    const skipBuildSpawn = vi.fn(() => closeChild(0));
    vi.doMock("node:child_process", () => ({ spawn: skipBuildSpawn }));
    vi.doMock("node:fs/promises", () => ({
      mkdtemp: mkdtempMock,
      rm: rmMock,
    }));
    process.env.PM_RUN_TESTS_SKIP_BUILD = "1";
    process.argv = ["node", "scripts/run-tests.mjs", "coverage", "--", "tests/unit/check-secrets.spec.ts"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsSkipBuildWave4");
    expect(skipBuildSpawn).toHaveBeenCalledTimes(1);
    expect(skipBuildSpawn.mock.calls.at(0)?.[0]).toBe(process.execPath);
    expect(skipBuildSpawn.mock.calls.at(0)?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join("node_modules", "vitest", "vitest.mjs")),
        "run",
        "--coverage",
        "tests/unit/check-secrets.spec.ts",
      ]),
    );
    expect(process.exitCode).toBe(0);

    vi.resetModules();
    const spawnError = new Error("spawn failed");
    const errorSpawn = vi.fn(() => errorChild(spawnError));
    vi.doMock("node:child_process", () => ({ spawn: errorSpawn }));
    vi.doMock("node:fs/promises", () => ({
      mkdtemp: mkdtempMock,
      rm: rmMock,
    }));
    delete process.env.PM_RUN_TESTS_SKIP_BUILD;
    process.argv = ["node", "scripts/run-tests.mjs", "test"];
    await importRepoModule("scripts/run-tests.mjs", "runTestsSpawnErrorWave4");
    expect(process.exitCode).toBe(1);
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Failed to run sandboxed tests");
    expect(rmMock).toHaveBeenCalledWith("/tmp/pm-run-tests-wave4", { recursive: true, force: true });
  });

  it("covers plugin-mcp-smoke-harness request/call parsing and disposal paths", async () => {
    const readlineEmitter = new EventEmitter();
    const createInterface = vi.fn(() => readlineEmitter);
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();
    const kill = vi.fn();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdin: { write: stdinWrite, end: stdinEnd },
      stdout: new EventEmitter(),
      stderr,
      kill,
    });

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => child),
    }));
    vi.doMock("node:fs/promises", () => ({
      mkdtemp: vi.fn(async () => "/tmp/pm-mcp-harness-wave4"),
      rm: vi.fn(async () => undefined),
    }));
    vi.doMock("node:readline", () => ({
      default: { createInterface },
      createInterface,
    }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harnessModule = await importRepoModule<typeof import("../../../scripts/plugin-mcp-smoke-harness.mjs")>(
      "scripts/plugin-mcp-smoke-harness.mjs",
      "pluginMcpHarnessWave4",
    );
    const harness = await harnessModule.startPluginMcpSmoke({
      serverPath: "/tmp/mock-plugin-server.mjs",
      author: "lane-c-wave4",
      tmpPrefix: "pm-harness-wave4-",
      requestTimeoutMs: 50,
    });

    const initializePromise = harness.request("initialize", { ping: true });
    const initializeId = JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
    readlineEmitter.emit("line", JSON.stringify({ jsonrpc: "2.0", id: initializeId, result: { instructions: "ok" } }));
    await expect(initializePromise).resolves.toEqual({ instructions: "ok" });

    const structuredToolPromise = harness.callTool("pm_get", { id: "pm-1" });
    const structuredToolId = JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
    readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: structuredToolId,
        result: {
          isError: false,
          structuredContent: { result: { item: { id: "pm-1" } } },
          content: [{ text: "{}" }],
        },
      }),
    );
    await expect(structuredToolPromise).resolves.toEqual({ item: { id: "pm-1" } });

    const parsedToolPromise = harness.callTool("pm_context", {});
    const parsedToolId = JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
    readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsedToolId,
        result: {
          isError: false,
          content: [{ text: "{\"ok\":true}" }],
        },
      }),
    );
    await expect(parsedToolPromise).resolves.toEqual({ ok: true });

    const toolErrorPromise = harness.callTool("pm_update", {});
    const toolErrorId = JSON.parse(String(stdinWrite.mock.calls.at(-1)?.[0] ?? "{}")).id;
    readlineEmitter.emit(
      "line",
      JSON.stringify({
        jsonrpc: "2.0",
        id: toolErrorId,
        result: {
          isError: true,
          content: [{ text: "mock tool failure" }],
        },
      }),
    );
    await expect(toolErrorPromise).rejects.toThrow("pm_update returned isError: mock tool failure");

    readlineEmitter.emit("line", "not-json");
    stderr.emit("data", Buffer.from("stderr line\n"));
    await harness.dispose();
    expect(stdinEnd).toHaveBeenCalled();
    expect(kill).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("ignored non-JSON stdout");
    expect(String(errorSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("stderr line");
  });

  it("covers plugin-mcp-smoke-harness request timeout branch", async () => {
    const createInterface = vi.fn(() => new EventEmitter());
    const child = Object.assign(new EventEmitter(), {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => child),
    }));
    vi.doMock("node:fs/promises", () => ({
      mkdtemp: vi.fn(async () => "/tmp/pm-mcp-harness-timeout"),
      rm: vi.fn(async () => undefined),
    }));
    vi.doMock("node:readline", () => ({
      default: { createInterface },
      createInterface,
    }));

    const harnessModule = await importRepoModule<typeof import("../../../scripts/plugin-mcp-smoke-harness.mjs")>(
      "scripts/plugin-mcp-smoke-harness.mjs",
      "pluginMcpHarnessTimeoutWave4",
    );
    const harness = await harnessModule.startPluginMcpSmoke({
      serverPath: "/tmp/mock-plugin-server-timeout.mjs",
      author: "lane-c-wave4-timeout",
      tmpPrefix: "pm-harness-timeout-",
      requestTimeoutMs: 5,
    });
    await expect(harness.request("tools/list")).rejects.toThrow("Timed out waiting for tools/list");
    await harness.dispose();
  });

  it("covers check-secrets script clean and secret findings paths", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "README.md\0binary.bin\0deleted.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn((target: string) => {
        if (target === "README.md") {
          return Buffer.from("Docs only; no secrets.");
        }
        if (target === "binary.bin") {
          return Buffer.from([0, 1, 2, 3]);
        }
        if (target === "deleted.txt") {
          throw Object.assign(new Error("removed"), { code: "ENOENT" });
        }
        return Buffer.from("");
      }),
    }));
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await importRepoModule("scripts/check-secrets.mjs", "checkSecretsCleanWave4");
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("No credential-like secrets detected");

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "leak.txt\0"),
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => Buffer.from(`token ghp_${"A1b2C3d4".repeat(5)}`)),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = mockProcessExit();
    process.argv = ["node", path.join(process.cwd(), "scripts/check-secrets.mjs")];
    await expect(importRepoModule("scripts/check-secrets.mjs", "checkSecretsLeakWave4")).rejects.toThrow("EXIT:1");
    expect(String(errorSpy.mock.calls.at(0)?.[0] ?? "")).toContain("Potential secrets detected:");
    exitSpy.mockRestore();
  });
});
