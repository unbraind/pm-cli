import { Buffer } from "node:buffer";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptHarness } from "../../../helpers/scriptModule";

const harness = createScriptHarness([
  "../../../../scripts/release/utils.mjs",
  "../../../../scripts/release/release-relevance.mjs",
]);

const SCRIPT = "scripts/release/run-release-pipeline.mjs";

type PipelineModule = {
  usage: () => void;
  getLastTag: () => string | null;
  getCommitCountSince: (lastTag: string | null) => number;
  getChangedFilesSince: (lastTag: string | null) => string[];
  listTodayTags: (todayKey: string) => string[];
  ensureCleanWorkingTree: () => void;
  resolveVersion: (explicit: string | null, allowSameDay: boolean, todayKey: string) => string;
  bumpSameDayOrdinal: (version: string, todayKey: string) => string;
  parseCalendarVersion: (version: string) => { dateKey: string; ordinal: number } | null;
  readPackageVersion: () => string;
  extractGeneratedChangelogSection: (changelog: string, heading: string) => string | null;
  ensureGeneratedReleaseSectionHasContent: (version: string, changelogPath?: string) => boolean;
  runReleaseGates: (options: {
    telemetryMode: string;
    skipCompatibility: boolean;
    skipTelemetrySentry: boolean;
  }) => { ok: boolean; telemetry_mode: string };
  withReleasePushCredentials: (
    options?: { env?: Record<string, string> } | null,
    token?: string,
  ) => { env?: Record<string, string> };
  pushReleaseRefs: (tagName: string, options?: { env?: Record<string, string> }) => { retried: boolean };
  runPipeline: () => void;
};

function mockUtils(runCommand: ReturnType<typeof vi.fn>, repoRoot?: string): void {
  vi.doMock("../../../../scripts/release/utils.mjs", async () => {
    const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(
      "../../../../scripts/release/utils.mjs",
    );
    return {
      ...actual,
      ...(repoRoot ? { repoRoot } : {}),
      runCommand,
      fail(message: string, exitCode = 1) {
        throw new Error(`FAIL:${exitCode}:${message}`);
      },
    };
  });
}

