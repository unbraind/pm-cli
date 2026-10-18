import {
  execFileSync,
  fork,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { x as extractTar } from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { packDistribution } from "../../../scripts/release/package-distribution.mjs";
import { withBuildLease } from "../../../scripts/build-lease.mjs";
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
async function createBundleFixture(optionalPeer = false) {
  const root = await mkdtemp(path.join(tmpdir(), "pm-bundle-fixture-"));
  roots.push(root);
  const manifest = {
    name: "runtime-bundle-fixture",
    version: "1.0.0",
    files: ["index.js", "runtime-dependencies.json", "metadata.json"],
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
  if (optionalPeer) {
    Object.assign(packages["node_modules/first"], {
      peerDependencies: { peer: "^1.0.0", shared: "^1.0.0" },
      peerDependenciesMeta: { peer: { optional: true } },
      optionalDependencies: { peer: "1.0.0" },
    });
    Object.assign(packages, {
      "node_modules/peer": { version: "1.0.0", dependencies: { leaf: "1.0.0" }, optional: true },
      "node_modules/leaf": { version: "1.0.0", optional: true },
    });
  }
  const ledger = { name: manifest.name, version: manifest.version, packages };
  const metadata = {
    extension: {
      text: "Unicode λ and escaped \"quotes\"\n",
      values: [null, true, 1.25, 9007199254740991],
      nested: { preserved: "unknown field" },
    },
  };
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "index.js"), "export const result = 1;\n");
  await writeFile(
    path.join(root, "runtime-dependencies.json"),
    JSON.stringify(ledger, null, 2),
  );
  await writeFile(
    path.join(root, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  for (const [location, entry] of Object.entries(packages)) {
    if (!location) continue;
    const directory = path.join(root, location);
    const name = location.slice(
      location.lastIndexOf("node_modules/") + "node_modules/".length,
    );
    await mkdir(directory, { recursive: true });
    const installed = { name, ...entry, main: "index.js" };
    // A pnpm snapshot binds the optional peer, while its upstream manifest declares only the peer.
    if (optionalPeer && name === "first") {
      Reflect.deleteProperty(installed, "optionalDependencies");
      Reflect.set(installed, "dependencies", { shared: "^1.0.0" });
    }
    Reflect.deleteProperty(installed, "optional");
    await writeFile(path.join(directory, "package.json"), JSON.stringify(installed));
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
  return { root, manifest, packages, ledger, metadata };
}

it.each([true, false])("retains the complete optional-peer subtree without changing source manifests (tarball peer declaration=%s)", async (tarballPeer) => {
  const { root } = await createBundleFixture(true);
  const source = path.join(root, "node_modules/first/package.json");
  if (!tarballPeer) {
    const metadata = JSON.parse(await readFile(source, "utf8"));
    delete metadata.peerDependencies;
    await writeFile(source, JSON.stringify(metadata));
  }
  const before = await readFile(source, "utf8");
  await writeFile(path.join(root, "index.js"), 'module.exports = require("first");');
  await writeFile(path.join(root, "node_modules/first/index.js"), 'module.exports = require("peer");');
  await writeFile(path.join(root, "node_modules/peer/index.js"), 'module.exports = require("leaf");');
  await writeFile(path.join(root, "node_modules/leaf/index.js"), 'module.exports = 17;');
  const destination = await harness.createTempRoot("pm-peer-tarball-");
  const artifact = await packDistribution(root, { destination });
  const extracted = await harness.createTempRoot("pm-peer-extracted-");
  await extractTar({ file: path.join(destination, artifact.filename), cwd: extracted });
  const installed = path.join(extracted, "package");
  expect(verifyRuntimeInstallation(installed)).toMatchObject({ ok: true, runtime_packages: 6 });
  expect(execFileSync(process.execPath, ["-p", 'require("./")'], { cwd: installed, encoding: "utf8" }).trim()).toBe("17");
  const published = JSON.parse(await readFile(path.join(installed, "node_modules/first/package.json"), "utf8"));
  expect(published).toMatchObject({ dependencies: { shared: "^1.0.0" }, peerDependenciesMeta: { peer: { optional: true } }, optionalDependencies: { peer: "1.0.0" } });
  expect(published.peerDependencies).toEqual(JSON.parse(before).peerDependencies);
  expect(await readFile(source, "utf8")).toBe(before);
  await rm(path.join(installed, "node_modules/leaf"), { recursive: true });
  expect(() => verifyRuntimeInstallation(installed)).toThrow("ENOENT");
}, 60_000);

it("packs exact physical runtime packages without development dependencies or maps and refuses installed drift", async () => {
  const { root, packages, ledger } = await createBundleFixture();
  const before = await readFile(path.join(root, "package.json"), "utf8");
  const artifact = await packDistribution(root);
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
  await expect(packDistribution(root)).rejects.toThrow("Installed runtime drift");
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
  await expect(packDistribution(root)).rejects.toThrow(
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
    await expect(packDistribution(root)).rejects.toThrow(
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
  await expect(module.packDistribution(root)).rejects.toThrow(
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
  const artifact = await packDistribution(root, { destination });
  expect(
    await readFile(path.join(destination, artifact.filename)),
  ).not.toHaveLength(0);
}, 60_000);

it("packs real npm artifacts through the npm 12 keyed receipt format", async () => {
  const { root, manifest, ledger, metadata } = await createBundleFixture();
  const destination = await harness.createTempRoot("pm-keyed-publication-");
  const sourcePaths = ["metadata.json", "runtime-dependencies.json", "node_modules/first/package.json"];
  const originals = await Promise.all(
    sourcePaths.map((file) => readFile(path.join(root, file), "utf8")),
  );
  // npm 11 returns arrays; npm 12 keys the same real packing receipt by name.
  // Preserve real child execution and filesystem output on either CI version.
  const execute = vi.fn(
    (
      file: string,
      args: readonly string[],
      options: ExecFileSyncOptionsWithStringEncoding,
    ) => {
      const receipt: unknown = JSON.parse(execFileSync(file, args, options));
      return JSON.stringify({
        [manifest.name]: Array.isArray(receipt)
          ? receipt[0]
          : (receipt as Record<string, unknown>)[manifest.name],
      });
    },
  );
  vi.doMock("node:child_process", () => ({ execFileSync: execute }));
  const module = await harness.importModule<{
    packDistribution: typeof packDistribution;
  }>("scripts/release/package-distribution.mjs");
  const artifact = await module.packDistribution(root, { destination });
  expect(artifact.name).toBe(manifest.name);
  expect(artifact.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "node_modules/first/package.json" }),
      expect.objectContaining({
        path: "node_modules/second/node_modules/shared/package.json",
      }),
    ]),
  );
  expect(
    await readFile(path.join(destination, artifact.filename)),
  ).not.toHaveLength(0);
  expect(execute).toHaveBeenCalledTimes(2);
  const extracted = await harness.createTempRoot("pm-keyed-extracted-");
  await extractTar({
    file: path.join(destination, artifact.filename),
    cwd: extracted,
  });
  for (const [file, value] of [
    ["metadata.json", metadata],
    ["runtime-dependencies.json", ledger],
  ] as const) {
    const delivered = await readFile(path.join(extracted, "package", file), "utf8");
    expect(JSON.parse(delivered)).toEqual(value);
    expect(delivered).toBe(`${JSON.stringify(value)}\n`);
  }
  expect(
    await readFile(path.join(extracted, "package/node_modules/first/package.json"), "utf8"),
  ).toBe(originals[2]);
  expect(
    await Promise.all(sourcePaths.map((file) => readFile(path.join(root, file), "utf8"))),
  ).toEqual(originals);
}, 60_000);

it.each(["{", '{"value":-0}', '{"value":1e400}'])("refuses invalid or lossy first-party JSON instead of silently changing its values: %s", async (raw) => {
  const { root } = await createBundleFixture();
  await writeFile(path.join(root, "metadata.json"), raw);
  await expect(packDistribution(root)).rejects.toThrow(/JSON|lossless/u);
  expect(await readFile(path.join(root, "metadata.json"), "utf8")).toBe(raw);
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
  vi.stubEnv("PM_BUILD_CONSUMER_LEASE", "");
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

it("refuses incomplete generations and validates inherited ownership before source inventory", async () => {
  const { root } = await createBundleFixture();
  await mkdir(path.join(root, ".cache"));
  await writeFile(path.join(root, ".cache/build-incomplete"), "interrupted build");
  await expect(packDistribution(root)).rejects.toThrow("incomplete build generation");
  expect(await readFile(path.join(root, ".cache/build-incomplete"), "utf8")).toBe("interrupted build");
  await rm(path.join(root, ".cache/build-incomplete"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("PM_BUILD_CONSUMER_LEASE", "invalid");
  vi.stubEnv("PM_BUILD_CONSUMER_LEASE_ROOT", root);
  await mkdir(path.join(root, ".cache/build-lease"));
  const owner = JSON.stringify({ pid: process.pid, token: "actual-owner" });
  await writeFile(path.join(root, ".cache/build-lease/owner.json"), owner);
  await expect(packDistribution(root)).rejects.toThrow("Invalid inherited build lease");
  expect(await readFile(path.join(root, ".cache/build-lease/owner.json"), "utf8")).toBe(owner);
});

it("binds inherited packing leases to their source workspace and preserves both live owners", async () => {
  const { root: source } = await createBundleFixture();
  const { root: foreign } = await createBundleFixture();
  await withBuildLease(source, async (lease: string) => {
    vi.stubEnv("PM_BUILD_CONSUMER_LEASE", lease);
    vi.stubEnv("PM_BUILD_CONSUMER_LEASE_ROOT", source);
    vi.spyOn(process, "cwd").mockReturnValue(foreign);
    expect((await packDistribution(foreign)).name).toBe("runtime-bundle-fixture");
    const ownerPath = path.join(source, ".cache/build-lease/owner.json");
    const owner = await readFile(ownerPath, "utf8");
    expect(JSON.parse(owner)).toMatchObject({ token: lease, pid: process.pid });
    vi.mocked(process.cwd).mockReturnValue(source);
    expect((await packDistribution(source)).name).toBe("runtime-bundle-fixture");
    expect(await readFile(ownerPath, "utf8")).toBe(owner);
    vi.stubEnv("PM_BUILD_CONSUMER_LEASE_ROOT", undefined);
    vi.mocked(process.cwd).mockReturnValue(foreign);
    expect((await packDistribution(foreign)).name).toBe("runtime-bundle-fixture");
    expect(await readFile(ownerPath, "utf8")).toBe(owner);
  });
}, 60_000);

it.each(["missing", "non-directory"])("packs independently when the inherited owner path is %s", async (state) => {
  const { root } = await createBundleFixture();
  const retired = path.join(root, "retired-owner");
  if (state === "non-directory") await writeFile(retired, "preserved foreign file");
  vi.stubEnv("PM_BUILD_CONSUMER_LEASE", "former-owner-token");
  vi.stubEnv("PM_BUILD_CONSUMER_LEASE_ROOT", state === "missing" ? retired : path.join(retired, "workspace"));
  expect((await packDistribution(root)).name).toBe("runtime-bundle-fixture");
  await expect(readFile(path.join(root, ".cache/build-lease/owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  if (state === "non-directory") expect(await readFile(retired, "utf8")).toBe("preserved foreign file");
});

it("waits for an independent real build to finish before inventorying and packing one generation", async () => {
  const { root, manifest } = await createBundleFixture();
  const destination = await harness.createTempRoot("pm-overlap-artifact-");
  manifest.files.push("second.js");
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, "second.js"), "generation-one");
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "node_modules/typescript/bin"), { recursive: true });
  await writeFile(path.join(root, "scripts/prepare-build-cache.mjs"), `
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
writeFileSync('index.js', 'partial-generation');
console.log('build-is-partial');
await once(process.stdin, 'data');
process.stdin.pause();
writeFileSync('index.js', 'generation-two');
`);
  await writeFile(path.join(root, "node_modules/typescript/bin/tsc"), "process.exitCode = 0;");
  await writeFile(path.join(root, "scripts/bundle-cli.mjs"), "");
  await writeFile(path.join(root, "scripts/finalize-build.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('second.js', 'generation-two');");
  const fixture = path.join(root, "consumer.mjs");
  const packerUrl = pathToFileURL(path.resolve("scripts/release/package-distribution.mjs")).href;
  await writeFile(fixture, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalMkdir = fs.mkdir;
let reported = false;
fs.mkdir = async (...args) => {
  try { return await originalMkdir(...args); }
  catch (error) {
    if (!reported && error.code === 'EEXIST' && String(args[0]).endsWith('build-lease')) {
      reported = true;
      process.send({ state: 'contending', owner: JSON.parse(await fs.readFile(String(args[0]) + '/owner.json', 'utf8')) });
    }
    throw error;
  }
};
syncBuiltinESMExports();
try {
  const { packDistribution } = await import(${JSON.stringify(packerUrl)});
  const artifact = await packDistribution(process.cwd(), { destination: process.argv[2] });
  process.send({ state: 'packed', filename: artifact.filename });
} catch (error) { process.send({ state: 'failed', message: error.message }); process.exitCode = 1; }
process.disconnect();
`);
  const producer = fork(path.resolve("scripts/build.mjs"), [], {
    cwd: root, env: { ...process.env, PM_BUILD_CONSUMER_LEASE: "" },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const producerClosed = once(producer, "close");
  let consumer: ReturnType<typeof fork> | undefined;
  let consumerClosed: ReturnType<typeof once> | undefined;
  try {
    expect(String((await once(producer.stdout!, "data"))[0])).toContain("build-is-partial");
    consumer = fork(fixture, [destination], { cwd: root, env: { ...process.env, PM_BUILD_CONSUMER_LEASE: "" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    consumerClosed = once(consumer, "close");
    const [waiting] = await once(consumer, "message");
    expect(waiting).toMatchObject({ state: "contending", owner: { pid: producer.pid, token: expect.any(String) } });
    const packed = once(consumer, "message");
    producer.stdin!.end("finish generation\n");
    expect((await producerClosed)[0]).toBe(0);
    const [artifact] = await packed as [{ state: string; filename: string }];
    expect(artifact.state).toBe("packed");
    expect((await consumerClosed)[0]).toBe(0);
    const extracted = await harness.createTempRoot("pm-overlap-extracted-");
    await extractTar({ file: path.join(destination, artifact.filename), cwd: extracted });
    expect(await readFile(path.join(extracted, "package/index.js"), "utf8")).toBe("generation-two");
    expect(await readFile(path.join(extracted, "package/second.js"), "utf8")).toBe("generation-two");
  } finally {
    producer.kill();
    consumer?.kill();
    await Promise.all([producerClosed, ...(consumerClosed ? [consumerClosed] : [])]);
  }
}, 60_000);
