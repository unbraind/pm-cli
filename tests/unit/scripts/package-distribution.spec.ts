import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { packDistribution } from "../../../scripts/release/package-distribution.mjs";
import { verifyRuntimeInstallation } from "../../../scripts/release/verify-runtime-installation.mjs";
import { createScriptHarness } from "../../helpers/scriptModule.js";

const harness = createScriptHarness();

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Create physical conflicting-version packages and a dependency cycle for publication tests. */
async function createBundleFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pm-bundle-fixture-"));
  roots.push(root);
  const manifest = {
    name: "runtime-bundle-fixture",
    version: "1.0.0",
    files: ["index.js", "runtime-dependencies.json"],
    dependencies: { first: "^1.0.0", second: "^1.0.0" },
    devDependencies: { dev: "^1.0.0" },
    scripts: { prepack: "exit 97" },
  };
  const packages = {
    "": {
      name: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies,
    },
    "node_modules/first": {
      version: "1.0.0",
      dependencies: { shared: "1.0.0" },
    },
    "node_modules/second": {
      version: "1.0.0",
      dependencies: { shared: "2.0.0" },
    },
    "node_modules/shared": {
      version: "1.0.0",
      dependencies: { first: "1.0.0" },
    },
    "node_modules/second/node_modules/shared": {
      version: "2.0.0",
      dependencies: { first: "1.0.0" },
    },
  };
  const ledger = { name: manifest.name, version: manifest.version, packages };
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "index.js"), "export const result = 1;\n");
  await writeFile(
    path.join(root, "runtime-dependencies.json"),
    JSON.stringify(ledger),
  );
  for (const [location, entry] of Object.entries(packages)) {
    if (!location) continue;
    const directory = path.join(root, location);
    const name = location.slice(
      location.lastIndexOf("node_modules/") + "node_modules/".length,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name, ...entry, main: "index.js" }),
    );
    await writeFile(path.join(directory, "index.js"), "module.exports = 1;\n");
    await writeFile(path.join(directory, "index.js.map"), "private source map");
  }
  const dev = path.join(root, "node_modules/dev");
  await mkdir(dev);
  await writeFile(
    path.join(dev, "package.json"),
    '{"name":"dev","version":"1.0.0"}',
  );
  await writeFile(path.join(dev, "private.txt"), "development-only");
  return { root, manifest, packages, ledger };
}

it("packs exact physical runtime packages without development dependencies or maps and refuses installed drift", async () => {
  const { root, packages, ledger } = await createBundleFixture();
  const before = await readFile(path.join(root, "package.json"), "utf8");
  const artifact = packDistribution(root);
  const files = artifact.files.map(
    (file: { path: string }) => file.path,
  ) as string[];
  expect(
    files.filter(
      (file) =>
        file.startsWith("node_modules/") && file.endsWith("package.json"),
    ),
  ).toEqual(
    expect.arrayContaining(
      Object.keys(packages)
        .filter(Boolean)
        .map((location) => `${location}/package.json`),
    ),
  );
  expect(
    files.some(
      (file) => file.includes("node_modules/dev") || file.endsWith(".map"),
    ),
  ).toBe(false);
  expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(before);
  expect(verifyRuntimeInstallation(root)).toMatchObject({
    ok: true,
    runtime_packages: 4,
  });
  await writeFile(
    path.join(root, "node_modules/shared/package.json"),
    '{"name":"shared","version":"9.0.0"}',
  );
  expect(() => packDistribution(root)).toThrow("Installed runtime drift");
  expect(() => verifyRuntimeInstallation(root)).toThrow(
    "Installed runtime version mismatch",
  );
  await writeFile(
    path.join(root, "runtime-dependencies.json"),
    JSON.stringify({
      ...ledger,
      packages: {
        ...packages,
        "node_modules/../../escape": { version: "1.0.0" },
      },
    }),
  );
  expect(() => packDistribution(root)).toThrow(
    "Unsafe runtime ledger location",
  );
}, 60_000);

it.each([
  "manifest",
  "missing-package",
  "missing-ledger-child",
  "unused-ledger",
  "peer-context",
  "runtime-symlink",
] as const)(
  "refuses %s before a mismatched runtime can be published",
  async (failure) => {
    const { root, manifest, packages, ledger } = await createBundleFixture();
    if (failure === "manifest") manifest.version = "2.0.0";
    if (failure === "missing-package")
      await rm(path.join(root, "node_modules/first"), { recursive: true });
    if (failure === "missing-ledger-child")
      delete (packages as Record<string, unknown>)["node_modules/shared"];
    if (failure === "unused-ledger")
      Object.assign(packages, { "node_modules/unused": { version: "1.0.0" } });
    if (failure === "peer-context") {
      packages["node_modules/second"].dependencies.shared = "1.0.0";
      delete (packages as Record<string, unknown>)[
        "node_modules/second/node_modules/shared"
      ];
      await writeFile(
        path.join(root, "node_modules/second/node_modules/shared/package.json"),
        '{"name":"shared","version":"1.0.0"}',
      );
    }
    if (failure === "runtime-symlink")
      await symlink(
        path.join(root, "index.js"),
        path.join(root, "node_modules/first/linked.js"),
      );
    await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
    await writeFile(
      path.join(root, "runtime-dependencies.json"),
      JSON.stringify(ledger),
    );
    expect(() => packDistribution(root)).toThrow(
      {
        manifest: "publication manifest",
        "missing-package": "Missing tested runtime package",
        "missing-ledger-child": "Runtime ledger lacks dependency",
        "unused-ledger": "complete tested closure",
        "peer-context": "Conflicting runtime peer context",
        "runtime-symlink": "physical publication files",
      }[failure],
    );
  },
  60_000,
);

