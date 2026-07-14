import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  diagnoseCliBundleIntegrityFailure,
  readCliBundleManifestSnapshot,
  runCliWithBundleIntegrity,
  type CliBundleManifest,
} from "../../../src/cli/bundle-integrity.js";

const tempRoots: string[] = [];

async function createBundleFixture(): Promise<{
  root: string;
  cliPath: string;
  bundleRoot: string;
  outputPath: string;
  manifest: CliBundleManifest;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-bundle-integrity-"));
  tempRoots.push(root);
  const cliPath = path.join(root, "dist", "cli.js");
  const bundleRoot = path.join(root, "dist", "cli-bundle");
  const outputPath = path.join(bundleRoot, "main.js");
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(cliPath, "// cli\n", "utf8");
  await writeFile(outputPath, "export const ok = true;\n", "utf8");
  const sha256 = createHash("sha256")
    .update("export const ok = true;\n")
    .digest("hex");
  const manifest: CliBundleManifest = {
    schema_version: 1,
    generation: "generation-a",
    files: [{ path: "main.js", sha256 }],
  };
  await writeFile(
    path.join(bundleRoot, "bundle-manifest.json"),
    JSON.stringify(manifest),
    "utf8",
  );
  return { root, cliPath, bundleRoot, outputPath, manifest };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI bundle manifest parsing", () => {
  it("reads a valid manifest and rejects missing, malformed, or invalid shapes", async () => {
    const fixture = await createBundleFixture();
    expect(
      readCliBundleManifestSnapshot(fixture.cliPath)?.manifest.generation,
    ).toBe("generation-a");

    const manifestPath = path.join(
      fixture.bundleRoot,
      "bundle-manifest.json",
    );
    for (const invalid of [
      "not-json",
      JSON.stringify(null),
      JSON.stringify({}),
      JSON.stringify({ schema_version: 2, generation: "x", files: [] }),
      JSON.stringify({ schema_version: 1, generation: 1, files: [] }),
      JSON.stringify({ schema_version: 1, generation: "x", files: {} }),
      JSON.stringify({ schema_version: 1, generation: "x", files: [null] }),
      JSON.stringify({
        schema_version: 1,
        generation: "x",
        files: [{ path: 1, sha256: "x" }],
      }),
      JSON.stringify({
        schema_version: 1,
        generation: "x",
        files: [{ path: "main.js", sha256: 1 }],
      }),
    ]) {
      await writeFile(manifestPath, invalid, "utf8");
      expect(readCliBundleManifestSnapshot(fixture.cliPath)).toBeUndefined();
    }
    expect(
      readCliBundleManifestSnapshot(path.join(fixture.root, "missing", "cli.js")),
    ).toBeUndefined();
  });
});

describe("CLI torn-bundle diagnosis", () => {
  it("requires a module-loader failure and a prior validated manifest", async () => {
    const fixture = await createBundleFixture();
    const snapshot = readCliBundleManifestSnapshot(fixture.cliPath);
    expect(
      diagnoseCliBundleIntegrityFailure(new Error("boom"), snapshot, fixture.cliPath),
    ).toBeUndefined();
    expect(
      diagnoseCliBundleIntegrityFailure("raw", snapshot, fixture.cliPath),
    ).toBeUndefined();
    expect(
      diagnoseCliBundleIntegrityFailure(
        Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" }),
        undefined,
        fixture.cliPath,
      ),
    ).toBeUndefined();
    expect(
      diagnoseCliBundleIntegrityFailure(
        new Error("Cannot find module but the bundle is intact"),
        snapshot,
        fixture.cliPath,
      ),
    ).toBeUndefined();
  });

  it("reports missing manifests and changed generations", async () => {
    const fixture = await createBundleFixture();
    const snapshot = readCliBundleManifestSnapshot(fixture.cliPath);
    const failure = Object.assign(new Error("missing chunk"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await rm(path.join(fixture.bundleRoot, "bundle-manifest.json"));
    expect(
      diagnoseCliBundleIntegrityFailure(failure, snapshot, fixture.cliPath),
    ).toMatchObject({
      code: "bundle_integrity_torn_install",
      reason: "manifest_missing",
      cause: "missing chunk",
    });

    await writeFile(
      path.join(fixture.bundleRoot, "bundle-manifest.json"),
      JSON.stringify({ ...fixture.manifest, generation: "generation-b" }),
      "utf8",
    );
    expect(
      diagnoseCliBundleIntegrityFailure(failure, snapshot, fixture.cliPath),
    ).toMatchObject({ reason: "generation_changed" });
  });

  it("reports missing and hash-invalid files while accepting intact outputs", async () => {
    const fixture = await createBundleFixture();
    const snapshot = readCliBundleManifestSnapshot(fixture.cliPath);
    const missingExport = new Error(
      "The requested module './chunk.js' does not provide an export named 'runUpdate'",
    );
    expect(
      diagnoseCliBundleIntegrityFailure(missingExport, snapshot, fixture.cliPath),
    ).toBeUndefined();

    await rm(fixture.outputPath);
    expect(
      diagnoseCliBundleIntegrityFailure(missingExport, snapshot, fixture.cliPath),
    ).toMatchObject({ reason: "file_missing" });

    await writeFile(fixture.outputPath, "changed\n", "utf8");
    expect(
      diagnoseCliBundleIntegrityFailure(missingExport, snapshot, fixture.cliPath),
    ).toMatchObject({ reason: "hash_mismatch" });
  });

  it("ignores manifest paths that escape the bundle root", async () => {
    const fixture = await createBundleFixture();
    const manifestPath = path.join(
      fixture.bundleRoot,
      "bundle-manifest.json",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...fixture.manifest,
        files: [{ path: "../outside.js", sha256: "not-read" }],
      }),
      "utf8",
    );
    const snapshot = readCliBundleManifestSnapshot(fixture.cliPath);
    expect(
      diagnoseCliBundleIntegrityFailure(
        Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" }),
        snapshot,
        fixture.cliPath,
      ),
    ).toBeUndefined();
  });
});

describe("CLI bundle-aware startup", () => {
  it("runs a healthy CLI and preserves genuine loader failures", async () => {
    const fixture = await createBundleFixture();
    const runPmCli = vi.fn(async () => {});
    await runCliWithBundleIntegrity(
      ["get", "pm-1"],
      fixture.cliPath,
      async () => ({ runPmCli }),
      vi.fn(),
    );
    expect(runPmCli).toHaveBeenCalledWith(["get", "pm-1"]);

    const genuineFailure = new Error("genuine startup failure");
    await expect(
      runCliWithBundleIntegrity(
        [],
        fixture.cliPath,
        async () => {
          throw genuineFailure;
        },
        vi.fn(),
      ),
    ).rejects.toBe(genuineFailure);
  });

  it("renders the recovery and exits nonzero for a proven torn generation", async () => {
    const fixture = await createBundleFixture();
    const output: string[] = [];
    const previousExitCode = process.exitCode;
    try {
      await runCliWithBundleIntegrity(
        [],
        fixture.cliPath,
        async () => {
          await writeFile(
            path.join(fixture.bundleRoot, "bundle-manifest.json"),
            JSON.stringify({ ...fixture.manifest, generation: "generation-b" }),
            "utf8",
          );
          throw Object.assign(new Error("missing chunk"), {
            code: "ERR_MODULE_NOT_FOUND",
          });
        },
        (message) => output.push(message),
      );
      expect(output.join("\n")).toContain("bundle_integrity_torn_install");
      expect(output.join("\n")).toContain("generation_changed");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
