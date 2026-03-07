import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function extractSection(readme: string, startHeading: string, endHeading: string): string {
  const start = readme.indexOf(startHeading);
  if (start < 0) {
    throw new Error(`Missing README heading: ${startHeading}`);
  }

  const tail = readme.slice(start + startHeading.length);
  const end = tail.indexOf(endHeading);
  if (end < 0) {
    throw new Error(`Missing README heading: ${endHeading}`);
  }

  return tail.slice(0, end);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function extractBacktickPmCommands(section: string): string[] {
  return unique([...section.matchAll(/`pm ([a-z-]+)/g)].map((match) => match[1]));
}

function extractBacktickFlags(section: string): string[] {
  return unique([...section.matchAll(/`(--[a-z-]+)/g)].map((match) => match[1]));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

describe("README/help contract (sandboxed)", () => {
  it("keeps documented core command and flag sections aligned with CLI help", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    const coreSection = extractSection(
      readme,
      "### Core (implemented in v0.1)",
      "### Roadmap (post-v0.1 / partial areas)",
    );
    const roadmapSection = extractSection(readme, "### Roadmap (post-v0.1 / partial areas)", "### Global flags");
    const flagsSection = extractSection(readme, "### Global flags", "### `pm create` explicit-field contract");

    const documentedCoreCommands = extractBacktickPmCommands(coreSection);
    const documentedRoadmapCommands = extractBacktickPmCommands(roadmapSection);
    const documentedFlags = extractBacktickFlags(flagsSection);

    expect(documentedCoreCommands.length).toBeGreaterThan(0);
    expect(documentedFlags.length).toBeGreaterThan(0);

    await withTempPmPath(async (context) => {
      const help = context.runCli(["--help"]);
      expect(help.code).toBe(0);

      for (const command of documentedCoreCommands) {
        const commandRegex = new RegExp(String.raw`\n\s+${escapeRegExp(command)}(?:\s|\[|<)`);
        expect(help.stdout).toMatch(commandRegex);
      }

      for (const command of documentedRoadmapCommands) {
        const commandRegex = new RegExp(String.raw`\n\s+${escapeRegExp(command)}(?:\s|\[|<)`);
        expect(help.stdout).not.toMatch(commandRegex);
      }

      for (const flag of documentedFlags) {
        expect(help.stdout).toContain(flag);
      }
    });
  });

  it("describes reindex help text as keyword plus semantic/hybrid capable", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["reindex", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(
        "Rebuild deterministic search artifacts for keyword, semantic, and hybrid modes.",
      );
      expect(help.stdout).toContain("Reindex mode: keyword|semantic|hybrid");
    });
  });

  it("describes include-linked help text as keyword and hybrid lexical scoring", async () => {
    await withTempPmPath(async (context) => {
      const help = context.runCli(["search", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout.replaceAll(/\s+/g, " ").trim()).toContain(
        "Include readable linked docs/files/tests content in keyword and hybrid lexical scoring",
      );
    });
  });

  it("documents sandbox env variables for integration subprocesses", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");
    const testingSection = extractSection(
      readme,
      "## Testing and Coverage Policy",
      "## Community and Governance Files",
    );

    expect(testingSection).toContain("`PM_PATH` and `PM_GLOBAL_PATH`");
  });

  it("documents concrete raw installer URLs for bootstrap snippets", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");
    const installerSection = extractSection(readme, "### Installer scripts", "During development in this repo:");

    expect(installerSection).toContain("https://raw.githubusercontent.com/unbraind/pm-cli/main/scripts/install.sh");
    expect(installerSection).toContain("https://raw.githubusercontent.com/unbraind/pm-cli/main/scripts/install.ps1");
    expect(installerSection).toContain("`PM_CLI_PACKAGE`");
    expect(installerSection).not.toContain("<raw-url>");
  });

  it("keeps installer package override behavior aligned across shell and PowerShell scripts", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");
    const installerSection = extractSection(readme, "### Installer scripts", "During development in this repo:");
    const shellInstaller = await readFile(path.resolve(process.cwd(), "scripts/install.sh"), "utf8");
    const powershellInstaller = await readFile(path.resolve(process.cwd(), "scripts/install.ps1"), "utf8");

    expect(installerSection).toContain("Scoped package names such as `@scope/pkg` still honor `--version`");
    expect(installerSection).toContain("literal specs");
    expect(shellInstaller).toContain('PACKAGE_NAME="${PM_CLI_PACKAGE:-pm-cli}"');
    expect(shellInstaller).toContain("is_literal_install_spec");
    expect(shellInstaller).toContain('if is_literal_install_spec "$PACKAGE_NAME"; then');
    expect(shellInstaller).toContain('[[ "$name" == @*/*@* ]]');
    expect(powershellInstaller).toContain('[string]$PackageName = ""');
    expect(powershellInstaller).toContain("$envPackageName = $env:PM_CLI_PACKAGE");
    expect(powershellInstaller).toContain('$PackageName = "pm-cli"');
    expect(powershellInstaller).toContain("$PackageName = $envPackageName");
    expect(powershellInstaller).toContain("function Use-LiteralInstallSpec");
    expect(powershellInstaller).toContain('if ($Name.StartsWith("@"))');
    expect(powershellInstaller).toContain("if (Use-LiteralInstallSpec $PackageName)");
  });

  it("executes the README quickstart lifecycle in a temporary PM_PATH sandbox", async () => {
    await withTempPmPath(async (context) => {
      const init = context.runCli(["init", "--json"], { expectJson: true });
      expect(init.code).toBe(0);

      const create = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "README Quickstart Lifecycle",
          "--description",
          "Validate README quickstart command sequence.",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "docs,quickstart",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "90",
          "--acceptance-criteria",
          "Quickstart commands succeed in a sandbox.",
          "--author",
          "readme-test",
          "--message",
          "Create quickstart item",
          "--assignee",
          "none",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(create.code).toBe(0);

      const id = (create.json as { item: { id: string } }).item.id;

      const listOpen = context.runCli(["list-open", "--limit", "20", "--json"], { expectJson: true });
      expect(listOpen.code).toBe(0);

      const claim = context.runCli(["claim", id, "--json", "--author", "readme-test"], { expectJson: true });
      expect(claim.code).toBe(0);

      const update = context.runCli(
        [
          "update",
          id,
          "--json",
          "--status",
          "in_progress",
          "--acceptance-criteria",
          "Exact replay by version and timestamp",
          "--author",
          "readme-test",
          "--message",
          "Update quickstart acceptance criteria",
        ],
        { expectJson: true },
      );
      expect(update.code).toBe(0);

      const addFile = context.runCli(
        [
          "files",
          id,
          "--json",
          "--add",
          "path=src/cli/main.ts,scope=project,note=quickstart example",
          "--author",
          "readme-test",
          "--message",
          "Add quickstart file link",
        ],
        { expectJson: true },
      );
      expect(addFile.code).toBe(0);

      const addTest = context.runCli(
        [
          "test",
          id,
          "--json",
          "--add",
          "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240,note=quickstart example",
          "--author",
          "readme-test",
          "--message",
          "Add quickstart test link",
        ],
        { expectJson: true },
      );
      expect(addTest.code).toBe(0);

      const addComment = context.runCli(
        [
          "comments",
          id,
          "--json",
          "--add",
          "Evidence: quickstart flow succeeded",
          "--author",
          "readme-test",
          "--message",
          "Record quickstart evidence",
        ],
        { expectJson: true },
      );
      expect(addComment.code).toBe(0);

      const close = context.runCli(
        [
          "close",
          id,
          "quickstart lifecycle validated",
          "--json",
          "--author",
          "readme-test",
          "--message",
          "Close: quickstart lifecycle validated",
        ],
        { expectJson: true },
      );
      expect(close.code).toBe(0);

      const release = context.runCli(["release", id, "--json"], { expectJson: true });
      expect(release.code).toBe(0);
    });
  }, 90_000);
});