it.each([
  "empty",
  "multiple",
  "missing-files",
  "non-string",
  "absolute",
  "traversal",
  "node-modules",
  "escaping-link",
] as const)("rejects an unsafe npm source receipt: %s", async (failure) => {
  const { root } = await createBundleFixture();
  const outside = await harness.createTempRoot("pm-outside-publication-");
  await writeFile(path.join(outside, "external.js"), "private external file");
  await symlink(
    path.join(outside, "external.js"),
    path.join(root, "external.js"),
  );
  const receipts = {
    empty: [],
    multiple: [{ files: [] }, { files: [] }],
    "missing-files": [{}],
    "non-string": [{ files: [{ path: 7 }] }],
    absolute: [{ files: [{ path: path.join(outside, "external.js") }] }],
    traversal: [{ files: [{ path: "../external.js" }] }],
    "node-modules": [{ files: [{ path: "node_modules/first/package.json" }] }],
    "escaping-link": [{ files: [{ path: "external.js" }] }],
  };
  const execute = vi
    .fn(execFileSync)
    .mockReturnValueOnce(JSON.stringify(receipts[failure]));
  vi.doMock("node:child_process", () => ({ execFileSync: execute }));
  const module = await harness.importModule<{
    packDistribution: typeof packDistribution;
  }>("scripts/release/package-distribution.mjs");
  expect(() => module.packDistribution(root)).toThrow(
    /exactly one npm artifact|Unsafe source distribution path|escapes the checkout/u,
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(outside, "external.js"), "utf8")).toBe(
    "private external file",
  );
});

it("uses npm's Node entrypoint on Windows and writes a real distributable tarball", async () => {
  const { root } = await createBundleFixture();
  const destination = await harness.createTempRoot(
    "pm-publication-destination-",
  );
  const installation = await harness.createTempRoot("pm-node-installation-");
  const executable = path.join(installation, "node.exe");
  await symlink(process.execPath, executable);
  await mkdir(path.join(installation, "node_modules"));
  const npmRoot =
    process.platform === "win32"
      ? path.dirname(
          createRequire(import.meta.url).resolve("npm/package.json", {
            paths: [path.dirname(process.execPath)],
          }),
        )
      : path.join(
          execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
          "npm",
        );
  await symlink(
    npmRoot,
    path.join(installation, "node_modules/npm"),
    "junction",
  );
  vi.spyOn(process, "execPath", "get").mockReturnValue(executable);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const artifact = packDistribution(root, { destination });
  expect(
    await readFile(path.join(destination, artifact.filename)),
  ).not.toHaveLength(0);
}, 60_000);

it.each([
  "identity-name",
  "identity-version",
  "missing-root",
  "absolute",
  "traversal",
  "prefix",
  "installed-name",
] as const)("rejects an invalid installed ledger: %s", async (failure) => {
  const { root, ledger, packages } = await createBundleFixture();
  if (failure === "identity-name") ledger.name = "different-package";
  if (failure === "identity-version") ledger.version = "2.0.0";
  if (failure === "missing-root")
    delete (packages as Record<string, unknown>)["node_modules/first"];
  if (failure === "absolute")
    Object.assign(packages, {
      [path.resolve(root, "external")]: { version: "1.0.0" },
    });
  if (failure === "traversal")
    Object.assign(packages, {
      "node_modules/../external": { version: "1.0.0" },
    });
  if (failure === "prefix")
    Object.assign(packages, { external: { version: "1.0.0" } });
  if (failure === "installed-name")
    await writeFile(
      path.join(root, "node_modules/first/package.json"),
      '{"name":"different","version":"1.0.0"}',
    );
  await writeFile(
    path.join(root, "runtime-dependencies.json"),
    JSON.stringify(ledger),
  );
  expect(() => verifyRuntimeInstallation(root)).toThrow(
    /identity mismatch|lacks root|Unsafe installed|version mismatch/u,
  );
});

it("runs the installation-verifier CLI and rejects missing arguments", async () => {
  const { root } = await createBundleFixture();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [
    process.execPath,
    path.resolve("scripts/release/verify-runtime-installation.mjs"),
    root,
  ];
  await harness.importModule("scripts/release/verify-runtime-installation.mjs");
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
    ok: true,
    runtime_packages: 4,
  });
  vi.resetModules();
  process.argv = process.argv.slice(0, 2);
  await expect(
    harness.importModule("scripts/release/verify-runtime-installation.mjs"),
  ).rejects.toThrow("Usage");
});

it("runs both packer CLI modes and rejects ambiguous arguments", async () => {
  const { root } = await createBundleFixture();
  const destination = await harness.createTempRoot("pm-publication-cli-");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const args of [[], [`--destination=${destination}`]]) {
    process.argv = [
      process.execPath,
      path.resolve("scripts/release/package-distribution.mjs"),
      ...args,
    ];
    // Resolve the script from the actual checkout, independently of its publication cwd.
    process.argv[1] = path.resolve(
      import.meta.dirname,
      "../../../scripts/release/package-distribution.mjs",
    );
    vi.resetModules();
    await harness.importModule("scripts/release/package-distribution.mjs");
  }
  expect(output).toHaveBeenCalledTimes(2);
  for (const args of [
    ["--unknown"],
    ["--destination=one", "--destination=two"],
  ]) {
    process.argv = [process.execPath, process.argv[1], ...args];
    vi.resetModules();
    await expect(
      harness.importModule("scripts/release/package-distribution.mjs"),
    ).rejects.toThrow("Usage");
  }
}, 60_000);