function baseGitMock(overrides: (command: string, args: string[]) => unknown | undefined): ReturnType<typeof vi.fn> {
  return vi.fn((command: string, args: string[]) => {
    const custom = overrides(command, args);
    if (custom !== undefined) {
      return custom;
    }
    if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
    if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "3\n", stderr: "" };
    if (command === "git" && args[0] === "diff") return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
    if (command === "git" && args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
}

describe("run-release-pipeline", () => {
  describe("exported helpers", () => {
    it("covers usage()", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModule<PipelineModule>(SCRIPT, "usage");
      mod.usage();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Usage:"))).toBe(true);
    });

    it("runPipeline prints usage and returns early on --help", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModule<PipelineModule>(SCRIPT, "help");
      process.argv = ["node", "x", "--help"];
      mod.runPipeline();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Usage:"))).toBe(true);
    });

    it("covers parseCalendarVersion and bumpSameDayOrdinal", async () => {
      const mod = await harness.importModule<PipelineModule>(SCRIPT, "parse");
      expect(mod.parseCalendarVersion("2026.6.15")).toEqual({ dateKey: "2026.6.15", ordinal: 1 });
      expect(mod.parseCalendarVersion("2026.6.15-3")).toEqual({ dateKey: "2026.6.15", ordinal: 3 });
      expect(mod.parseCalendarVersion("not-a-version")).toBeNull();

      expect(mod.bumpSameDayOrdinal("2026.6.15", "2026.6.15")).toBe("2026.6.15-2");
      expect(mod.bumpSameDayOrdinal("2026.6.15-4", "2026.6.15")).toBe("2026.6.15-5");
    });

    it("covers bumpSameDayOrdinal mismatch failure", async () => {
      vi.doMock("../../../../scripts/release/utils.mjs", async () => {
        const actual = await vi.importActual<typeof import("../../../../scripts/release/utils.mjs")>(
          "../../../../scripts/release/utils.mjs",
        );
        return {
          ...actual,
          fail(message: string, exitCode = 1) {
            throw new Error(`FAIL:${exitCode}:${message}`);
          },
        };
      });
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(() => mod.bumpSameDayOrdinal("2026.6.14", "2026.6.15")).toThrow(/Automatic same-day ordinal bump/);
    });

    it("covers extractGeneratedChangelogSection variants", async () => {
      const mod = await harness.importModule<PipelineModule>(SCRIPT, "extract");
      const changelog = [
        "# Changelog",
        "",
        "## [2026.6.15]",
        "",
        "### Added",
        "- A feature",
        "",
        "## [2026.6.14]",
        "- Older",
      ].join("\n");
      expect(mod.extractGeneratedChangelogSection(changelog, "2026.6.15")).toContain("A feature");
      expect(mod.extractGeneratedChangelogSection(changelog, "2026.6.14")).toContain("Older");
      expect(mod.extractGeneratedChangelogSection(changelog, "2026.1.1")).toBeNull();
      const plain = ["## 2026.6.15", "- plain"].join("\n");
      expect(mod.extractGeneratedChangelogSection(plain, "2026.6.15")).toContain("plain");
    });

    it("covers ensureGeneratedReleaseSectionHasContent true and false", async () => {
      const root = await harness.createTempRoot("pm-pipeline-changelog-");
      const withSection = path.join(root, "with.md");
      const empty = path.join(root, "empty.md");
      const fs = await import("node:fs");
      fs.writeFileSync(withSection, "## [2026.6.15]\n\n- item\n", "utf8");
      fs.writeFileSync(empty, "# Changelog\n", "utf8");
      const mod = await harness.importModule<PipelineModule>(SCRIPT, "ensure");
      expect(mod.ensureGeneratedReleaseSectionHasContent("2026.6.15", withSection)).toBe(true);
      expect(mod.ensureGeneratedReleaseSectionHasContent("2026.6.15", empty)).toBe(false);
    });

    it("covers git helpers (getLastTag null + value, count, changed-files, today-tags)", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
        if (args[0] === "rev-list" && args.includes("v2026.6.13..HEAD")) {
          return { status: 0, stdout: "5\n", stderr: "" };
        }
        if (args[0] === "rev-list") return { status: 0, stdout: "12\n", stderr: "" };
        if (args[0] === "diff") return { status: 0, stdout: "src/a.ts\n\n  src/b.ts \n", stderr: "" };
        if (args[0] === "ls-files") return { status: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" };
        if (args[0] === "tag") return { status: 0, stdout: "v2026.6.15\nv2026.6.15-2\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(mod.getLastTag()).toBe("v2026.6.13");
      expect(mod.getCommitCountSince("v2026.6.13")).toBe(5);
      expect(mod.getCommitCountSince(null)).toBe(12);
      expect(mod.getChangedFilesSince("v2026.6.13")).toEqual(["src/a.ts", "src/b.ts"]);
      expect(mod.getChangedFilesSince(null)).toEqual(["src/a.ts", "src/b.ts"]);
      expect(mod.listTodayTags("2026.6.15")).toEqual(["v2026.6.15", "v2026.6.15-2"]);
    });

    it("covers empty-stdout fallback in commit-count and changed-files", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args[0] === "rev-list") return { status: 0, stdout: "   \n", stderr: "" };
        if (args[0] === "diff" || args[0] === "ls-files") return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(mod.getCommitCountSince("v2026.6.13")).toBe(0);
      expect(mod.getCommitCountSince(null)).toBe(0);
      expect(mod.getChangedFilesSince("v2026.6.13")).toEqual([]);
      expect(mod.getChangedFilesSince(null)).toEqual([]);
    });

    it("covers getLastTag failure + empty tag branches", async () => {
      let mode = "fail";
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args[0] === "describe") {
          if (mode === "fail") return { status: 1, stdout: "", stderr: "no tags" };
          return { status: 0, stdout: "\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(mod.getLastTag()).toBeNull();
      mode = "empty";
      expect(mod.getLastTag()).toBeNull();
    });

    it("covers ensureCleanWorkingTree dirty failure", async () => {
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args[0] === "status") return { status: 0, stdout: " M file.ts\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(() => mod.ensureCleanWorkingTree()).toThrow(/clean working tree/);
    });

    it("covers resolveVersion explicit, today, and same-day-next paths + failure", async () => {
      let nextStdout = "2026.6.15-2\n";
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (args[0] === "scripts/release-version.mjs" && args[1] === "next") {
          return { status: 0, stdout: nextStdout, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(mod.resolveVersion("2026.6.15", false, "2026.6.15")).toBe("2026.6.15");
      expect(mod.resolveVersion(null, false, "2026.6.15")).toBe("2026.6.15");
      expect(mod.resolveVersion(null, true, "2026.6.15")).toBe("2026.6.15-2");
      nextStdout = "\n";
      expect(() => mod.resolveVersion(null, true, "2026.6.15")).toThrow(/next release version/);
    });

    it("covers runReleaseGates with skip flags", async () => {
      const calls: string[][] = [];
      const runCommand = vi.fn((command: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      const result = mod.runReleaseGates({ telemetryMode: "off", skipCompatibility: true, skipTelemetrySentry: true });
      expect(result.ok).toBe(true);
      expect(result.telemetry_mode).toBe("off");
      const gateArgs = calls.find((a) => a[0] === "scripts/release/run-gates.mjs");
      expect(gateArgs).toContain("--skip-compatibility");
      expect(gateArgs).toContain("--skip-telemetry-sentry");
    });

    it("covers runReleaseGates without skip flags", async () => {
      const calls: string[][] = [];
      const runCommand = vi.fn((command: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      const result = mod.runReleaseGates({
        telemetryMode: "best-effort",
        skipCompatibility: false,
        skipTelemetrySentry: false,
      });
      expect(result.ok).toBe(true);
      const gateArgs = calls.find((a) => a[0] === "scripts/release/run-gates.mjs");
      expect(gateArgs).not.toContain("--skip-compatibility");
      expect(gateArgs).not.toContain("--skip-telemetry-sentry");
    });

    it("readPackageVersion reads version from package.json under repoRoot", async () => {
      const root = await harness.createTempRoot("pm-pipeline-pkg-");
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");
      mockUtils(vi.fn(() => ({ status: 0, stdout: "", stderr: "" })), root);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(mod.readPackageVersion()).toBe("2026.6.13");
    });
  });

  describe("full pipeline", () => {
    it("skips on no-changes-since-last-tag (json + text)", async () => {
      const runCommand = baseGitMock((command, args) => {
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "0\n", stderr: "" };
        return undefined;
      });
      mockUtils(runCommand);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--json"];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.reason).toBe("no_changes_since_last_tag");

      vi.resetModules();
      mockUtils(runCommand);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod2 = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x"];
      mod2.runPipeline();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("No changes"))).toBe(true);
    });

    it("skips on tracker-only changes (json + text)", async () => {
      const trackerMock = baseGitMock((command, args) => {
        if (command === "git" && args[0] === "diff") {
          return { status: 0, stdout: ".agents/pm/tasks/pm-1.toon\n.agents/pm/history/pm-1.jsonl\n", stderr: "" };
        }
        return undefined;
      });
      mockUtils(trackerMock);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--json"];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.reason).toBe("tracker_only_changes_since_last_tag");

      vi.resetModules();
      mockUtils(trackerMock);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod2 = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x"];
      mod2.runPipeline();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("tracker changes"))).toBe(true);
    });

    it("skips on release-already-cut-today (json + text)", async () => {
      const runCommand = baseGitMock((command, args) => {
        if (command === "git" && args[0] === "tag") return { status: 0, stdout: "v2026.6.15\n", stderr: "" };
        return undefined;
      });
      mockUtils(runCommand);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--json"];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.reason).toBe("release_already_cut_today");

      vi.resetModules();
      mockUtils(runCommand);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod2 = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x"];
      mod2.runPipeline();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Release already exists"))).toBe(true);
    });

    it("fails on unsupported telemetry mode and unsupported version", async () => {
      const runCommand = baseGitMock(() => undefined);
      mockUtils(runCommand);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--telemetry-mode", "bogus"];
      expect(() => mod.runPipeline()).toThrow(/Unsupported --telemetry-mode/);

      vi.resetModules();
      mockUtils(runCommand);
      const mod2 = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--version", "not-a-version", "--dry-run"];
      expect(() => mod2.runPipeline()).toThrow(/Unsupported target version/);
    });

    it("dry-run with explicit version emits JSON result", async () => {
      const root = await harness.createTempRoot("pm-pipeline-dryjson-");
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");
      const runCommand = baseGitMock((command, args) => {
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "2\n", stderr: "" };
        return undefined;
      });
      mockUtils(runCommand, root);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--json", "--dry-run", "--version", "2026.6.15", "--telemetry-mode", "off"];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
        ok: boolean;
        skipped: boolean;
        dry_run: boolean;
        target_version: string;
        gates: { telemetry_mode: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.skipped).toBe(false);
      expect(payload.dry_run).toBe(true);
      expect(payload.target_version).toBe("2026.6.15");
      expect(payload.gates.telemetry_mode).toBe("off");
    });

    it("runs full non-dry-run path: changelog gen, commit, tag, push (json)", async () => {
      const root = await harness.createTempRoot("pm-pipeline-full-");
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");

      const gitCalls: string[][] = [];
      const runCommand = vi.fn((command: string, args: string[]) => {
        gitCalls.push([command, ...args]);
        if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "3\n", stderr: "" };
        if (command === "git" && args[0] === "diff") return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
        if (command === "git" && args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
        if (args.includes("changelog") && args.includes("generate")) {
          const outPath = args[args.indexOf("--output") + 1];
          fs.writeFileSync(outPath, "## [2026.6.15]\n\n- thing\n", "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand, root);

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = [
        "node",
        "x",
        "--json",
        "--version",
        "2026.6.15",
        "--telemetry-mode",
        "off",
        "--push",
        "--author",
        "Release Bot!!",
        "--release-notes-output",
        path.join(root, "notes.md"),
      ];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.skipped).toBe(false);
      expect(payload.target_version).toBe("2026.6.15");
      expect(payload.pushed).toBe(true);
      expect(payload.author).toBe("Release Bot!!");
      expect(gitCalls.some((c) => c[0] === "git" && c[1] === "commit")).toBe(true);
      expect(gitCalls.some((c) => c[0] === "git" && c[1] === "push")).toBe(true);
      expect(fs.existsSync(path.join(root, "CHANGELOG.md"))).toBe(true);
    });

    it("rebases and retargets the tag when release push sees origin/main advance", async () => {
      const gitCalls: string[][] = [];
      let pushAttempts = 0;
      const runCommand = vi.fn((command: string, args: string[]) => {
        gitCalls.push([command, ...args]);
        if (command === "git" && args[0] === "push") {
          pushAttempts += 1;
          if (pushAttempts === 1) {
            return {
              status: 1,
              stdout: "",
              stderr: "! [rejected] HEAD -> main (fetch first)\nerror: failed to push some refs",
            };
          }
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(mod.pushReleaseRefs("v2026.6.18")).toEqual({ retried: true });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("origin/main advanced"));
      expect(gitCalls).toEqual([
        ["git", "push", "--atomic", "origin", "HEAD", "v2026.6.18"],
        ["git", "fetch", "origin", "main"],
        ["git", "rebase", "origin/main"],
        ["git", "tag", "-f", "v2026.6.18", "HEAD"],
        ["git", "push", "--atomic", "origin", "HEAD", "v2026.6.18"],
      ]);
    });

    it("returns retried false when release push succeeds on the first attempt", async () => {
      const runCommand = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
      mockUtils(runCommand);

      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(mod.pushReleaseRefs("v2026.6.18")).toEqual({ retried: false });
      expect(runCommand).toHaveBeenCalledWith(
        "git",
        ["push", "--atomic", "origin", "HEAD", "v2026.6.18"],
        expect.objectContaining({ allowFailure: true }),
      );
    });

    it("scopes RELEASE_PUSH_TOKEN to git push without leaving it in child environments", async () => {
      process.env.RELEASE_PUSH_TOKEN = "release-token";
      const runCommand = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
      mockUtils(runCommand);

      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(process.env.RELEASE_PUSH_TOKEN).toBeUndefined();
      expect(mod.pushReleaseRefs("v2026.6.18", { env: { GIT_AUTHOR_NAME: "release-bot" } })).toEqual({
        retried: false,
      });
      const expectedHeader = `Authorization: Basic ${Buffer.from(
        "x-access-token:release-token",
        "utf8",
      ).toString("base64")}`;
      expect(runCommand).toHaveBeenCalledWith(
        "git",
        ["push", "--atomic", "origin", "HEAD", "v2026.6.18"],
        expect.objectContaining({
          allowFailure: true,
          env: {
            GIT_AUTHOR_NAME: "release-bot",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: expectedHeader,
          },
        }),
      );
      expect(mod.withReleasePushCredentials({ env: { GIT_AUTHOR_NAME: "release-bot" } }, "")).toEqual({
        env: { GIT_AUTHOR_NAME: "release-bot" },
      });
      expect(mod.withReleasePushCredentials({}, "release-token")).toEqual({
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: expectedHeader,
        },
      });
      expect(mod.withReleasePushCredentials(null, "release-token")).toEqual({
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: expectedHeader,
        },
      });
      expect(mod.withReleasePushCredentials({ env: { GIT_CONFIG_COUNT: "not-a-number" } }, "release-token")).toEqual({
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: expectedHeader,
        },
      });
      expect(
        mod.withReleasePushCredentials(
          {
            env: {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "safe.directory",
              GIT_CONFIG_VALUE_0: "/workspace/pm-cli",
            },
          },
          "release-token",
        ),
      ).toEqual({
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "/workspace/pm-cli",
          GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_1: expectedHeader,
        },
      });
    });

    it("aborts and fails when release push rebase cannot replay cleanly", async () => {
      const gitCalls: string[][] = [];
      const runCommand = vi.fn((command: string, args: string[]) => {
        gitCalls.push([command, ...args]);
        if (command === "git" && args[0] === "push") {
          return {
            status: 1,
            stdout: "",
            stderr: "Updates were rejected because the tip of your current branch is behind",
          };
        }
        if (command === "git" && args[0] === "rebase" && args[1] === "origin/main") {
          return {
            status: 1,
            stdout: "",
            stderr: "CONFLICT (content): Merge conflict in package.json",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);

      vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(() => mod.pushReleaseRefs("v2026.6.18", { env: { GIT_AUTHOR_NAME: "release-bot" } })).toThrow(
        "FAIL:1:Command failed: git rebase origin/main\nCONFLICT (content): Merge conflict in package.json",
      );
      expect(gitCalls).toEqual([
        ["git", "push", "--atomic", "origin", "HEAD", "v2026.6.18"],
        ["git", "fetch", "origin", "main"],
        ["git", "rebase", "origin/main"],
        ["git", "rebase", "--abort"],
      ]);
    });

    it("fails immediately when release push fails for a non-retryable reason", async () => {
      const gitCalls: string[][] = [];
      const runCommand = vi.fn((command: string, args: string[]) => {
        gitCalls.push([command, ...args]);
        if (command === "git" && args[0] === "push") {
          return {
            status: 1,
            stdout: "",
            stderr: "remote: permission denied\nerror: failed to push some refs to 'origin'",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);

      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(() => mod.pushReleaseRefs("v2026.6.18")).toThrow(
        "FAIL:1:Command failed: git push --atomic origin HEAD v2026.6.18\nremote: permission denied\nerror: failed to push some refs to 'origin'",
      );
      expect(gitCalls).toEqual([["git", "push", "--atomic", "origin", "HEAD", "v2026.6.18"]]);
    });

    it("fails when release push retry is still rejected after rebase", async () => {
      let pushAttempts = 0;
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (command === "git" && args[0] === "push") {
          pushAttempts += 1;
          return {
            status: 1,
            stdout: "",
            stderr: pushAttempts === 1
              ? "! [rejected] HEAD -> main (fetch first)"
              : "remote: protected branch update rejected",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand);

      vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      expect(() => mod.pushReleaseRefs("v2026.6.18")).toThrow(
        "FAIL:1:Command failed: git push --atomic origin HEAD v2026.6.18\nremote: protected branch update rejected",
      );
    });

    it("runs full non-dry-run path without push (text output)", async () => {
      const root = await harness.createTempRoot("pm-pipeline-nopush-");
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "3\n", stderr: "" };
        if (command === "git" && args[0] === "diff") return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
        if (command === "git" && args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
        if (args.includes("changelog") && args.includes("generate")) {
          const outPath = args[args.indexOf("--output") + 1];
          fs.writeFileSync(outPath, "## [2026.6.15]\n\n- thing\n", "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand, root);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--version", "2026.6.15", "--telemetry-mode", "off"];
      mod.runPipeline();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Release pipeline completed"))).toBe(true);
    });

    it("fails non-dry-run when generated changelog section empty and explicit version given", async () => {
      const root = await harness.createTempRoot("pm-pipeline-emptyexplicit-");
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "3\n", stderr: "" };
        if (command === "git" && args[0] === "diff") return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
        if (command === "git" && args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
        if (args.includes("changelog") && args.includes("generate")) {
          const outPath = args[args.indexOf("--output") + 1];
          fs.writeFileSync(outPath, "# Changelog\n", "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand, root);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--version", "2026.6.15", "--telemetry-mode", "off"];
      expect(() => mod.runPipeline()).toThrow(/missing a non-empty section/);
    });

    it("skips when generated changelog section empty and no explicit version (json + text)", async () => {
      const root = await harness.createTempRoot("pm-pipeline-emptyskip-");
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");

      function makeRunCommand(): ReturnType<typeof vi.fn> {
        return vi.fn((command: string, args: string[]) => {
          if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
          if (command === "git" && args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
          if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "3\n", stderr: "" };
          if (command === "git" && args[0] === "diff") return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
          if (command === "git" && args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
          if (args.includes("changelog") && args.includes("generate")) {
            const outPath = args[args.indexOf("--output") + 1];
            fs.writeFileSync(outPath, "# Changelog\n", "utf8");
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        });
      }

      mockUtils(makeRunCommand(), root);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--json", "--telemetry-mode", "off"];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.reason).toBe("empty_generated_changelog_section_for_target_version");

      vi.resetModules();
      mockUtils(makeRunCommand(), root);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod2 = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--telemetry-mode", "off"];
      mod2.runPipeline();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("no non-empty section"))).toBe(true);
    });

    it("dry-run with allow-same-day + explicit version (text output, no bump block)", async () => {
      const root = await harness.createTempRoot("pm-pipeline-sdexplicit-");
      const fs = await import("node:fs");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");
      const runCommand = baseGitMock(() => undefined);
      mockUtils(runCommand, root);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = [
        "node",
        "x",
        "--allow-same-day-release",
        "--dry-run",
        "--version",
        "2026.6.15",
        "--telemetry-mode",
        "off",
      ];
      mod.runPipeline();
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes("(dry run)"))).toBe(true);
    });

    it("allow-same-day without bump when previous version is an older date", async () => {
      const root = await harness.createTempRoot("pm-pipeline-nobump-");
      const fs = await import("node:fs");
      const today = new Date();
      const todayKey = `${today.getUTCFullYear()}.${today.getUTCMonth() + 1}.${today.getUTCDate()}`;
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.6.13" }), "utf8");
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "3\n", stderr: "" };
        if (command === "git" && args[0] === "diff") return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
        if (command === "git" && args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "scripts/release-version.mjs" && args[1] === "next") {
          return { status: 0, stdout: `${todayKey}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand, root);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      process.argv = ["node", "x", "--json", "--allow-same-day-release", "--dry-run", "--telemetry-mode", "off"];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.target_version).toBe(todayKey);
    });

    it("auto-runs runPipeline when imported as the CLI entrypoint", async () => {
      const runCommand = baseGitMock((command, args) => {
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "0\n", stderr: "" };
        return undefined;
      });
      mockUtils(runCommand);
      const scriptPath = path.join(process.cwd(), "scripts/release/run-release-pipeline.mjs");
      process.argv = ["node", scriptPath, "--json"];
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      // importModuleStable runs the module body without a cache-bust query so the
      // `import.meta.url === pathToFileURL(process.argv[1]).href` guard matches and
      // the CLI auto-run invokes runPipeline().
      await harness.importModuleStable(SCRIPT);
      await harness.waitForCondition(() => {
        expect(stdoutSpy).toHaveBeenCalled();
      });
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.reason).toBe("no_changes_since_last_tag");
    });

    it("bumps same-day ordinal when allow-same-day and previous version is today's date", async () => {
      const root = await harness.createTempRoot("pm-pipeline-sameday-");
      const fs = await import("node:fs");
      const today = new Date();
      const todayKey = `${today.getUTCFullYear()}.${today.getUTCMonth() + 1}.${today.getUTCDate()}`;
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: `${todayKey}` }), "utf8");
      const runCommand = vi.fn((command: string, args: string[]) => {
        if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
        if (command === "git" && args[0] === "describe") return { status: 0, stdout: "v2026.6.13\n", stderr: "" };
        if (command === "git" && args[0] === "rev-list") return { status: 0, stdout: "3\n", stderr: "" };
        if (command === "git" && args[0] === "diff") return { status: 0, stdout: "src/cli/main.ts\n", stderr: "" };
        if (command === "git" && args[0] === "tag") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "scripts/release-version.mjs" && args[1] === "next") {
          return { status: 0, stdout: `${todayKey}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      mockUtils(runCommand, root);
      const mod = await harness.importModuleStable<PipelineModule>(SCRIPT);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      process.argv = ["node", "x", "--json", "--allow-same-day-release", "--dry-run", "--telemetry-mode", "off"];
      mod.runPipeline();
      const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(payload.target_version).toBe(`${todayKey}-2`);
    });
  });
});
