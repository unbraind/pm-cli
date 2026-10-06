import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  buildRuntimeLock,
  synchronizeRuntimeLock,
} from "../../../scripts/release/runtime-lock.mjs";
import { createScriptHarness } from "../../helpers/scriptModule.js";

const harness = createScriptHarness();

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixtureManifest = {
  name: "runtime-lock-fixture",
  version: "1.0.0",
  dependencies: { first: "^1.0.0", second: "^1.0.0" },
  optionalDependencies: { optional: "^1.0.0" },
};
const fixtureLock = {
  lockfileVersion: "9.0",
  importers: {
    ".": {
      dependencies: {
        first: { specifier: "^1.0.0", version: "1.0.0" },
        second: { specifier: "^1.0.0", version: "1.0.0" },
      },
      optionalDependencies: {
        optional: { specifier: "^1.0.0", version: "1.0.0" },
      },
      devDependencies: { dev: { specifier: "^1.0.0", version: "1.0.0" } },
    },
  },
  packages: {
    "first@1.0.0": { resolution: { integrity: "sha512-first" } },
    "second@1.0.0": { resolution: { integrity: "sha512-second" } },
    "shared@1.0.0": { resolution: { integrity: "sha512-shared-one" } },
    "shared@2.0.0": { resolution: { integrity: "sha512-shared-two" } },
    "optional@1.0.0": {
      resolution: { integrity: "sha512-optional" },
      os: ["darwin"],
    },
    "optional-child@1.0.0": {
      resolution: { integrity: "sha512-optional-child" },
    },
    "dev@1.0.0": { resolution: { integrity: "sha512-dev" } },
  },
  snapshots: {
    "first@1.0.0": { dependencies: { shared: "1.0.0" } },
    "second@1.0.0": { dependencies: { shared: "2.0.0" } },
    "shared@1.0.0": { dependencies: { first: "1.0.0" } },
    "shared@2.0.0": {},
    "optional@1.0.0": {
      dependencies: { "optional-child": "1.0.0", shared: "1.0.0" },
    },
    "optional-child@1.0.0": {},
    "dev@1.0.0": {},
  },
};

it("publishes a runtime-only dependency lock and a bounded optional Node types peer", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional: boolean }>;
  };
  expect(manifest.dependencies["@types/node"]).toBeUndefined();
  expect(manifest.peerDependencies?.["@types/node"]).toBe("^22 || ^24 || ^26");
  expect(manifest.peerDependenciesMeta?.["@types/node"]).toEqual({
    optional: true,
  });
  const shrinkwrap = JSON.parse(
    await readFile("runtime-dependencies.json", "utf8"),
  ) as {
    lockfileVersion: number;
    packages: Record<
      string,
      { version: string; integrity?: string; dev?: boolean }
    >;
  };
  expect(shrinkwrap.lockfileVersion).toBe(3);
  const testedLock = parse(await readFile("pnpm-lock.yaml", "utf8"));
  expect(shrinkwrap).toEqual(buildRuntimeLock(manifest, testedLock));
  expect(shrinkwrap.packages["node_modules/@types/node"]).toBeUndefined();
  for (const [location, entry] of Object.entries(shrinkwrap.packages)) {
    if (location === "") continue;
    expect(entry.dev).not.toBe(true);
    expect(entry.integrity).toMatch(/^sha512-/u);
  }
});

it("preserves conflicting versions, cycles and optional-only runtime closures", () => {
  const result = buildRuntimeLock(fixtureManifest, fixtureLock);
  expect(result.packages["node_modules/shared"].version).toBe("1.0.0");
  expect(
    result.packages["node_modules/second/node_modules/shared"].version,
  ).toBe("2.0.0");
  expect(Object.keys(result.packages)).toHaveLength(7);
  expect(result.packages["node_modules/optional"].optional).toBe(true);
  expect(result.packages["node_modules/optional-child"].optional).toBe(true);
  expect(result.packages["node_modules/shared"].optional).toBeUndefined();
  expect(result.packages["node_modules/dev"]).toBeUndefined();
  expect(result.packages["node_modules/optional"].os).toEqual(["darwin"]);
});

