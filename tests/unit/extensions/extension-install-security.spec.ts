import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create as createTar } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testOnlyInstallSources,
  parseExtensionInstallSource,
  resolveInstallSource,
} from "../../../src/sdk/extension/install-sources.js";
import { ensureInstalledExtensionSdkLink } from "../../../src/sdk/extension/install-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("untrusted extension runtime dependencies", () => {
  it("links copied extensions to the exact host public SDK", async () => {
    const extensionRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-host-sdk-"),
    );
    temporaryRoots.push(extensionRoot);

    await ensureInstalledExtensionSdkLink(extensionRoot);

    const linkPath = path.join(
      extensionRoot,
      "node_modules",
      "@unbrained",
      "pm-cli",
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await realpath(linkPath)).toBe(await realpath(process.cwd()));

    const junctionRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-host-sdk-junction-"),
    );
    temporaryRoots.push(junctionRoot);
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    try {
      await ensureInstalledExtensionSdkLink(junctionRoot);
    } finally {
      platform.mockRestore();
    }
    expect(
      await realpath(
        path.join(junctionRoot, "node_modules", "@unbrained", "pm-cli"),
      ),
    ).toBe(await realpath(process.cwd()));
  });

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

  it("isolates the pm-owned npm lifecycle policy from ambient allow-scripts", async () => {
    const calls: NodeJS.ProcessEnv[] = [];
    await _testOnlyInstallSources.runNpmCommand(
      ["install", "--ignore-scripts", "--"],
      undefined,
      async (_file, _args, options) => {
        calls.push(options.env ?? {});
        return { stdout: "", stderr: "" } as never;
      },
      "linux",
      {
        PATH: "/bin",
        npm_config_allow_scripts: "unsafe-package",
        NpM_CoNfIg_AlLoW_ScRiPtS: "mixed-case-unsafe-package",
        NPM_CONFIG_REGISTRY: "https://registry.example.test",
        PM_UNRELATED_POLICY: "preserved",
      },
    );

    expect(calls).toEqual([
      {
        PATH: "/bin",
        NPM_CONFIG_REGISTRY: "https://registry.example.test",
        PM_UNRELATED_POLICY: "preserved",
        NPM_CONFIG_ALLOW_SCRIPTS: "",
      },
    ]);
    expect(
      Object.keys(calls[0] ?? {}).filter(
        (key) => key.toLowerCase() === "npm_config_allow_scripts",
      ),
    ).toEqual(["NPM_CONFIG_ALLOW_SCRIPTS"]);
  });
});

