import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _testOnly } from "../../../src/cli/commands/extension.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("extension install copy containment", () => {
  it("falls back to lexical containment when the source does not exist yet", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-copy-missing-"),
    );
    tempRoots.push(root);
    const source = path.join(root, "missing-source");
    const destination = path.join(root, "destination");
    const copyDirectory = vi.fn(async () => {});
    await _testOnly.copyExtensionDirectoryWithoutSelfNesting(
      source,
      destination,
      copyDirectory,
    );
    expect(copyDirectory).toHaveBeenCalledWith(source, destination, {
      recursive: true,
      force: true,
    });
  });

  it("stages a symlinked source whose real install destination is nested inside it", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-copy-safety-"),
    );
    tempRoots.push(root);
    const source = path.join(root, "source");
    const sourceAlias = path.join(root, "source-alias");
    const destination = path.join(
      source,
      ".agents",
      "pm",
      "extensions",
      "demo",
    );
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "manifest.json"), "manifest\n", "utf8");
    await symlink(
      source,
      sourceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );

    await _testOnly.copyExtensionDirectoryWithoutSelfNesting(
      sourceAlias,
      destination,
      cp,
    );
    expect(
      await readFile(path.join(destination, "manifest.json"), "utf8"),
    ).toBe("manifest\n");
  });

  it("canonicalizes a missing destination tree through its deepest existing ancestor", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-copy-canonical-"),
    );
    tempRoots.push(root);
    const source = path.join(root, "source");
    const sourceAlias = path.join(root, "source-alias");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "manifest.json"), "manifest\n", "utf8");
    await symlink(
      source,
      sourceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const destination = path.join(
      sourceAlias,
      "missing-parent",
      "extensions",
      "demo",
    );

    await _testOnly.copyExtensionDirectoryWithoutSelfNesting(
      source,
      destination,
      cp,
    );
    expect(
      await readFile(path.join(destination, "manifest.json"), "utf8"),
    ).toBe("manifest\n");
  });

  it("moves staging outside a source that contains the configured temp directory", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-copy-temp-"),
    );
    tempRoots.push(root);
    const source = path.join(root, "source");
    const destination = path.join(source, "installed", "demo");
    const configuredTemp = path.join(source, "runtime", "tmp");
    await mkdir(configuredTemp, { recursive: true });
    await writeFile(path.join(source, "manifest.json"), "manifest\n", "utf8");

    await _testOnly.copyExtensionDirectoryWithoutSelfNesting(
      source,
      destination,
      cp,
      configuredTemp,
    );
    expect(
      await readFile(path.join(destination, "manifest.json"), "utf8"),
    ).toBe("manifest\n");
  });

  it("moves staging outside a source whose temp directory is configured through a symlink alias", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-copy-temp-alias-"),
    );
    tempRoots.push(root);
    const source = path.join(root, "source");
    const sourceAlias = path.join(root, "source-alias");
    const destination = path.join(source, "installed", "demo");
    await mkdir(path.join(source, "runtime", "tmp"), { recursive: true });
    await writeFile(path.join(source, "manifest.json"), "manifest\n", "utf8");
    await symlink(
      source,
      sourceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );

    await _testOnly.copyExtensionDirectoryWithoutSelfNesting(
      source,
      destination,
      cp,
      path.join(sourceAlias, "runtime", "tmp"),
    );
    expect(
      await readFile(path.join(destination, "manifest.json"), "utf8"),
    ).toBe("manifest\n");
  });

  it("canonicalizes a missing temp directory through its deepest existing ancestor", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pm-extension-copy-temp-missing-"),
    );
    tempRoots.push(root);
    const source = path.join(root, "source");
    const sourceAlias = path.join(root, "source-alias");
    const destination = path.join(source, "installed", "demo");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "manifest.json"), "manifest\n", "utf8");
    await symlink(
      source,
      sourceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );

    await _testOnly.copyExtensionDirectoryWithoutSelfNesting(
      source,
      destination,
      cp,
      path.join(sourceAlias, "missing-tmp", "nested"),
    );
    expect(
      await readFile(path.join(destination, "manifest.json"), "utf8"),
    ).toBe("manifest\n");
  });

  it("rejects a filesystem-root source when no external staging base exists", async () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    await expect(
      _testOnly.copyExtensionDirectoryWithoutSelfNesting(
        filesystemRoot,
        path.join(filesystemRoot, "nested-extension-destination"),
        vi.fn(),
        filesystemRoot,
      ),
    ).rejects.toMatchObject({
      context: { code: "extension_install_source_contains_destination" },
    });
  });
});
