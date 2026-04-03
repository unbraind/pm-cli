import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EXIT_CODE } from "../../src/constants.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

function writeMockExtension(targetDir: string, name: string): void {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    path.join(targetDir, "manifest.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        entry: "index.js",
        capabilities: ["commands", "schema"],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(path.join(targetDir, "index.js"), "export default { activate() {} };", "utf8");
}

function installGitMock(): void {
  execFileMock.mockImplementation((command: string, args: string[], _options: unknown, callback: (error: Error | null, result?: { stdout?: string; stderr?: string }) => void) => {
    if (command !== "git") {
      callback(new Error(`Unexpected command: ${command}`));
      return;
    }

    if (args[0] === "clone") {
      const cloneDir = args.at(-1);
      const repository = args.at(-2);
      if (!cloneDir || !repository) {
        callback(new Error("Invalid clone invocation"));
        return;
      }

      if (repository.includes("/repo-fail.git")) {
        callback(new Error("fatal: repository not found"), { stderr: "fatal: repository not found" });
        return;
      }

      if (repository.includes("/repo-direct.git")) {
        writeMockExtension(path.join(cloneDir, "pi"), "github-direct-ext");
      } else if (repository.includes("/repo-default.git")) {
        writeMockExtension(path.join(cloneDir, ".agents", "pm", "extensions", "default-ext"), "github-default-ext");
      } else if (repository.includes("/repo-multiple.git")) {
        writeMockExtension(path.join(cloneDir, ".agents", "pm", "extensions", "a"), "github-multi-a");
        writeMockExtension(path.join(cloneDir, ".agents", "pm", "extensions", "b"), "github-multi-b");
      } else if (repository.includes("/repo-root.git")) {
        writeMockExtension(cloneDir, "github-root-ext");
      }

      callback(null, { stdout: "", stderr: "" });
      return;
    }

    if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "HEAD") {
      callback(null, { stdout: "deadbeefcafebabe\n", stderr: "" });
      return;
    }

    if (args[0] === "ls-remote") {
      callback(null, { stdout: "deadbeefcafebabe\tHEAD\n", stderr: "" });
      return;
    }

    callback(new Error(`Unhandled git args: ${args.join(" ")}`));
  });
}

describe("extension command github source handling", () => {
  it("installs from forced GitHub shorthand sources with deterministic metadata", async () => {
    installGitMock();
    const { runExtension } = await import("../../src/cli/commands/extension.js");
    await withTempPmPath(async (context) => {
      const result = await runExtension(
        undefined,
        { install: true, project: true, gh: "owner/repo-direct/pi", ref: "main" },
        { path: context.pmPath },
      );
      expect(result.details).toMatchObject({
        extension: {
          name: "github-direct-ext",
          directory: "github-direct-ext",
        },
        source: {
          kind: "github",
          owner: "owner",
          repo: "repo-direct",
          subpath: "pi",
          ref: "main",
          commit: "deadbeefcafebabe",
        },
      });
    });
  });

  it("accepts --github alias input for forced shorthand installs", async () => {
    installGitMock();
    const { runExtension } = await import("../../src/cli/commands/extension.js");
    await withTempPmPath(async (context) => {
      const result = await runExtension(
        undefined,
        { install: true, project: true, github: "owner/repo-direct/pi" },
        { path: context.pmPath },
      );
      expect(result.details).toMatchObject({
        source: {
          kind: "github",
          repo: "repo-direct",
          subpath: "pi",
        },
      });
    });
  });

  it("discovers default extension roots when no explicit subpath is provided", async () => {
    installGitMock();
    const { runExtension } = await import("../../src/cli/commands/extension.js");
    await withTempPmPath(async (context) => {
      const result = await runExtension(
        "https://github.com/owner/repo-default",
        { install: true, project: true },
        { path: context.pmPath },
      );
      expect(result.details).toMatchObject({
        extension: {
          name: "github-default-ext",
        },
        source: {
          kind: "github",
          subpath: ".agents/pm/extensions/default-ext",
        },
      });
    });
  });

  it("supports repository-root manifests for GitHub installs", async () => {
    installGitMock();
    const { runExtension } = await import("../../src/cli/commands/extension.js");
    await withTempPmPath(async (context) => {
      const result = await runExtension(
        "https://github.com/owner/repo-root",
        { install: true, project: true },
        { path: context.pmPath },
      );
      expect(result.details).toMatchObject({
        extension: {
          name: "github-root-ext",
        },
        source: {
          kind: "github",
          subpath: ".",
        },
      });
    });
  });

  it("returns usage errors for ambiguous or missing GitHub manifest discovery", async () => {
    installGitMock();
    const { runExtension } = await import("../../src/cli/commands/extension.js");
    await withTempPmPath(async (context) => {
      await expect(
        runExtension("https://github.com/owner/repo-multiple", { install: true, project: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(
        runExtension("https://github.com/owner/repo-missing", { install: true, project: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("returns generic failure when git clone fails", async () => {
    installGitMock();
    const { runExtension } = await import("../../src/cli/commands/extension.js");
    await withTempPmPath(async (context) => {
      await expect(
        runExtension("https://github.com/owner/repo-fail", { install: true, project: true }, { path: context.pmPath }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.GENERIC_FAILURE,
      });
    });
  });
});