describe("local npm package archives", () => {
  async function createPackageArchive(
    configure?: (packageRoot: string) => Promise<void>,
  ): Promise<{ archive: string; root: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-local-archive-"));
    temporaryRoots.push(root);
    const packageRoot = path.join(root, "package");
    const extensionRoot = path.join(packageRoot, "extensions", "archive-demo");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/pm-archive-demo",
        version: "1.2.3",
        pm: { extensions: ["extensions/archive-demo"] },
      }),
      "utf8",
    );
    await writeFile(
      path.join(extensionRoot, "manifest.json"),
      JSON.stringify({
        name: "archive-demo",
        version: "1.2.3",
        entry: "./index.js",
      }),
      "utf8",
    );
    await writeFile(
      path.join(extensionRoot, "index.js"),
      "export default {};\n",
      "utf8",
    );
    await configure?.(packageRoot);
    const archive = path.join(root, "archive-demo-1.2.3.tgz");
    await createTar({ cwd: root, file: archive, gzip: true }, ["package"]);
    return { archive, root };
  }

  it("resolves a standard npm tarball through the same public local-source contract", async () => {
    const { archive } = await createPackageArchive();
    const source = parseExtensionInstallSource(archive);
    const resolved = await resolveInstallSource(source);
    temporaryRoots.push(path.dirname(resolved.source_root!));

    expect(source).toMatchObject({ kind: "local", absolute_path: archive });
    expect(resolved.directory.replaceAll(path.sep, "/")).toMatch(
      /package\/extensions\/archive-demo$/,
    );
    expect(
      JSON.parse(
        await readFile(path.join(resolved.directory, "manifest.json"), "utf8"),
      ),
    ).toMatchObject({
      name: "archive-demo",
      version: "1.2.3",
    });
    await resolved.cleanup?.();

    const npmResolved =
      await _testOnlyInstallSources.resolveNpmSourceDirectoryWithRunner(
        {
          kind: "npm",
          input: `npm:${archive}`,
          spec: archive,
        },
        async () => {
          throw new Error("local archives must not invoke npm pack");
        },
      );
    expect(npmResolved.directory.replaceAll(path.sep, "/")).toMatch(
      /package\/extensions\/archive-demo$/,
    );
    await npmResolved.cleanup();
  });

  it("validates registry tarballs and types a missing npm pack artifact", async () => {
    const safe = await createPackageArchive();
    const safeSource = {
      kind: "npm" as const,
      input: "npm:@example/pm-archive-demo",
      spec: "@example/pm-archive-demo",
    };
    const safeResolved =
      await _testOnlyInstallSources.resolveNpmSourceDirectoryWithRunner(
        safeSource,
        async (args) => {
          const packDirectory = args.at(-1);
          if (!packDirectory) throw new Error("missing pack destination");
          await copyFile(safe.archive, path.join(packDirectory, "registry.tgz"));
          return JSON.stringify([{ filename: "registry.tgz" }]);
        },
      );
    expect(safeResolved).toMatchObject({
      package: "@example/pm-archive-demo",
      version: "1.2.3",
    });
    await safeResolved.cleanup();

    const normalizedAliasSpec = `archive-alias@file:${path.join(
      safe.root,
      "missing-package-root",
    )}`;
    const aliasResolved =
      await _testOnlyInstallSources.resolveNpmSourceDirectoryWithRunner(
        {
          kind: "npm",
          input: `npm:${normalizedAliasSpec}`,
          spec: normalizedAliasSpec,
        },
        async (args) => {
          expect(args[1]).toBe(
            `archive-alias@${path.join(safe.root, "missing-package-root")}`,
          );
          const packDirectory = args.at(-1);
          if (!packDirectory) throw new Error("missing pack destination");
          await copyFile(safe.archive, path.join(packDirectory, "alias.tgz"));
          return JSON.stringify({
            "@example/pm-archive-demo": {
              filename: "alias.tgz",
              name: "@example/pm-archive-demo",
              version: "1.2.3",
            },
          });
        },
      );
    expect(aliasResolved).toMatchObject({
      package: "@example/pm-archive-demo",
      version: "1.2.3",
    });
    await aliasResolved.cleanup();

    const linked = await createPackageArchive(async (packageRoot) => {
      await symlink("../../outside", path.join(packageRoot, "escape"));
    });
    await expect(
      _testOnlyInstallSources
        .resolveNpmSourceDirectoryWithRunner(safeSource, async (args) => {
          const packDirectory = args.at(-1);
          if (!packDirectory) throw new Error("missing pack destination");
          await copyFile(linked.archive, path.join(packDirectory, "registry.tgz"));
          return JSON.stringify([{ filename: "registry.tgz" }]);
        })
        .then(async (resolved) => {
          await resolved.cleanup();
          throw new Error("unsafe registry archive resolved");
        }),
    ).rejects.toMatchObject({
      context: { code: "local_package_archive_unsafe" },
    });

    await expect(
      _testOnlyInstallSources.resolveNpmSourceDirectoryWithRunner(
        safeSource,
        async () => JSON.stringify([{ filename: "missing.tgz" }]),
      ),
    ).rejects.toMatchObject({
      context: { code: "npm_package_archive_missing" },
    });

    await expect(
      _testOnlyInstallSources.resolveNpmSourceDirectoryWithRunner(
        safeSource,
        async () => JSON.stringify([{ filename: safe.archive }]),
      ),
    ).rejects.toMatchObject({
      context: { code: "npm_package_archive_unsafe" },
    });
  });

  it("rejects escaping links and archives without the npm package root", async () => {
    const linked = await createPackageArchive(async (packageRoot) => {
      await symlink("../../outside", path.join(packageRoot, "escape"));
    });
    await expect(
      resolveInstallSource(parseExtensionInstallSource(linked.archive)),
    ).rejects.toThrow(/link.*not supported|escaping link/i);

    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-local-archive-root-"),
    );
    temporaryRoots.push(root);
    await writeFile(path.join(root, "package.json"), "{}", "utf8");
    const archive = path.join(root, "wrong-root.tar.gz");
    await createTar({ cwd: root, file: archive, gzip: true }, ["package.json"]);
    await expect(
      resolveInstallSource(parseExtensionInstallSource(archive)),
    ).rejects.toThrow(/package\/ root/);
  });

  it("enforces entry and expanded-byte limits before extraction", async () => {
    const { archive } = await createPackageArchive();
    await expect(
      _testOnlyInstallSources.extractLocalPackageArchive(archive, {
        maxArchiveBytes: 1024 * 1024,
        maxEntries: 1,
        maxExpandedBytes: 1024 * 1024,
        maxEntryBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/entry limit/);
    await expect(
      _testOnlyInstallSources.extractLocalPackageArchive(archive, {
        maxArchiveBytes: 1,
        maxEntries: 100,
        maxExpandedBytes: 1024 * 1024,
        maxEntryBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/archive byte limit/);
    await expect(
      _testOnlyInstallSources.extractLocalPackageArchive(archive, {
        maxArchiveBytes: 1024 * 1024,
        maxEntries: 100,
        maxExpandedBytes: 1024 * 1024,
        maxEntryBytes: 1,
      }),
    ).rejects.toThrow(/byte entry limit/);
    await expect(
      _testOnlyInstallSources.extractLocalPackageArchive(archive, {
        maxArchiveBytes: 1024 * 1024,
        maxEntries: 100,
        maxExpandedBytes: 1,
        maxEntryBytes: 1024 * 1024,
      }),
    ).rejects.toThrow(/expanded byte limit/);
  });

  it("requires package metadata and rejects every unsafe entry shape", async () => {
    const unnamed = await createPackageArchive(async (packageRoot) => {
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ pm: { extensions: ["extensions/archive-demo"] } }),
        "utf8",
      );
    });
    const unnamedResolved =
      await _testOnlyInstallSources.extractLocalPackageArchive(unnamed.archive);
    expect(unnamedResolved.package).toBeUndefined();
    expect(unnamedResolved.version).toBeUndefined();
    await unnamedResolved.cleanup();

    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-local-archive-empty-"),
    );
    temporaryRoots.push(root);
    await mkdir(path.join(root, "package"));
    await writeFile(
      path.join(root, "package", "README.md"),
      "missing metadata",
      "utf8",
    );
    const archive = path.join(root, "missing-package-json.tgz");
    await createTar({ cwd: root, file: archive, gzip: true }, ["package"]);
    await expect(
      _testOnlyInstallSources.extractLocalPackageArchive(archive),
    ).rejects.toThrow(/exactly one package\/package.json/);

    const limits = {
      maxArchiveBytes: 100,
      maxEntries: 10,
      maxExpandedBytes: 100,
      maxEntryBytes: 100,
    };
    const metaState = {
      entries: 0,
      expandedBytes: 0,
      packageJsonEntries: 0,
    };
    _testOnlyInstallSources.validateLocalPackageArchiveEntry(
      { meta: true } as never,
      limits,
      metaState,
    );
    expect(metaState).toEqual({
      entries: 0,
      expandedBytes: 0,
      packageJsonEntries: 0,
    });
    for (const entry of [
      { path: "package\\escape", type: "File", size: 0 },
      { path: "/package/escape", type: "File", size: 0 },
      { path: "C:/package/escape", type: "File", size: 0 },
      { path: "package/../escape", type: "File", size: 0 },
      { path: "package/device", type: "CharacterDevice", size: 0 },
    ]) {
      expect(() =>
        _testOnlyInstallSources.validateLocalPackageArchiveEntry(
          entry as never,
          limits,
          { entries: 0, expandedBytes: 0, packageJsonEntries: 0 },
        ),
      ).toThrow(/archive/);
    }
  });
});
