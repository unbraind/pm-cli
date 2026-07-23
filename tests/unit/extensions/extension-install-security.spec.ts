import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _testOnlyInstallSources } from "../../../src/sdk/extension/install-sources.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("untrusted extension runtime dependencies", () => {
  it("rejects option-like names and shell metacharacters before npm execution", () => {
    expect(() =>
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
        dependencies: { "--ignore-scripts": "false" },
      }),
    ).toThrow(/command-line option/);
    expect(() =>
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
        dependencies: { safe: "1.0.0 & calc.exe" },
      }),
    ).toThrow(/unsafe version specifier/);
    expect(() =>
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
        dependencies: { "not a package": "1.0.0" },
      }),
    ).toThrow(/not a valid npm dependency specifier/);
    expect(() =>
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
        dependencies: { safe: "workspace:*" },
      }),
    ).toThrow(/not a valid npm dependency specifier/);
    expect(() =>
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
        dependencies: { safe: "latest<malicious" },
      }),
    ).toThrow(/not a valid npm dependency specifier/);
    expect(
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
        dependencies: { safe: ">=1.0.0 <2.0.0" },
      }),
    ).toEqual(["safe@>=1.0.0 <2.0.0"]);
    expect(
      _testOnlyInstallSources.runtimeDependencyInstallSpecs({
        dependencies: { safe: ">= 1.0.0 < 2.0.0" },
      }),
    ).toEqual(["safe@>= 1.0.0 < 2.0.0"]);
  });

  it("installs from the validated manifest without forwarding specs through the shell", async () => {
    const packageRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-dependency-security-"),
    );
    temporaryRoots.push(packageRoot);
    const packageJsonPath = path.join(packageRoot, "package.json");
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: "safe-extension",
        version: "1.0.0",
        dependencies: { safe: "^1.2.3" },
      }),
      "utf8",
    );
    const invocations: string[][] = [];

    await _testOnlyInstallSources.installNpmPackageRuntimeDependencies(
      packageRoot,
      async (args) => {
        invocations.push(args);
        return "";
      },
    );

    expect(invocations).toEqual([
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--fund=false",
        "--package-lock=false",
        "--no-save",
        "--omit=peer",
        "--",
      ],
    ]);
    expect(JSON.parse(await readFile(packageJsonPath, "utf8"))).toMatchObject({
      dependencies: { safe: "^1.2.3" },
    });
  });

  it.each([
    ["linux", "npm", false],
    ["win32", "npm.cmd", true],
  ] as const)(
    "preserves the validated argv boundary on %s",
    async (platform, executable, shell) => {
      const calls: Array<{
        executable: string;
        args: readonly string[];
        shell: boolean | string | undefined;
      }> = [];
      await _testOnlyInstallSources.runNpmCommand(
        ["install", "--ignore-scripts", "--", "safe@1.0.0"],
        undefined,
        async (file, args, options) => {
          calls.push({ executable: file, args, shell: options.shell });
          return { stdout: "", stderr: "" } as never;
        },
        platform,
      );
      expect(calls).toEqual([
        {
          executable,
          args: ["install", "--ignore-scripts", "--", "safe@1.0.0"],
          shell,
        },
      ]);
    },
  );
});
