import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS,
  collectPackageExtensionDirectories,
  readPmPackageManifest,
} from "../../src/core/packages/manifest.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { writeTestExtension } from "../helpers/extensions.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function createExtension(root: string, name: string): Promise<string> {
  const fixture = await writeTestExtension({ root, directory: name, name });
  return fixture.extensionRoot;
}

async function collectBundledExtensionDirectories(): Promise<string[]> {
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await readdir(packagesRoot, { withFileTypes: true });
  const extensionDirectories: string[] = [];
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory() || !packageEntry.name.startsWith("pm-")) {
      continue;
    }
    const extensionsRoot = path.join(packagesRoot, packageEntry.name, "extensions");
    const extensionEntries = await readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
    for (const extensionEntry of extensionEntries) {
      if (extensionEntry.isDirectory()) {
        extensionDirectories.push(path.join(extensionsRoot, extensionEntry.name));
      }
    }
  }
  return extensionDirectories.sort();
}

describe("pm package manifest model", () => {
  it("publishes the SDK runtime subpath used by bundled package runtimes", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports?.["./sdk/runtime"]).toMatchObject({
      types: "./dist/sdk/runtime.d.ts",
      import: "./dist/sdk/runtime.js",
      default: "./dist/sdk/runtime.js",
    });
  });

  it("reads package.json pm resources as a first-class manifest", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-manifest-"));
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "pm-resource-package",
          version: "1.2.3",
          description: "Package manifest test fixture.",
          keywords: ["pm-package", "fixture"],
          homepage: "https://example.com/package-docs",
          repository: {
            type: "git",
            url: "https://github.com/example/pm-resource-package",
          },
          bugs: {
            url: "https://github.com/example/pm-resource-package/issues",
          },
          pm: {
            aliases: ["resource-fixture"],
            extensions: ["extensions"],
            docs: ["docs/README.md", "README.md", "README.md"],
            examples: "examples",
            catalog: {
              display_name: "Resource Package",
              category: "workflow",
              summary: "Fixture package for catalog metadata.",
              tags: ["fixture", "workflow"],
              links: {
                docs: "https://example.com/catalog-docs",
              },
              media: {
                image: "https://example.com/image.png",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const manifest = await readPmPackageManifest(tempRoot);
    expect(manifest).toMatchObject({
      source: "pm",
      package_name: "pm-resource-package",
      package_version: "1.2.3",
      package_description: "Package manifest test fixture.",
      package_keywords: ["fixture", "pm-package"],
      package_homepage: "https://example.com/package-docs",
      package_repository_url: "https://github.com/example/pm-resource-package",
      package_bugs_url: "https://github.com/example/pm-resource-package/issues",
      aliases: ["resource-fixture"],
      resources: {
        extensions: ["extensions"],
        docs: ["docs/README.md", "README.md"],
        examples: ["examples"],
      },
      catalog: {
        display_name: "Resource Package",
        category: "workflow",
        summary: "Fixture package for catalog metadata.",
        tags: ["fixture", "workflow"],
        links: {
          docs: "https://example.com/catalog-docs",
        },
        media: {
          image: "https://example.com/image.png",
        },
      },
    });
  });

  it("collects extension resources from explicit and conventional package roots", async () => {
    const explicitRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-explicit-"));
    const explicitExtension = await createExtension(path.join(explicitRoot, "runtime"), "explicit-ext");
    await writeFile(
      path.join(explicitRoot, "package.json"),
      JSON.stringify({ pm: { extensions: ["runtime"] } }, null, 2),
      "utf8",
    );
    await expect(collectPackageExtensionDirectories(explicitRoot)).resolves.toEqual([explicitExtension]);

    const conventionalRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-conventional-"));
    const conventionalExtensionsRoot = path.join(conventionalRoot, PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS.extensions[1]);
    const conventionalExtension = await createExtension(conventionalExtensionsRoot, "conventional-ext");
    await expect(collectPackageExtensionDirectories(conventionalRoot)).resolves.toEqual([conventionalExtension]);
  });

  it("handles package manifest edge branches deterministically", async () => {
    const nullPmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-null-"));
    await writeFile(path.join(nullPmRoot, "package.json"), JSON.stringify({ name: "null-pm", pm: null }), "utf8");
    await expect(readPmPackageManifest(nullPmRoot)).resolves.toMatchObject({
      source: "convention",
      package_name: "null-pm",
      resources: {},
    });

    const unknownResourceRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-unknown-resource-"));
    await writeFile(
      path.join(unknownResourceRoot, "package.json"),
      JSON.stringify({ pm: { extensions: null, unknown: ["ignored"] } }),
      "utf8",
    );
    await expect(readPmPackageManifest(unknownResourceRoot)).resolves.toMatchObject({
      resources: {},
    });

    const scalarResourceRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-scalar-resource-"));
    await writeFile(
      path.join(scalarResourceRoot, "package.json"),
      JSON.stringify({ pm: { extensions: "extensions" } }),
      "utf8",
    );
    await expect(readPmPackageManifest(scalarResourceRoot)).resolves.toMatchObject({
      resources: {
        extensions: ["extensions"],
      },
    });

    const sortedResourceRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-sorted-resource-"));
    await writeFile(
      path.join(sortedResourceRoot, "package.json"),
      JSON.stringify({
        pm: {
          extensions: ["z-extension", "extensions", "extensions"],
          docs: ["docs/z", "docs/a", "docs/a"],
          examples: "examples/sample",
        },
      }),
      "utf8",
    );
    await expect(readPmPackageManifest(sortedResourceRoot)).resolves.toMatchObject({
      resources: {
        extensions: ["extensions", "z-extension"],
        docs: ["docs/a", "docs/z"],
        examples: ["examples/sample"],
      },
    });

    const stringRepositoryRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-string-repository-"));
    await writeFile(
      path.join(stringRepositoryRoot, "package.json"),
      JSON.stringify({
        repository: "https://github.com/example/string-repository",
        pm: {
          catalog: {
            links: "ignored",
          },
        },
      }),
      "utf8",
    );
    await expect(readPmPackageManifest(stringRepositoryRoot)).resolves.toMatchObject({
      package_repository_url: "https://github.com/example/string-repository",
      catalog: undefined,
    });

    const emptyMetadataRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-empty-metadata-"));
    await writeFile(
      path.join(emptyMetadataRoot, "package.json"),
      JSON.stringify({
        keywords: [42],
        repository: {
          url: "",
        },
        bugs: {
          url: "",
        },
        pm: {
          catalog: {
            links: {},
            media: {},
          },
        },
      }),
      "utf8",
    );
    await expect(readPmPackageManifest(emptyMetadataRoot)).resolves.toMatchObject({
      package_keywords: undefined,
      package_repository_url: undefined,
      package_bugs_url: undefined,
      catalog: undefined,
    });

    const rootExtension = await createExtension(await mkdtemp(path.join(os.tmpdir(), "pm-package-root-extension-")), "root-ext");
    await expect(collectPackageExtensionDirectories(rootExtension)).resolves.toEqual([rootExtension]);

    const explicitPackageRootExtension = await mkdtemp(path.join(os.tmpdir(), "pm-package-explicit-root-extension-"));
    const nestedPackageRootExtension = await createExtension(explicitPackageRootExtension, "nested-placeholder");
    await writeFile(
      path.join(explicitPackageRootExtension, "package.json"),
      JSON.stringify({ pm: { extensions: ["."] } }),
      "utf8",
    );
    await expect(collectPackageExtensionDirectories(explicitPackageRootExtension)).resolves.toEqual([
      nestedPackageRootExtension,
    ]);

    const mixedRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-mixed-"));
    const mixedExtensionsRoot = path.join(mixedRoot, "extensions");
    const mixedExtension = await createExtension(mixedExtensionsRoot, "mixed-ext");
    await mkdir(path.join(mixedExtensionsRoot, "no-manifest"), { recursive: true });
    await writeFile(path.join(mixedExtensionsRoot, "README.md"), "not an extension directory\n", "utf8");
    await expect(collectPackageExtensionDirectories(mixedRoot)).resolves.toEqual([mixedExtension]);
  });

  it("recognizes first-party package roots as installable pm packages", async () => {
    const beadsRoot = path.join(repoRoot, "packages", "pm-beads");
    const calendarRoot = path.join(repoRoot, "packages", "pm-calendar");
    const governanceAuditRoot = path.join(repoRoot, "packages", "pm-governance-audit");
    const guideShellRoot = path.join(repoRoot, "packages", "pm-guide-shell");
    const linkedTestAdaptersRoot = path.join(repoRoot, "packages", "pm-linked-test-adapters");
    const searchAdvancedRoot = path.join(repoRoot, "packages", "pm-search-advanced");
    const templatesRoot = path.join(repoRoot, "packages", "pm-templates");
    const todosRoot = path.join(repoRoot, "packages", "pm-todos");

    await expect(readPmPackageManifest(beadsRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-beads",
      package_version: "0.1.0",
      aliases: ["beads"],
      catalog: {
        display_name: "Beads Import",
        category: "migration",
      },
      resources: {
        extensions: ["extensions/beads"],
      },
    });
    await expect(collectPackageExtensionDirectories(beadsRoot)).resolves.toEqual([
      path.join(beadsRoot, "extensions", "beads"),
    ]);

    await expect(readPmPackageManifest(calendarRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-calendar",
      package_version: "0.1.0",
      aliases: ["calendar"],
      catalog: {
        display_name: "Calendar Views",
        category: "workflow",
      },
      resources: {
        extensions: ["extensions/calendar"],
      },
    });
    await expect(collectPackageExtensionDirectories(calendarRoot)).resolves.toEqual([
      path.join(calendarRoot, "extensions", "calendar"),
    ]);

    await expect(readPmPackageManifest(governanceAuditRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-governance-audit",
      package_version: "0.1.0",
      aliases: ["governance-audit"],
      catalog: {
        display_name: "Governance Audit",
        category: "governance",
      },
      resources: {
        extensions: ["extensions/governance-audit"],
      },
    });
    await expect(collectPackageExtensionDirectories(governanceAuditRoot)).resolves.toEqual([
      path.join(governanceAuditRoot, "extensions", "governance-audit"),
    ]);

    await expect(readPmPackageManifest(guideShellRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-guide-shell",
      package_version: "0.1.0",
      aliases: ["guide-shell"],
      catalog: {
        display_name: "Guide + Shell UX",
        category: "workflow",
      },
      resources: {
        extensions: ["extensions/guide-shell"],
      },
    });
    await expect(collectPackageExtensionDirectories(guideShellRoot)).resolves.toEqual([
      path.join(guideShellRoot, "extensions", "guide-shell"),
    ]);

    await expect(readPmPackageManifest(linkedTestAdaptersRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-linked-test-adapters",
      package_version: "0.1.0",
      aliases: ["linked-test-adapters"],
      catalog: {
        display_name: "Linked Test Adapters",
        category: "testing",
      },
      resources: {
        extensions: ["extensions/linked-test-adapters"],
      },
    });
    await expect(collectPackageExtensionDirectories(linkedTestAdaptersRoot)).resolves.toEqual([
      path.join(linkedTestAdaptersRoot, "extensions", "linked-test-adapters"),
    ]);

    await expect(readPmPackageManifest(searchAdvancedRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-search-advanced",
      package_version: "0.1.0",
      aliases: ["search-advanced"],
      catalog: {
        display_name: "Advanced Search",
        category: "search",
      },
      resources: {
        extensions: ["extensions/search-advanced"],
      },
    });
    await expect(collectPackageExtensionDirectories(searchAdvancedRoot)).resolves.toEqual([
      path.join(searchAdvancedRoot, "extensions", "search-advanced"),
    ]);

    await expect(readPmPackageManifest(templatesRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-templates",
      package_version: "0.1.0",
      aliases: ["templates"],
      catalog: {
        display_name: "Create Templates",
        category: "workflow",
      },
      resources: {
        extensions: ["extensions/templates"],
      },
    });
    await expect(collectPackageExtensionDirectories(templatesRoot)).resolves.toEqual([
      path.join(templatesRoot, "extensions", "templates"),
    ]);

    await expect(readPmPackageManifest(todosRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-todos",
      package_version: "0.1.0",
      aliases: ["todos"],
      catalog: {
        display_name: "Todos Import/Export",
        category: "migration",
      },
      resources: {
        extensions: ["extensions/todos"],
      },
    });
    await expect(collectPackageExtensionDirectories(todosRoot)).resolves.toEqual([
      path.join(todosRoot, "extensions", "todos"),
    ]);

    for (const packageRoot of [
      beadsRoot,
      calendarRoot,
      governanceAuditRoot,
      guideShellRoot,
      linkedTestAdaptersRoot,
      searchAdvancedRoot,
      templatesRoot,
      todosRoot,
    ]) {
      const manifest = await readPmPackageManifest(packageRoot);
      expect(manifest.resources.docs).toEqual(["README.md"]);
      expect(manifest.resources.examples).toEqual(["README.md"]);
    }
  });

  it("ships TypeScript-authored sources for first-party package entrypoints", async () => {
    await expect(access(path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "index.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "runtime-loader.ts"))).resolves
      .toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "runtime.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-calendar", "extensions", "calendar", "index.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-calendar", "extensions", "calendar", "runtime.ts"))).resolves.toBeUndefined();
    await expect(
      access(path.join(repoRoot, "packages", "pm-governance-audit", "extensions", "governance-audit", "index.ts")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(repoRoot, "packages", "pm-governance-audit", "extensions", "governance-audit", "runtime.ts")),
    ).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-guide-shell", "extensions", "guide-shell", "index.ts"))).resolves
      .toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-guide-shell", "extensions", "guide-shell", "runtime.ts"))).resolves
      .toBeUndefined();
    await expect(
      access(path.join(repoRoot, "packages", "pm-linked-test-adapters", "extensions", "linked-test-adapters", "index.ts")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(repoRoot, "packages", "pm-linked-test-adapters", "extensions", "linked-test-adapters", "runtime.ts")),
    ).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-search-advanced", "extensions", "search-advanced", "index.ts"))).resolves
      .toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-search-advanced", "extensions", "search-advanced", "runtime.ts"))).resolves
      .toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-templates", "extensions", "templates", "index.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-templates", "extensions", "templates", "runtime.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "index.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "runtime-loader.ts"))).resolves
      .toBeUndefined();
    await expect(access(path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "runtime.ts"))).resolves.toBeUndefined();
  });

  it("keeps generated package runtime loaders in sync", () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(repoRoot, "scripts", "gen-package-runtime-loaders.mjs"), "--check"], {
        cwd: repoRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("keeps shipped extension module manifest capabilities aligned with manifest.json", async () => {
    const extensionDirectories = await collectBundledExtensionDirectories();
    expect(extensionDirectories.length).toBeGreaterThan(0);

    for (const extensionDirectory of extensionDirectories) {
      const manifestPath = path.join(extensionDirectory, "manifest.json");
      const modulePath = path.join(extensionDirectory, "index.js");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { capabilities?: unknown };
      const source = await readFile(modulePath, "utf8");
      const capabilitiesMatch = source.match(/capabilities:\s*(\[[^\]]*\])/);
      expect(capabilitiesMatch?.[1], modulePath).toBeDefined();
      const capabilitiesLiteral = capabilitiesMatch?.[1]?.replace(/'/g, "\"").replace(/,\s*\]/g, "]") ?? "[]";
      const moduleCapabilities = JSON.parse(capabilitiesLiteral) as unknown;
      expect(moduleCapabilities, modulePath).toEqual(manifest.capabilities);
    }
  });

  it("keeps shipped package sources on the public SDK surface", async () => {
    const packageSourceFiles = [
      path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "index.ts"),
      path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "runtime-loader.ts"),
      path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "index.js"),
      path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "runtime-loader.js"),
      path.join(repoRoot, "packages", "pm-beads", "extensions", "beads", "runtime.js"),
      path.join(repoRoot, "packages", "pm-calendar", "extensions", "calendar", "index.ts"),
      path.join(repoRoot, "packages", "pm-calendar", "extensions", "calendar", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-calendar", "extensions", "calendar", "index.js"),
      path.join(repoRoot, "packages", "pm-calendar", "extensions", "calendar", "runtime.js"),
      path.join(repoRoot, "packages", "pm-governance-audit", "extensions", "governance-audit", "index.ts"),
      path.join(repoRoot, "packages", "pm-governance-audit", "extensions", "governance-audit", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-governance-audit", "extensions", "governance-audit", "index.js"),
      path.join(repoRoot, "packages", "pm-governance-audit", "extensions", "governance-audit", "runtime.js"),
      path.join(repoRoot, "packages", "pm-guide-shell", "extensions", "guide-shell", "index.ts"),
      path.join(repoRoot, "packages", "pm-guide-shell", "extensions", "guide-shell", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-guide-shell", "extensions", "guide-shell", "index.js"),
      path.join(repoRoot, "packages", "pm-guide-shell", "extensions", "guide-shell", "runtime.js"),
      path.join(repoRoot, "packages", "pm-linked-test-adapters", "extensions", "linked-test-adapters", "index.ts"),
      path.join(repoRoot, "packages", "pm-linked-test-adapters", "extensions", "linked-test-adapters", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-linked-test-adapters", "extensions", "linked-test-adapters", "index.js"),
      path.join(repoRoot, "packages", "pm-linked-test-adapters", "extensions", "linked-test-adapters", "runtime.js"),
      path.join(repoRoot, "packages", "pm-search-advanced", "extensions", "search-advanced", "index.ts"),
      path.join(repoRoot, "packages", "pm-search-advanced", "extensions", "search-advanced", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-search-advanced", "extensions", "search-advanced", "index.js"),
      path.join(repoRoot, "packages", "pm-search-advanced", "extensions", "search-advanced", "runtime.js"),
      path.join(repoRoot, "packages", "pm-templates", "extensions", "templates", "index.ts"),
      path.join(repoRoot, "packages", "pm-templates", "extensions", "templates", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-templates", "extensions", "templates", "index.js"),
      path.join(repoRoot, "packages", "pm-templates", "extensions", "templates", "runtime.js"),
      path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "index.ts"),
      path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "runtime-loader.ts"),
      path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "runtime.ts"),
      path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "index.js"),
      path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "runtime-loader.js"),
      path.join(repoRoot, "packages", "pm-todos", "extensions", "todos", "runtime.js"),
    ];

    for (const sourceFile of packageSourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      expect(source).not.toMatch(/["']\.\.\/\.\.\/\.\.\/\.\.\/(?:src|dist)\/(?:core|types)\//);
      if (sourceFile.endsWith("runtime.js")) {
        const referencesDistSdk =
          source.includes("../../../../dist/sdk/index.js") ||
          source.includes("../../../../dist/sdk/runtime.js") ||
          source.includes('"dist", "sdk", "index.js"') ||
          source.includes('"dist", "sdk", "runtime.js"');
        expect(referencesDistSdk).toBe(true);
      }
      if (sourceFile.endsWith(".ts") && !sourceFile.endsWith("runtime-loader.ts")) {
        const referencesSrcSdk =
          source.includes("../../../../src/sdk/index.js") ||
          source.includes("../../../../src/sdk/runtime.js");
        expect(referencesSrcSdk).toBe(true);
      }
      if (sourceFile.endsWith("runtime-loader.ts") || sourceFile.endsWith("runtime-loader.js")) {
        expect(source).not.toContain("../../../../src/sdk/");
        expect(source).not.toContain("../../../../dist/sdk/");
      }
    }
  });

  it("reports convention manifests and malformed package manifests", async () => {
    const noPackageJsonRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-no-json-"));
    await expect(readPmPackageManifest(noPackageJsonRoot)).resolves.toMatchObject({
      source: "convention",
      resources: {},
    });

    const malformedRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-malformed-"));
    await writeFile(path.join(malformedRoot, "package.json"), "{", "utf8");
    await expect(readPmPackageManifest(malformedRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });

    const scalarRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-scalar-"));
    await writeFile(path.join(scalarRoot, "package.json"), '"not-object"', "utf8");
    await expect(readPmPackageManifest(scalarRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });

    const invalidResourceRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-invalid-resource-"));
    await writeFile(path.join(invalidResourceRoot, "package.json"), JSON.stringify({ pm: "extensions" }), "utf8");
    await expect(readPmPackageManifest(invalidResourceRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });

    const invalidEntryRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-invalid-entry-"));
    await writeFile(path.join(invalidEntryRoot, "package.json"), JSON.stringify({ pm: { extensions: [42] } }), "utf8");
    await expect(readPmPackageManifest(invalidEntryRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
  });

  it("rejects extension globs and paths outside the package root", async () => {
    const globRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-glob-"));
    await writeFile(path.join(globRoot, "package.json"), JSON.stringify({ pm: { extensions: ["extensions/*"] } }), "utf8");
    await expect(collectPackageExtensionDirectories(globRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-outside-"));
    await writeFile(path.join(outsideRoot, "package.json"), JSON.stringify({ pm: { extensions: ["../outside"] } }), "utf8");
    await expect(collectPackageExtensionDirectories(outsideRoot)).rejects.toMatchObject({
      exitCode: EXIT_CODE.USAGE,
    });
  });
});
