import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { createScriptHarness } from "../../../helpers/scriptModule.js";
import type * as FirstRunModule from "../../../../scripts/release/packed-first-run.mjs";
import { readQuickstartCommands } from "../../../../scripts/release/packed-first-run.mjs";

describe("packed first run", () => {
  it("extracts the actual documented cold-start commands", async () => {
    const commands = readQuickstartCommands(
      await readFile("README.md", "utf8"),
    );
    expect(commands.map((args: string[]) => args[0])).toEqual([
      "init",
      "create",
      "list",
    ]);
    expect(commands[1]).toContain("Fix stale lock restore failure");
  });

  it("refuses missing, reordered, and shell-bearing quickstarts", () => {
    expect(() => readQuickstartCommands("# Other")).toThrow(
      "60 Second Example",
    );
    expect(() => readQuickstartCommands("## 60 Second Example\nEmpty")).toThrow(
      "bash block",
    );
    for (const command of [
      "pm init; evil",
      "other init",
      "pm list",
      'pm init "broken',
    ]) {
      expect(() =>
        readQuickstartCommands(
          `## 60 Second Example\n\`\`\`bash\n${command}\n\`\`\``,
        ),
      ).toThrow();
    }
    expect(
      readQuickstartCommands(
        "## 60 Second Example\n```bash\npm init\npm create 'example'\npm list\n```",
      ),
    ).toEqual([["init"], ["create", "example"], ["list"]]);
  });

  it("requires all platform and runtime combinations to consume the same packed artifact", async () => {
    const workflow = parse(
      await readFile(".github/workflows/ci.yml", "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          needs?: string;
          strategy?: { matrix: { os: string[]; node: Array<string | number> } };
          steps: Array<{ run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    const job = workflow.jobs["first-run"];
    expect(job.needs).toBe("build-foundation");
    expect(job.strategy?.matrix).toEqual({
      os: ["ubuntu-latest", "macos-latest", "windows-latest"],
      node: ["22.18.0", 24],
    });
    expect(
      job.steps.some((step) => step.with?.name === "packed-first-run"),
    ).toBe(true);
    const run = job.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("npm install --global --ignore-scripts");
    expect(run).toContain(
      'node scripts/release/packed-first-run.mjs "${package_root}"',
    );
    expect(run).toContain("pm --version");
    const install = run
      .split("\n")
      .find((line) => line.startsWith("npm install "));
    expect(install).toBeDefined();
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "pm-workflow-install-")),
    );
    try {
      for (const folder of ["fixture", "packed", "home"])
        await mkdir(path.join(root, folder));
      await writeFile(
        path.join(root, "fixture", "package.json"),
        JSON.stringify({ name: "packed-first-run-fixture", version: "1.0.0" }),
      );
      const execute = promisify(execFile);
      const env = {
        // Windows keeps the first case-insensitive key; inherited NPM_CONFIG_*
        // aliases must not override this fixture's lower-case npm settings.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !/^(?:npm_config_|home$|userprofile$)/iu.test(name),
          ),
        ),
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        npm_config_prefix: path.join(root, "prefix"),
        npm_config_cache: path.join(root, "cache"),
      };
      const { stdout: modules } = await execute(
        "bash",
        ["-c", "npm root --global"],
        {
          cwd: root,
          env,
          timeout: 15_000,
        },
      );
      const relativeModules = path.relative(
        path.join(root, "prefix"),
        modules.trim(),
      );
      expect(path.isAbsolute(relativeModules)).toBe(false);
      expect(
        relativeModules.split(path.sep),
        `npm root ${modules.trim()} must remain inside ${path.join(root, "prefix")}`,
      ).not.toContain("..");
      await execute(
        "bash",
        ["-c", "npm pack --ignore-scripts --pack-destination ../packed"],
        { cwd: path.join(root, "fixture"), env, timeout: 15_000 },
      );
      await execute("bash", ["-c", install ?? "exit 1"], {
        cwd: root,
        env,
        timeout: 15_000,
      });
      const installed = JSON.parse(
        await readFile(
          path.join(modules.trim(), "packed-first-run-fixture", "package.json"),
          "utf8",
        ),
      );
      expect(installed.version).toBe("1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);

  it("runs its CLI entrypoint and refuses an unspecified installation", async () => {
    const harness = createScriptHarness([]);
    const previous = process.argv;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      vi.resetModules();
      process.argv = [
        process.execPath,
        path.resolve("scripts/release/packed-first-run.mjs"),
        path.resolve("."),
      ];
      await harness.importModuleStable<typeof FirstRunModule>(
        "scripts/release/packed-first-run.mjs",
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"ok":true'));
      const receipt = JSON.parse(String(log.mock.calls[0][0]));
      expect(receipt).toMatchObject({
        ok: true,
        mcp: true,
        merge_history: true,
        detached_telemetry: true,
      });
      expect(receipt.steps).toHaveLength(3);
      vi.resetModules();
      process.argv = process.argv.slice(0, 2);
      await expect(
        harness.importModuleStable("scripts/release/packed-first-run.mjs"),
      ).rejects.toThrow("Pass the installed");
      vi.resetModules();
      process.argv = [];
      await harness.importModuleStable("scripts/release/packed-first-run.mjs");
    } finally {
      process.argv = previous;
      log.mockRestore();
    }
  }, 60_000);
});