it.each(["importer", "integrity", "url", "format"] as const)(
  "rejects %s drift instead of resolving a different graph",
  (failure) => {
    const lock = structuredClone(fixtureLock);
    if (failure === "importer")
      lock.importers["."].dependencies.first.specifier = "^2.0.0";
    if (failure === "integrity")
      lock.packages["first@1.0.0"].resolution.integrity = "";
    if (failure === "url")
      Object.assign(lock.packages["first@1.0.0"].resolution, {
        tarball: "https://user:secret@example.invalid/package.tgz",
      });
    if (failure === "format") lock.lockfileVersion = "8.0";
    expect(() => buildRuntimeLock(fixtureManifest, lock)).toThrow(
      /drift|integrity-locked|Unsafe|version 9/u,
    );
  },
);

it("checks actual files and refuses stale or edited runtime ledgers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pm-runtime-lock-"));
  roots.push(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(fixtureManifest),
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), stringify(fixtureLock));
  expect(synchronizeRuntimeLock(root, "apply")).toMatchObject({
    ok: true,
    packages: 6,
  });
  expect(synchronizeRuntimeLock(root, "check")).toMatchObject({ ok: true });
  const installed = JSON.parse(
    await readFile(path.join(root, "runtime-dependencies.json"), "utf8"),
  );
  installed.packages["node_modules/shared"].version = "9.0.0";
  await writeFile(
    path.join(root, "runtime-dependencies.json"),
    JSON.stringify(installed),
  );
  expect(() => synchronizeRuntimeLock(root, "check")).toThrow(
    "Runtime lock drift",
  );
  expect(() => synchronizeRuntimeLock(root, "unknown")).toThrow("Usage");
});

it.each([
  "http",
  "username",
  "password",
  "snapshot",
  "version",
  "importer",
] as const)("refuses %s in the tested production graph", (failure) => {
  const lock = structuredClone(fixtureLock);
  if (failure === "http")
    Object.assign(lock.packages["first@1.0.0"].resolution, {
      tarball: "http://example.invalid/package.tgz",
    });
  if (failure === "username")
    Object.assign(lock.packages["first@1.0.0"].resolution, {
      tarball: "https://user@example.invalid/package.tgz",
    });
  if (failure === "password")
    Object.assign(lock.packages["first@1.0.0"].resolution, {
      tarball: "https://:secret@example.invalid/package.tgz",
    });
  if (failure === "snapshot")
    delete (lock.snapshots as Record<string, unknown>)["first@1.0.0"];
  if (failure === "version") {
    lock.importers["."].dependencies.first.version = "latest";
    Object.assign(lock.packages, {
      "first@latest": lock.packages["first@1.0.0"],
    });
    Object.assign(lock.snapshots, { "first@latest": {} });
  }
  if (failure === "importer")
    delete (lock.importers as Record<string, unknown>)["."];
  expect(() => buildRuntimeLock(fixtureManifest, lock)).toThrow(
    /Unsafe|integrity-locked|importer drift/u,
  );
});

it("preserves optional transitive edges and exact peer-context metadata", () => {
  const lock = structuredClone(fixtureLock);
  Object.assign(lock.snapshots["first@1.0.0"], {
    optionalDependencies: { optional: "1.0.0" },
  });
  Object.assign(lock.packages["first@1.0.0"], {
    peerDependencies: { host: "^1.0.0" },
    peerDependenciesMeta: { host: { optional: true } },
    cpu: ["x64"],
    hasBin: true,
  });
  const result = buildRuntimeLock(fixtureManifest, lock);
  expect(result.packages["node_modules/first"]).toMatchObject({
    optionalDependencies: { optional: "1.0.0" },
    peerDependencies: { host: "^1.0.0" },
    peerDependenciesMeta: { host: { optional: true } },
    cpu: ["x64"],
    hasBin: true,
  });
});

it("checks the real projection through the default and explicit CLI modes without rewriting it", async () => {
  const before = await readFile("runtime-dependencies.json", "utf8");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const args of [[], ["check"]]) {
    process.argv = [
      process.execPath,
      path.resolve("scripts/release/runtime-lock.mjs"),
      ...args,
    ];
    vi.resetModules();
    await harness.importModule("scripts/release/runtime-lock.mjs");
  }
  expect(output).toHaveBeenCalledTimes(2);
  expect(await readFile("runtime-dependencies.json", "utf8")).toBe(before);
});
