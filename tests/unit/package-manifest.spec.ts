import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function createExtension(root: string, name: string): Promise<string> {
  const extensionRoot = path.join(root, name);
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(
    path.join(extensionRoot, "manifest.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        entry: "index.js",
        capabilities: ["commands"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(extensionRoot, "index.js"), "export default { activate() {} };\n", "utf8");
  return extensionRoot;
}

describe("pm package manifest model", () => {
  it("reads package.json pm resources as a first-class manifest", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-package-manifest-"));
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "pm-resource-package",
          version: "1.2.3",
          pm: {
            extensions: ["extensions"],
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
      resources: {
        extensions: ["extensions"],
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
      JSON.stringify({ pm: { extensions: ["z-extension", "extensions", "extensions"] } }),
      "utf8",
    );
    await expect(readPmPackageManifest(sortedResourceRoot)).resolves.toMatchObject({
      resources: {
        extensions: ["extensions", "z-extension"],
      },
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
    const todosRoot = path.join(repoRoot, "packages", "pm-todos");

    await expect(readPmPackageManifest(beadsRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-package-beads",
      resources: {
        extensions: ["extensions/beads"],
      },
    });
    await expect(collectPackageExtensionDirectories(beadsRoot)).resolves.toEqual([
      path.join(beadsRoot, "extensions", "beads"),
    ]);

    await expect(readPmPackageManifest(todosRoot)).resolves.toMatchObject({
      source: "pm",
      package_name: "@unbrained/pm-package-todos",
      resources: {
        extensions: ["extensions/todos"],
      },
    });
    await expect(collectPackageExtensionDirectories(todosRoot)).resolves.toEqual([
      path.join(todosRoot, "extensions", "todos"),
    ]);
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
